import { createFileRoute } from '@tanstack/react-router';
import { READ_DIAGNOSTIC_LOGS_CAPABILITY } from '@/constants';
import { AccessDenied, PermissionsUnavailable } from '@/components/shared';
import { DiagnosticLogsPage } from '@/components/logs';
import { useCapabilities } from '@/hooks';

export const Route = createFileRoute('/_app/logs')({
  component: LogsRoute,
});

function LogsRoute() {
  const { hasCapability, isLoading, isError } = useCapabilities();

  if (isLoading) return null;
  if (isError) return <PermissionsUnavailable />;
  if (!hasCapability(READ_DIAGNOSTIC_LOGS_CAPABILITY)) return <AccessDenied />;

  return <DiagnosticLogsPage />;
}
