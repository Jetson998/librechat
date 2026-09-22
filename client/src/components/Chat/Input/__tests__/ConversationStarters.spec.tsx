import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import ConversationStarters from '../ConversationStarters';

let mockConversation: Record<string, unknown> | null = null;
let mockAgentsMap: Record<string, any> | undefined;
let mockAssistantMap: Record<string, any> | undefined;
let mockModelSpec: { conversation_starters?: string[] } | undefined;
const mockSubmitMessage = jest.fn();

jest.mock('librechat-data-provider', () => ({
  Constants: { MAX_CONVO_STARTERS: 4 },
  EModelEndpoint: {
    azureOpenAI: 'azureOpenAI',
    openAI: 'openAI',
  },
}));

jest.mock('~/Providers', () => ({
  useChatContext: () => ({ conversation: mockConversation }),
  useAgentsMapContext: () => mockAgentsMap,
  useAssistantsMapContext: () => mockAssistantMap,
}));

jest.mock('~/data-provider', () => ({
  useGetAssistantDocsQuery: () => ({ data: new Map() }),
  useGetEndpointsQuery: () => ({ data: {} }),
  useGetStartupConfig: () => ({ data: {} }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => {
    const translations: Record<string, string> = {
      com_agents_conversation_starters_heading: '可以这样开始',
    };
    return translations[key] || key;
  },
  useSubmitMessage: () => ({ submitMessage: mockSubmitMessage }),
}));

jest.mock('~/utils', () => ({
  getIconEndpoint: ({ endpoint }: { endpoint: string }) => endpoint,
  getModelSpec: () => mockModelSpec,
  getEntity: ({
    endpoint,
    agentsMap,
    assistantMap,
    agent_id,
    assistant_id,
  }: {
    endpoint: string;
    agentsMap?: Record<string, any>;
    assistantMap?: Record<string, any>;
    agent_id?: string;
    assistant_id?: string;
  }) => {
    if (endpoint === 'agents' && agent_id != null) {
      return { entity: agentsMap?.[agent_id], isAgent: true };
    }
    if (assistant_id != null) {
      return { entity: assistantMap?.[assistant_id], isAgent: false };
    }
    return { entity: undefined, isAgent: false };
  },
}));

describe('ConversationStarters', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConversation = null;
    mockAgentsMap = undefined;
    mockAssistantMap = undefined;
    mockModelSpec = undefined;
  });

  it('shows preset guidance when the Agent projection omits configured starters', () => {
    mockConversation = {
      endpoint: 'agents',
      agent_id: 'agent_workflow_excel-audit-reconciliation',
    };
    mockAgentsMap = {
      'agent_workflow_excel-audit-reconciliation': {
        id: 'agent_workflow_excel-audit-reconciliation',
        name: 'Excel 数据审计与对账',
      },
    };

    render(<ConversationStarters />);

    expect(screen.getByRole('group', { name: '可以这样开始' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '审计这个 Excel，检查重复、缺失、公式和异常值' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: '保留原数据，生成一份可追溯的审计工作簿' }));
    expect(mockSubmitMessage).toHaveBeenCalledWith({
      text: '保留原数据，生成一份可追溯的审计工作簿',
    });
  });

  it('keeps an Agent own configured starters ahead of the preset fallback', () => {
    mockConversation = {
      endpoint: 'agents',
      agent_id: 'agent_workflow_excel-audit-reconciliation',
    };
    mockAgentsMap = {
      'agent_workflow_excel-audit-reconciliation': {
        id: 'agent_workflow_excel-audit-reconciliation',
        conversation_starters: ['使用 Agent 当前配置的引导语'],
      },
    };

    render(<ConversationStarters />);

    expect(screen.getByRole('button', { name: '使用 Agent 当前配置的引导语' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '审计这个 Excel，检查重复、缺失、公式和异常值' }),
    ).not.toBeInTheDocument();
  });

  it('does not invent guidance for a non-preset Agent', () => {
    mockConversation = { endpoint: 'agents', agent_id: 'personal-agent' };
    mockAgentsMap = { 'personal-agent': { id: 'personal-agent' } };

    const { container } = render(<ConversationStarters />);

    expect(container).toBeEmptyDOMElement();
  });

  it('preserves model-spec starters outside the Agent endpoint', () => {
    mockConversation = { endpoint: 'openAI', spec: 'guided-model' };
    mockModelSpec = { conversation_starters: ['Explain this document'] };

    render(<ConversationStarters />);

    expect(screen.getByRole('button', { name: 'Explain this document' })).toBeInTheDocument();
    expect(screen.queryByText('可以这样开始')).not.toBeInTheDocument();
  });
});
