import { useMemo } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { AccessDenied, PermissionsUnavailable } from '@/components/shared';
import { ConfigPage } from '@/components/configuration/ConfigPage';
import { getConfigSchemaFields } from '@/server';
import { hasConfigCapability } from '@/utils';
import { useCapabilities } from '@/hooks';

interface ConfigSearchParams {
  tab?: string;
  field?: string;
  scope?: string;
}

export const Route = createFileRoute('/_app/configuration/')({
  loader: () => getConfigSchemaFields(),
  validateSearch: (search: Record<string, unknown>): ConfigSearchParams => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
    field: typeof search.field === 'string' ? search.field : undefined,
    scope: typeof search.scope === 'string' ? search.scope : undefined,
  }),
  component: ConfigurationPage,
});

function ConfigurationPage() {
  const { tab, field, scope } = Route.useSearch();
  const { hasCapability, isLoading, isError } = useCapabilities();
  const { tree: schemaTree } = Route.useLoaderData();

  const canViewAnyConfig = useMemo(
    () =>
      hasConfigCapability(hasCapability, null, 'read') ||
      hasConfigCapability(hasCapability, null, 'manage') ||
      schemaTree.some(
        (s) =>
          hasConfigCapability(hasCapability, s.key, 'read') ||
          hasConfigCapability(hasCapability, s.key, 'manage'),
      ),
    [hasCapability, schemaTree],
  );

  if (isLoading) return null;
  if (isError) return <PermissionsUnavailable />;
  if (!canViewAnyConfig) return <AccessDenied />;
  return <ConfigPage initialTab={tab} highlightField={field} initialScope={scope} />;
}
