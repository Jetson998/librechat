# LibreChat 预置 Workflow Agent 市场发布计划

Date: 2026-07-29

Status: 设计门禁；本文件提交并推送前，不允许修改生产 Agent、分类或 ACL 数据

Parent gate:
`docs/AGENT_PLATFORM_COMPLETION_AND_MARKET_ENABLEMENT_PLAN.md`

## 一、问题与结论

生产只读盘点确认：

- `agents` 集合当前为 0，因此市场没有任何预置 Agent；
- `agentcategories` 仍启用了 LibreChat 上游默认的 `general`、`hr`、`rd`、
  `finance`、`it`、`sales` 和 `aftersales`；
- 2026-07-28 的 Agent UI 和侧栏发布明确排除了 7 个 Workflow Agent，当前现象不是
  前端加载故障，而是发布范围遗漏；
- 生产已经提供 `anthropic / claude-fable-5`、代码执行、文件搜索、当前会话文件、
  Office 文件处理、联网检索和生成文件下载卡，可作为首版预置 Agent 的真实执行能力；
- 仓库中的 File Agent Runtime 目前仍是非生产、单 XLSX Worker，不得为了显示市场卡片
  临时接入生产，也不得把它描述为已经支持 7 个工作流。

本批采用分阶段契约：

```text
版本化 Workflow Template Manifest
        -> 严格校验与确定性编译
        -> LibreChat 原生 Agent 记录
        -> 生产现有 LLM + Tools + Skills + Office/CodeAPI 能力
        -> 当前会话文件与下载卡
```

首版执行引擎标识为 `librechat-native-agent-v1`。它不是 Prompt 占位卡：每个模板必须声明
真实能力依赖、固定工具、输入要求、产物要求、失败边界和验收样例；缺少任何必需能力时，
整个发布必须停止。后续 Runtime Task Manifest 和多步骤恢复引擎继续作为独立批次实施，
不得在本批验收记录中宣称已经完成。

## 二、发布范围

### 2.1 纳入范围

- 定义并校验 7 个版本化 Workflow Template Manifest；
- 将 Manifest 确定性编译为 LibreChat Agent seed 数据；
- 通过幂等生产操作创建或更新 7 个预置 Agent；
- 给系统所有者写入 Agent owner ACL，给 PUBLIC 写入 Agent viewer ACL；
- 将 7 个 Agent 设为推荐，并统一归入 `automation-workflow`；
- 新增并启用“自动化工作流”分类；
- 只停用 7 个上游非自定义默认分类，不删除用户自定义分类；
- 提供定向备份、漂移检查、发布结果和定向回滚；
- 使用普通用户 `vip998` 验证市场发现、Agent 选择和新会话入口。

### 2.2 不纳入范围

- 不直接修改生产 MongoDB 后再补仓库记录；
- 不在前端硬编码 Agent 卡片或分类；
- 不创建第二套用户、文件、会话、计费或下载系统；
- 不接入当前非生产 File Agent Runtime；
- 不新增 Flowise、Dify、LangGraph、CrewAI 或其他外部服务；
- 不开放普通用户向公共市场直接发布；
- 不修改个人 Agent、个人 Skills、Office 上传、普通聊天和生成文件链路；
- 不宣称已具备工作流断点恢复、人工确认状态机或定时触发。

## 三、市场目录

所有预置 Agent 的一级分类固定为：

```text
value: automation-workflow
label: 自动化工作流
description: 使用文件、代码、检索和 Office 能力完成可交付任务
```

领域不再作为一级分类，只保存在 Manifest 中供后续筛选和展示：

| 优先级 | 领域 | 市场显示名称 | 稳定模板 ID |
| --- | --- | --- | --- |
| P0 | 通用 | 会议到执行计划 | `meeting-to-action` |
| P0 | 通用 | 企业知识库整理器 | `knowledge-base-curator` |
| P0 | 通用 | Excel 数据审计与对账 | `excel-audit-reconciliation` |
| P0 | 金融 | KYC/CDD/EDD 定期审查 Agent | `kyc-periodic-review` |
| P0 | 金融 | 总账与会计分录审计 Agent | `journal-entry-audit` |
| P1 | 通用 | 制度版本差异与影响分析 | `policy-change-impact` |
| P1 | 通用 | 客户反馈与问题根因分析 | `feedback-root-cause-analysis` |

