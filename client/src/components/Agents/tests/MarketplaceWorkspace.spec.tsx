import React from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import Marketplace from '../Marketplace';

let mockCanCreate = true;

jest.mock('@librechat/client', () => ({
  useMediaQuery: () => false,
}));

jest.mock('~/hooks', () => ({
  useDocumentTitle: jest.fn(),
  useHasAccess: ({ permission }: { permission: string }) =>
    permission === 'CREATE' ? mockCanCreate : true,
  useLocalize: () => (key: string) => {
    const translations: Record<string, string> = {
      com_agents_workspace: 'AI Assistants',
      com_agents_workspace_recommended: 'Recommended',
      com_agents_workspace_mine: 'My Assistants',
      com_agents_workspace_create: 'Create Assistant',
      com_agents_workspace_back: 'Back to assistants',
      com_agents_workspace_navigation: 'Assistant workspace',
      com_agents_top_picks: 'Top Picks',
      com_agents_recommended: 'Recommended assistants',
      com_agents_all: 'All Assistants',
      com_agents_all_description: 'All shared assistants',
    };
    return translations[key] ?? key;
  },
}));

jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: () => ({
    data: { agents: { disableBuilder: false } },
    isLoading: false,
    isSuccess: true,
  }),
  useGetAgentCategoriesQuery: () => ({
    data: [
      { value: 'promoted', label: 'Top Picks' },
      { value: 'all', label: 'All' },
    ],
    isLoading: false,
  }),
}));

jest.mock('~/components/Chat/Menus/OpenSidebar', () => ({
  __esModule: true,
  default: () => <button type="button">Open sidebar</button>,
}));

jest.mock('~/components/SidePanel', () => ({
  SidePanelGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock('~/components/SidePanel/Agents/AgentPanelSwitch', () => ({
  __esModule: true,
  default: ({ onAgentIdChange }: { onAgentIdChange?: (agentId?: string) => void }) => (
    <div data-testid="workspace-builder">
      <button type="button" onClick={() => onAgentIdChange?.('agent_new')}>
        Persist assistant
      </button>
    </div>
  ),
}));

jest.mock('../MarketplaceAdminSettings', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('../SearchBar', () => ({
  __esModule: true,
  default: () => <div data-testid="search-bar" />,
}));

jest.mock('../CategoryTabs', () => ({
  __esModule: true,
  default: ({ activeTab }: { activeTab: string }) => (
    <div data-testid="category-tabs">{activeTab}</div>
  ),
}));

jest.mock('../AgentGrid', () => ({
  __esModule: true,
  default: () => <div data-testid="agent-grid" />,
}));

jest.mock('../MyAgentsView', () => ({
  __esModule: true,
  default: ({ onEdit }: { onEdit: (agent: { id: string }) => void }) => (
    <div data-testid="my-agents-view">
      <button type="button" onClick={() => onEdit({ id: 'agent_owned' })}>
        Edit owned
      </button>
    </div>
  ),
}));

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderMarketplace(initialEntry = '/agents') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route
          path="/agents"
          element={
            <>
              <Marketplace />
              <LocationProbe />
            </>
          }
        />
        <Route
          path="/agents/:category"
          element={
            <>
              <Marketplace />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Agent workspace navigation', () => {
  beforeEach(() => {
    mockCanCreate = true;
  });

  test('opens Recommended by default and preserves category deep links', () => {
    renderMarketplace('/agents/finance');
    expect(screen.getByRole('tab', { name: 'Recommended' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId('category-tabs')).toHaveTextContent('finance');
    expect(screen.getByTestId('location')).toHaveTextContent('/agents/finance');
  });

  test('switches between My Assistants and Create Assistant through URL state', () => {
    renderMarketplace();

    fireEvent.click(screen.getByRole('tab', { name: 'My Assistants' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/agents?view=mine');
    expect(screen.getByTestId('my-agents-view')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Create Assistant' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/agents?view=create');
    expect(screen.getByTestId('workspace-builder')).toBeInTheDocument();
  });

  test('supports keyboard navigation and links the active tab to its panel', () => {
    renderMarketplace();

    const recommendedTab = screen.getByRole('tab', { name: 'Recommended' });
    expect(recommendedTab).toHaveAttribute('tabindex', '0');
    expect(recommendedTab).toHaveAttribute('aria-controls', 'agent-workspace-panel-recommended');
    expect(screen.getByRole('tabpanel')).toHaveAttribute(
      'aria-labelledby',
      'agent-workspace-tab-recommended',
    );

    fireEvent.keyDown(recommendedTab, { key: 'ArrowRight' });

    const mineTab = screen.getByRole('tab', { name: 'My Assistants' });
    expect(mineTab).toHaveFocus();
    expect(mineTab).toHaveAttribute('tabindex', '0');
    expect(screen.getByTestId('location')).toHaveTextContent('/agents?view=mine');
  });

  test('synchronizes created and selected assistant IDs with the edit URL', () => {
    renderMarketplace('/agents?view=create');
    fireEvent.click(screen.getByRole('button', { name: 'Persist assistant' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/agents?view=mine&agent=agent_new');

    fireEvent.click(screen.getByRole('button', { name: 'Back to assistants' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit owned' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/agents?view=mine&agent=agent_owned');
  });

  test('redirects a forbidden create URL without rendering the builder', async () => {
    mockCanCreate = false;
    renderMarketplace('/agents?view=create');

    expect(screen.queryByRole('tab', { name: 'Create Assistant' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('workspace-builder')).not.toBeInTheDocument();
    expect(screen.getByTestId('my-agents-view')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/agents?view=mine');
    });
  });
});
