# LibreChat Agent 平台 P0 UI 实施计划

Date: 2026-07-28

Status: 设计门禁已确认；源码候选、本地验证和修正版远程 CI artifact 验签已完成；
未部署生产

Parent gate:
`docs/AGENT_PLATFORM_COMPLETION_AND_MARKET_ENABLEMENT_PLAN.md`

## 一、结论

首个开发批次只完成 Agent 产品壳和普通用户易用性，不同时实现 Workflow
Manifest、Runtime 生产接入、业务规则包或 7 个市场模板。

本批目标是把当前分散的“智能体市场”和“智能体构建器”整理为一个可发现、可理解、
可创建、可返回的 `Agent` 工作区，并建立可重复的 LibreChat Client 源码构建链。

本批完成后可以继续使用个人 Agent，但仍不能宣称“自动化工作流市场正式开通”。市场
正式开通仍需后续 Manifest、Runtime、真实 P0 模板和业务验收全部完成。

## 二、本批不可变决策

1. 侧栏入口和工作区产品名统一使用 `Agent`，内部 API、类型、权限和数据库继续使用
   `agent`；“推荐助手 / 我的助手 / 创建助手”等动作标签本批保持不变。
2. Agent UI 必须修改固定版本的 LibreChat React 源码，不新增大型 DOM 注入补丁。
3. 生产基线固定为 LibreChat `0.8.7`、上游提交
   `8fcb77fe6fcc91bd82f290b6db604c4c8bdb01c9`。
4. Runtime Connector 的上游覆盖继续独立固定在
   `60eba76375213dafc1874d943e41371201c300ab`，本批不得混用或升级该覆盖。
5. 本批只改 Client，不改 Agent API、MongoDB schema、CodeAPI、Office Converter、
   Runtime 或角色权限。
6. 现有市场搜索、分类、详情、深链接和权限检查必须保留。
7. 现有上传菜单、上下文安全、登录页、用量与模型市场、搜索图标 fallback、生成文件
   下载页等定制能力必须进入构建保护清单，不得因重建 Client 丢失。
8. 普通 `USER` 和 `ADMIN` 使用同一产品流程，差异只来自现有权限和管理员控制。
9. 不发布 Prompt 占位 Agent，不把 7 个未来模板做成空卡片。
10. 本计划提交后等待确认，确认前不写功能代码、不创建生产发布、不修改生产。

## 三、首批范围

### 3.1 纳入范围

- 一个统一的 `Agent` 入口；
- “推荐助手 / 我的助手 / 创建助手”三条明确路径；
- 市场空状态、搜索空状态和无权限状态的可操作反馈；
- 构建器基础设置和高级设置的清晰分区；
- Agent 相关普通用户界面的简体中文术语收敛；
- USER 和 ADMIN 的创建、编辑、删除、共享可见性回归；
- 固定上游源码、可验证 patch、Client 测试、构建和 artifact 产出；
- 当前生产 Client 定制资产的确定性合成和 hash/marker 保护；
- 后续生产发布所需的精确回滚和浏览器验收定义。

### 3.2 明确不纳入

- Workflow Template Manifest schema、存储和 compiler；
- Runtime Task Manifest 扩展或 Runtime 生产启动；
- draft Agent、创建前文件 staging、临时文件回收；
- 创建前测试、预览运行、样例输入和 capability preflight；
- 人工确认、任务状态、断点恢复和工作流运行页；
- Agent 安装、模板升级、版本迁移和市场审核；
- 7 个自动化工作流模板及其 Prompt、规则包和测试数据；
- Word、PPT、PDF Worker 的新增能力；
- 多 Agent 编排功能扩展；
- 角色权限、计费、用量、文件隔离和下载卡协议变更；
- 生产部署。

上述内容必须作为独立批次进入设计、测试和发布门禁，不能顺手带入本批。

## 四、目标用户流程

### 4.1 统一入口

统一侧栏只保留一个面向用户的 `Agent` 入口。点击后进入 `/agents`，不再要求用户
先理解“市场入口在对话历史内、构建器入口在另一枚图标中”的现状。

现有其他入口可以保留为兼容入口：

- 对话模型选择器中的市场入口；
- 收藏区域中的市场入口；
- 已分享 Agent 的深链接；
- `/agents/:category` 分类深链接。