市场仍保留 LibreChat 的特殊视图：

- `promoted`：推荐，显示 7 个预置 Agent；
- `automation-workflow`：自动化工作流，显示 7 个预置 Agent；
- `all`：全部，显示用户有权访问的全部 Agent。

`general`、`hr`、`rd`、`finance`、`it`、`sales` 和 `aftersales` 仅在其
`custom != true` 时停用。发布脚本不得删除这些记录，也不得停用其他自定义分类。

## 四、Manifest 契约

每个 JSON Manifest 至少包含：

```text
schemaVersion
templateId
templateVersion
engine
display.name
display.description
priority
domain
category
provider
model
requiredCapabilities
tools
inputContract
outputContract
instructions
conversationStarters
limits
acceptanceFixtures
```

固定约束：

- `schemaVersion` 首版为 `1.0`；
- `templateVersion` 首版为 `1.0.0`；
- `engine` 固定为 `librechat-native-agent-v1`；
- `provider` 固定为 `anthropic`；
- `model` 固定为 `claude-fable-5`；
- `category` 固定为 `automation-workflow`；
- Agent 数据 ID 固定编译为 `workflow_<templateId>`，模板 ID 创建后不可复用；
- `is_promoted` 固定为 `true`；
- 工具只允许 `execute_code`、`file_search` 和 `web_search`；
- 禁止凭据、URL 密钥、Cookie、用户 ID、会话 ID、文件 ID、Mongo ObjectId 和任意脚本正文；
- 指令必须限制为当前会话文件和当前轮产物，不得搜索其他会话或服务器目录；
- 需要生成文件时必须写入 `/mnt/data`，并使用现有下载卡链路交付；
- 缺少输入时必须向用户说明需要补充的文件或字段，不能伪造数据；
- 输出必须包含结论、依据、异常或待确认项，以及模板定义的最终产物。

## 五、7 个 Agent 的能力边界

| 模板 ID | 必需能力 | 主要输入 | 默认交付 |
| --- | --- | --- | --- |
| `meeting-to-action` | `file_search`, `execute_code` | 会议纪要、录音转写或文字 | 决策、行动项、负责人、截止时间，可选 DOCX/XLSX |
| `knowledge-base-curator` | `file_search`, `execute_code` | Word、PDF、PPT、Markdown、表格 | 去重目录、知识条目、缺口清单，可选 MD/DOCX/XLSX |
| `excel-audit-reconciliation` | `execute_code`, `file_search` | 一个或多个 Excel/CSV | 审计摘要、差异明细、可追溯 XLSX |
| `policy-change-impact` | `file_search`, `execute_code` | 新旧制度文件 | 条款差异、影响对象、行动清单，可选 DOCX/XLSX |
| `feedback-root-cause-analysis` | `execute_code`, `file_search` | 反馈表、工单或文本 | 主题、频次、根因、优先级和整改清单，可选 XLSX/PPTX |
| `kyc-periodic-review` | `file_search`, `execute_code`, `web_search` | 客户资料、历史审查和公开信息 | 风险信号、证据引用、缺失项和人工复核清单，不自动作出最终合规决定 |
| `journal-entry-audit` | `execute_code`, `file_search` | 总账、分录和科目映射 | 异常分录、规则命中、样本依据和审计工作底稿 XLSX |

金融 Agent 必须明确：只提供辅助审查、证据整理和异常提示，不代替持牌人员或机构作出
开户、拒绝、冻结、可疑交易上报、审计意见或其他最终决定。

## 六、系统所有者与权限

发布预检按用户名解析一个现有 `ADMIN` 作为系统所有者，默认候选为 `admin`。仓库和
Manifest 不写死生产 ObjectId。

每个 Agent 必须具有：

- 一条 `principalType=user`、`accessRoleId=agent_owner` 的 owner ACL；
- 一条 `principalType=public`、`accessRoleId=agent_viewer` 的 PUBLIC ACL；
- 不向 PUBLIC、USER 或 ROLE 授予编辑、删除或分享权限；
- 不创建 `remoteAgent` ACL，因为本批不发布远程 Agent；
- 普通用户只能查看和使用，不能修改系统预置 Agent。

发布前必须确认角色记录和权限位与生产现状一致，不能在脚本中写死 role ObjectId。

## 七、幂等发布与漂移处理

生产写入必须由仓库内版本化操作脚本完成：

