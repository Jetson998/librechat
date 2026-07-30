import en from './en/translation.json';
import zhHans from './zh-Hans/translation.json';

const workspaceKeys = [
  'com_agents_workspace',
  'com_agents_workspace_recommended',
  'com_agents_workspace_mine',
  'com_agents_workspace_create',
  'com_agents_workspace_back',
  'com_agents_workspace_navigation',
  'com_agents_workspace_market_empty',
  'com_agents_workspace_market_empty_description',
  'com_agents_workspace_mine_empty',
  'com_agents_workspace_mine_empty_description',
  'com_agents_platform_capabilities',
  'com_agents_advanced_integrations',
  'com_agents_advanced_publishing',
  'com_agents_category_agent',
  'com_agents_top_picks',
  'com_agents_recommended',
  'com_agents_conversation_starters_heading',
  'com_nav_tool_dialog_agents',
  'com_nav_tool_dialog_agents_description',
  'com_ui_delete_tool_save_reminder',
] as const;

describe('Agent workspace locale contract', () => {
  test.each(workspaceKeys)('defines %s in English and Simplified Chinese', (key) => {
    expect(en[key]).toEqual(expect.any(String));
    expect(en[key].trim()).not.toBe('');
    expect(zhHans[key]).toEqual(expect.any(String));
    expect(zhHans[key].trim()).not.toBe('');
  });

  test('uses Agent terminology throughout the Agent workspace', () => {
    const agentWorkspaceValues = workspaceKeys.map((key) => zhHans[key]);
    expect(agentWorkspaceValues.some((value) => value.includes('助手'))).toBe(false);
    expect(agentWorkspaceValues.some((value) => value.includes('智能助手'))).toBe(false);
    expect(agentWorkspaceValues.some((value) => value.includes('智能体'))).toBe(false);
    expect(agentWorkspaceValues.some((value) => value.includes('自动化工作流'))).toBe(false);
  });

  test('does not retain legacy Chinese terms in Agent-specific locale keys', () => {
    const legacyEntries = Object.entries(zhHans).filter(
      ([key, value]) =>
        key.toLowerCase().includes('agent') &&
        typeof value === 'string' &&
        /(助手|智能体|自动化工作流)/.test(value),
    );

    expect(legacyEntries).toEqual([]);
  });
});