这些入口最终都进入同一个 Agent 工作区。

#### 4.1.1 侧栏选中与收起契约

`Agent` 虽然打开主区域路由，但必须遵守统一侧栏与其他菜单相同的交互状态机：

- `/agents`、`/agents/:category` 以及带查询参数的工作区 URL 必须让 `Agent` 显示灰底选中态；
- 从其他页面第一次点击时，先把菜单设为当前项，再进入 `/agents`；
- 菜单已选中且侧栏已展开时，再次点击只收起侧栏，不重复导航；
- 带 `onClick` 的路由菜单不得绕过公共 `setActive`、展开和收起逻辑；
- 离开 Agent 路由后，不得继续使用失效的 Agent 路由选中态遮盖正常菜单。

### 4.2 工作区导航

主区域顶部使用三项明确操作：

```text
推荐助手 | 我的助手 | 创建助手
```

- `推荐助手`：默认视图，继续使用现有市场的 promoted、all、分类和搜索能力；
- `我的助手`：使用现有 `useListAgentsQuery`，只显示当前用户有编辑权限的 Agent；
- `创建助手`：打开空白构建器，不先创建数据库记录；
- 选择“我的助手”中的条目：打开同一构建器编辑该 Agent；
- 关闭或返回构建器：回到进入前的推荐/我的视图和滚动位置。

URL 状态必须可恢复：

```text
/agents                         推荐助手默认页
/agents/:category               推荐助手分类页，保持现有兼容
/agents?view=mine               我的助手
/agents?view=create             创建助手
/agents?view=mine&agent=<id>    编辑有权限的助手
```

`agent` 参数只作为导航提示，加载时仍通过现有资源权限接口校验。无权限、已删除或无效
ID 不得显示扩展配置，并返回可操作的错误状态。

### 4.3 空状态

市场完全为空时显示：

```text
暂无可用的推荐助手
当前还没有已发布的助手，你仍可创建自己的助手。
[创建助手]
```

规则：

- 有 `AGENTS.CREATE` 权限时显示“创建助手”；
- 无创建权限时不显示不可执行按钮；
- 搜索无结果时显示“清除搜索”，不把搜索无结果误报为市场为空；
- 某分类为空时保留分类名称并提供“查看全部”；
- API 失败继续使用现有错误与重试组件，不伪装为空状态；
- 不展示 7 个尚未实现的模板卡片。

### 4.4 移动端

- 三项导航使用可滚动或自适应的分段控件，不产生横向页面溢出；
- 创建和返回操作保持在可见区域；
- 构建器继续使用现有侧栏/抽屉交互，不在主区域叠加第二张浮动卡；
- Agent 卡片、空状态文字和操作按钮在 390px 宽度内完整显示；
- 保留市场分类横向滚动和键盘/屏幕阅读器语义。

## 五、构建器信息架构

### 5.1 基础设置

普通用户首次打开只看到完成一个可用 Agent 所必需的内容：

1. 名称、描述和头像；
2. 模型；
3. 指令；
4. 当前环境实际提供的推荐能力；
5. 已保存 Agent 的文件上下文；
6. 保存或创建操作。

能力必须按运行配置显示，不能硬编码平台并未提供的开关：

- 联网检索仅在 `web_search` capability 可用时出现；
- 代码与文件处理仅在 `execute_code` capability 可用时出现；
- 文件搜索仅在 `file_search` capability 可用时出现；
- 个人 Skills 仅在 Agent Skills capability 和用户权限同时满足时出现；
- Office 能力没有独立 capability 时，不新增一个会误导用户的 Office 开关。

创建中的临时 Agent 仍不能上传长期文件。本批只把状态说明改为明确的“保存助手后可
添加长期参考文件”，不实现 staging，也不自动提前保存。

### 5.2 高级设置

以下内容从基础表单移入高级设置：

- 类别；
- 支持联系人；
- 最大 Agent 步骤数；
- stateful code session；
- MCP、Actions 和完整工具库；
- 子 Agent、handoff、chain 和其他编排设置；
- Agent ID 等技术信息。

高级设置不得改变未编辑字段。用户从基础模式保存时，现有高级字段必须保持原值；
新 Agent 使用 LibreChat 的稳定默认值。

