# File Agent Runtime Phase 2A 实施记录

Date: 2026-07-23

Status: implemented and locally verified against an isolated recorded model
relay. No external model, production key, production CodeAPI, LibreChat
integration, billing write, or deployment was used.

## 一、完成范围

Phase 2A 在独立 Runtime 内完成：

- 正式 `ProviderAdapter` 接口与错误类型；
- 单个 allowlisted `modelRouteId`；
- OpenAI-compatible `/v1/chat/completions` transport；
- 结构化 plan schema 和 capability profile 动作白名单；
- 模型 Call Journal 的 pending、completed 和 ambiguous 状态；
- 相同 callId 的本地 completed replay；
- request digest 冲突拒绝；
- 不支持幂等 route 的 pending 调用转 ambiguous；
- 最大 12,000 字符的上下文投影；
- `context.compacted` 持久事件；
- 输入、缓存读取、缓存写入和输出 Token usage；
- usageEventId / callId 幂等去重；
- verification failure fingerprint；
- 相同失败下重复 repair action 在执行前转 `needs_input`；
- Provider 返回后、Runtime checkpoint 前中断的恢复验收。

## 二、新增文件

```text
services/file-agent-runtime/src/provider-adapter.js
services/file-agent-runtime/src/model-call-journal.js
services/file-agent-runtime/src/context-projector.js
services/file-agent-runtime/src/openai-compatible-provider.js
services/file-agent-runtime/test/isolated-model-relay.js
services/file-agent-runtime/test/phase2-provider.test.js
docs/FILE_AGENT_RUNTIME_PHASE2_SINGLE_MODEL_POC_PLAN.md
docs/FILE_AGENT_RUNTIME_PHASE2A_IMPLEMENTATION.md
```

更新文件：

```text
services/file-agent-runtime/src/runtime.js
services/file-agent-runtime/src/task-store.js
services/file-agent-runtime/src/executor-adapter.js
services/file-agent-runtime/test/phase1-codeapi.test.js
services/file-agent-runtime/package.json
services/file-agent-runtime/README.md
docs/INDEPENDENT_FILE_AGENT_RUNTIME_ARCHITECTURE.md
docs/FILE_AGENT_RUNTIME_PHASE1_IMPLEMENTATION.md
```

## 三、模型调用边界

任务只保存：

```text
modelRouteId
capabilityProfile
```

route 的 base URL、API Key、provider model、输出预算和幂等能力只存在于 Provider
实例配置中。测试读取持久 task 后确认其中不含测试 secret 或 relay URL。

模型只能返回：

```text
xlsx_transform
xlsx_patch_and_transform
```

action 只允许 `kind` 和 `summary`。未知动作、command、script、path 等附加字段、
无效 JSON、缺失 usage 或超出动作数量都会触发 `ProviderProtocolError`。

## 四、Call Journal

调用前写入：

```text
<journal-dir>/model-calls/<sha256-call-id>.json
```

Journal 只保存 call ID 哈希、request digest、route ID、状态、尝试次数和规范化结果，
不保存 API Key、请求头、价格或完整原始响应。

行为：

- completed + 相同 digest：本地 replay，不再次调用 transport；
- 相同 callId + 不同 digest：`ProviderCallConflictError`；
- pending + 支持幂等：允许相同 callId 重放；
- pending + 不支持幂等：标记 ambiguous；
- ambiguous：Runtime 转 `needs_input`，不自动重复可能已计费的调用。

## 五、上下文投影

投影包含：

- objective 和 acceptance；
- phase、plan revision、instruction revision；
- 输入、脚本和输出的名称与哈希；
- 最多 8 个最近 item 摘要；
- verification 和 progress；
- 禁止生成源码和凭据的约束。

预算：

```text
objective: 2,000 chars
acceptance total: 2,000 chars
resources: 3,000 chars
recent summaries: 4,000 chars
serialized context: 12,000 chars
```

