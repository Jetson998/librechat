import { useMemo, useCallback } from 'react';
import { EModelEndpoint, Constants } from 'librechat-data-provider';
import {
  useGetAssistantDocsQuery,
  useGetEndpointsQuery,
  useGetStartupConfig,
} from '~/data-provider';
import { useChatContext, useAgentsMapContext, useAssistantsMapContext } from '~/Providers';
import { getIconEndpoint, getEntity, getModelSpec } from '~/utils';
import { useLocalize, useSubmitMessage } from '~/hooks';

// Keep these Client-only fallbacks aligned with workflow-templates/preset-agents/compiled-agents.json.
const PRESET_AGENT_CONVERSATION_STARTERS: Record<string, string[]> = {
  'agent_workflow_excel-audit-reconciliation': [
    '审计这个 Excel，检查重复、缺失、公式和异常值',
    '按订单号和金额对账这两份表，并生成差异明细',
    '保留原数据，生成一份可追溯的审计工作簿',
  ],
  'agent_workflow_feedback-root-cause-analysis': [
    '分析这份客户反馈表，找出高频问题和根因假设',
    '把工单按主题、影响和优先级分类',
    '生成一份客户问题整改清单 Excel',
  ],
  'agent_workflow_journal-entry-audit': [
    '审计这份总账和分录表，生成异常分录工作底稿',
    '检查期末手工分录、大额整数和罕见科目组合',
    '按我提供的审计规则生成可追溯的 Excel 结果',
  ],
  'agent_workflow_knowledge-base-curator': [
    '整理这些制度和培训材料，生成知识库目录与标准条目',
    '找出上传文档中的重复、冲突和过期内容',
    '把资料整理成可导入知识库的 Excel',
  ],
  'agent_workflow_kyc-periodic-review': [
    '根据上传的客户资料整理一份 KYC 定期审查清单',
    '核对客户档案完整性，并列出需要人工复核的风险信号',
    '汇总获准公开来源中的负面信息并保留证据链接',
  ],
  'agent_workflow_meeting-to-action': [
    '把这份会议纪要整理成行动计划，并标出负责人和截止时间',
    '从上传的会议转写中提取决策、风险和待确认事项',
    '生成一份可下载的会议执行台账 Excel',
  ],
  'agent_workflow_policy-change-impact': [
    '比较这两版制度，输出条款级差异和影响分析',
    '找出新制度对现有流程、系统和岗位的影响',
    '生成一份整改行动清单 Excel',
  ],
};

const ConversationStarters = () => {
  const localize = useLocalize();
  const { conversation } = useChatContext();
  const agentsMap = useAgentsMapContext();
  const assistantMap = useAssistantsMapContext();
  const { data: endpointsConfig } = useGetEndpointsQuery();
  const { data: startupConfig } = useGetStartupConfig();

  const endpointType = useMemo(() => {
    let ep = conversation?.endpoint ?? '';
    if (ep === EModelEndpoint.azureOpenAI) {
      ep = EModelEndpoint.openAI;
    }
    return getIconEndpoint({
      endpointsConfig,
      iconURL: conversation?.iconURL,
      endpoint: ep,
    });
  }, [conversation?.endpoint, conversation?.iconURL, endpointsConfig]);

  const { data: documentsMap = new Map() } = useGetAssistantDocsQuery(endpointType, {
    select: (data) => new Map(data.map((dbA) => [dbA.assistant_id, dbA])),
  });

  const { entity, isAgent } = getEntity({
    endpoint: endpointType,
    agentsMap,
    assistantMap,
    agent_id: conversation?.agent_id,
    assistant_id: conversation?.assistant_id,
  });

  const modelSpec = useMemo(
    () => getModelSpec({ specName: conversation?.spec, startupConfig }),
    [conversation?.spec, startupConfig],
  );

  const conversation_starters = useMemo(() => {
    if (entity?.conversation_starters?.length) {
      return entity.conversation_starters;
    }

    if (isAgent) {
      return PRESET_AGENT_CONVERSATION_STARTERS[entity?.id ?? ''] ?? [];
    }

    if (modelSpec?.conversation_starters?.length) {
      return modelSpec.conversation_starters;
    }

    return documentsMap.get(entity?.id ?? '')?.conversation_starters ?? [];
  }, [documentsMap, isAgent, entity, modelSpec]);

  const { submitMessage } = useSubmitMessage();
  const sendConversationStarter = useCallback(
    (text: string) => submitMessage({ text }),
    [submitMessage],
  );

  if (!conversation_starters.length) {
    return null;
  }

  return (
    <div
      className="mb-8 mt-2 flex w-full flex-col items-center gap-2 px-4"
      role={isAgent ? 'group' : undefined}
      aria-label={isAgent ? localize('com_agents_conversation_starters_heading') : undefined}
    >
      {isAgent && (
        <p className="mb-1 text-sm font-medium text-text-secondary">
          {localize('com_agents_conversation_starters_heading')}
        </p>
      )}
      <div className="flex w-full flex-wrap items-stretch justify-center gap-2">
        {conversation_starters
          .slice(0, Constants.MAX_CONVO_STARTERS)
          .map((text: string, index: number) => (
            <button
              key={index}
              type="button"
              onClick={() => sendConversationStarter(text)}
              style={{ animationDelay: `${index * 75}ms`, animationFillMode: 'backwards' }}
              className="flex max-w-[16rem] cursor-pointer items-center justify-center rounded-2xl border border-border-medium bg-surface-secondary px-4 py-2.5 text-center text-sm text-text-secondary shadow-sm transition-colors duration-200 fade-in hover:border-border-heavy hover:bg-surface-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary"
            >
              <span className="line-clamp-2 text-balance break-words">{text}</span>
            </button>
          ))}
      </div>
    </div>
  );
};

export default ConversationStarters;