### 5.3 Skills 与工具术语

普通用户界面统一为：

```text
能力
  平台能力
  我的 Skills
  高级集成
```

- `Native` 显示为“平台能力”；
- `Tools` 在本页面显示为“能力”；
- `Agent skills` 与主表单 Skills 不再重复显示为两个不同开关；
- MCP 和 Actions 放入“高级集成”；
- Admin Panel 的 `AGENT`、`SKILLS` 权限资源名本批不做全局改名。

个人 Skills 的 ACL、所有者隔离和平台 Skill 注册表均保持现有实现，不因术语调整改变。

## 六、源码所有权与仓库结构

本仓库当前没有完整 LibreChat 主站源码。本批采用“固定上游源码 + 仓库拥有 patch +
CI 构建”的方式，不把临时下载目录或生产 dist 当作开发源。

实施时新增：

```text
integrations/librechat-upstream/
  8fcb77fe6fcc91bd82f290b6db604c4c8bdb01c9/
    agent-platform-p0-ui.patch
    agent-platform-p0-ui.sources.json
    AGENT_PLATFORM_P0_UI.md

scripts/
  verify-agent-platform-p0-ui-overlay.sh
  compose-agent-platform-client.sh

.github/workflows/
  librechat-agent-platform-client-ci.yml
```

`agent-platform-p0-ui.sources.json` 至少记录：

- 上游仓库 URL；
- 固定 commit；
- 每个被修改源文件的上游 blob SHA；
- patch SHA-256；
- lockfile SHA-256；
- 构建命令；
- Node/npm 版本；
- 预期输出目录。

验证脚本必须在干净的固定上游源码上：

1. 验证 commit 和所有源 blob；
2. 在临时目录应用 patch；
3. 拒绝 fuzz、`.rej`、额外未声明文件或上下文漂移；
4. 执行 `git diff --check`；
5. 输出实际变更文件清单；
6. 确认 Runtime Connector 的 `60eba...` 覆盖未被修改。

如果生产 pin 的文件结构与当前研究快照不同，实施必须停在 source-onboarding gate，
重新评估文件映射；不得静默改用 `60eba...` 或另一个上游 HEAD。

## 七、预计源码变更面

最终文件清单以固定上游 blob 验证为准，预计只涉及：

```text
client/src/hooks/Nav/useSideNavLinks.ts
client/src/hooks/Nav/useUnifiedSidebarLinks.ts
client/src/routes/index.tsx
client/src/components/Agents/Marketplace.tsx
client/src/components/Agents/AgentGrid.tsx
client/src/components/Agents/CategoryTabs.tsx
client/src/components/Agents/AgentWorkspaceHeader.tsx        new
client/src/components/Agents/MyAgentsView.tsx                new
client/src/components/SidePanel/Agents/AgentPanelSwitch.tsx
client/src/components/SidePanel/Agents/AgentPanel.tsx
client/src/components/SidePanel/Agents/AgentConfig.tsx
client/src/components/SidePanel/Agents/FileContext.tsx
client/src/components/SidePanel/Agents/AgentFooter.tsx
client/src/components/SidePanel/Agents/Advanced/*
client/src/components/SidePanel/Agents/Tools/*
client/src/locales/en/translation.json
client/src/locales/zh-Hans/translation.json
```

约束：

- 优先复用现有 `MarketplaceContext`、`useListAgentsQuery`、`AgentPanel` 和权限 hooks；
- 不新增第二套 Agent API 或客户端全局状态库；
- 不复制 Marketplace 查询逻辑；
- 不改变 Agent create/update payload；
- 不修改文件、Skill、计费和会话数据结构；
- 不做无关样式重构。

## 八、现有 Client 定制保护

完整 Client 重建前先建立 `client-overlay-manifest.json`，记录当前需要保留的仓库资产、
输出文件、插入顺序、SHA-256 和运行 marker。至少覆盖：

- `business-upload-menu.js` 和三类上传入口；
- `odysseia-login.js`；
- `search-favicon-fallback.js`；
- `context-safety-ui.js` / `context-safety-ui.css`；
- 用户用量与模型市场资产；
- `generated-files-tab.js` / `generated-files-tab.css`；
- 当前 stale-asset recovery marker；
- 当前 `index.html` 中对应脚本和样式的唯一引用。

