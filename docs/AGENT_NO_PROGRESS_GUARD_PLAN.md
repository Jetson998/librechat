# LibreChat Agent 通用无进展防护方案

Date: 2026-07-24

Status: 方案已记录，尚未实施、未部署

## 一、决策

1. LibreChat 当前产品不支持生成图片，不接入 `image_gen` 或其他生图工具。
2. 用户可以上传已有图片，用于 Office/PPT 编辑和文档制作。
3. Agent 循环问题按公共运行时问题修复，不做 GPT、Fable、生图、Office 或某个
   Skill 的专用重试补丁。
4. `recursionLimit=50` 保留为最终安全上限，但不再承担正常的无进展判断。

## 二、事故证据

目标对话：

```text
https://152.32.172.162.sslip.io/c/435c96b0-4b32-4219-ac92-38755bda4cca
```

已确认：

- 模型声称已经生成图片，但没有真实图片工具调用和图片产物；
- `/mnt/data` 始终只有原始 PPTX，没有新的 PNG、JPG、JPEG 或 WebP；
- Agent 使用不同脚本反复扫描相同目录，约十五次没有产生新的文件状态；
- 最终由 LangGraph 的 `Recursion limit of 50` 异常终止；
- 没有交付更新后的 PPTX 和下载卡。

该事故说明只比较工具名称或完整参数不够。模型可以改写 Bash/Python 脚本，但仍然
得到相同的外部状态，运行时必须判断“结果和产物是否变化”。

## 三、目标

在原生 LibreChat Agent 的公共工具执行入口增加 run-scoped progress ledger，覆盖：

- `bash_tool`、`read_file`、`skill`；
- Office/PPT/Excel/Word 解析与生成；
- Web 搜索、MCP 和其他后续新增工具；
- GPT、Fable、Opus 和后续新增模型；
- 串行及并行工具调用。

防护依据状态变化，不依据某个工具固定最多调用三次或五次。

### 3.1 两层职责

本方案明确区分两层：

- 原生 Agent 公共防护负责立即截住可确定的重复状态、重复错误和重复产物检查；
- 独立 File Agent Runtime 负责复杂文件任务的计划、执行、验证、repair 和语义进展。

工具层无法可靠判断一串“每次文本都不同、但对用户目标都无用”的输出是否取得语义
进展。不能用模糊文本相似度假装解决该问题。此类复杂任务应由已有 File Agent
Runtime 的结构化 plan、verification fingerprint 和 action signature 判断。

因此第一阶段解决生产中可观测、可确定的循环，不宣称替代完整 Agent Runtime。

## 四、不采用的方案

- 不单纯降低 `recursionLimit`；
- 不按工具总调用次数直接截断正常复杂任务；
- 不只比较完整 Bash 命令，因为模型可用不同代码重复同一检查；
- 不把 `Grep`、`Glob` 或其他不存在的工具转换为任意 shell 命令；
- 不修改上传、Office 预解析、CodeAPI 文件挂载和下载卡链路；
- 不等待独立 File Agent Runtime 生产接入后再处理原生 Agent 的公共风险。

## 五、生图能力收口

### 5.1 能力声明

共享模型提示词和相关 Skills 不得再声明可以调用图片生成模型。实际工具目录是能力
事实来源，提示词不得描述未注册工具。

当用户明确要求生成图片时，统一回复：

```text
当前产品暂不支持生成图片。你可以上传已有图片，继续用于 PPT 或其他文档制作。
```

### 5.2 成功声明约束

模型不得仅根据自己的计划或思考内容声称“已生成”。文件类成功必须至少存在：

- 对应工具的成功结果；
- 新增或更新后的产物引用；
- 可交付文件名或下载卡所需的文件记录。

没有产物引用时，只能报告能力不可用或执行失败。

## 六、通用进展账本

### 6.1 作用域

账本以 `run_id` 为主键，`thread_id` 和 `agentId` 只用于审计。不同用户、对话和
回复不得共享进展状态。

