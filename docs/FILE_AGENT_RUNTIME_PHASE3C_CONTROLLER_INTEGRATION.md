# File Agent Runtime Phase 3C Controller Integration 记录

Date: 2026-07-23

Status: repository implementation and version-pinned upstream overlay verified.
No production service, production Mongo collection, customer file, external
model request, billable request, or deployment was used.

## 一、这次解决什么

Phase 3B 已经具备 Mongo delivery、原生计费、原生生成文件、assistant message 与 final
event 交付能力，但运行中的 Agent Controller 尚无确定性的 Runtime 分流边界。本阶段增加：

```text
prepare route without writes
  -> persist authoritative LibreChat user message + conversation
  -> create immutable billing snapshot
  -> create/submit durable Runtime delivery
  -> Connector reconciler owns assistant/final/job completion
```

分流仅替换模型执行，不替换 LibreChat 的聊天、消息、会话、文件、计费和 SSE 协议。

## 二、为什么分成 prepare 与 submit

普通聊天、非 allowlist 用户、无文件请求和 Runtime 不支持的 MIME 必须在任何持久化前
返回 native。符合条件的请求先冻结一份 prepared route，其中包含 Runtime capability 与
输入身份摘要，但尚不创建 delivery 或 billing snapshot。

只有 prepared route 通过后才保存 user message/conversation。保存后请求不得再回到 native
Agent；Connector 会校验 instruction、file refs、session、model route 和消息身份没有变化。
变化即失败，不建立 delivery，从而避免同一轮同时执行 Runtime 与原生 Agent。

## 三、Controller 生命周期边界

版本锁定 overlay 位于：

```text
integrations/librechat-upstream/
  60eba76375213dafc1874d943e41371201c300ab/
```

它在 `initializeClient()` 之后、唯一的 `client.sendMessage()` 之前调用可选 Bridge。这样可以
复用 client 已解析的 attachments、endpoint、Agent identity 和 `saveMessageToDatabase()`，
同时保证 Runtime 接管时模型调用尚未开始。

Runtime 接管后 Controller 不做以下操作：

- 不调用 `client.sendMessage()`；
- 不生成 sibling response；
- 不启动 immediate/final title model call；
- 不保存最终 assistant 下载卡；
- 不 emit final event；
- 不 complete GenerationJob。

Controller 只清理自己的 MCP request context、pending request 计数和 client 引用。Runtime
任务的并发和容量必须由独立 Runtime 自己治理，不能借用 LibreChat Controller 的短期计数。

## 四、失败语义

失败分为三段：

1. prepared route 前或 capability probe 失败：未保存 user turn，不允许产生半条历史；
2. user turn 保存后、durable delivery 前失败：不回退 native，使用预分配 assistant ID 保存
   终态错误消息并结束当前 GenerationJob；
3. delivery 已存在但即时 reconcile 排队失败：delivery 仍是权威状态，等待周期 reconciler
   恢复，不结束 job、不调用 native。

Runtime submit 响应丢失仍由 delivery idempotency key 和 Connector 的 `pending` 状态恢复。

## 五、本地验证

```text
Connector tests: 37 passed
Connector syntax checks: passed
Runtime tests: 27 passed
Runtime syntax checks: passed
Pinned upstream overlay apply check: passed
Pinned upstream controller node --check: passed
Only one upstream source file changed: passed
Native client.sendMessage call count remains one: passed
Release governance validation: 32 passed
```

## 六、仍未完成

本阶段不是生产接入。下一道独立门禁仍包括：

1. 在完整非生产 LibreChat build 中实现 `prepareRequest` 的文件 ownership/CodeAPI resolver；
2. 把 Admin resolved tokenConfig 冻结到 billing snapshot；
3. 注册独立 delivery/billing collections 和周期 reconciler；
4. 只给测试账号与测试 conversation 注入 Bridge；
5. 验证普通聊天零 Runtime 调用、复杂 XLSX 单次 Runtime task、API/Runtime 重启恢复；
6. 验证关闭 flag 后新请求完全回到原路径；
7. 通过后另行设计 production package 和 release gate。
