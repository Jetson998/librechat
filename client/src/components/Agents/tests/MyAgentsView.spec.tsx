import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { PermissionBits } from 'librechat-data-provider';
import type t from 'librechat-data-provider';
import MyAgentsView from '../MyAgentsView';

const mockUseListAgentsQuery = jest.fn();

jest.mock('~/data-provider', () => ({
  useListAgentsQuery: (...args: unknown[]) => mockUseListAgentsQuery(...args),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string>) => {
    const translations: Record<string, string> = {
      com_agents_loading: 'Loading',
      com_agents_workspace_mine: 'My Assistants',
      com_agents_workspace_mine_empty: 'No assistants yet',
      com_agents_workspace_mine_empty_description: 'Create your first assistant.',
      com_agents_workspace_create: 'Create Assistant',
      com_agents_workspace_no_description: 'No description',
      com_agents_workspace_edit_named: `Edit ${values?.name ?? ''}`,
      com_ui_agent: 'Assistant',
    };
    return translations[key] ?? key;
  },
}));

jest.mock('~/utils', () => ({
  renderAgentAvatar: () => <div data-testid="agent-avatar" />,
}));

jest.mock('@librechat/client', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Spinner: () => <div data-testid="spinner" />,
}));

jest.mock('../ErrorDisplay', () => ({
  __esModule: true,
  default: () => <div data-testid="error-display" />,
}));

const agent = {
  id: 'agent_owned',
  name: 'Owned Assistant',
  description: 'Editable',
  provider: 'openAI',
  model: 'gpt-4o',
} as t.Agent;

describe('MyAgentsView', () => {
  beforeEach(() => {
    mockUseListAgentsQuery.mockReset();
    mockUseListAgentsQuery.mockReturnValue({
      data: { data: [] },
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
  });

  test('requests only assistants the current user can edit', () => {
    render(<MyAgentsView canCreate={false} onCreate={jest.fn()} onEdit={jest.fn()} />);
    expect(mockUseListAgentsQuery).toHaveBeenCalledWith({
      requiredPermission: PermissionBits.EDIT,
    });
  });

  test('shows the create CTA only when creation is allowed', () => {
    const onCreate = jest.fn();
    const { rerender } = render(
      <MyAgentsView canCreate={false} onCreate={onCreate} onEdit={jest.fn()} />,
    );
    expect(screen.queryByRole('button', { name: 'Create Assistant' })).not.toBeInTheDocument();

    rerender(<MyAgentsView canCreate onCreate={onCreate} onEdit={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create Assistant' }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  test('opens an editable assistant from the owned list', () => {
    const onEdit = jest.fn();
    mockUseListAgentsQuery.mockReturnValue({
      data: { data: [agent] },
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });

    render(<MyAgentsView canCreate onCreate={jest.fn()} onEdit={onEdit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Owned Assistant' }));
    expect(onEdit).toHaveBeenCalledWith(agent);
  });
});