账本保存在 API 进程内，设置 TTL 和最大条目数。一次运行仍由同一 worker 执行；
运行结束或 TTL 到期后清理，不写入用户消息和模型上下文。

### 6.2 三类指纹

每个工具结果记录三类稳定指纹：

1. `callFingerprint`
   - 规范化后的工具名；
   - canonical JSON 参数；
   - 去除 `toolCallId`、`stepId`、`turn`、时间戳等运行时字段。
2. `observationFingerprint`
   - success/error 状态；
   - 规范化后的错误码或错误签名；
   - 有界、去 ANSI 和工具模板噪声后的结果内容；
   - JSON 结果按 key 排序后计算，普通文本折叠无意义空白。
3. `artifactFingerprint`
   - 文件路径或名称；
   - resource/storage 引用；
   - 可用时的内容 hash、size、version；
   - create/edit/write 工具返回的持久化结果。

原始大段 stdout 不进入账本，只保存 hash、计数和最多一段有界诊断摘要。

### 6.3 进展定义

满足任一条件视为产生进展：

- `artifactFingerprint` 变化；
- 创建、修改或发布了持久化文件；
- 工具返回以前未观察过的有效结果；
- 长任务的显式状态 token、cursor、checkpoint 或完成比例变化；
- 模型切换到不同目标、不同文件、不同范围或不同查询，并获得新信息。

以下情况不视为进展：

- 相同或等价工具调用返回相同结果；
- 不同 Bash/Python 脚本返回已经观察过的相同目录或文件状态；
- 反复收到相同 `Tool not found`、权限、参数或文件不存在错误；
- 只有思考文案变化，没有工具结果或产物状态变化；
- 仅产生新的临时调用 ID、时间戳或格式差异。

## 七、状态机

### 7.1 Normal

正常执行工具。新观察或新产物会更新账本。

### 7.2 Stalled

当某个已观察状态在没有产物变化的情况下再次出现：

- 返回本次真实工具结果；
- 附加机器可识别的 `NO_PROGRESS_WARNING`；
- 明确要求模型停止等价检查，只能换策略、使用已有证据作答或报告能力不可用；
- 允许一个后续策略动作，不立即按总调用次数杀死任务。

如果后续动作获得新观察或新产物，状态恢复为 `Normal`。

### 7.3 Stop Requested

进入 `Stalled` 后，后续动作仍返回已经观察过的状态且没有产物变化：

- 返回 `NO_PROGRESS_STOP` 工具结果；
- 要求模型不再调用工具，使用已有结果完成回复；
- 保留本轮已生成文件和已有工具结果。

### 7.4 Terminal Abort

模型在收到 `NO_PROGRESS_STOP` 后仍继续调用工具时，公共执行入口立即抛出
`AgentNoProgressError`，不再执行工具，不等待 `recursionLimit=50`。

用户可见文案：

```text
检测到重复执行但没有产生新结果，系统已停止继续尝试。已生成文件仍然保留。
```

技术详情保留 `run_id`、工具名、指纹和停机原因，只写服务日志，不把完整参数、
用户文件内容或密钥写入错误消息。

## 八、轮询和长任务

合法轮询不能依赖模型反复运行 `ls` 或 `find`。支持轮询的工具必须返回：

- 稳定 task/job ID；
- 状态 token 或 cursor；
- `retryAfter`；
- 明确的 pending/completed/failed 状态。

状态 token 变化算进展；同一 token 重复且未到 `retryAfter` 时不执行；超过工具自身
等待预算后进入 `needs_input` 或可见停止状态。该机制与普通工具的无进展判断共用
账本，但不把等待中的一次合法轮询误判为死循环。

## 九、实现位置

第一阶段只改原生 LibreChat Agent 公共路径：

1. 在当前 API 包的 `ON_TOOL_EXECUTE` 公共入口接入独立
   `tool-progress-guard` 模块；
