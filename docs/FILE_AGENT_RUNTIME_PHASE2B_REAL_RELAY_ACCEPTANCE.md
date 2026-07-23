# File Agent Runtime Phase 2B 真实 Relay 验收记录

Date: 2026-07-23

Status: passed non-production contract acceptance. Phase 2B is complete. This
record does not approve LibreChat integration, customer traffic, or production
deployment.

## 一、执行范围

本次使用新的隔离运行目录，只执行一个受预算约束的非生产任务：

- 模型：`gpt-5.6-sol`；
- capability profile：`office-planner-v1`；
- structured output：strict `json_schema`；
- 上游幂等保证：按 `false` 保守处理；
- 输入：仓库 fixture `phase2b-source.xlsx`；
- 执行器：本地隔离 CodeAPI；
- 不访问 LibreChat、生产 CodeAPI、客户文件、transaction、消息或下载卡。

Task ID：

```text
df3a669c-3f02-47b2-a327-728ebf66d545
```

Fixture SHA-256：

```text
f082ebb1a704ed9b65d16e8a44b41b6f07377979e684f4fc7464966a975aedc3
```

## 二、结果

```text
task status: completed
elapsed: 9.863 seconds
provider requests: 2
journaled provider calls: 2
plan revisions: 2
artifact count: 1
artifact verified: yes
input tokens: 1,541
cache read tokens: 0
cache write tokens: 0
output tokens: 217
budget exceeded: no
```

两个 provider call 都写入 `completed_valid`。第一次计划执行稳定 transform 后，fixture
按设计返回 `__PHASE1_PATCH_PENDING__` 验证指纹；Runtime 将该指纹投影给 repair plan，
第二次只选择 `xlsx_patch_and_transform`，复用既有 worker 做一次增量替换，随后验证
通过。该链路是预设的 transform -> verify -> incremental repair -> verify 验收场景，
不是在相同失败上重复生成脚本。

## 三、真实协议确认

目标 relay 对两次请求均返回 HTTP 200，并确认：

- `/v1/chat/completions` 可用；
- `gpt-5.6-sol` 被接受并原样返回；
- strict `response_format: json_schema` 被接受；
- schema 顶层和 action 均禁止额外字段，两个计划均通过本地白名单复核；
- `metadata.operation` 和 `metadata.call_id` 被接受；
- `Idempotency-Key` 请求头未导致拒绝；
- usage 包含 prompt、completion、total 和 prompt details；
- prompt details 同时暴露 `cached_tokens` 与 `cached_creation_tokens`。

本次没有缓存 Token，因此只确认字段兼容，不能从请求成功推断上游提供幂等去重，也
不能推断所有模型都会产生缓存命中。

## 四、持久化与恢复

- 两次模型调用分别保留四粒度 usage；
- call ID 同时作为 usage event ID，避免重放重复入账；
- journal 只保存已校验 plan、规范化调用元数据、usage 和 context 摘要；
- 一个最终 XLSX artifact 通过隔离 CodeAPI 引用发布；
- API Key、relay URL、Authorization、价格、余额和原始模型响应均未持久化；
- route 明确按不保证幂等处理，pending 调用仍不会自动重发。

## 五、报告修正

本次原始报告正确记录了请求的 `responseFormatType: json_schema` 和两个 HTTP 200，
但 `responseFormatAccepted` 使用旧的 `json_object` 常量，错误显示为 `false`。这是
报告派生字段 bug，不影响请求、journal、计划、执行、usage 或 artifact。

代码已改为与本次选择的 `structuredOutputMode` 比较，并增加 `json_schema` 回归测试。
修复后本地门禁结果：

```text
syntax checks: passed
tests: 27 passed, 0 failed
diff check: passed
```

没有为修正报告再次调用真实 relay，原始证据保持不变。

## 六、结论与边界

Phase 2B 通过，已证明独立 Runtime 能在真实 relay 上完成严格计划、验证失败后的增量
修复、四粒度 usage、持久 journal 和单一 artifact 交付。

这只解除 Phase 3 Connector 的前置设计阻塞。下一阶段仍需在仓库内先实现 Connector
契约、幂等 delivery record、usage 入账和 artifact 挂载测试；未完成发布门禁前，不得
接入生产聊天流量或客户文件。
