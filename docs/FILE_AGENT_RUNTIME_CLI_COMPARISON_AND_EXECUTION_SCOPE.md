# File Agent Runtime 与 Claude Code、Codex CLI 的边界及执行能力

Date: 2026-08-03

Status: architecture decision. This document defines product positioning,
execution maturity, Office scope, and production gates. It does not approve a
production deployment.

The implementation-ready functional requirements, data contracts, module map,
tests, milestones, and acceptance gates are defined in
`docs/FILE_AGENT_RUNTIME_IMPLEMENTATION_REQUIREMENTS.md`.

## 一、决策摘要

File Agent Runtime 不复制 Claude Code 或 Codex CLI，也不以通用代码 Agent 的能力
覆盖面作为首版目标。

三者定位如下：

```text
Claude Code / Codex CLI
  = 面向开发者的高自由度通用工程 Agent

LibreChat File Agent Runtime
  = 面向客户文件任务的低自由度、可恢复、可计费、可验证执行系统
```

File Agent Runtime 借鉴两类 CLI 的持久工作区、分阶段执行、增量修改、上下文压缩、
恢复和工具安全边界，但必须补充它们不负责的产品能力：

- LibreChat 用户、租户、会话和文件所有权；
- 模型调用与 CodeAPI 动作幂等；
- Token 四粒度计费和重放去重；
- 确定性 Office Verifier；
- 生成文件落库、下载卡和最终消息一致性；
- 服务重启、浏览器断线和消息收尾恢复。

因此，File Agent Runtime 在开放式代码任务上不会达到 Claude Code 或 Codex CLI 的
灵活性；在已经建设 Worker 和 Verifier 的 Office 任务上，应达到更高的可预测性和
生产稳定性。

## 二、比较依据与时间边界

本次比较以 2026-08-03 本机可验证版本为准：

```text
Claude Code 2.1.212
Codex CLI 0.146.0-alpha.9.2
```

本机 CLI 帮助确认：

- Claude Code 提供 `Bash`、`Edit`、`Read` 等工具选择，权限模式、会话继续和恢复、
  fork、worktree、后台 Agent、MCP、插件、结构化输出和调用预算；
- Codex CLI 提供交互和非交互执行、review、sandbox、审批策略、resume、fork、MCP、
  plugin，以及实验性的 app-server、remote-control 和 exec-server；
- 两者都以开发者工作目录和工程任务为中心，不是 LibreChat 的多用户文件、计费和
  下载交付系统。

Codex app-server 的 Thread、Turn、Item、事件、compact、resume、fork、steer 和
interrupt 只作为公开架构参考。File Agent Runtime 不嵌入 Codex app-server、Codex
SDK、Claude Code CLI 或其私有会话协议。

## 三、执行成熟度口径

为了避免笼统使用“支持代码执行”或“支持 Office”，统一使用以下等级：

| 等级 | 定义 |
| --- | --- |
| L0 | 不支持该任务 |
| L1 | 能执行单次命令或固定转换，但没有完整任务恢复和验证 |
| L2 | 能在工作区完成多步读取、修改、执行和基础检查 |
| L3 | 有持久任务、增量修复、幂等恢复，并能调用任务提供的确定性验证和产物契约 |
| L4 | 在 L3 基础上完成多租户隔离、计费、原生下载交付和生产验收 |

等级描述的是系统执行成熟度，不代表模型智力或文件内容质量。

## 四、整体能力对比

| 维度 | Claude Code | Codex CLI | 当前 File Agent Runtime | 目标 File Agent Runtime |
| --- | --- | --- | --- | --- |
| 开放式代码理解 | 强 | 强 | 不支持 | 非首版重点 |
| 自主探索工作区 | 强 | 强 | 仅固定任务目录 | 仅授权任务目录 |
| 自主编写完整程序 | 强 | 强 | 模型被禁止输出代码 | 首次可生成受控脚本 |
| 失败后增量修改 | 依赖 Agent 正确使用 Edit | 依赖 Agent 正确编辑文件 | 固定 marker patch 已验证 | 强制稳定脚本和受控 patch |
| 上下文管理 | 会话恢复和工具上下文管理 | session、compact 架构和恢复 | 默认最多 12,000 字符投影 | 按任务阶段投影 |
| 任务幂等 | 面向本地工程会话 | 面向本地工程会话 | item、model call、usage 已实现 | 扩展到生产 CodeAPI 和交付 |
| 确定性 Office 验证 | 由 Agent 临时编写 | 由 Agent 临时编写 | 固定 XLSX verifier | 版本化 Office verifier |
| 多用户文件隔离 | 非产品职责 | 非产品职责 | Connector 契约已验证 | 生产强制 |
| LibreChat 计费 | 不负责 | 不负责 | 非生产链路已验证 | 原生 transaction 入账 |
| 下载卡和最终消息 | 不负责 | 不负责 | 隔离浏览器验收通过 | 生产一致性保证 |
| 未知任务适应性 | 高 | 高 | 低 | 中低，按 capability 扩展 |