2. 在工具调用规范化后、实际加载和执行前进行 terminal/preflight 检查；
3. 在工具结果清洗和 artifact 归一化后更新账本；
4. 通过现有 handler 返回 warning/stop，必要时由 `reject` 终止 graph；
5. 在现有上下文安全 UI 中增加 `AgentNoProgressError` 的友好映射；
6. 共享提示词只增加能力事实与停止契约，不写某个模型专用规则。

独立 File Agent Runtime 已有 verification fingerprint 和
`repeated_no_progress_plan` 机制。后续生产接入时复用同一语义，但不把两个运行时
耦合成一个进程或共享内存模块。

## 十、误判保护

- 仅在同一 `run_id` 内判断；
- 并行工具批次作为同一 step 结算，避免并行结果互相误判；
- 读取不同文件、不同页码、不同 sheet/range 不视为重复；
- 文件写入后 artifact epoch 变化，允许重新读取和验证；
- 首次重复只警告并允许换策略；
- 输出规范化只移除明确的运行时噪声，不做模糊语义猜测；
- 无法可靠规范化的结果退化为 exact hash，不扩大拦截范围。

## 十一、测试矩阵

必须覆盖：

1. 相同命令和相同结果重复时进入 warning；
2. 不同脚本返回相同文件清单时识别为相同 observation；
3. warning 后改用有效写入工具并产生文件，恢复正常；
4. warning 后继续得到旧状态，返回 stop；
5. stop 后仍调用工具，立即抛出 `AgentNoProgressError`；
6. 不同文件、sheet、页码和搜索查询正常执行；
7. 文件修改后允许重新验证同一路径；
8. 合法 polling 状态 token 变化时正常继续；
9. 相同 `Tool not found` 或文件不存在错误不会循环到 50 步；
10. 并行工具调用不会互相污染；
11. GPT、Fable 共用同一防护，不使用模型名称分支；
12. 明确生图请求返回“不支持”，不调用 Bash 搜索不存在的图片；
13. 现有 Office 上传、解析、PPT/Excel 修改与下载卡回归通过；
14. 现有 Fable 工具别名兼容仍然通过；
15. `recursionLimit=50` 和上下文保护配置保持不变。

## 十二、发布边界

实施需要一个新的、仓库内可追踪的 production patch 和 release record：

- 先提交实现与自动化测试；
- CI/本地门禁通过后再批准生产写入；
- 生产只替换经过校验的 API 包和对应前端错误映射；
- 只重建 LibreChat API；若前端映射使用外置资产，则只更新该受控资产；
- 不重启 CodeAPI、MongoDB、Office Converter、RAG 或 Admin Panel；
- 不修改历史消息、历史文件和历史 transaction。

生产验收最多使用一个非敏感、低 Token 测试任务，证明循环在状态重复后提前停止，
并使用已有正常 Office 回归证据验证未影响文件链路。

## 十三、后续架构收口

原生 Agent 的公共防护上线后，复杂 Office/文件任务仍按已批准的混合架构逐步切换到
独立 File Agent Runtime。切换前必须完成非生产真实接入和独立生产发布方案。

File Agent Runtime 已具备：

- 版本化计划和 action cursor；
- verification fingerprint；
- 相同失败状态下的 repair plan 对比；
- `repeated_no_progress_plan` 停止条件；
- 中断恢复、调用账本和有界上下文投影。

该层解决“输出各不相同但计划没有推进”的语义循环；原生工具防护继续作为所有模型、
工具和普通对话的最后一道公共保护。两层不共享进程状态，也不增加 LibreChat 与
CodeAPI 的直接耦合。

## 十四、回滚

发布前备份：

- 当前 API 包；
- Compose override；
- 若修改共享提示词，备份完整 base Mongo 配置文档；
- 若修改前端外置资产，备份当前资产目录。

回滚恢复精确备份，只重建本次变更涉及的服务。无进展账本只在内存中存在，回滚
不需要迁移数据。