候选 Client 只能由构建脚本按 manifest 合成，不得从运行中的生产目录复制后再手工追加。

合成门禁必须验证：

- 每个资产 SHA 与仓库记录一致；
- 每个 marker 恰好出现一次；
- 同名旧版本资产不残留；
- 上传菜单仍只有“图片上传 / Office文件上传 / 文件提取文字上传”；
- 生成文件页仍使用认证请求和认证下载；
- 模型市场、用量页、登录页、上下文安全和搜索 fallback 的契约测试通过；
- Agent 源码构建不依赖这些运行时脚本来实现新 Agent UI。

若任一现有定制无法被确定性重放，本批停止，不用生产 dist 手工补洞。

## 九、测试计划

### 9.1 新增或扩展单元测试

至少覆盖：

1. 只有满足现有 Agent/Marketplace 权限时才显示 `Agent` 入口；
2. `/agents` 默认进入“推荐助手”；
3. 推荐、我的、创建三项切换可写入和恢复 URL；
4. `/agents/:category` 深链接继续工作；
5. 市场完全为空时按创建权限显示或隐藏 CTA；
6. 搜索无结果、分类为空和 API 错误是三个不同状态；
7. “我的助手”只请求具有 EDIT 权限的 Agent；
8. 无效或无权限 `agent` 参数不能加载扩展配置；
9. 创建、编辑、返回和删除后列表缓存正确刷新；
10. 基础设置不再显示类别、支持联系人和高级集成；
11. 高级设置编辑前后不丢失现有字段；
12. Skills 只显示一次，权限和 capability 不满足时不出现；
13. ephemeral Agent 文件上传仍被禁止，保存后恢复现有上传能力；
14. USER 不看到 Admin-only 设置，ADMIN 仍可使用现有设置；
15. 中文和英文 locale key 集合一致；
16. 空状态、分段导航和返回按钮具有可访问名称和键盘行为。
17. `/agents` 直达、刷新和分类深链接时 `Agent` 具有灰底选中态；
18. 路由型菜单第一次点击会选中并执行导航，第二次点击会收起且不重复导航；
19. 离开 Agent 路由后，失效的路由选中态会回退到有效侧栏菜单。
20. 英文和简体中文的侧栏入口、工作区标题与文档标题都显示 `Agent`。

优先扩展现有测试：

```text
client/src/components/Agents/tests/AgentGrid.integration.spec.tsx
client/src/components/Agents/tests/Accessibility.spec.tsx
client/src/components/Agents/tests/CategoryTabs.spec.tsx
client/src/components/UnifiedSidebar/__tests__/ExpandedPanel.spec.tsx
client/src/components/SidePanel/Agents/AgentPanel.test.tsx
client/src/components/SidePanel/Agents/__tests__/FileContext.spec.tsx
client/src/components/SidePanel/Agents/Tools/__tests__/*
client/src/routes/__tests__/*
```

### 9.2 本地开发门禁

日常提交使用轻量门禁：

```text
overlay source/blob verification
targeted Agent/Marketplace/Sidebar Jest tests
locale JSON parse and key parity
TypeScript typecheck for Client
git diff --check
secret scan on changed files
```

### 9.3 CI 门禁

一次完整 CI 必须：

1. 获取官方 LibreChat 固定 commit；
2. 验证 source manifest；
3. 应用 Agent patch；
4. 使用上游 lockfile 安装依赖；
5. 运行 Agent、Marketplace、Sidebar 和 route 测试；
6. 运行 Client typecheck；
7. 运行生产 Client build；
8. 合成全部现有定制资产；
9. 运行定制资产契约测试；
10. 扫描 candidate 中的重复/旧资产引用；
11. 生成 `client-dist.tar.gz`、manifest 和 SHA-256；
12. 上传 CI artifact，不在生产主机重新构建。

CI 失败时只修复源码或构建脚本后重新执行，不允许绕过测试或在服务器上补丁。

## 十、浏览器验收

开发完成后先在非生产候选环境验证，不直接在生产试错。

### 10.1 USER