## 五、代码执行能力

### 5.1 Claude Code 和 Codex CLI

两类 CLI 的代码执行成熟度通常为 L2；当仓库提供可靠测试、构建和验收脚本时，可以
达到 L3：

- 可以读取仓库、搜索代码、修改多个文件、运行命令和测试；
- 可以根据失败结果改变方案，而不局限于预置 Worker；
- 可以在持久工作目录中保留脚本、diff、构建结果和测试状态；
- 适合陌生代码库、开放式调试、重构、开发和运维诊断；
- 最终正确性仍取决于模型判断、仓库测试和用户验收，不自动提供 LibreChat 业务
  所需的交易、文件所有权和下载交付一致性。

### 5.2 当前 File Agent Runtime

当前通用代码执行程度为 L1，不能与 Claude Code 或 Codex CLI 等同：

- Runtime 已有 `prepare -> plan -> execute -> verify -> repair -> publish` 状态机；
- ExecutorAdapter 能驱动 CodeAPI 命令和文件读写；
- Provider 当前只能选择 `xlsx_transform` 和 `xlsx_patch_and_transform`；
- 模型返回 `command`、`script`、`path` 等字段会被拒绝；
- 当前稳定 Python 脚本是测试 Worker，不是模型针对任意需求编写的程序；
- 没有 Git diff、通用代码 patch、构建、lint 或仓库测试 Worker。

这种限制是 POC 的安全边界，不应被描述成“已经具备 Codex 级代码执行”。

### 5.3 目标代码执行方式

首个生产候选不开放任意 Shell Agent。模型与 Runtime 的职责应为：

```text
模型：理解目标、拆分计划、选择 Worker、生成首次脚本或局部 patch、调整策略
Runtime：保存状态、执行 Action、控制路径和预算、分类错误、判断进展
Worker：完成稳定的 Office 机械操作
Verifier：确定性判断产物是否可交付
```

模型动作不得直接携带一整段 Bash 命令作为任务计划。推荐 Action Envelope：

```json
{
  "objective": "修复表格结构并保持既有样式",
  "worker": "word.patch_document.v1",
  "targetRefs": ["artifact:F3"],
  "expectedChange": ["table_structure"],
  "verificationProfile": "word-structure-v1",
  "onFailure": "replan"
}
```

首次确实需要新代码时，代码写入稳定的 `scripts/` 路径。后续修复只允许受控 diff
或结构化 patch，不重复传输和重写 10K 至 20K 字符的完整脚本。

## 六、Office 文件执行程度

### 6.1 Claude Code 和 Codex CLI 的 Office 执行

两类 CLI 没有自动获得 Word、Excel 或 PowerPoint 的业务语义。它们通常通过 Python、
Node.js、LibreOffice 或其他已安装工具完成以下工作：

- 检查文件和环境，选择库并临时编写处理脚本；
- 读取 OOXML、表格数据或页面结构；
- 修改文件、运行渲染和再次检查；
- 根据错误继续编辑脚本，直到测试通过或 Agent 决定停止。

这类 Office 执行通常为 L2。只有任务同时提供稳定 fixture、确定性验证器、持久脚本
和明确产物契约时，单次工程任务才可能达到 L3。CLI 本身不提供：

- LibreChat 用户和会话文件隔离；
- Office 业务 Verifier 的统一版本；
- 模型调用、文件副作用和费用的跨服务幂等；
- 生成文件落库、下载卡和消息 final 的事务化收尾。

