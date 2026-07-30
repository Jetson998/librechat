import { useRef, type KeyboardEvent } from 'react';
import { ArrowLeft, Plus, Store, UserRound } from 'lucide-react';
import { useMediaQuery } from '@librechat/client';
import OpenSidebar from '~/components/Chat/Menus/OpenSidebar';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

export type AgentWorkspaceView = 'recommended' | 'mine' | 'create';

interface AgentWorkspaceHeaderProps {
  view: AgentWorkspaceView;
  canCreate: boolean;
  isBuilderOpen: boolean;
  onBack: () => void;
  onChange: (view: AgentWorkspaceView) => void;
}

export default function AgentWorkspaceHeader({
  view,
  canCreate,
  isBuilderOpen,
  onBack,
  onChange,
}: AgentWorkspaceHeaderProps) {
  const localize = useLocalize();
  const isSmallScreen = useMediaQuery('(max-width: 768px)');
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const items = [
    {
      value: 'recommended' as const,
      label: localize('com_agents_workspace_recommended'),
      icon: Store,
    },
    {
      value: 'mine' as const,
      label: localize('com_agents_workspace_mine'),
      icon: UserRound,
    },
    ...(canCreate
      ? [
          {
            value: 'create' as const,
            label: localize('com_agents_workspace_create'),
            icon: Plus,
          },
        ]
      : []),
  ];

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;

    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (index + 1) % items.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (index - 1 + items.length) % items.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = items.length - 1;
    }

    if (nextIndex == null) {
      return;
    }

    event.preventDefault();
    tabRefs.current[nextIndex]?.focus();
    onChange(items[nextIndex].value);
  };

  return (
    <header className="border-b border-border-light bg-presentation">
      <div className="container mx-auto flex max-w-4xl flex-col gap-3 px-4 py-4 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          {isSmallScreen && <OpenSidebar />}
          {isBuilderOpen && (
            <button
              type="button"
              onClick={onBack}
              title={localize('com_agents_workspace_back')}
              aria-label={localize('com_agents_workspace_back')}
              className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary"
            >
              <ArrowLeft className="h-5 w-5" aria-hidden="true" />
            </button>
          )}
          <h1 className="truncate text-xl font-semibold text-text-primary">
            {localize('com_agents_workspace')}
          </h1>
        </div>

        <div
          className="scrollbar-hide flex w-full min-w-0 gap-1 overflow-x-auto rounded-lg bg-surface-secondary p-1 md:w-auto"
          role="tablist"
          aria-label={localize('com_agents_workspace_navigation')}
        >
          {items.map((item, index) => {
            const active = item.value === view;
            const Icon = item.icon;
            return (
              <button
                key={item.value}
                ref={(element) => {
                  tabRefs.current[index] = element;
                }}
                type="button"
                role="tab"
                id={`agent-workspace-tab-${item.value}`}
                aria-controls={`agent-workspace-panel-${item.value}`}
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                onClick={() => onChange(item.value)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
                className={cn(
                  'inline-flex h-9 flex-shrink-0 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary',
                  active
                    ? 'bg-surface-primary text-text-primary shadow-sm'
                    : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
                )}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </header>
  );
}
