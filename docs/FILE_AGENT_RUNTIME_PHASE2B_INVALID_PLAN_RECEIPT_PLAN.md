# File Agent Runtime Phase 2B 无效计划回执修复方案

Date: 2026-07-23

Status: implemented, locally verified, and followed by a successful isolated
real-model acceptance in a new run directory. See
`docs/FILE_AGENT_RUNTIME_PHASE2B_REAL_RELAY_ACCEPTANCE.md`.

## 一、目标

修复“上游模型调用已成功并产生 usage，但计划 schema 校验失败后 journal 仍 pending、
usage 丢失”的问题。

正确语义必须拆成两层：

```text
transport completion: 上游是否已经返回可解析响应和 usage
semantic acceptance: 返回的 plan 是否符合 Runtime capability schema
```

计划无效时任务仍应失败，但调用回执必须 completed，usage 必须可幂等记录，恢复时
不得再次付费调用。

## 二、Journal 状态

从：

```text
pending
completed
ambiguous
```

扩展为：

```text
pending
completed_valid
completed_invalid
ambiguous
```

为兼容已有 Phase 2A 数据，读取旧 `completed` 时按 `completed_valid` 处理，不批量
重写旧 journal。

### completed_valid

保存当前规范化成功结果：

```text
validated plan
call metadata
four-part usage
context metadata
```

### completed_invalid

只保存脱敏回执：

```json
{
  "status": "completed_invalid",
  "requestDigest": "...",
  "routeId": "file-agent-primary",
  "receipt": {
    "call": {
      "callId": "...",
      "modelRouteId": "file-agent-primary",
      "providerModel": "gpt-5.6-sol"
    },
    "usage": {
      "inputTokens": 0,
      "cacheReadTokens": 0,
      "cacheWriteTokens": 0,
      "outputTokens": 0,
      "occurredAt": "..."
    },
    "responseDigest": "sha256-of-normalized-plan",
    "error": {
      "name": "ProviderProtocolError",
      "code": "PROVIDER_PROTOCOL",
      "message": "Provider plan contains unsupported fields"
    }
  }
}
```

禁止保存：

- 原始模型响应；
- 原始 plan；
- 未知字段和值；
- API Key、URL、请求头和价格。

`responseDigest` 只用于证明同一响应，不用于恢复原文。

## 三、Provider 执行顺序

新顺序：

1. `journal.begin()` 写 pending；
2. transport 调用 relay；
3. 规范化 provider model 和四粒度 usage；
4. 对 plan 计算 response digest；
5. 尝试 schema 校验；
6. 校验成功：`journal.completeValid()`；
7. 校验失败：`journal.completeInvalid()`；
8. 将带 call receipt 的 typed protocol error 抛给 Runtime。

`completeInvalid()` 必须在抛错前完成。若该持久化本身失败，调用状态才是 ambiguous，
不能伪装成普通 protocol failure。

## 四、Typed Error Receipt

`ProviderProtocolError` 增加可选的安全 receipt：

```text
call
usage
context digest/character count/compaction
responseDigest
```

Error message 仍只使用固定 schema 错误，不附加模型原文。

从 completed_invalid replay 时：

- 不调用 transport；
- 重建同一 typed error receipt；
- 标记 `call.replayed = true`；
- 保持相同 callId、usage 和 responseDigest。

## 五、Runtime usage 持久化

当前 usage 只在 provider item completed 时由 `persistProviderMetadata()` 写入。

修复后，`#runItem` catch 分支检测安全 error receipt：

1. 用相同 `usageEventId = callId` 调用统一的 metadata persistence；
2. 幂等写 `task.usageRecords` 和 `usage.recorded`；
3. 再写 `item.failed`；
4. 最后把 task 转为 failed 或 needs_input。

顺序必须是：

```text
completed_invalid journal
-> usage receipt persisted
-> item.failed
-> task.failed
```

Runtime 重启或错误 replay 时，`recordedUsageEventIds` 保证不重复记录。

## 六、严格结构输出

Post-validation 必须保留，不能只靠 prompt。

同时为 route 增加显式能力：

```text
structuredOutputMode: json_schema | json_object
```

### json_schema

发送严格 schema：

```text
additionalProperties: false
schemaVersion: const 1.0
needsInput: boolean
summary: bounded string
question: bounded optional string
actions: bounded array
action.additionalProperties: false
action.kind: capability enum
action.summary: bounded string
```

