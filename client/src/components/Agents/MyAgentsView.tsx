import { Pencil, Plus } from 'lucide-react';
import { Button, Spinner } from '@librechat/client';
import { PermissionBits } from 'librechat-data-provider';
import type t from 'librechat-data-provider';
import { useListAgentsQuery } from '~/data-provider';
import { useLocalize } from '~/hooks';
import { renderAgentAvatar } from '~/utils';
import ErrorDisplay from './ErrorDisplay';

interface MyAgentsViewProps {
  canCreate: boolean;
  onCreate: () => void;
  onEdit: (agent: t.Agent) => void;
}

export default function MyAgentsView({ canCreate, onCreate, onEdit }: MyAgentsViewProps) {
  const localize = useLocalize();
  const agentsQuery = useListAgentsQuery({
    requiredPermission: PermissionBits.EDIT,
  });
  const agents = agentsQuery.data?.data ?? [];

  if (agentsQuery.isLoading) {
    return (
      <div
        className="flex justify-center py-16"
        role="status"
        aria-label={localize('com_agents_loading')}
      >
        <Spinner className="h-8 w-8 text-primary" />
      </div>
    );
  }

  if (agentsQuery.error) {
    return (
      <ErrorDisplay
        error={agentsQuery.error}
        onRetry={() => agentsQuery.refetch()}
        context={{ category: 'mine' }}
      />
    );
  }

  if (agents.length === 0) {
    return (
      <div className="flex flex-col items-center px-4 py-16 text-center" role="status">
        <h2 className="text-lg font-semibold text-text-primary">
          {localize('com_agents_workspace_mine_empty')}
        </h2>
        <p className="mt-2 max-w-md text-sm text-text-secondary">
          {localize('com_agents_workspace_mine_empty_description')}
        </p>
        {canCreate && (
          <Button type="button" className="mt-5 gap-2" onClick={onCreate}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {localize('com_agents_workspace_create')}
          </Button>
        )}
      </div>
    );
  }

  return (
    <ul
      className="grid grid-cols-1 gap-3 px-4 pb-8 pt-6 md:grid-cols-2"
      aria-label={localize('com_agents_workspace_mine')}
    >
      {agents.map((agent) => (
        <li key={agent.id}>
          <button
            type="button"
            onClick={() => onEdit(agent)}
            aria-label={localize('com_agents_workspace_edit_named', {
              name: agent.name || localize('com_ui_agent'),
            })}
            className="flex h-28 w-full items-center gap-4 rounded-lg border border-border-light bg-surface-primary px-4 py-3 text-left transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary"
          >
            <div className="flex-shrink-0 overflow-hidden rounded-full">
              {renderAgentAvatar(agent, { size: 'sm', showBorder: false })}
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-base font-semibold text-text-primary">
                {agent.name || localize('com_ui_agent')}
              </h2>
              <p className="mt-1 line-clamp-2 text-sm text-text-secondary">
                {agent.description || localize('com_agents_workspace_no_description')}
              </p>
            </div>
            <Pencil className="h-4 w-4 flex-shrink-0 text-text-secondary" aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
}
