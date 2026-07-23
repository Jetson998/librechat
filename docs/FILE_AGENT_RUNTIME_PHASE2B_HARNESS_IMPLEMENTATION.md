# File Agent Runtime Phase 2B 验收工具实施记录

Date: 2026-07-23

Status: one-shot harness and invalid-plan receipt recovery are implemented and
locally verified. A new isolated real relay task subsequently passed Phase 2B.
See
`docs/FILE_AGENT_RUNTIME_PHASE2B_REAL_RELAY_FAILURE.md` and
`docs/FILE_AGENT_RUNTIME_PHASE2B_REAL_RELAY_ACCEPTANCE.md`.

## 一、完成范围

新增一个默认关闭的一次性非生产验收工具：

```text
services/file-agent-runtime/scripts/phase2b-once.js
```

它用于在受限 Key 门禁满足后执行至多一个完整真实模型任务，并固定：

- 一个 `file-agent-primary` route；
- 一个 `office-planner-v1` capability profile；
- 仓库内固定 XLSX fixture；
- 本地隔离 CodeAPI，不访问生产 CodeAPI；
- 最多两次模型调用；
- 每次输入 6,000 Token、任务总输入 12,000 Token；
- 每次输出 256 Token、任务总输出 512 Token；
- 8,000 字符上下文投影；
- 一个最终 XLSX artifact；
- 不写 LibreChat transaction、文件、消息或看板。

## 二、仓库 fixture

固定文件：

```text
services/file-agent-runtime/test/fixtures/phase2b-source.xlsx
```

SHA-256：

```text
f082ebb1a704ed9b65d16e8a44b41b6f07377979e684f4fc7464966a975aedc3
```

工具启动时重新计算哈希，不匹配即停止。文件只包含测试渠道、测试模型和
`repository-only` / `non-production` 标记，不含客户数据。

## 三、真实调用门禁

真实模式必须同时提供：

```text
FILE_AGENT_PHASE2B_BASE_URL
FILE_AGENT_PHASE2B_API_KEY
FILE_AGENT_PHASE2B_MODEL
FILE_AGENT_PHASE2B_KEY_SCOPE=non-production
FILE_AGENT_PHASE2B_CONFIRM=ONE_NON_PRODUCTION_BILLABLE_TASK
FILE_AGENT_PHASE2B_SUPPORTS_IDEMPOTENCY=true|false
```

限制：

- relay URL 必须是 HTTPS；
- URL 不能包含用户名、密码、query 或 fragment；
- `/v1` 尾缀会规范化，避免重复拼成 `/v1/v1/chat/completions`；
- Key 不进入 task manifest、journal、report 或 Git；
- 未确认 Key scope 时在启动本地 server 和发出请求前停止；
- `supportsIdempotency` 默认按 false 处理，不能从“请求头被接受”推断上游保证幂等。

## 四、调用和预算保护

调用前保护：

- context 粗略 Token 估算超过每次输入预算时拒绝请求；
- route 输出预算超过 256 时拒绝请求；
- 第三次模型调用在请求前拒绝。

调用后保护位于 Provider journal 完成之后：

1. Provider 响应先规范化并写 completed journal；
2. 再累计真实 usage；
3. 超预算则停止 Runtime task；
4. 因为 journal 已完成，恢复时不会把已付费调用当作 pending 再次发送。

该顺序只避免重复调用，不能撤销已经发生的上游费用。

## 五、契约观察报告

默认报告：

```text
services/file-agent-runtime/.phase2b/phase2b-report.json
```

`.phase2b/` 已忽略，不进入 Git。报告只记录：

- task status、plan revision、artifact count；
- route ID、provider 返回的 model 名；
- 固定预算和实际调用数；
- 输入、缓存读取、缓存写入和输出 usage；
- `/v1/chat/completions` 状态；
- `response_format`、`metadata` 和 `Idempotency-Key` 是否随请求发送并被成功请求接受；
- usage 和缓存字段是否实际出现；
- 动作质量和 artifact 验证结果；
- 延迟。

不记录：

- API Key；
- relay URL；
- Authorization header；
- 价格、余额和费用；
- 原始模型响应；
- 完整脚本、stdout 或文件正文。

写报告前会扫描运行目录的二进制内容，发现 Key 或 relay URL 即停止。

## 六、幂等和重跑

固定 idempotency key 由 fixture hash 和 contract version 构成。运行目录保留：

```text
runtime task store
provider call journal
isolated CodeAPI item results
phase2b report
```

同一运行目录再次执行时：

- 返回同一 task；
- completed provider call 从 journal replay；
- completed CodeAPI item 从隔离 fixture replay；
- 不创建第二个模型任务；
- 无新请求时保留首次契约报告，不用空观察覆盖。

如果上游没有明确幂等保证，pending provider call 在恢复时进入 ambiguous，不自动
重复发送。

## 七、测试

新增：

```text
services/file-agent-runtime/test/phase2b-runner.test.js
```

覆盖：

1. 固定 fixture 哈希；
2. 两次记录化模型调用完成 transform 和 repair；
3. 四粒度 usage；
4. `response_format`、metadata、usage 和 cache 字段观察；
5. artifact 验证；
6. report 不含 Key 或 relay URL；
7. 同一运行目录重跑不增加模型执行次数；
8. real mode 拒绝非 non-production Key scope；
9. 超预算响应先写 completed journal，再停止 task。

执行：

```sh
cd services/file-agent-runtime
npm run check
npm test
git diff --check
```

结果：

```text
syntax checks: passed
tests: 27 passed, 0 failed
diff check: passed
```

测试中的 relay 和 CodeAPI 只监听本机 `127.0.0.1`。当前受限命令沙箱禁止监听
loopback，因此测试通过明确授权在沙箱外执行；仍未访问外部网络或生产服务。

## 八、无生产影响

未修改或访问：

- LibreChat API/client bundle、Mongo、Nginx、Admin Panel 或 Compose；
- 生产 CodeAPI、Office Converter 或模型 relay；
- 客户文件、用户消息、transaction 或下载卡；
- `deployment/production-patches/` 和 `deployment/production-operations/`。

默认 `npm start` 仍使用 FakeProvider 和 FakeExecutor。Phase 2B 工具没有 HTTP
入口，也不能由 LibreChat 请求或环境配置自动启用。

## 九、真实验收结果与当前阻塞

真实 relay 已接受 `/v1/chat/completions`、`json_object`、metadata、usage 和缓存字段，
但模型 plan 包含白名单之外的字段，任务在 CodeAPI 前失败。失败同时暴露了 invalid
plan 的付费调用没有 completed journal 和 usage receipt 的问题。

无效计划回执修复已实现并通过本地全量测试：失败响应会写 `completed_invalid`，四粒度
usage 会在任务失败事件前幂等保留，安全回执重放不会再次调用 relay。第一次真实失败
证据仍保持原样，不迁移旧 pending journal。

新的隔离真实任务已使用 strict `json_schema` 完成 transform、验证失败后的增量 repair、
再次验证和单一 XLSX artifact 发布。Phase 2B 现已通过；第一次失败证据和旧 pending
journal 仍保持原样。完整结果见
`docs/FILE_AGENT_RUNTIME_PHASE2B_REAL_RELAY_ACCEPTANCE.md`。

## 十、回滚

没有生产写入。回滚只需撤销本次 harness、fixture、测试和文档提交；Phase 0、
Phase 1、Phase 2A 及 Phase 3 设计不受影响。
