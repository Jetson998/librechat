# File Agent Runtime Phase 3 LibreChat Connector 方案

Date: 2026-07-23

Status: design gate approved and Phase 2B prerequisite satisfied. Connector
implementation may begin in the repository, but this plan does not approve
production traffic, customer files, billable acceptance, or deployment.

## 一、目标

Phase 3 在 LibreChat 与独立 File Agent Runtime 之间增加一个窄 Connector，验证
复杂文件任务可以脱离聊天 Agent 循环执行，同时继续复用 LibreChat 原生的用户、
会话、消息、价格、交易、文件和下载卡能力。

本阶段要解决的不是 Office 解析或生成算法，而是以下交付可靠性问题：

- 同一用户消息只提交一个 Runtime task；
- LibreChat、Runtime 或浏览器中断后可以按事件游标恢复；
- 每条 Runtime usage 只进入 LibreChat transaction 一次；
- 每个已验证 artifact 只持久化和挂载一次；
- assistant 消息、附件和 final event 完成后，前端才结束“生成中”；
- Runtime 已接受的任务不得自动回退原 LibreChat Agent，避免重复执行和重复计费。

## 二、阶段前置门禁

Phase 3 实现前必须先完成 Phase 2B，并留下可审计结果：

1. 使用一个受限非生产 Key 和一个 allowlisted route；
2. 仅使用仓库 XLSX fixture，最多执行一个完整真实模型任务；
3. 确认 `/v1/chat/completions`、`response_format`、usage、缓存 Token 和
   `Idempotency-Key` 的真实兼容行为；
4. 记录模型计划质量、调用次数、Token 和延迟；
5. 不写 LibreChat transaction，不访问客户文件，不部署生产。

Phase 2B 已通过，证据见
`docs/FILE_AGENT_RUNTIME_PHASE2B_REAL_RELAY_ACCEPTANCE.md`。Connector 实现仍必须先
完成本地契约测试和 release gate；在单独审批前，不得让 LibreChat 请求路径启用真实
Runtime route 或 feature flag。

## 三、责任边界

### LibreChat Connector 负责

- 确定性复杂文件路由；
- 校验当前用户、会话、消息和输入文件所有权；
- 在提交前把授权输入 prime 到同一个 CodeAPI session；
- 创建 LibreChat 自己的持久 delivery record；
- 使用幂等键提交 Runtime task；
- 按持久 sequence 消费 Runtime 事件；
- 把四粒度 usage 写入 LibreChat 原生 transaction；
- 通过 `processCodeOutput()` 持久化 artifact；
- 保存或更新原 assistant message 的附件与最终文本；
- 持久化并发送 GenerationJobManager final event；
- 重启后 reconciliation。

### Connector 不负责

- 模型计划、脚本生成、执行和验证；
- 复制 Runtime task store 或完整事件正文；
- 新建价格、余额、用户、会话、消息或文件系统；
- 直接下载浏览器文件或生成第二种下载卡；
- 把完整 stdout、脚本、文件正文或模型原始响应写入聊天消息；
- 在 Runtime 已接受任务后自动调用原 LibreChat Agent 作为 fallback。

## 四、模块结构

Phase 3 代码必须以独立 Connector 模块存在，不把协调逻辑继续堆进 Agent prompt、
Office pre-parse 或 `BaseClient` 主循环。

```text
LibreChat Connector
  task-router
  task-manifest-builder
  runtime-client
  delivery-store
  event-consumer
  usage-ingestion
  artifact-delivery
  message-finalizer
  task-reconciler
```

端口依赖：

```text
task-router -> existing user/message/file ownership services
runtime-client -> Runtime HTTP/JSON API
usage-ingestion -> prepareStructuredTokenSpend + bulkWriteTransactions
artifact-delivery -> processCodeOutput
message-finalizer -> existing db.saveMessage/db.updateMessage
message-finalizer -> GenerationJobManager.emitDone/completeJob
```

禁止 Connector 导入 Runtime 内部类。双方只能依赖版本化 HTTP 契约。

## 五、确定性路由

Phase 3 不增加路由模型。只有同时满足以下条件才进入 Runtime：

- feature flag 已开启且账号在非生产 allowlist；
- 当前消息包含已完成所有权校验的 Office、PDF、Markdown 或数据文件；
- 用户明确要求读取后修改、生成、转换、汇总或交付新文件；
- capability discovery 表示 Runtime 支持该 `taskContractVersion`、文件类型和输出；
- 模型 route 和 LibreChat 价格快照可用；
- 输入已成功 prime 到一个任务专属 CodeAPI session。

图片理解、无文件聊天、只基于短预览回答、普通标题生成以及 Runtime 未声明支持的
文件任务继续走 LibreChat 原链路。

路由决策顺序：

