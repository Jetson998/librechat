# LibreChat Agent 功能完善与市场开通门禁

Date: 2026-07-28

Status: 设计门禁已记录；P0 UI 源码候选已完成但未部署；Workflow Manifest、Runtime
生产接入和模板尚未实施，智能体市场仍不满足正式开通条件

## 一、决策

本阶段只完善 LibreChat 的通用 Agent 产品能力，不在本阶段把业务需求写成若干
Prompt Agent，也不新增 Flowise、Dify、LangGraph、CrewAI 或其他外部工作流服务。

采用已经确认的主线：

```text
LibreChat 市场与会话
        -> Workflow Template Manifest
        -> Manifest compiler and policy validation
        -> Runtime Task Manifest
        -> File Agent Runtime / Connector
        -> CodeAPI + LLM + Office Worker
        -> 人工确认点 + LibreChat 下载卡
```

当前生产权限已经允许普通 `USER` 使用智能体、Skills 和市场，但“权限已开启”不等于
“市场已经可正式开通”。市场正式开通必须同时满足构建、测试、发布、运行、恢复、
人工确认和产物交付闭环。

本设计不批准生产写入。后续必须先完成实现、测试、提交、推送和发布门禁，才能修改
生产客户端、API、Runtime、MongoDB、配置或市场数据。

## 二、范围边界

### 本阶段负责

- 统一 Agent 市场、我的 Agent 和创建入口；
- 降低普通用户创建 Agent 的配置难度；
- 定义版本化 Workflow Template Manifest；
- 将模板定义编译成每次运行的 Runtime Task Manifest；
- 提供运行前测试、人工确认、失败恢复和产物交付状态；
- 保留个人 Skills、当前会话文件、CodeAPI 和下载卡能力；
- 定义市场发布、停用、版本升级和回滚边界；
- 为后续 7 个“自动化工作流”模板提供统一平台契约。

### 本阶段不负责

- 实现 7 个业务 Agent 的行业逻辑和规则包；
- 用 Prompt 占位方式提前发布尚不能执行的 Agent 卡片；
- 开放用户直接向公共市场发布未经审核的 Agent；
- 定时、邮件、Webhook 或外部事件触发；
- 默认启用多 Agent 编排、远程 Agent 或任意外部工具地址；
- 新建第二套文件库、用户库、会话库、价格系统或下载卡；
- 改变现有 Office 上传、个人 Skills 或普通聊天的可用行为。

## 三、2026-07-28 已验证生产基线

使用普通用户 `vip998` 和现有 Admin Panel 做了只读浏览器核对。

### 3.1 已具备

- 普通用户可以看到并打开“智能体构建器”；
- 普通用户可以输入名称、描述、模型、类别和指令；
- 构建器可以添加 Tools 和个人 Skills；
- Admin Panel 中 `USER` 的“智能体”“技能”和“市场”权限均已开启；
- `USER` 的运行代码、文件搜索和文件引用功能均已开启；
- 个人 Skills 创建、上传、发现和所有者隔离已有独立生产验收记录；
- Agent 通用无进展防护已经上线，不依赖某个模型或某个 Office Prompt；
- CodeAPI `/mnt/data`、Office 文件处理和生成文件下载卡已有稳定生产链路；
- File Agent Runtime 和 Connector 已完成仓库内非生产契约、恢复和产物交付验证。

### 3.2 当前阻塞

- 智能体市场为空，只显示“未找到智能体”；
- 空状态没有创建、导入、示例或申请模板的行动入口；
- 市场入口隐藏在“对话历史”内部，构建器是另一个侧栏按钮；
- 构建器被限制在窄侧栏，市场空页面同时占据主区域；
- 表单一次显示模型、类别、指令、Tools、Skills、文件上下文、支持联系人和高级设置；
- `Tools`、`Skills`、`Essentials`、`Agent skills` 和多 Agent 说明存在中英文混排；
- 主表单已经显示 Skills，高级设置又出现一个 `Agent skills` 开关，职责不清；
- 文件上下文必须先创建 Agent 才能上传，无法完成“配置 -> 测试 -> 保存”的自然流程；
- 创建前没有测试面板，也没有输入样例、预期输出和能力检查；
- 市场没有共享 Agent，普通用户无法验证安装、运行、升级或停用流程；
- 当前 Runtime 只声明一个当前轮 XLSX 输入，不支持通用 Word、PPT、PDF Worker；
- Runtime 和 Connector 仍没有生产启动入口或正式生产路由；
- 当前任务清单是运行实例契约，不是市场模板定义契约。

因此当前开通判定为：

```text
个人 Agent 权限：已开启
个人 Skills 权限：已开启
智能体市场入口：已开启但为空
自动化工作流市场：BLOCKED，不允许宣称正式开通
```

