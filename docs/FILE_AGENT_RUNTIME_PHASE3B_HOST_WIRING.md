# File Agent Runtime Phase 3B LibreChat Host Wiring 记录

Date: 2026-07-23

Status: repository-side host composition implemented and locally verified. The
repository still does not contain the complete upstream LibreChat API source or
an independent non-production Mongo deployment. No production process, customer
file, external model request, billable request, or deployment was used.

## 一、为什么增加 host composition

Phase 3B 的 `NativeLibreChatPorts` 已确认原生函数调用边界，但仍要求调用方逐项拼装
Mongo store、transaction finder、生成文件、assistant message 与 final event。若每个
部署补丁自行拼装，容易再次出现以下分歧：

- 文件已经写入 Mongo，但 assistant message 没有 `attachments/files` 下载引用；
- final event 使用临时对象，而不是权威 conversation 和 user message；
- transaction 去重查询没有限制 user；
- 文件查询误返回其他用户、tenant 或 conversation 的记录；
- service scope、feature flag 和 lease 参数散落在 controller 中。

本轮新增统一 composition root：

```text
services/librechat-file-agent-connector/src/librechat-host-integration.js
```

它只接收显式注入的 LibreChat 原生依赖，不 import 本仓库不存在的上游路径。

## 二、组合入口

`createLibreChatHostIntegration()` 统一创建：

```text
MongoDeliveryStore
MongoBillingSnapshotStore
RuntimeClient + ServiceScopeSigner（未注入 runtimeClient 时）
NativeLibreChatPorts
LibreChatFileAgentConnector
```

宿主必须提供三类 Mongo collection：

```text
deliveries
billingSnapshots
transactions
```

以及已核对的原生依赖：

```text
prepareStructuredTokenSpend
bulkWriteTransactions
transactionDbOps
processCodeOutput
saveMessage
GenerationJobManager
authenticated request resolver
generated-file query and sanitizer
conversation/message loaders
message identity resolver
sanitizeMessageForTransmit
```

`init()` 只建立 delivery 与 billing snapshot 索引，不启动网络监听、不注册 controller、
不修改生产配置。

## 三、生成文件到下载卡

Runtime artifact receipt 现在保留：

```text
artifactId
fileId
name
toolCallId
```

Message finalization 同时向 host builder 传入 `fileIds` 和有序 artifact refs。Host
builder 使用当前 delivery 的 user、tenant 和 conversation 查询权威 file records，
并再次验证每个返回记录：

```text
file.user === delivery.user
file.tenantId === delivery.tenantId（有 tenant 时）
file.conversationId === delivery.conversationId
```

缺失或不属于当前范围的 file 立即停止 finalization。通过验证后，文件先经过现有
`sanitizeFileForTransmit()`，再按 Runtime artifact 顺序写入同一 response message 的：

```text
attachments
files
```

每个引用保留预分配 `assistantMessageId` 和稳定 `toolCallId`。这与现有 BaseClient 对
code execution output 的下载卡结构一致，不建立第二套文件协议。

## 四、消息与 final event

Message identity 由宿主 `resolveMessageIdentity()` 提供，并强制包含：

```text
sender
endpoint
model
iconURL（可选）
```

除上述字段外的 identity 字段会被拒绝，不能覆盖 messageId、user、text、附件或完成态。
因此 Connector 不猜测 Admin Panel display label、自定义 endpoint 或 Agent ID。
`needs_input` 使用同一 assistant message 并标记 `unfinished: true`；完成、失败和取消
使用同一 messageId 覆盖为终态。

Final-event builder 在 emit 前重新加载：

```text
authoritative conversation
authoritative user message
authoritative saved assistant message
```

然后生成现有 resumable controller 使用的结构：

```text
final
conversation
title
requestMessage
responseMessage
```

用户消息和已保存 assistant message 都经过原生 `sanitizeMessageForTransmit()`。
`responseMessage` 不重新查询文件或再次拼装下载引用；因此 message 保存后发生中断，
恢复 emit 的内容与刷新后从 Mongo 读取的内容一致，同时不会把 Mongo 内部字段发给
浏览器。找不到 conversation、user message 或 assistant message 时停止，不发送不完整
final event。

## 五、transaction 查询

`createMongoTransactionIdFinder()` 只返回同时匹配以下条件的 transaction `_id`：

```text
_id in stable usage transaction IDs
user === delivery.user
```

这避免其他用户的同名测试数据影响当前 receipt 恢复。实际写入仍使用 Phase 3B 已实现
的稳定 `_id`、短租约和原生 `bulkWriteTransactions()`。

## 六、本地验证

新增测试覆盖：

- 生成文件按 artifact 顺序 rehydrate；
- `attachments` 与 `files` 同时包含可下载记录；
- sanitizer 清除内部字段；
- 缺失、其他用户、其他 tenant 或其他 conversation 文件拒绝交付；
- final event 使用权威 conversation、user message 与已保存 assistant message；
- transaction finder 按 user 隔离；
- host composition 初始化 Mongo stores 且不访问生产。

当前门禁：

```text
connector syntax checks: passed
connector tests: 30 passed, 0 failed
runtime tests: 27 passed, 0 failed
```

## 七、仍未完成

这次解决的是统一宿主组装方式，不等于已接入运行中的 LibreChat。下一道独立非生产
门禁仍需：

1. 在完整 LibreChat source/build 环境导入实际 native dependencies；
2. 建立独立非生产 delivery 与 billing snapshot collections；
3. 只给测试账号和测试 conversation 打开 feature flag；
4. 使用仓库 XLSX fixture 验证 submit、Runtime restart、API restart 和浏览器断线；
5. 核对真实 transaction、file record、assistant message、final event 和下载卡；
6. 关闭 flag 后证明新请求完全回到原 LibreChat 链路。

以上未通过前，不创建 production patch，不部署生产，也不扩展 Word、PPT、PDF worker。