因此，Claude Code 或 Codex CLI 可能更快解决第一次陌生 Office 问题，但结果依赖
当次 Agent、安装环境和临时脚本；File Agent Runtime 的目标是把已验证做法沉淀为
后续客户任务可重复执行的 Worker。

### 6.2 当前已实现

| 文件类型 | 读取 | 修改 | 验证 | 交付 | 当前等级 |
| --- | --- | --- | --- | --- | --- |
| XLSX | 单个已授权输入 | 固定新增 Sheet 和 marker patch | openpyxl 打开、Sheet 和 marker | 单个 XLSX ref，隔离下载卡已验收 | L3 POC |
| DOCX | 现有 LibreChat 原生链路可解析 | Runtime 无 Worker | Runtime 无 Verifier | Runtime 无产物 | L0 Runtime |
| PPTX | 现有 LibreChat/CodeAPI 路径可处理部分任务 | Runtime 无 Worker | Runtime 无 Verifier | Runtime 无产物 | L0 Runtime |
| PDF | 现有上传/提取链路负责 | Runtime 无 Worker | Runtime 无 Verifier | Runtime 无产物 | L0 Runtime |

当前 XLSX 的 L3 只表示 Runtime 机制已经证明，不表示支持任意 Excel 业务修改。当前
能力仍限定为一个 `.xlsx` 输入、固定测试 transform、一次增量修复和一个输出。

### 6.3 Word 受控试用目标

Word 是下一类优先 Worker，因为已确认的循环事故发生在复杂 DOCX 修改和验证中。

首版接纳：

- 读取 DOCX 段落、表格、样式、页眉页脚和基础 OOXML 结构；
- 修改文字、段落、表格、基础样式和已有结构；
- 原始输入只读，候选输出使用稳定路径和 revision；
- 验证 ZIP/OOXML、XML、relationship、关键结构和可渲染性；
- 验证通过后只交付一个最终 DOCX；
- 修复失败后复用同一脚本和候选文件，不重新加载完整聊天历史。

首版不承诺：

- 任意复杂修订痕迹和批注语义完全正确；
- Word 桌面端像素级一致；
- 宏、嵌入对象、复杂域代码和所有第三方 Office 扩展；
- 仅凭模型主观判断文件已完成。

修订痕迹、批注完整性和接受/拒绝全部修订必须有专项 Verifier 后才能加入支持范围。

### 6.4 Excel 生产目标

首版生产范围建议限定 `.xlsx`：

- 读取 Sheet、单元格类型、公式、命名区域、合并单元格和关键样式；
- 在保留公式和未授权区域的前提下修改数据、公式、样式和工作表；
- 检查工作簿可打开、公式引用、关键列、目标 Sheet 和预期数据变化；
- 必要时执行渲染抽查；
- 只发布通过验证的最终 `.xlsx`。

`.xls`、`.xlsm`、VBA、外部数据连接、Power Query 和复杂透视表不自动继承 `.xlsx`
支持结论，必须分别增加 Worker、fixture 和验收。

### 6.5 PowerPoint 生产目标

PPTX 在 Word 试点稳定后接入：

- 修改已有 PPTX 的文字、表格、图片、顺序和基础布局；
- 根据已授权 Office 数据生成一个完整 PPTX，而不是多个单页文件；
- 可使用用户上传的图片，不提供新图片生成能力；
- 验证 OOXML、Slide/media/notes 引用、页面数量和全部页面可渲染；
- 视觉溢出、字体替换和版式一致性作为独立视觉 Verifier；
- 一次对话最多交付三个用户明确要求的独立文件，不提供 ZIP fallback。

首版不把“可打开”升级为“设计质量已达到专业演示标准”。内容正确性、版式验证和
视觉质量必须分开记录。

### 6.6 PDF 边界

PDF 首版只作为输入、预览或转换来源，不作为优先编辑格式：

- 文本型 PDF 可提取后进入文件任务；
- 图片型 PDF 需要明确 OCR 能力和置信度；
- PDF 修改优先转换为 DOCX/PPTX 等可编辑格式后处理；
- 没有 OCR 或版式 Verifier 时，不声明完整读取或无损编辑。

## 七、进展与循环判断

新的 Artifact revision 或文件哈希变化不能单独算作有效进展。否则 Agent 可以不断
生成不同但仍然错误的文件。

有效进展至少满足一项：

