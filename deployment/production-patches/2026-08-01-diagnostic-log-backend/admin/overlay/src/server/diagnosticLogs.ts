/**
 * Server functions for the runtime diagnostic-event view.
 *
 * The Admin Panel is only a BFF here: it does not read MongoDB or invent
 * events. The production API remains the source of truth, and an absent or
 * temporarily unavailable endpoint is returned as an explicit UI state.
 */

import { z } from "zod";
import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import {
  READ_AUDIT_LOG_CAPABILITY,
  READ_DIAGNOSTIC_LOGS_CAPABILITY,
} from "@/constants";
import { apiFetch, extractApiError } from "./utils/api";
import { requireAnyCapability } from "./capabilities";

export const DIAGNOSTIC_LOG_PAGE_SIZE = 50;

const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a calendar date")
  .optional();

const isoTimestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/,
    "Expected an ISO timestamp",
  );

/** Strip line breaks from operator-facing text so a backend error cannot
 * create a misleading multi-row/table layout. Unknown fields are discarded by
 * the surrounding Zod object schemas. */
const boundedText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((value) => value.replace(/[\r\n]+/g, " ").trim());

const boundedId = z.string().min(1).max(256);

export const diagnosticLogFilterSchema = z.object({
  q: boundedText(200).optional(),
  level: z.enum(["error", "warning", "info"]).optional(),
  stage: z
    .enum(["request", "office_preparse", "generation", "followup"])
    .optional(),
  from: dateOnlySchema,
  to: dateOnlySchema,
  conversationId: boundedId.optional(),
  streamId: boundedId.optional(),
  cursor: z.string().max(256).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export type DiagnosticLogFilters = z.infer<typeof diagnosticLogFilterSchema>;

const diagnosticLogEntrySchema = z.object({
  id: boundedId,
  timestamp: isoTimestampSchema,
  level: z.enum(["error", "warning", "info"]),
  event: boundedText(160),
  stage: z.enum(["request", "office_preparse", "generation", "followup"]),
  requestId: boundedId.optional(),
  userId: boundedId.optional(),
  userIdHash: boundedId.optional(),
  conversationId: boundedId.optional(),
  streamId: boundedId.optional(),
  messageId: boundedId.optional(),
  model: boundedText(200).optional(),
  errorCode: boundedText(160).optional(),
  errorName: boundedText(160).optional(),
  errorMessage: boundedText(1000).optional(),
  durationMs: z.number().int().min(0).max(86_400_000).optional(),
  release: boundedText(128).optional(),
  stack: z.string().max(6000).optional(),
});

const diagnosticLogPageResponseSchema = z.object({
  entries: z.array(diagnosticLogEntrySchema).max(1000),
  total: z.number().int().min(0).max(10_000_000),
  nextCursor: z.string().max(256).nullable(),
  /** Optional aggregate supplied by newer backends. Older responses remain
   * valid and the UI falls back to the currently returned page. */
  errorCount: z.number().int().min(0).max(10_000_000).optional(),
});

export type DiagnosticLogEntry = z.infer<typeof diagnosticLogEntrySchema>;
export type DiagnosticLogPage = z.infer<typeof diagnosticLogPageResponseSchema>;

export type DiagnosticLogsResult =
  | ({ available: true } & DiagnosticLogPage)
  | { available: false; reason: "not_configured" | "unavailable" };

const diagnosticLogEntryInputSchema = z.object({ id: boundedId });

/** Build the documented wire query without sending empty filters. */
export function buildDiagnosticLogQuery(filters: DiagnosticLogFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null) continue;
    const normalized = typeof value === "string" ? value.trim() : value;
    if (normalized === "") continue;
    params.set(key, String(normalized));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function parseDiagnosticLogPage(value: unknown): DiagnosticLogPage {
  return diagnosticLogPageResponseSchema.parse(value);
}

export const getDiagnosticLogPageFn = createServerFn({ method: "GET" })
  .inputValidator(diagnosticLogFilterSchema)
  .handler(
    async ({
      data,
    }: {
      data: DiagnosticLogFilters;
    }): Promise<DiagnosticLogsResult> => {
      await requireAnyCapability([
        READ_DIAGNOSTIC_LOGS_CAPABILITY,
        READ_AUDIT_LOG_CAPABILITY,
      ]);

      const filters: DiagnosticLogFilters = {
        ...data,
        limit: data.limit ?? DIAGNOSTIC_LOG_PAGE_SIZE,
      };
      const response = await apiFetch(
        `/api/admin/diagnostic-events${buildDiagnosticLogQuery(filters)}`,
      );

      if (response.status === 404) {
        return { available: false, reason: "not_configured" };
      }
      if (response.status === 503) {
        return { available: false, reason: "unavailable" };
      }
      if (!response.ok) {
        await extractApiError(response, "Failed to fetch diagnostic logs");
      }

      return {
        available: true,
        ...parseDiagnosticLogPage(await response.json()),
      };
    },
  );

export const diagnosticLogsQueryOptions = (
  filters: DiagnosticLogFilters = {},
) =>
  queryOptions({
    queryKey: ["diagnosticLogs", filters] as const,
    queryFn: () => getDiagnosticLogPageFn({ data: filters }),
    staleTime: 15_000,
  });

export const getDiagnosticLogEntryFn = createServerFn({ method: "GET" })
  .inputValidator(diagnosticLogEntryInputSchema)
  .handler(async ({ data }: { data: { id: string } }) => {
    await requireAnyCapability([
      READ_DIAGNOSTIC_LOGS_CAPABILITY,
      READ_AUDIT_LOG_CAPABILITY,
    ]);
    const response = await apiFetch(
      `/api/admin/diagnostic-events/${encodeURIComponent(data.id)}`,
    );
    if (response.status === 404) return { entry: null };
    if (!response.ok) {
      await extractApiError(response, "Failed to fetch diagnostic log entry");
    }
    const json = await response.json();
    return {
      entry:
        json.entry == null ? null : diagnosticLogEntrySchema.parse(json.entry),
    };
  });

export const diagnosticLogEntryQueryOptions = (id?: string) =>
  queryOptions({
    queryKey: ["diagnosticLogEntry", id] as const,
    queryFn: () => getDiagnosticLogEntryFn({ data: { id: id ?? "" } }),
    enabled: Boolean(id),
    staleTime: 60_000,
  });
