import { useEffect } from 'react';
import { useRecoilValue } from 'recoil';
import { AgentPanelProvider, useAgentPanelContext } from '~/Providers/AgentPanelContext';
import { Panel, isEphemeralAgent } from '~/common';
import VersionPanel from './Version/VersionPanel';
import AgentPanel from './AgentPanel';
import store from '~/store';

interface AgentPanelSwitchProps {
  workspaceMode?: boolean;
  workspaceAgentId?: string;
  onAgentIdChange?: (agentId?: string) => void;
}

export default function AgentPanelSwitch(props: AgentPanelSwitchProps = {}) {
  return (
    <AgentPanelProvider>
      <AgentPanelSwitchWithContext {...props} />
    </AgentPanelProvider>
  );
}

function AgentPanelSwitchWithContext({
  workspaceMode = false,
  workspaceAgentId,
  onAgentIdChange,
}: AgentPanelSwitchProps) {
  const { activePanel, setActivePanel, setCurrentAgentId } = useAgentPanelContext();
  const agentId = useRecoilValue(store.conversationAgentIdByIndex(0));

  useEffect(() => {
    if (workspaceMode) {
      setCurrentAgentId(
        workspaceAgentId && !isEphemeralAgent(workspaceAgentId) ? workspaceAgentId : undefined,
      );
      setActivePanel(Panel.builder);
      return;
    }

    const agent_id = agentId ?? '';
    if (!isEphemeralAgent(agent_id)) {
      setCurrentAgentId(agent_id);
    }
  }, [agentId, setActivePanel, setCurrentAgentId, workspaceAgentId, workspaceMode]);

  if (activePanel === Panel.version) {
    return <VersionPanel />;
  }
  return <AgentPanel workspaceMode={workspaceMode} onAgentIdChange={onAgentIdChange} />;
}
