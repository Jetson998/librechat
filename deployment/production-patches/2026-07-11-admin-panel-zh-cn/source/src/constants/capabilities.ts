import { CAPABILITY_CATEGORIES as UPSTREAM_CAPABILITY_CATEGORIES } from '@librechat/data-schemas/capabilities';

export {
  SystemCapabilities,
  expandImplications,
  hasImpliedCapability,
  CapabilityImplications,
} from '@librechat/data-schemas/capabilities';

/**
 * Forward-compat shim: the LibreChat backend gates `/api/admin/audit-log` on
 * this capability string. The local literal keeps the Admin Panel build
 * independent of which data-schemas version exposes the upstream enum member.
 */
export const READ_AUDIT_LOG_CAPABILITY = 'read:audit_log' as const;

/** Dedicated capability for runtime diagnostic events. Keep the audit-log
 * capability as a compatibility fallback until the backend seeds this one. */
export const READ_DIAGNOSTIC_LOGS_CAPABILITY = 'read:diagnostic_logs' as const;

/**
 * Local override of the upstream `CAPABILITY_CATEGORIES` so the System
 * category surfaces the log capabilities in the grants editing UI even while
 * the upstream package does not contain the diagnostic-log capability.
 *
 * The audit capability can eventually be removed from this local override once
 * the upstream category includes it; the diagnostic capability remains here
 * until the backend/data-schemas package owns the dedicated enum and category.
 */
export const CAPABILITY_CATEGORIES: typeof UPSTREAM_CAPABILITY_CATEGORIES =
  UPSTREAM_CAPABILITY_CATEGORIES.map((cat) => {
    if (cat.key !== 'system') return cat;
    const caps = cat.capabilities as readonly string[];
    const missing = [READ_AUDIT_LOG_CAPABILITY, READ_DIAGNOSTIC_LOGS_CAPABILITY].filter(
      (cap) => !caps.includes(cap),
    );
    if (missing.length === 0) return cat;
    return {
      ...cat,
      capabilities: [...cat.capabilities, ...missing],
    } as typeof cat;
  });
