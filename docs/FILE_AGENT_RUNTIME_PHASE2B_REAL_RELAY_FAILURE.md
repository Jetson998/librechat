# File Agent Runtime Phase 2B 真实 Relay 失败记录

Date: 2026-07-23

Status: failed acceptance. One approved non-production task was attempted. No
automatic retry was performed. Phase 2B remains incomplete and Phase 3
implementation remains blocked.

## 一、执行范围

本次只执行：

- 一个受限非生产 model route；
- 模型 `gpt-5.6-sol`；
- 仓库 fixture `phase2b-source.xlsx`；
- 一个 Runtime task；
- 最多两次模型调用，但实际只发出一次；
- 本地隔离 CodeAPI；
- 不访问 LibreChat 生产数据，不写 transaction、消息、文件或下载卡。

Task ID：

```text
b9c28af6-7a8b-4645-955c-e572dd018705
```

Fixture SHA-256：

```text
f082ebb1a704ed9b65d16e8a44b41b6f07377979e684f4fc7464966a975aedc3
```

## 二、结果

```text
task status: failed
elapsed: 19.048 seconds
provider requests: 1
CodeAPI execution: 0
plan revision: 0
artifact count: 0
error: PROVIDER_PROTOCOL
message: Provider plan contains unsupported fields
```

未触发 repair、CodeAPI 脚本、artifact 或第二次模型调用。

## 三、已确认兼容

目标 relay 对本次请求返回 HTTP 200，并确认：

- `/v1/chat/completions` 可用；
- `gpt-5.6-sol` model 名被接受并原样返回；
- `response_format: json_object` 被接受；
- `metadata.operation` 和 `metadata.call_id` 被接受；
- `Idempotency-Key` 请求头未导致拒绝；
- usage 包含 `prompt_tokens`、`completion_tokens` 和 `total_tokens`；
- prompt details 包含 `cached_tokens` 和 `cached_creation_tokens`。

这只能证明字段随成功请求被 relay 接受，不能证明 relay 对
`Idempotency-Key` 提供重复请求去重保证。

## 四、直接失败原因

模型返回了可解析 JSON，但顶层 plan 包含当前 schema 白名单之外的字段。

当前允许的顶层字段只有：

```text
schemaVersion
summary
needsInput
question
actions
```

Provider 正确拒绝了未知字段，没有把宽松模型输出传给 Executor。原始计划没有保存，
因此本记录不推测具体多出的字段名。

## 五、暴露的架构缺陷

当前 `SingleModelAgentProvider` 顺序是：

1. transport 返回 plan、model 和 usage；
2. 校验 plan；
3. 校验通过后调用 `journal.complete()`；
4. Runtime item completed 后记录 usage。

本次在第 2 步失败，造成：

- 上游请求已经成功且可能产生费用；
- journal 仍是 `pending`；
- `journaledCalls` 为 0；
- Runtime usage record 为 0；
- report 只能确认 usage 字段存在，不能保留 Token 数；
- 因 route 未声明幂等，恢复时不能安全自动重放。

这是 Phase 2B 失败中比“模型多返回字段”更重要的问题：模型语义无效不等于上游调用
没有发生。调用回执和 usage 必须先于语义接受状态持久化。

## 六、安全审计

运行目录扫描结果：

```text
API Key persisted: no
relay URL persisted: no
LibreChat transaction written: no
customer data used: no
production CodeAPI accessed: no
```

未记录 Authorization、原始模型回复、完整脚本、stdout、价格或余额。

## 七、停止决定

本次不自动重试，原因：

- 已消耗一次真实模型请求；
- journal 是 pending；
- route 未声明上游幂等保证；
- 固定 one-shot task 已进入 terminal failed；
- prompt retry 不能解决付费回执缺失问题。

下一步必须先实现并验证
`docs/FILE_AGENT_RUNTIME_PHASE2B_INVALID_PLAN_RECEIPT_PLAN.md`。实现通过后，如需再次
真实验收，必须使用新的审批、run ID 和调用预算，不能覆盖或删除本次证据。
