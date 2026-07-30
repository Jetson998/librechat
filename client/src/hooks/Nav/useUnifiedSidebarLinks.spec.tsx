import { renderHook } from '@testing-library/react';
import { EModelEndpoint } from 'librechat-data-provider';
import useUnifiedSidebarLinks from './useUnifiedSidebarLinks';

const mockNavigate = jest.fn();
let mockMarketplaceAccess = true;

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock('@librechat/client', () => ({
  useMediaQuery: () => false,
}));

jest.mock('~/components/Chat/Menus/OpenSidebar', () => ({
  CLOSE_SIDEBAR_ID: 'close-sidebar-button',
}));

jest.mock('recoil', () => ({
  useRecoilValue: () => ({ endpoint: 'openAI' }),
}));

jest.mock('librechat-data-provider/react-query', () => ({
  useUserKeyQuery: () => ({ data: { expiresAt: undefined } }),
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { interface: {} } }),
  useGetEndpointsQuery: () => ({
    data: {
      agents: {},
      openAI: {},
    },
  }),
}));

jest.mock('~/hooks/Nav/useSideNavLinks', () => ({
  __esModule: true,
  default: () => [
    {
      title: 'legacy builder',
      label: '',
      icon: () => null,
      id: 'agents',
      Component: () => null,
    },
    {
      title: 'files',
      label: '',
      icon: () => null,
      id: 'files',
      Component: () => null,
    },
  ],
}));

jest.mock('~/hooks', () => ({
  useHasAccess: ({ permissionType }: { permissionType: string }) =>
    permissionType === 'MARKETPLACE' ? mockMarketplaceAccess : true,
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: { conversationByIndex: () => ({}) },
}));

jest.mock('~/components/UnifiedSidebar/ConversationsSection', () => ({
  __esModule: true,
  default: () => null,
}));

describe('useUnifiedSidebarLinks', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    mockMarketplaceAccess = true;
  });

  test('replaces the legacy builder panel with one assistant workspace command', () => {
    const { result } = renderHook(() => useUnifiedSidebarLinks());
    const ids = result.current.map((link) => link.id);

    expect(ids).toEqual(['conversations', 'agents-workspace', 'files']);
    expect(ids).not.toContain(EModelEndpoint.agents);

    result.current.find((link) => link.id === 'agents-workspace')?.onClick?.();
    expect(mockNavigate).toHaveBeenCalledWith('/agents');
  });

  test('does not expose the workspace without marketplace access', () => {
    mockMarketplaceAccess = false;
    const { result } = renderHook(() => useUnifiedSidebarLinks());
    expect(result.current.map((link) => link.id)).toEqual(['conversations', 'files']);
  });
});