## 四、目标信息架构

侧栏入口和工作区产品名统一使用 `Agent`，内部代码继续保留 LibreChat `agent`
术语；“推荐助手 / 我的助手 / 创建助手”等动作标签保持中文，避免无必要的数据迁移。

```text
Agent
  推荐助手
  我的助手
  创建助手
```

- `推荐助手`：展示已发布并通过验收的系统工作流；
- `我的助手`：展示用户自己创建、安装或复制的助手；
- `创建助手`：提供基础模式和高级模式；
- 市场一级分类增加“自动化工作流”；
- “通用”和“金融”作为领域标签，不再与执行引擎绑定；
- 现有 Agent、Skills 和市场权限继续由角色系统控制。

市场为空时必须提供明确行动：

```text
暂无可用的自动化工作流
[创建我的助手] [查看使用示例]
```

不得展示没有真实执行能力的占位卡。

## 五、创建体验

### 5.1 基础模式

普通用户默认只看到四步：

1. 选择任务模板或从空白开始；
2. 用一句话描述目标，并填写模板要求的输入字段；
3. 选择推荐能力，例如联网、代码、Office 和个人 Skills；
4. 使用样例或当前文件测试，确认结果后保存。

基础模式只显示一个平台推荐模型。模型路由、temperature、Top P/K、缓存、思考预算、
Token 上限、多 Agent 和支持联系人放入高级模式。

### 5.2 高级模式

高级模式用于熟悉 Agent 配置的用户和模板作者，包含：

- 模型与推理参数；
- 版本化能力引用；
- 输入字段和输出产物定义；
- 人工确认点；
- 失败、重试和停止规则；
- 支持联系人和发布元数据；
- 多 Agent 编排实验入口，但首期默认关闭。

### 5.3 创建前文件

文件不能再依赖“先创建正式 Agent 才能上传”。实现必须选择一个可回滚方案：

- 保存临时 draft Agent 后上传；或
- 使用有时限、所有者隔离的 staging file scope，保存时再绑定 Agent。

无论采用哪种方式，都必须满足：

- 文件只对当前用户和当前 draft 可见；
- 取消创建后可回收临时文件；
- 不把文件正文默认写入 Agent Manifest；
- 不暴露其他会话或其他用户的 CodeAPI session；
- 测试运行继续使用 LibreChat 权威文件记录和 `metadata.codeEnvRef`。

## 六、两层 Manifest 契约

### 6.1 Workflow Template Manifest

市场模板必须使用独立的版本化定义，至少包含：

```text
schemaVersion
templateId
templateVersion
display metadata
domain and category
input schema
ordered steps or constrained graph
capability references
human confirmation points
artifact definitions
industry rule pack references
failure and retry policy
limits
test fixtures and acceptance assertions
engine contract range
deprecation and migration metadata
```

模板不得包含：

- API Key、Cookie、密码或数据库凭据；
- LibreChat 原始用户、会话、消息或 MongoDB 对象；
- 模型 URL、价格表或完整 Admin 配置；
- 作者个人私有 Skill 的内容或所有权授权；
- 任意可执行 URL、未审核脚本或不受限 shell 命令；
- 用户历史消息数组和其他会话文件引用。

### 6.2 Runtime Task Manifest

每次运行由 compiler 使用以下输入生成不可变任务实例：

```text
published template version
current user and tenant scope
current conversation and message refs
current-turn authorized file refs
user field values and instruction
allowlisted modelRouteId
LibreChat-owned billing snapshot ref
Runtime capability profile
wall-time, token and artifact limits
```

现有 `task-manifest-builder.js` 继续负责 Runtime Task Manifest，不直接承担市场模板存储。

compiler 必须：

- 校验模板版本和 Runtime capability；
- 校验用户、会话、文件和 Skill 权限；
- 冻结本次运行使用的模板版本；
- 生成稳定幂等键；
- 拒绝缺失能力，而不是静默退回 Prompt Agent；
- 在 Runtime 接受任务后禁止原生 Agent 重复执行。

## 七、Skills 与 Tools

面向普通用户统一显示“能力”，按用途分组：

```text
推荐能力
  联网检索
  代码执行
  Office 文件处理

我的工作流说明
  用户自己的个人 Skills

高级集成
  MCP、Actions、远程能力
```

权限规则：

- 私有 Agent 可以引用所有者有权使用的个人 Skill；
- 其他用户复制 Agent 时不能继承作者私有 Skill 的访问权；
- 公共市场模板只能引用平台批准的 capability ID 或 deployment Skill；
- 安装模板时发现缺失个人能力，应要求用户映射或移除，不能越权读取；
- 普通 `USER` 不获得 `READ_SKILLS` 或 `MANAGE_SKILLS` 平台管理权限；
- deployment Skill 与个人 Skill 继续保持不同注册表和修改边界。

