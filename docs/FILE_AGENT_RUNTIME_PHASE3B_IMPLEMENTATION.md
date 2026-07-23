# File Agent Runtime Phase 3B 原生适配实施记录

Date: 2026-07-23

Status: repository-side non-production integration contracts implemented and
locally verified. No real Mongo deployment, LibreChat API process, customer
file, external model call, production traffic, or deployment was used.

The repository-side LibreChat host composition is also implemented; see
`docs/FILE_AGENT_RUNTIME_PHASE3B_HOST_WIRING.md`.

## 一、实施范围

Phase 3B 在现有 Connector POC 上增加可注入的 LibreChat 原生适配层，不伪造本仓库
中不存在的上游 `api/` 源码目录。宿主集成必须显式注入已核对签名的 LibreChat 函数、
Mongo collection 和消息/final-event builder。

新增模块：

```text
mongo-delivery-store
mongo-billing-snapshot-store
native-ports
service-scope
librechat-host-integration
```

Runtime HTTP server 增加可选 `authorizeRequest` hook。`/v1/*` 可以启用服务签名，
`/healthz` 仍用于内部存活检查。默认开发入口没有自动配置生产 secret 或公网监听。

## 二、Mongo delivery 与租约

`MongoDeliveryStore` 建立以下索引：

```text
unique idempotencyKeyHash
unique conversationId + userMessageId + taskContractVersion
status + retryNextAt
leaseExpiresAt
```

创建时同时核对 idempotency identity 与消息契约 identity。相同提交返回原 delivery，
任一 identity 指向不同 manifest 时停止，不覆盖原记录。

mutation 使用 `version` 乐观更新，冲突后重新读取再执行 mutator。Reconciler 在 store
支持 lease 时先获取短租约；另一 API 副本持有有效租约则跳过，过期后允许接管，最后
在 `finally` 释放。租约只减少并发 consumer，usage/artifact/finalization receipt 仍是
业务幂等的最终保护。

## 三、不可变计费快照与 usage

`MongoBillingSnapshotStore` 每个任务只保存当前模型 route 的：

```text
endpoint
model
prompt / completion / cacheRead / cacheWrite prices
pricing
endpointTokenConfig
balance switch
transaction switch
pricing digest
```

快照没有 update API，并递归拒绝 `apiKey`、`authorization`、`baseURL`、password、
secret 和 service token 字段。Runtime 不接收价格或费用。

`NativeLibreChatPorts.writeUsageTransactions()` 使用快照调用：

```text
prepareStructuredTokenSpend(txData, tokenUsage, pricing)
bulkWriteTransactions({ user, docs }, dbOps)
```

映射固定为：

```text
promptTokens.input = inputTokens
promptTokens.read = cacheReadTokens
promptTokens.write = cacheWriteTokens
completionTokens = outputTokens
```

每条 transaction `_id` 由 `usageEventId + tokenType` 稳定派生。写入前查询 prompt 与
completion 的已有 ID，只把缺失 entry 交给原生 bulk writer。测试覆盖全部重放不重复
扣费，以及 prompt 已有、只补 completion 的部分恢复。

## 四、文件、消息与完成态

Artifact 继续调用已确认的原生签名：

```text
processCodeOutput({
  req,
  id,
  name,
  toolCallId,
  conversationId,
  messageId,
  session_id,
})
```

`toolCallId` 固定为 `file-agent:<artifactId>`，message 使用请求开始时预分配的
`assistantMessageId`。返回存在 `finalize` 时必须等待 Office preview 完成后才记录
artifact receipt。重放先检查 receipt，避免再次建立文件。

宿主必须注入 `buildMessage()` 和 `buildFinalEvent()`，因为当前仓库不是完整上游源码，
不能在 Connector 内猜测特定版本的 message schema。Connector 提供确定性的 text、
fileIds、billing snapshot、conversation/message identity 和 terminal status。

成功顺序仍固定为：

```text
assistant message saved
GenerationJobManager.emitDone(streamId, finalEvent)
GenerationJobManager.completeJob(streamId)
delivery completed
```

final payload 携带与已保存消息相同的确定性 text；host composition 在实际 emit 前
重新读取权威 assistant message。API 在 message 保存后、final emit 前中断时，会发送
Mongo 中同一 response，而不是生成另一条 sibling 或不同文案。

## 五、服务认证

`ServiceScopeSigner` 使用 HMAC-SHA256 签名短期内部 scope，绑定：

```text
issuer
audience
issued-at / expiry
HTTP method
pathname + query
SHA-256 request body digest
SHA-256 idempotency-key digest
```

Runtime 在读取业务 body 前验证 request clone。缺失、签名错误、路径/body/任务幂等键
被篡改、过期或尚未生效的 scope 返回 `401`。secret 长度至少 32 字符，scope 最长 300 秒。
仓库不包含 secret、credential loader 或生产轮换方案。

## 六、本地验证

Connector 测试覆盖原 Phase 3A 场景，并新增：

- Mongo 双唯一 identity；
- 乐观 mutation 冲突重试；
- lease 排他与过期接管；
- 计费快照不可变副本与 credential 拒绝；
- structured token 粒度、完整重放和部分 transaction 恢复；
- 原生 `processCodeOutput()` receipt 重放与 deferred finalize；
- message、final event、generation job 顺序；
- 多副本 lease skip；
- signed、missing、tampered、expired Runtime scope。
- concrete Runtime HTTP server authorizer forwarding and unauthenticated
  `/healthz` access.

本地门禁：

```text
connector syntax checks: passed
connector tests: 30 passed, 0 failed
runtime syntax checks: passed
runtime tests: 27 passed, 0 failed
git diff check: passed
```

## 七、未完成与停止条件

本次没有完成，也没有批准：

- 将 adapter 接入真实 LibreChat API imports、Mongo collections 或请求 lifecycle；
- 测试账号 feature flag 与真实非生产 conversation；
- LibreChat API、Runtime、浏览器三类真实中断恢复验收；
- CI 构建、production patch、容器、部署或生产回滚包；
- Word、PPT、PDF worker 扩面。

进入 Phase 3C 前，必须先在独立非生产环境完成上述真实 wiring 与中断验收。若原生
transaction 无法保持稳定 `_id` 去重、message builder 无法挂回同一 assistant message、
或服务 scope 无法在实际 Runtime server 生效，则停止，不得制作生产发布候选。