1. 校验身份和当前会话文件范围；
2. 计算确定性 intent；
3. 检查 Runtime capability；
4. 建立 delivery record 和 GenerationJob；
5. 提交 task；
6. task 被 Runtime 接受后终止原 Agent 调用分支。

如果 Runtime 在接受前不可达，可以明确回到原链路或返回暂不可用。Runtime 已返回
`taskId` 后不得自动回退，因为此时外部模型或 CodeAPI 可能已经产生副作用和费用。

## 六、LibreChat Delivery Record

Connector 需要一个由 LibreChat 管理的窄持久记录。它不是第二套 Runtime task，
只保存跨系统交付状态和幂等游标。

```json
{
  "schemaVersion": "1.0",
  "taskId": "runtime-task-id",
  "taskContractVersion": "office-file-agent.v1",
  "user": "librechat-user-id",
  "tenantId": "tenant-id-or-null",
  "conversationId": "conversation-id",
  "userMessageId": "user-message-id",
  "assistantMessageId": "preallocated-response-message-id",
  "streamId": "generation-stream-id",
  "status": "running",
  "lastSequence": 17,
  "billingSnapshotRef": "librechat-owned-snapshot-ref",
  "usageReceipts": {
    "task-id:plan:1:0": "completed"
  },
  "artifactReceipts": {
    "artifact-id": {
      "status": "completed",
      "fileId": "librechat-file-id"
    }
  },
  "finalization": {
    "messageSaved": false,
    "finalEventSaved": false,
    "jobCompleted": false
  },
  "retry": {
    "attempts": 0,
    "nextAt": null,
    "lastErrorCode": null
  },
  "createdAt": "2026-07-23T12:00:00Z",
  "updatedAt": "2026-07-23T12:00:10Z"
}
```

唯一约束：

```text
taskId
conversationId + userMessageId + taskContractVersion
```

记录不得保存 API Key、Runtime base URL、完整用户对象、完整事件、完整脚本、文件
正文或价格表。价格快照由 LibreChat 自己持有，Runtime 只接收 opaque ref。

状态：

```text
submitting -> running -> needs_input
                    -> delivering -> completed
                                  -> delivery_retry
                                  -> delivery_failed
                    -> failed
                    -> canceled
```

`Runtime completed` 与 `LibreChat completed` 不是同一状态。只有消息、附件和 final
全部持久化后，LibreChat delivery 才能进入 `completed`。

## 七、任务提交幂等

提交键：

```text
sha256(
  conversationId +
  userMessageId +
  sorted(input file_id + content hash) +
  taskContractVersion
)
```

同一键：

- 相同 manifest 返回原 `taskId`；
- 不同 manifest 返回冲突并停止；
- API 请求超时后先按本地 delivery record 和同一键查询，不创建第二个任务；
- preallocated `assistantMessageId` 和 `streamId` 在重试中保持不变。

输入 session 失效时不得新建第二个 task。Connector 重新 prime 后通过受控 rebind
或 `steer` 更新输入引用，并从 Runtime 最近检查点继续。

## 八、事件消费

首版只使用持久轮询：

```text
GET /v1/tasks/{taskId}/events?after={lastSequence}
```

SSE 或 webhook 只允许作为以后加速机制，不能成为唯一事实源。

每批事件处理规则：

1. 必须按 sequence 升序；
2. `sequence <= lastSequence` 直接忽略；
3. 发现 sequence 缺口时停止本批并重新拉取；
4. 每个事件的业务副作用完成后才能推进 `lastSequence`；
5. 进程中断后从最后持久 sequence 重放；
6. 未知非终态事件记录摘要并跳过，未知终态事件停止并告警。

映射：

| Runtime event | LibreChat action |
| --- | --- |
| `task.accepted` / `task.phase_changed` | 更新 delivery 状态和轻量进度 |
| `usage.recorded` | 幂等写原生 transaction |
| `artifact.ready` | 调用 `processCodeOutput()` 并记录 `fileId` |
| `task.needs_input` | 保存可恢复状态并向同一对话请求补充信息 |
| `task.completed` | 检查 usage 与 artifact 均已消费后进入 finalization |
| `task.failed` | 保存失败消息和 final error |
| `task.canceled` | 保存取消状态并结束 generation job |

## 九、usage 入账

Runtime usage 映射到 LibreChat 原生结构：

```text
promptTokens.input = inputTokens
promptTokens.read = cacheReadTokens
promptTokens.write = cacheWriteTokens
completionTokens = outputTokens
```

Connector 使用提交时的 LibreChat 价格快照调用：

```text
prepareStructuredTokenSpend(...)
bulkWriteTransactions(...)
```

交易继续保留：

