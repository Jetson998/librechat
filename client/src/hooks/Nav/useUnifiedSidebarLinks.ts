import { useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import { useNavigate } from 'react-router-dom';
import { useMediaQuery } from '@librechat/client';
import { Bot, MessagesSquare } from 'lucide-react';
import { useUserKeyQuery } from 'librechat-data-provider/react-query';
import {
  Permissions,
  EModelEndpoint,
  PermissionTypes,
  getConfigDefaults,
  getEndpointField,
} from 'librechat-data-provider';
import type { TEndpointsConfig } from 'librechat-data-provider';
import type { NavLink } from '~/common';
import ConversationsSection from '~/components/UnifiedSidebar/ConversationsSection';
import { CLOSE_SIDEBAR_ID } from '~/components/Chat/Menus/OpenSidebar';
import { useGetEndpointsQuery, useGetStartupConfig } from '~/data-provider';
import useSideNavLinks from '~/hooks/Nav/useSideNavLinks';
import { useHasAccess } from '~/hooks';
import store from '~/store';

const defaultInterface = getConfigDefaults().interface;

export default function useUnifiedSidebarLinks() {
  const navigate = useNavigate();
  const isSmallScreen = useMediaQuery('(max-width: 768px)');
  const conversation = useRecoilValue(store.conversationByIndex(0));
  const endpoint = conversation?.endpoint;
  const { data: startupConfig } = useGetStartupConfig();
  const { data: endpointsConfig = {} as TEndpointsConfig } = useGetEndpointsQuery();

  const interfaceConfig = useMemo(
    () => startupConfig?.interface ?? defaultInterface,
    [startupConfig],
  );

  const endpointType = useMemo(
    () => getEndpointField(endpointsConfig, endpoint, 'type'),
    [endpoint, endpointsConfig],
  );

  const userProvidesKey = useMemo(
    () => !!(endpointsConfig?.[endpoint ?? '']?.userProvide ?? false),
    [endpointsConfig, endpoint],
  );

  const { data: keyExpiry = { expiresAt: undefined } } = useUserKeyQuery(endpoint ?? '');

  const keyProvided = useMemo(
    () => (userProvidesKey ? !!(keyExpiry.expiresAt ?? '') : true),
    [keyExpiry.expiresAt, userProvidesKey],
  );

  const sideNavLinks = useSideNavLinks({
    keyProvided,
    endpoint,
    endpointType,
    interfaceConfig,
    endpointsConfig,
    includeHidePanel: false,
  });

  const hasAccessToAgents = useHasAccess({
    permissionType: PermissionTypes.AGENTS,
    permission: Permissions.USE,
  });
  const hasAccessToMarketplace = useHasAccess({
    permissionType: PermissionTypes.MARKETPLACE,
    permission: Permissions.USE,
  });

  const links = useMemo(() => {
    const conversationLink: NavLink = {
      title: 'com_ui_chat_history',
      label: '',
      icon: MessagesSquare,
      id: 'conversations',
      Component: ConversationsSection,
    };

    const filteredLinks = sideNavLinks.filter((link) => link.id !== EModelEndpoint.agents);
    const workspaceLink: NavLink | null =
      endpointsConfig?.[EModelEndpoint.agents] && hasAccessToAgents && hasAccessToMarketplace
        ? {
            title: 'com_agents_workspace',
            label: '',
            icon: Bot,
            id: 'agents-workspace',
            onClick: () => {
              navigate('/agents');
              if (isSmallScreen) {
                document.getElementById(CLOSE_SIDEBAR_ID)?.click();
              }
            },
          }
        : null;

    return [conversationLink, ...(workspaceLink ? [workspaceLink] : []), ...filteredLinks];
  }, [
    endpointsConfig,
    hasAccessToAgents,
    hasAccessToMarketplace,
    isSmallScreen,
    navigate,
    sideNavLinks,
  ]);

  return links;
}
