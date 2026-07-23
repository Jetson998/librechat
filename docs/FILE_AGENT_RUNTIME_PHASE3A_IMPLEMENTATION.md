# File Agent Runtime Phase 3A Connector 实施记录

Date: 2026-07-23

Status: implemented and locally verified. Phase 3B non-production LibreChat
integration has not started. No production traffic, customer file, external
model call, Mongo write, transaction, or deployment was used.

## 一、实施范围

新增独立包：

```text
services/librechat-file-agent-connector
```

Connector 源码只依赖 Runtime 的版本化 HTTP/JSON 契约，不导入 Runtime 内部类。测试
使用现有 `FileAgentRuntime` 启动本地 fixture，并把请求交给真实 HTTP handler；
LibreChat 侧 transaction、文件、消息和 GenerationJobManager 全部使用记录化 ports。

Runtime HTTP 新增只读能力发现：

```text
GET /v1/capabilities
```

Phase 3A 默认只声明已验证的 XLSX 输入、XLSX 输出、`office-file-agent.v1`、
`office_transform`、`office-planner-v1` 和最多三个可见 artifact，不提前声称 Word、
PPT、PDF worker 已可用。

## 二、模块

```text
task-router
task-manifest-builder
runtime-client
delivery-store
event-consumer
usage-ingestion
artifact-delivery
message-finalizer
connector/reconciler
recorded LibreChat ports
```

路由只在 feature flag、测试账号 allowlist、当前会话文件所有权、复杂文件意图、
CodeAPI session、模型 route、billing snapshot 和 Runtime capability 全部满足时返回
Runtime。普通聊天、无文件消息和不支持的 MIME 返回原 LibreChat 链路，且不创建
delivery record。

## 三、任务与幂等

Manifest 使用哈希后的 user、conversation、message 和 LibreChat file refs，只包含
授权 CodeAPI ref、文件哈希、MIME、模型 route、opaque billing ref 和限制。禁止包含
API Key、Runtime URL、价格、历史消息、完整用户对象或文件正文。

提交键固定为：

```text
sha256(conversationId + userMessageId + sorted(fileRef + sha256) + contractVersion)
```

同一用户消息和相同 manifest 返回原 taskId；manifest 冲突停止。同一 delivery 一旦
获得 taskId，Connector 返回 `suppressNativeAgent: true`，不能回退原 Agent 再执行。

Phase 3A 的 `MemoryDeliveryStore` 为了验证 submitting 恢复，在内存中保留安全
submission envelope。它不落盘。Phase 3B 的持久实现应从 LibreChat 权威消息和文件
记录重建，或只保存同等脱敏的最小 envelope，不能复制价格表或用户对象。

## 四、事件与恢复

Connector 只使用：

```text
GET /v1/tasks/{taskId}/events?after={lastSequence}
```

每个事件业务副作用完成后才推进 `lastSequence`。sequence 缺口停止本批并进入
`delivery_retry`，不会越过缺失事件。

关键映射：

- `usage.recorded`：以 `usageEventId + tokenType` 派生稳定交易 ID；
- `artifact.ready`：确认 Runtime verification passed，校验 MIME、扩展名、大小和三份
  上限，再用稳定 claim 调用记录化 `processCodeOutput()` port；
- `task.needs_input`：保存同一 assistant message，等待 steer，不循环调用模型；
- `task.completed`：usage 和 artifact receipt 全部完成后才进入 finalization；
- `task.failed` / `task.canceled`：保存同一消息并结束同一 generation job。

暂时性 message/final 持久化中断进入 `delivery_retry`。artifact 策略违规进入
`delivery_failed`，不会创建第四个文件记录。

## 五、完成顺序

成功交付固定为：

```text
usage receipts
artifact receipts
assistant message saved
final event saved
generation job completed
delivery completed
```

测试分别在“artifact 已完成、message 未保存”和“message 已保存、final 未保存”处
模拟中断。恢复后不会重新提交 Runtime task、重复 transaction、重复文件、重复消息或
创建 sibling。

## 六、测试

Connector 包覆盖 capability 路由、重复提交、usage/artifact 幂等、消息与 final
顺序、重启恢复、`needs_input`、steer、cancel、三文件上限、sequence gap 和脱敏。

本地门禁：

```text
connector syntax checks: passed
connector tests: 15 passed, 0 failed
runtime tests: 27 passed, 0 failed
diff check: passed
```

## 七、边界与下一阶段

Phase 3A 证明跨系统契约和恢复顺序，不证明生产 LibreChat 已接入。

Phase 3B 仍需：

- Mongo-backed delivery store、唯一索引和 lease；
- 接入真实价格快照、`prepareStructuredTokenSpend()` 与 transaction bulk write；
- 接入真实 `processCodeOutput()`、message persistence 和 GenerationJobManager；
- 测试账号 feature flag 与签名服务认证；
- LibreChat API、Runtime 和浏览器中断恢复；
- 独立非生产验收和回滚记录。

在 Phase 3B 完成前，不得连接生产聊天流量或客户文件。