- user、conversationId、assistantMessageId；
- endpoint / model route 的 LibreChat 映射；
- prompt 输入、缓存读取、缓存写入和 completion 两条原生交易粒度；
- `rateDetail`、`rawAmount`、`tokenValue` 和余额逻辑；
- 用户用量看板现有聚合口径。

提交任务时，Connector 在 LibreChat 内保存一个不可变的单任务 billing snapshot，
并把其 ID 写入 `billingSnapshotRef`。它只包含当前任务实际使用的一条模型配置：

```text
snapshotId
modelRouteId
endpoint
model
prompt price
completion price
cache read price
cache write price
balance/transaction switches
pricing config version or digest
createdAt
```

该 snapshot 不复制完整 Admin 价格表，不发送给 Runtime，也不在任务完成后重新读取
当前价格。任务内全部 usage 使用同一 snapshot；后台改价只影响之后提交的新任务。

幂等规则：

- `usageEventId` 是唯一业务键；
- receipt 只有在 transaction 写入成功后才能标记 `completed`；
- transaction 文档使用由 `usageEventId + tokenType` 派生的稳定 Mongo `_id`；
- 重放时先按稳定 `_id` 查询，缺哪条补哪条；
- prompt 和 completion 必须全部落库后才完成 receipt；
- 不允许先标记 receipt 再异步写交易；
- Runtime 不接收价格、费用或余额结果。

这保证 API 在“交易已写、receipt 未写”之间中断时，reconciler 可以识别已有稳定
交易并补齐 receipt，而不是重复扣费。

## 十、artifact 交付

`artifact.ready` 必须通过现有 `processCodeOutput()`：

```text
id = artifact.codeEnvRef.file_id
session_id = artifact.codeEnvRef.storage_session_id
name = artifact.name
toolCallId = stable "file-agent:<artifactId>"
conversationId = delivery.conversationId
messageId = delivery.assistantMessageId
```

流程：

1. 校验 artifact verification 为 `passed`；
2. 校验 MIME、扩展名、大小和最多三个可见文件规则；
3. 调用 `processCodeOutput()`；
4. 持久化返回的 LibreChat `file_id` 到 artifact receipt；
5. 需要 preview 时触发已有 deferred finalize；
6. 最终 message 只挂载 receipt 中已完成的文件；
7. “生成的文件”继续通过 assistant message 与 execute_code file 关联自动展示。

如果在 `processCodeOutput()` 完成后进程中断，现有按 filename、conversation 和
context 的 claim 会收敛到同一 file record；Connector 再通过 artifact receipt
补齐映射，不建立第二套文件记录。

Runtime 只允许发布通过验证的最终 artifact。中间脚本、日志、临时图片和验证文件
不得进入 `artifact.ready`。

## 十一、消息与前端完成态

Connector 必须复用请求开始时预分配的 `assistantMessageId`，不能在 delivery 时
再创建 sibling message。

成功顺序固定为：

1. 确认 Runtime `task.completed` 已持久；
2. 确认全部 usage receipts 完成；
3. 确认全部可见 artifact receipts 完成；
4. 使用确定性模板根据已交付 artifact 生成简短结果文本；
5. 使用现有 message persistence 保存同一 assistant message 的文本和附件；
6. 调用 `GenerationJobManager.emitDone(streamId, finalEvent)`，持久 final event；
7. 调用 `GenerationJobManager.completeJob(streamId)`；
8. 把 delivery 标记为 `completed`。

结果模板只说明任务完成、文件名和下载可用状态，不额外调用模型。例如：

```text
已完成文件处理并生成 report.pptx，文件已附在本条回复中，可直接下载。
```

不得在第 5 步之前向浏览器发送 final。否则会重现“文件已生成，但前端仍生成中”
或“回复完成但下载卡缺失”的竞态。

如果浏览器已断线，第 5 步保存的消息保证刷新可见；如果 API 在第 5 至第 8 步之间
中断，reconciler 根据三个 finalization 布尔状态继续，不重新执行 Runtime task。

## 十二、Reconciler

API 启动后和固定间隔扫描非终态 delivery records：

```text
submitting
running
delivering
delivery_retry
needs_input
```

行为：

- `submitting`：用同一 idempotency key 查询或重交；
- `running`：从 `lastSequence` 拉取事件；
- `delivering`：只补 usage、artifact、message 或 final 中缺失的步骤；
- `delivery_retry`：按错误类别指数退避；
- `needs_input`：不自动调用模型，等待同一用户 steer；
- Runtime 已完成但 LibreChat 未完成：只做 delivery，不重新执行任务；
- 超过租约的 consumer 可由另一 API 副本接管。

每条 delivery 使用短租约：

```text
leaseOwner
leaseExpiresAt
```

多副本只能有一个活动 consumer，但幂等 receipt 仍是最终保护，租约本身不能代替
业务幂等。