完整脚本、stdout/stderr、文件正文、原始模型响应、URL、Key、价格和 LibreChat
对象不会进入模型上下文。省略旧 item 时发出幂等 `context.compacted` 事件。

## 六、usage

Provider 的规范化结果包含：

```text
inputTokens
cacheReadTokens
cacheWriteTokens
outputTokens
```

Runtime 在 provider item completed 的同一次 Task Store mutation 中写入 usage record
和 `usage.recorded` 事件。`usageEventId` 等于 callId，相同 journal replay 不重复记录。

Runtime 不保存价格、不计算美元费用、不修改 LibreChat transaction。

## 七、进展判断

verification fingerprint 由以下字段生成：

```text
passed
summary
repairMarker
outputHash
errorSignature
```

首次失败正常进入 repair。repair 后若再次得到相同失败 fingerprint，
`stagnationCount` 增加并发出 `progress.stalled`。如果 Provider 再次返回与上一次
相同的 repair action signature，Runtime 保存 plan 审计记录后直接进入
`needs_input`，不执行重复的 Executor action。

该逻辑依据状态变化，不依据固定三次或五次调用。

## 八、中断恢复结果

测试在 Provider 已将 completed 结果写入 Call Journal、但 Runtime 尚未持久化
provider item 时注入 `RuntimeShutdownError`：

1. `item.started` 保留；
2. 不写伪造的 `item.failed`；
3. 新 Runtime 使用相同 callId；
4. Provider 从本地 journal replay；
5. transport 实际调用次数保持一；
6. usage record 和 `usage.recorded` 事件各一条；
7. 任务继续完成。

## 九、验证结果

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
tests: 20 passed, 0 failed
```

Phase 2A 新测试覆盖：

1. 模型计划驱动完整 XLSX transform、repair、verify 和 artifact；
2. 投影不含脚本、marker、secret 或 relay URL；
3. 两次 provider 调用产生两条四粒度 usage；
4. provider completed 后 Runtime 中断只调用 transport 一次；
5. 相同失败和相同 repair plan 不触发重复 Executor action；
6. 40 个历史 item 被压缩到预算内并发出一个 compacted 事件；
7. journal digest conflict 和 non-idempotent ambiguous；
8. 未知动作及 command-bearing 响应被拒绝；
9. ambiguous provider completion 转 `needs_input` 且不自动重试；
10. Phase 0 和 Phase 1 全部回归通过。

## 十、无生产影响审计

本阶段未修改或访问：

- `deployment/production-patches/`；
- `deployment/production-operations/`；
- LibreChat API/client bundle、Mongo、Nginx、Admin Panel 或 Compose；
- 生产 CodeAPI、生产 relay、生产 Key 或客户文件；
- Office 上传、pre-parse、消息、下载卡、价格和 transaction。

默认 `npm start` 仍只使用 FakeProvider 和 FakeExecutor。Phase 2A route 不可通过
环境变量或 HTTP API 启用。

## 十一、已知限制

- Phase 2A relay 是本地记录化 fixture，不证明真实中转兼容性；
- `/v1/chat/completions` 的 metadata、usage 和缓存字段仍需在 Phase 2B 对目标中转
  做一次契约验证；
- 只有一个 XLSX capability profile；
- 没有 LibreChat Connector、usage ingestion 或 artifact delivery；
- 没有多副本 journal 协调；
- 没有真实模型质量、Token 或延迟对比数据。

## 十二、下一步门禁

下一步不是生产集成。只能二选一：

1. 经单独审批执行 Phase 2B：使用受限非生产 Key 和仓库 fixture 完成一次真实模型
   契约验收；
2. 暂不调用真实模型，先设计 Phase 3 LibreChat 非生产 Connector，但不得实施连接。

在 Phase 2B 未确认目标中转协议、结构化 plan 质量、usage 字段和幂等能力前，不应
进入 Phase 3 实施，更不能进入生产试用。

## 十三、回滚

本阶段没有生产写入。回滚只需撤销 Phase 2A 实现提交；Phase 2 设计文档可保留。