1. 读取并验证 7 个 Manifest；
2. 校验生产 Agent capability、允许 provider、模型和工具；
3. 解析系统所有者和 `agent_owner`、`agent_viewer` 角色；
4. 备份目标 Agent、目标 ACL 和 8 个相关分类的原始 EJSON；
5. 按稳定 Agent ID upsert 7 个记录；
6. 按资源和 principal upsert owner/public ACL；
7. upsert `automation-workflow`，停用 7 个非自定义默认分类；
8. 重新读取并验证数量、字段、ACL 和分类；
9. 生成不可变的 `DEPLOY_RESULT.json`。

重复执行相同版本必须得到 `created=0`、`updated=0` 或等价的无漂移结果。若生产中同一
稳定 ID 已存在但作者、provider、模型、模板语义或 ACL 与预期冲突，脚本必须停止，
不得覆盖未知数据。

## 八、回滚

回滚只处理本批目标：

- 删除本批创建的目标 Agent 和对应 ACL；
- 对发布前已经存在的目标 Agent 和 ACL 按备份恢复；
- 按备份恢复 8 个相关分类；
- 不恢复整个 `agents`、`aclentries` 或 `agentcategories` 集合；
- 不影响发布后由用户新建的个人 Agent、个人 Skills、文件、会话或其他 ACL；
- 回滚后验证 7 个稳定 ID、相关 PUBLIC ACL 和分类状态与发布前快照一致。

## 九、测试与验收

### 9.1 本地测试

- 7 个 Manifest 通过 JSON schema 和语义校验；
- 模板 ID、版本、Agent ID、名称和 conversation starter 唯一；
- 工具集合属于允许列表，且每个模板包含其声明的必需能力；
- 禁止凭据、硬编码生产 ID、跨会话文件扫描和任意脚本正文；
- 编译结果稳定，同一输入产生相同摘要；
- seed 脚本在隔离 Mongo fixture 中首次执行、重复执行、漂移停止和定向回滚通过；
- `git diff --check` 和 release-governance 测试通过。

### 9.2 生产只读预检

- `agents`、目标 ACL 和相关分类快照完成；
- 系统所有者、角色、provider、模型和能力全部存在；
- Mongo、API、NGINX、CodeAPI、RAG、Admin 和 Office Converter 身份已记录；
- 内存、磁盘和回滚目录满足门禁；
- 预检不得写 Mongo、重启容器或发送模型请求。

### 9.3 发布后数据验收

- 7 个稳定 Agent ID 各存在且仅存在一条；
- 7 个 Agent 均为 `automation-workflow` 和 `is_promoted=true`；
- 每个 Agent 各有一条 owner ACL 和 PUBLIC viewer ACL；
- `/api/agents/v1/categories` 对普通用户返回推荐 7、自动化工作流 7 和全部；
- 不再返回 7 个已停用的默认分类；
- LibreChat API、NGINX、CodeAPI、RAG、Admin、Mongo 和 Office Converter 无异常变化。

### 9.4 `vip998` 浏览器验收

- 打开 Agent 后首屏直接看到 7 个预置 Agent，不再是空市场；
- 分类不再显示人事、研发、财务、IT、销售和售后；
- 桌面和移动端均可查看 7 个卡片；
- 选择一个 Agent 后可以进入新会话，名称、描述和建议任务正确；
- 普通用户不能编辑或删除系统预置 Agent；
- 个人 Agent、个人 Skills、Office 上传和生成文件入口没有回归。

本批最多选择一个无文件、低成本请求验证 Agent 可实际回复。Excel、KYC 或审计业务
质量不在生产发布时用真实敏感数据测试，后续使用脱敏 fixture 做独立业务验收。

## 十、发布顺序

1. 提交并推送本设计门禁；
2. 新增 Manifest、校验器、编译器、测试和版本化生产操作；
3. 本地测试通过后提交并推送实现；
4. 完成一个 CI/独立构建证明和 release artifact；
5. 执行只读生产预检；
6. 通过 release-governance 受控写入 Mongo；
7. 完成数据和 `vip998` 浏览器验收；
8. 补全 `RELEASE.json`、备份、回滚和修改清单；
9. 推送最终发布记录并报告 commit hash。

任一步失败都停止在当前门禁，不允许通过临时 Mongo 命令、前端硬编码或未记录的热补丁
绕过后续步骤。