## 八、运行、人工确认与恢复

用户运行自动化工作流时必须看到稳定状态，而不是只看到模型思考文本：

```text
准备输入
规划步骤
处理中
等待确认
验证结果
生成文件
已完成 / 已失败 / 已取消
```

人工确认点必须映射到 Runtime `needs_input` 和 `steer`：

- 显示需要确认的决定和影响；
- 保留同一个 task、assistant message 和 stream identity；
- 用户确认后从最近检查点继续；
- 刷新页面或 API 重启后可以恢复；
- 不因确认而重复调用模型、重复执行 CodeAPI 或重复计费。

失败状态必须区分：

- 输入缺失；
- 权限或文件所有权失败；
- 模板与 Runtime capability 不兼容；
- 模型计划无效；
- CodeAPI 执行失败；
- 验证失败且可修复；
- 产物交付失败；
- 用户取消。

不得把内部 stdout、堆栈、路径扫描、Token 上限或 Runtime 内部术语直接展示给业务用户。

## 九、产物交付

所有用户可见文件继续使用现有链路：

```text
Runtime artifact.ready
  -> Connector verification
  -> LibreChat processCodeOutput()
  -> assistant message files
  -> 生成的文件
  -> 下载卡
```

要求：

- 默认一个完整最终文件，用户明确要求时最多三个可见文件；
- XLSX、PPTX、DOCX、PDF、MD、CSV、TXT 和图片按现有能力生成下载卡；
- manifest、日志、脚本、QA、预览和中间文件不得作为最终下载卡；
- artifact、message、final event 和 job completion 必须可恢复且幂等；
- 当前会话文件和当前轮产物可用，其他会话文件不可见。

## 十、首期市场模板目录

后续业务模板统一归入“自动化工作流”。当前冻结目录为 7 个：

| 优先级 | 领域 | 市场显示名称 | 内部 ID |
| --- | --- | --- | --- |
| P0 | 通用 | 会议到执行计划 | `meeting-to-action` |
| P0 | 通用 | 企业知识库整理器 | `knowledge-base-curator` |
| P0 | 通用 | Excel 数据审计与对账 | `excel-audit-reconciliation` |
| P0 | 金融 | KYC/CDD/EDD 定期审查助手 | `kyc-periodic-review` |
| P0 | 金融 | 总账与会计分录审计助手 | `journal-entry-audit` |
| P1 | 通用 | 制度版本差异与影响分析 | `policy-change-impact` |
| P1 | 通用 | 客户反馈与问题根因分析 | `feedback-root-cause-analysis` |

按当前表格实际为 P0 五个、P1 两个。内部 ID 创建后不可复用或改变语义。

本平台完善批次不实现这些模板。它们是下一阶段验证 Workflow Manifest、Runtime 和
市场闭环的首批消费者。模板未通过真实输入、人工确认、失败恢复和产物验收前，不得
发布到公共市场。

## 十一、实现优先级

### P0：开通阻塞

1. 统一“推荐助手 / 我的助手 / 创建助手”入口和中文术语；
2. 完成 Workflow Template Manifest schema、校验器和版本策略；
3. 完成 Template Manifest 到 Runtime Task Manifest 的 compiler；
4. 实现基础/高级模式和四步创建流程；
5. 实现创建前测试、输入样例和 capability preflight；
6. 实现 draft 文件 staging 和所有权回收；
7. 实现运行状态、取消、人工确认和恢复 UI；
8. 实现私有 Agent、系统模板、安装副本和发布状态；
9. 实现市场空状态、搜索、领域标签、版本和可用性提示；
10. 完成 Runtime 生产入口、受限 secret source、feature flag 和回滚开关；
11. 完成至少所需 Office Worker 和非文件工作流 action；
12. 完成 usage、artifact、message 和 final event 幂等交付；
13. 完成 USER/ADMIN、文件、Skill、会话和租户隔离验收。

### P1：开通后增强

- 用户提交公共市场发布申请和管理员审核；
- 模板版本差异、升级提示和回退；
- 使用次数、成功率、人工接管率和失败阶段分析；
- 收藏、最近使用和组织推荐；
- 更丰富的模板作者调试信息；
- 经单独设计的多 Agent 编排。

## 十二、开通条件

### 12.1 个人 Agent 功能

个人 Agent 功能目前已允许使用。完成 P0 UI 改造后，必须继续满足：

- 普通 `USER` 和 `ADMIN` 都能创建、测试、保存、编辑和删除自己的 Agent；
- 用户可绑定自己的个人 Skills，但其他用户不可见；
- 创建失败不留下不可见 Agent、孤立文件或持续 generation job；
- 普通聊天、个人 Skills、Office 上传和下载卡没有回归。