- 从 `/c/new` 一步找到 `Agent`；
- 默认看到推荐助手视图；
- 空市场时可进入创建助手；
- 创建并保存一个私有助手；
- 在“我的助手”中找到、编辑并删除该助手；
- 个人 Skills 仍可发现和选择；
- 未保存时明确提示不能添加长期文件，保存后可以添加；
- 不出现管理员设置；
- 返回聊天后普通对话不受影响。

### 10.2 ADMIN

- 与 USER 使用相同三项导航；
- 保留现有管理员市场设置和 Agent 分享能力；
- 管理员控制不挤入普通用户基础设置；
- 不改变 Admin Panel 中现有 Agent/Skills/Marketplace 权限。

### 10.3 视口与回归

至少验证：

- desktop `1440 x 900`；
- mobile `390 x 844`；
- 推荐、我的、创建、编辑、返回、空状态、搜索和分类；
- 无横向溢出、文字遮挡、按钮截断或双侧栏叠加；
- 登录页、上传菜单、普通聊天、模型市场、用量页、上下文安全、搜索 favicon、
  My Files 上传页、生成文件页和下载卡；
- `/api/config` 和现有服务健康保持不变。

本 UI 批次不需要发送计费模型请求。Agent 保存、列表和界面行为即可完成业务验收。

## 十一、提交与发布拆分

开发阶段建议按以下提交拆分，每个提交都可独立测试：

1. `chore(agent-ui): pin upstream client source and verifier`
2. `feat(agent-ui): add unified assistant workspace navigation`
3. `feat(agent-ui): add actionable marketplace and my assistants views`
4. `feat(agent-ui): separate basic and advanced builder settings`
5. `fix(agent-ui): align agent workspace localization and accessibility`
6. `build(agent-ui): compose protected client overlays in CI`
7. `docs(agent-ui): record tests release scope and rollback`

功能完成后先推送全部源码和测试。只有远程 CI 完整成功并确认 candidate artifact 后，才
创建生产 release record。

生产发布预计由 `release-governance.json` 解析为 `protected + light`：

- 目标服务仅 `LibreChat-API`；
- 依赖检查 `LibreChat-NGINX`；
- CodeAPI、RAG、MongoDB、Admin Panel 和 Office Converter 不重建；
- 生产写入前备份当前 Compose override 和当前 Client artifact；
- 将 CI 构建的不可变 Client artifact 放入版本化 release 目录；
- 只替换 `/app/client/dist:ro` 对应 mount；
- 只重建 `LibreChat-API`；
- 完成 public/API/browser/business acceptance 后再 finalize。

实际发布范围必须以当时 `release-plan.json` 为准。本计划不替代发布计划，也不批准
生产写入。

## 十二、回滚

发布前必须记录：

- 当前 Client mount；
- 当前 Client artifact SHA-256；
- candidate artifact SHA-256；
- Compose override 备份路径和 SHA-256；
- `LibreChat-API` 发布前容器 ID；
- 所有受保护资产的 marker/hash 清单。

回滚步骤：

1. 恢复本次时间戳对应的 Compose override；
2. 恢复前一版本 Client mount；
3. 只重建 `LibreChat-API`；
4. 验证 `/`、`/api/config` 和登录；
5. 验证上传菜单、普通聊天、市场旧入口、个人 Skills、My Files 和生成文件下载；
6. 确认 CodeAPI、RAG、MongoDB、Admin Panel 和 Office Converter 容器 ID/启动时间未变。

不得通过删除 Agent、文件、会话或市场数据完成回滚。

## 十三、停止条件

出现任一情况必须停止开发或发布：

- 无法证明 Client 源码来自固定上游 commit；
- production pin 与研究快照不兼容，却需要静默升级上游；
- 新 Agent UI 只能通过大型 DOM 注入完成；
- 必须修改 Agent API、MongoDB 或角色权限才能完成本批目标；
- 基础/高级切换会丢失已有 Agent 字段；
- “我的助手”可能展示用户没有编辑权限的 Agent；
- 现有 Client 定制资产不能确定性重放；
- 候选 Client 缺少上传、登录、用量、模型市场、上下文安全、搜索或生成文件能力；
- CI Client build 未完成或 artifact 来源无法证明；
- 没有精确 Client/Compose 回滚；
- 需要在生产服务器手工修补才能通过验收。

## 十四、后续批次

本批通过后，按以下顺序继续，不并入本次开发：