- Verifier 失败项减少；
- 必要验收节点从失败变为通过；
- 一个计划节点被确定性关闭；
- 用户补充信息解除真实阻塞。

以下只属于状态证据，不单独放行：

- 脚本或产物哈希变化；
- 文件名变化；
- stdout 文本变化；
- 模型使用了不同措辞；
- 生成了新的候选 revision。

推荐规范化进展向量：

```text
task phase
target artifact identity
verification profile and version
sorted failed assertion codes
passed required assertion count
normalized error class
script hash
artifact hash
```

相同失败断言、相同修复意图且验证没有改善时，应在下一次 CodeAPI 执行前进入
`needs_input` 或 `failed`。现有 progress ledger 和 recursion limit 继续作为最后保险丝，
不承担正常任务编排。

## 八、效能与稳定性预期

对于未知、开放式工程任务：

- Claude Code 和 Codex CLI 的首次解决能力更强；
- File Agent Runtime 没有对应 capability 时必须明确拒绝或保持原生路线；
- 不应通过放开任意工具调用伪造通用能力。

对于已经沉淀 Worker 的重复 Office 任务：

- Runtime 不重复发送完整聊天、脚本和 stdout；
- 每次模型调用使用有界任务投影；
- 失败修复复用稳定工作区和脚本；
- 重启和重放不重复模型调用、CodeAPI 副作用、交易和产物；
- Verifier 通过后才交付；
- 下载卡、消息和 final event 完成后才结束“生成中”。

现有真实模型加隔离 CodeAPI 的 XLSX 验收结果：

```text
provider requests: 2
elapsed: 9.863 seconds
input tokens: 1,541
output tokens: 217
artifact count: 1
```

该结果证明协议和执行方向，不代表复杂 Word、Excel 或 PPT 的生产性能。生产效果必须
使用同一 fixture、同一验收条件和同一价格口径，与原生 Agent 路线做 A/B 对比。

## 九、当前状态与上线门禁

截至本文日期：

- File Agent Runtime 测试 35/35 通过；
- LibreChat Connector 测试 53/53 通过；
- 真实模型加隔离 CodeAPI 的 XLSX 契约验收通过；
- 完整 LibreChat 加隔离依赖的浏览器验收通过，覆盖重启恢复、计费、下载卡和无刷新
  结束；
- 真实外部非生产 CodeAPI、真实中转和完整 LibreChat 的联合 Phase 3D-C 尚未执行；
- 没有 Word、PPT、PDF Worker；
- 没有生产启动入口、生产 Runtime secret 或生产 feature flag；
- 当前状态不得描述为“已经具备 Claude Code/Codex 同等执行能力”或“Office 全格式
  已由 Runtime 支持”。

进入受控试用前必须完成：

1. 将 Action Envelope、规范化进展向量和跨轮次 `activeTaskRef` 固化为版本化契约；
2. 建设 Word Worker、Verifier 和事故回放 fixture；
3. 完成真实非生产 model relay、CodeAPI 和完整 LibreChat 联合验收；
4. 验证 Runtime、LibreChat、CodeAPI 和浏览器分别中断后的恢复；
5. 验证普通聊天不创建 Runtime task；
6. 使用 `vip998` 和显式 feature flag 做单任务受控试用；
7. 通过独立生产发布、回滚和业务验收后再扩大账号范围。

## 十、最终产品边界

首版明确接纳：

- LibreChat 复杂 Office 文件任务的持久状态、计划、执行、验证、恢复和交付；
- 一个任务内的多步执行和有进展的修复；
- 版本化 Worker 与确定性 Verifier；
- 原生 Token 计费、生成文件和下载卡。

首版明确延后：

- 通用仓库编码 Agent；
- 任意 Shell、Web、MCP 和多 Agent 编排；
- 所有 Office 格式和高级特性的自动兼容；
- 多模型协作和第二套模型管理后台；
- 对 Claude Code 或 Codex CLI 私有协议的运行时依赖。

首版明确不接纳：

- 通过提示词声称已经持久化任务状态；
- 以固定工具次数代替进展判断；
- 把不同文件哈希直接视为成功进展；
- 模型自行声明未经 Verifier 的文件可交付；
- Runtime 直接写 LibreChat 用户、消息、价格或交易数据库；
- 把 POC 验收结果宣传为 Office 全能力生产可用。