### 12.2 自动化工作流市场

只有以下条件全部通过，才能宣布正式开通：

1. 市场不再是空壳，且没有 Prompt 占位 Agent；
2. Template Manifest、compiler 和 Runtime capability 校验通过；
3. 至少一个 P0 模板完成真实端到端非生产验收；
4. 计划公开的全部 P0 模板完成各自业务验收后才可同时发布；
5. USER 可以发现、安装、运行、确认、取消和重新打开任务；
6. 当前会话文件、个人 Skills 和租户边界通过隔离测试；
7. 产物下载卡、刷新恢复和失败重试通过；
8. 计费和 usage 只记录一次；
9. 模板停用、Runtime feature flag 和客户端/API 回滚均可用；
10. 发布记录、构建证据、生产备份和浏览器验收完整。

在这些条件完成前，允许继续使用现有个人 Agent 功能，但不得把空市场或未实现模板
描述为“自动化工作流市场已开通”。

## 十三、测试矩阵

实现必须覆盖：

1. USER 创建私有 Agent；
2. ADMIN 创建私有 Agent；
3. 基础模式保存后高级字段使用稳定默认值；
4. 高级模式字段不泄漏凭据或内部 route；
5. 创建前文件测试成功并在取消后回收；
6. 个人 Skill 只对所有者 Agent 可用；
7. 公共模板不能继承作者私有 Skill；
8. 模板缺失 capability 时阻止运行并给出可操作提示；
9. 同一用户消息只创建一个 Runtime task；
10. 人工确认后从同一 task 恢复；
11. 浏览器刷新和 API/Runtime 重启后恢复；
12. 失败修复不重复计费、不重复生成文件；
13. 一个最终 artifact 只产生一个 LibreChat file record 和下载卡；
14. 当前会话可引用当前文件，其他会话文件不可见；
15. 市场搜索、分类、空状态和安装流程在桌面与移动宽度可用；
16. 全部普通用户界面使用完整中文，技术字段只在高级模式出现；
17. 现有 Office、个人 Skills、无进展防护、普通聊天和 Admin Panel 回归通过。

## 十四、发布拆分

不要把平台 UI、Runtime 生产接入和 7 个业务模板打成一次大发布。

建议拆分：

1. **Agent 产品壳与中文体验**：客户端和必要 API，`protected + light`；
2. **Workflow Manifest 与 compiler**：API/数据契约，本地和非生产验证；
3. **Runtime 生产接入**：API、Runtime、CodeAPI 和交付链，`enhanced + heavy`；
4. **P0 模板批次**：规则包、测试 fixture 和业务验收，按共同引擎批量发布；
5. **公共市场开通**：只写已通过验收的模板和发布状态。

每个发布批次都必须使用 `release-governance.json` 计算实际路径对应的构建、测试、
目标服务、备份和验收，不得用本文件预先替代发布计划。

## 十五、回滚

发布前必须具备：

- 当前客户端和 API artifact；
- Runtime 与 Connector feature flag 的关闭方式；
- 模板发布状态快照；
- Compose/配置备份；
- 如涉及 Mongo schema，必须有向后兼容读取和受控回滚脚本；
- 涉及 CodeAPI 或 Office Worker 时保留对应镜像和配置备份。

回滚顺序：

1. 停止新工作流提交；
2. 保留已运行任务记录和用户产物，不删除用户数据；
3. 下架本批模板或恢复模板发布状态；
4. 关闭 Runtime route feature flag；
5. 恢复客户端/API/Runtime 精确 artifact；
6. 只重建本批涉及的服务；
7. 验证个人 Agent、个人 Skills、普通聊天、Office 和下载卡恢复。

## 十六、停止条件

任一条件出现必须停止开通：

- Template Manifest 与 Runtime Task Manifest 没有明确版本边界；
- 需要把业务流程重新塞回 Agent Prompt；
- 需要读取其他会话或其他用户文件才能运行；
- 需要把个人 Skill 权限转交给市场模板；
- Runtime 接受任务后仍可能执行原生 Agent；
- usage、artifact 或 message 可能重复；
- 没有 feature flag、备份或回滚 artifact；
- 只能通过生产手工补丁完成；
- 市场卡片无法用真实测试输入完成验收；
- 生产验收需要暴露客户文件、凭据或敏感金融数据。

## 十七、当前结论

当前没有权限阻塞，但存在产品和执行闭环阻塞，因此本轮不执行生产开通。

下一阶段只能从 P0 平台能力的设计和实现开始。完成至少一个 P0 模板的非生产真实
验收后，再提交 Runtime 生产接入和市场开通的独立发布审批。