1. draft file staging 与创建前测试；
2. Workflow Template Manifest schema、版本和校验器；
3. Template Manifest 到 Runtime Task Manifest compiler；
4. Runtime 生产接入、人工确认、恢复与幂等交付；
5. 一个 P0 模板的非生产真实验收；
6. 五个 P0 模板的业务设计、实现和验收；
7. 已验收模板入市和自动化工作流市场正式开通；
8. 两个 P1 模板。

## 十五、门禁结果

用户已确认本计划。首个源码批次已按固定上游 commit 完成 Agent UI overlay、source
manifest、验证脚本、受保护 Client 资产合成和 CI workflow，并通过本地测试与构建。

该结果只允许提交并推送仓库源码、测试、构建定义和记录。生产发布仍必须使用成功的
远程 CI、不可变 Client artifact 和独立生产 release record；本计划不批准生产写入。

首轮远程 CI 证据（已作废，不得部署）：

- Source commit: `b30c733c2d9a0fd6932828bda0f2dd70e23448e0`
- GitHub Actions run: `30325303899`
- Workflow: `LibreChat Agent Platform Client`
- Conclusion: `success`
- Completed at: `2026-07-28T03:16:15Z`
- Artifact: `librechat-agent-platform-client-8fcb77f`
- Artifact ID: `8675483264`
- Artifact size: `15293161` bytes
- Artifact digest:
  `sha256:aef0a5e23224db21a346006ea08ddcdc45a54b114a81cd9d7a9fa9918edc895f`
- Artifact expiry: `2026-08-11T03:16:06Z`

该 CI 完成固定上游验证、patch 应用、依赖安装、packages 构建、13 组聚焦回归、Client
typecheck、生产构建、六项受保护资产契约、10 资产合成、不可变打包和 artifact 上传。
下载后确认 ZIP 和 Client 内容有效，但 `client-dist.tar.gz.sha256` 错误保留了 CI 工作目录
前缀 `artifacts/`，解压后的 artifact 无法直接执行 `sha256sum -c`。因此该 artifact 被
判定为不可部署，workflow 必须生成 basename-only 校验文件并重新完成 CI。

修正版远程 CI 证据（已验签，可进入生产发布门禁）：

- Source commit: `d826e12c523632c2f674da29cf7b767af9d49c71`
- GitHub Actions run: `30326622161`
- Workflow: `LibreChat Agent Platform Client`
- Conclusion: `success`
- Completed at: `2026-07-28T03:44:56Z`
- Artifact: `librechat-agent-platform-client-8fcb77f`
- Artifact ID: `8675938396`
- Artifact size: `15293155` bytes
- Artifact ZIP digest:
  `sha256:015ab73f6e5ac4bbf84f5a19f48160e3072f7cf494669a18c5c45e84eb90410c`
- Artifact expiry: `2026-08-11T03:44:49Z`
- Client tar digest:
  `sha256:1bae767735f53be05a9acbc5fceb7ec04b4bad7576f48f52d5a3ca73175f6c68`
- Composed Client index digest:
  `sha256:e50a1f4ba112abe37df27d5af4608bfa8b4b6c5cdcf06763960ba1b742f9f67e`

独立下载验签结果：

- 下载 ZIP SHA-256 与 GitHub artifact digest 完全一致；
- `client-dist.tar.gz.sha256` 只包含 `client-dist.tar.gz`，不再包含 CI 工作目录前缀；
- 解压后执行 `sha256sum -c client-dist.tar.gz.sha256` 成功；
- Client tar 共 `355` 个成员，其中 `352` 个文件、`3` 个目录；
- tar 内不存在绝对路径、`..` 路径、符号链接、硬链接或设备文件；
- artifact 中的 source manifest 与仓库固定 manifest 字节一致；
- 10 个受保护 Client 资产 SHA-256 全部匹配；
- artifact 内 overlay manifest 与外层 manifest 字节一致；
- `index.html` SHA-256 与 composed index digest 完全一致。

该 artifact 只证明固定源码和 Client 构建结果可部署，不代表生产已经修改。下一步仍需
创建独立 production patch、精确备份和回滚脚本，通过 release governance、生产只读
预检和受控部署后，才能进行 USER/ADMIN 浏览器验收。