### json_object

用于不支持 strict JSON Schema 的 relay，继续发送 JSON object，但必须经过相同本地
白名单校验。模型多字段时直接 completed_invalid，不做同任务 prompt retry。

第一次目标 relay 请求只证明了 `json_object`。后续单独批准的真实验收明确选择
`json_schema`，两次请求均返回 HTTP 200，两个计划也通过本地白名单校验。整个过程
没有在协议失败后自动切换模式或追加请求。

## 七、usage 字段

本次目标 relay 的 prompt details 使用：

```text
cached_tokens
cached_creation_tokens
```

当前 normalizer 已读取 `cached_tokens`，但未读取 `cached_creation_tokens`。修复需要
兼容：

```text
prompt_tokens_details.cached_creation_tokens
usage.cache_creation_input_tokens
usage.cache_write_tokens
```

三者按明确优先级取一个值，不能相加，避免重复计算缓存写入。

## 八、报告

Phase 2B report 增加：

```text
transportCompleted
planAccepted
journalStatus
protocolError
responseDigest
usageFromInvalidReceipt
structuredOutputMode
```

计划无效时 report 仍应显示真实四粒度 Token，但不得显示原始计划或未知字段。

## 九、测试

必须新增：

1. 有效 plan 写 `completed_valid`，Phase 2A 行为不变；
2. 多余顶层字段写 `completed_invalid`；
3. 多余 action 字段写 `completed_invalid`；
4. invalid journal 不含原始 plan、未知字段、Key 或 URL；
5. invalid response usage 在 task.failed 前持久化一次；
6. completed_invalid replay 不调用 transport；
7. replay usage 不重复；
8. journal 写失败转 ambiguous，不伪装 protocol failure；
9. `cached_creation_tokens` 映射 cacheWrite；
10. strict JSON Schema request 不允许 additional properties；
11. json_object route 继续本地严格校验；
12. Phase 0、Phase 1、Phase 2A 和 Phase 2B harness 全回归。

## 十、实现边界

只允许修改：

```text
provider-adapter
model-call-journal
openai-compatible-provider
runtime provider-error persistence
Phase 2 tests
Phase 2B harness/report
documentation
```

不修改 LibreChat Connector、生产 patch、CodeAPI、Office Worker、价格、transaction、
消息、文件或 UI。

## 十一、真实复验启动前停止条件

真实复验启动前曾使用以下停止条件；这些条件均在复验前完成检查：

- invalid receipt 仍可能保持 pending；
- usage 不能在 failed task 中幂等保留；
- journal 需要保存原始模型输出才能恢复；
- strict schema 与 capability profile 可能漂移；
- cache write 字段存在重复计数；
- 本地全量测试未通过；
- 第二次调用没有新的明确批准和预算。

## 十二、回滚

本方案没有生产影响。实现回滚为撤销后续代码提交；本次真实失败记录和脱敏运行目录
必须保留，不因回滚删除。

## 十三、实施结果

实现范围严格保持在第十节边界内：

- journal 新增 `completed_valid` / `completed_invalid`，并兼容读取旧 `completed`；
- 无效 plan 在抛出协议错误前写入仅含 call、四粒度 usage、context 摘要、响应摘要和
  固定错误信息的安全回执；
- Runtime 在 `item.failed` / `task.failed` 前幂等写入回执 usage；
- `completed_invalid` 重放不再调用 relay；
- 无效回执写盘失败转为 `ProviderAmbiguousCommitError`；
- route 可显式选择 `json_object` 或 strict `json_schema`，本地白名单校验始终保留；
- `prompt_tokens_details.cached_creation_tokens` 已映射为 cache write usage；
- Phase 2B 报告增加 transport completion、plan acceptance、journal 状态、协议错误、
  响应摘要和无效回执 usage 证明，不保存原始 plan。

本地验证：

```text
syntax checks: passed
tests: 27 passed, 0 failed
diff check: passed
```

测试证明无效响应只触发一次 relay execution，重放使用安全回执；journal 和报告均不含
未知字段值、原始响应、API Key 或 relay URL。真实 relay 的第二次单次验收已另行记录
在 `docs/FILE_AGENT_RUNTIME_PHASE2B_REAL_RELAY_ACCEPTANCE.md`，没有用本地测试替代。