## 十三、取消和 steer

- 用户停止生成时，Connector 调用 Runtime cancel 并等待持久 `task.canceled`；
- cancel 请求重复发送必须幂等；
- 已发布且已持久化的 artifact 不删除，未发布中间物不展示；
- `needs_input` 的用户补充通过 Runtime `steer`，不创建新 conversation、message
  或 task；
- steer 使用唯一 `instructionId`，重复提交不增加 plan revision；
- 取消后不得再写新的 usage 或 artifact，已发生的 usage 仍需正常入账。

## 十四、安全

Phase 3 Runtime 仍只绑定内部地址，不向浏览器或公网开放。

Connector 到 Runtime 的请求必须包含服务认证，并绑定：

```text
taskId
user scope
conversation ref
allowed CodeAPI session
allowed file IDs
capability profile
expiry
```

要求：

- 浏览器不能提交任意 Runtime manifest；
- Runtime 不能列举 LibreChat 用户、会话或文件；
- 日志不写 Authorization、Key、文件正文、完整 task identity 或价格；
- delivery record 不保存 Runtime URL 和 credential；
- artifact 下载仍只经过 LibreChat 现有鉴权接口；
- 非生产测试只使用仓库 fixture 和测试账号。

## 十五、实现阶段

### Phase 3A：本地 Connector contract POC

前置：Phase 2B 通过。

- 使用隔离 LibreChat ports 和本地 Runtime fixture；
- 实现 manifest builder、runtime client、delivery state machine 和 event consumer；
- transaction、message、GenerationJobManager 和 `processCodeOutput()` 使用记录化 ports；
- 不接 Mongo、不构建生产 bundle、不调用外部模型。

### Phase 3B：非生产 LibreChat 集成

- 增加真实 delivery store 和 lease；
- 接入原生 transaction、message、GenerationJobManager 和 `processCodeOutput()`；
- 只对测试账号和测试 conversation 开 flag；
- Runtime、LibreChat API 和浏览器分别做一次中断恢复；
- 不进入生产，不使用客户文件。

### Phase 3C：受控发布候选

- 形成 versioned production patch 和回滚包；
- 完成 release governance 的 package、CI 和独立构建证据；
- 仍需 Phase 4 单独生产审批才能部署。

## 十六、验收场景

至少覆盖：

1. 同一 user message 重交只产生一个 Runtime task；
2. task 接受后不调用原 LibreChat Agent；
3. sequence 重放不重复更新进度；
4. 两条 usage 重放不重复 transaction 或扣费；
5. prompt 保留输入、缓存读、缓存写，completion 保留输出；
6. artifact 重放只产生一个 LibreChat file record；
7. 最多三个可见最终 artifact，中间文件不交付；
8. assistant message 使用预分配 messageId，无重复 sibling；
9. artifact 完成而 API 中断后，reconciler 只补消息和 final；
10. final event 丢失后刷新仍能看到消息和下载卡；
11. 浏览器断线不取消 Runtime task；
12. Runtime 重启后从 task checkpoint 继续；
13. LibreChat API 重启后从 delivery lastSequence 继续；
14. `needs_input` 等待 steer，不循环调用模型；
15. cancel 停止后续执行，已产生 usage 仍只入账一次；
16. 普通聊天和图片理解完全不经过 Connector；
17. delivery、日志和 task manifest 中无 Key、URL、价格或文件正文。

## 十七、停止条件

出现以下任一情况不得进入下一阶段：

- Phase 2B 无法证明结构化 plan 或 usage 粒度；
- 真实 route 不支持可靠幂等，且 ambiguous reconciliation 未定义；
- transaction 无法通过稳定键做到可恢复去重；
- `processCodeOutput()` 重放会产生重复文件；
- message finalization 仍可能先于附件持久化；
- 普通聊天被误路由；
- Runtime 需要访问 LibreChat Mongo、价格或消息 schema；
- 测试需要客户文件或生产账号才能通过。

## 十八、明确不做

Phase 3 不做：

- 生产部署和生产流量；
- 浏览器直连 Runtime；
- 新计费系统、新文件库或新消息协议；
- 模型自动路由；
- Word、PPT、PDF 等 Worker 扩面；
- 任意 shell 工具暴露；
- 把 Runtime 进度逐条写成聊天消息；
- 在 Runtime 已接受任务后自动回退原 Agent；
- 复用或嵌入 Codex app-server。

## 十九、回滚

本设计阶段没有运行时影响。后续 Phase 3A 仍只包含本地 POC，回滚为撤销对应提交。
Phase 3B 必须提供独立 feature flag；关闭后所有新请求回到原 LibreChat 链路，已有
Runtime task 由 reconciler 完成交付或明确取消，不能静默丢弃。
