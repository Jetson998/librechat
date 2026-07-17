import { createFileRoute } from '@tanstack/react-router';
import { AccessDenied, PermissionsUnavailable } from '@/components/shared';
import { SystemCapabilities } from '@/constants';
import { UsersPage } from '@/components/users';
import { useCapabilities } from '@/hooks';

export const Route = createFileRoute('/_app/users')({
  component: UsersRoute,
});

function UsersRoute() {
  const { hasCapability, isLoading, isError } = useCapabilities();

  if (isLoading) return null;
  if (isError) return <PermissionsUnavailable />;
  if (!hasCapability(SystemCapabilities.READ_USERS)) return <AccessDenied />;

  return <UsersPage />;
}
