# File Agent Runtime Phase 2 单模型 Agent POC 方案

Date: 2026-07-23

Status: design gate approved for repository implementation. Phase 2A is an
isolated recorded-relay POC. Phase 2B requires separate approval and a scoped
non-production key. Neither phase may receive production LibreChat traffic.

## 一、目标

Phase 2 验证独立 Runtime 能否在不复制 LibreChat Provider、价格或消息系统的前提
下，使用一个 `modelRouteId` 完成结构化计划、增量修复、最小上下文投影、usage
记录和按进展停止。

本阶段不是让模型重新生成大型 Excel 脚本。模型只在版本化动作集合中选择下一步，
稳定 Office 机械逻辑继续由 Executor / Worker 执行。

## 二、阶段拆分

### Phase 2A：隔离记录化 relay

- 使用只绑定 `127.0.0.1` 的 OpenAI-compatible 测试 relay；
- 使用记录化结构响应，不调用外部模型，不产生费用；
- 验证 ProviderAdapter、route allowlist、上下文投影、usage、调用幂等和进展判断；
- 继续使用 Phase 1 的隔离 CodeAPI XLSX 场景；
- 允许模拟 Runtime 在模型返回后、item checkpoint 前中断。

### Phase 2B：一次真实非生产调用

只有 Phase 2A 全部通过后才可启动，并需满足：

- 单独受限测试 Key；
- 只启用一个 route；
- 明确最大输入、最大输出和调用预算；
- 使用仓库内记录化 XLSX fixture，不使用客户文件；
- 不写 LibreChat transaction，不进入用户看板；
- 独立审批后最多执行一次完整任务。

当前开发默认只实施 Phase 2A。Phase 2B 不因本方案自动获批。

## 三、ProviderAdapter 契约

正式接口：

```text
plan({ callId, task, context, signal }) -> ProviderResult<Plan>
repair({ callId, task, context, verification, signal }) -> ProviderResult<Plan>
```

`callId` 必须等于 Runtime 的确定性 provider item ID，不得由 Adapter 重新生成。

```json
{
  "value": {
    "schemaVersion": "1.0",
    "summary": "Run the stable workbook worker",
    "needsInput": false,
    "actions": [
      {
        "kind": "xlsx_transform",
        "summary": "Run the persisted transform"
      }
    ]
  },
  "call": {
    "callId": "task-id:plan:1:0",
    "modelRouteId": "file-agent-primary",
    "providerModel": "test-model"
  },
  "usage": {
    "inputTokens": 1200,
    "cacheReadTokens": 0,
    "cacheWriteTokens": 0,
    "outputTokens": 180
  }
}
```

Provider 不返回价格、美元费用、用户余额、LibreChat transaction ID 或消息内容。

## 四、单路由配置

任务清单只允许：

```json
{
  "model": {
    "modelRouteId": "file-agent-primary",
    "capabilityProfile": "office-planner-v1"
  }
}
```

Runtime 启动配置将 route 映射到：

```text
baseUrl
model
credentialRef
requestProtocol
supportsIdempotency
inputBudget
outputBudget
```

约束：

- 任务不能携带 URL、API Key、请求头或价格；
- 未在 allowlist 中的 route 在模型调用前拒绝；
- Phase 2A 只允许 `file-agent-primary`；
- route 配置不进入 Task Store 和事件；
- credential 只能由调用进程注入，错误信息不得包含请求头。

## 五、结构化模型协议

Phase 2A 使用 OpenAI-compatible `POST /v1/chat/completions` transport，并要求响应
只包含一个 JSON plan。transport 与 Agent Provider 分离，未来可替换为 Responses
API 或其他兼容协议，不影响 Runtime 状态机。

模型可选动作严格来自 capability profile：

```text
office-planner-v1
  xlsx_transform
  xlsx_patch_and_transform
```

模型不得返回任意 shell、Python 源码、文件系统路径或 LibreChat 工具名。未知动作、
重复 action ID、空 summary、超出 action 数量或非 JSON 响应均作为 Provider 协议错误。

Phase 2A 每个 plan 最多两个动作。该限制是 profile 的结构边界，不是整个 Agent
任务的固定工具次数上限。

## 六、模型调用幂等与计费保护

模型调用与 CodeAPI 外部副作用不同：一次模型调用可能已产生费用，但 Runtime 在
收到响应后尚未来得及持久化。

因此 Provider 使用独立 Call Journal：

```text
<data-dir>/model-calls/<sha256-call-id>.json
```

状态：

```text
pending
completed
ambiguous
```

流程：

1. 调用前原子写入 `pending`、request digest 和 route ID；
2. 请求携带 `Idempotency-Key: <callId>`；
3. 响应规范化并原子写入 `completed` 后才返回 Runtime；
4. 相同 callId 和 digest 返回本地 completed 结果；
5. 相同 callId、不同 digest 返回冲突；
6. 启动时遇到 pending：
   - route 明确支持上游幂等，允许以同一 callId 重放；
   - route 不支持幂等，标记 ambiguous，不自动二次计费调用；
7. ambiguous 任务进入 `needs_input` 或运维 reconciliation，不伪装成功。

Phase 2A relay 必须实现同一 Idempotency-Key 的响应重放，并记录实际模型执行次数。

## 七、上下文投影

每次调用只构造 `ContextProjectionV1`：

```json
{
  "schemaVersion": "1.0",
  "objective": "任务目标",
  "acceptance": ["验收条件"],
  "state": {
    "phase": "repairing",
    "planRevision": 1,
    "instructionRevision": 0
  },
  "resources": {
    "inputs": [{"name": "source.xlsx", "sha256": "..."}],
    "scripts": [{"name": "transform_workbook.py", "sha256": "..."}],
    "outputs": [{"name": "phase1-output.xlsx", "sha256": "..."}]
  },
  "recentItems": [
    {"kind": "artifact_verification", "summary": "repair marker missing"}
  ],
  "verification": {
    "passed": false,
    "summary": "Incremental patch is required"
  },
  "progress": {
    "stagnationCount": 0,
    "lastFingerprint": "..."
  },
  "constraints": [
    "Reuse the persisted script",
    "Do not emit source code"
  ]
}
```

明确禁止投影：

- 完整脚本正文；
- 完整 stdout/stderr；
- 原始模型响应；
- 全部旧工具调用；
- 文件全文；
- API Key、URL、请求头、价格和用户对象；
- LibreChat Message 或 Conversation schema。

预算：

| 区域 | 最大字符 |
| --- | ---: |
| objective + acceptance | 4,000 |
| resources + hashes | 3,000 |
| recent item summaries | 4,000 |
| verification + progress | 2,000 |
| total serialized JSON | 12,000 |

超过预算时先丢弃旧 item，再截断单个摘要。发生省略时持久化一次
`context.compacted` 事件，只记录省略数量和投影字符数，不记录被省略正文。

## 八、usage 契约

每个成功模型调用生成一个持久 usage record：

```json
{
  "usageEventId": "task-id:plan:1:0",
  "callId": "task-id:plan:1:0",
  "modelRouteId": "file-agent-primary",
  "providerModel": "test-model",
  "inputTokens": 1200,
  "cacheReadTokens": 0,
  "cacheWriteTokens": 0,
  "outputTokens": 180,
  "occurredAt": "2026-07-23T12:00:00Z"
}
```

规则：

- `usageEventId` 等于 callId；
- Task Store 持久化 `recordedUsageEventIds` 和 usage records；
- 相同 call replay 不重复发出 `usage.recorded`；
- Runtime 不乘单价、不保存价格、不产生美元金额；
- Phase 2A usage 是 fixture 数据，不进入 LibreChat；
- Phase 3 Connector 才负责幂等入账。

## 九、进展指纹

每次 executor item 和 verification 后计算：

```text
sha256(
  phase
  planRevision
  actionSignature
  scriptHash
  outputHash
  verificationHash
  normalizedErrorSignature
)
```

有效进展：

- phase 前进；
- script hash 改变且验证项减少；
- output hash 改变且更接近验收；
- verification 从失败变为通过；
- error signature 改变并产生可验证结果。

无进展处理：

1. 首次验证失败进入正常 repair；
2. 相同失败指纹再次出现，标记 `stagnationCount + 1`，下一次 repair 必须重新规划；
3. 在相同失败指纹下，Provider 返回与上次相同 action signature 时，不执行该 plan，
   转为 `needs_input`；
4. 不按固定第三次或第五次工具调用停止；
5. wall time、Token、命令数仍只作最终熔断。

Phase 2A 必须证明重复模型建议不会再次触发相同 CodeAPI 动作。

## 十、错误分类

新增 Provider 错误：

| 类型 | 含义 | 自动重试 |
| --- | --- | --- |
| `ProviderRouteError` | route 未配置或 capability 不匹配 | 否 |
| `ProviderTransportError` | relay 暂时不可达或 5xx | 仅在幂等可保证时 |
| `ProviderRejectedError` | 认证、配额或请求拒绝 | 否 |
| `ProviderProtocolError` | 非 JSON、schema 或 usage 错误 | 否 |
| `ProviderCallConflictError` | 相同 callId、不同 request digest | 否 |
| `ProviderAmbiguousCommitError` | pending 调用无法确认是否已计费 | 否 |
| `ProviderCanceledError` | 用户或 Runtime 中断 | 否 |

Runtime 事件只保存稳定 code、message 和 retryable，不保存 prompt、credential 或
完整上游响应。

## 十一、Phase 2A 验收场景

### 场景 A：正常单模型 XLSX

- relay 返回初始 `xlsx_transform`；
- 第一次验证失败；
- relay 根据投影返回 `xlsx_patch_and_transform`；
- 第二次验证通过；
- 一个 artifact ref；
- 两条 usage，不含费用；
- prompt 中不存在稳定脚本正文和完整 stdout。

### 场景 B：模型调用后 Runtime 中断

- relay 实际执行一次并 journal completed；
- Runtime 在 provider item checkpoint 前中断；
- 重启后相同 callId 返回 journal 结果；
- relay 实际执行次数保持一；
- usage 事件只出现一次。

### 场景 C：无进展模型建议

- verification 连续得到相同失败指纹；
- relay 再次返回相同 repair action signature；
- Runtime 不执行重复 CodeAPI action；
- 任务转 `needs_input`，保留现有输出和审计事件。

### 场景 D：上下文压缩

- Task Store 注入大量旧 item 摘要；
- 投影 JSON 不超过 12,000 字符；
- 旧摘要被省略；
- 产生一个幂等 `context.compacted` 事件；
- 发送给 relay 的内容不含完整脚本或 stdout fixture marker。

## 十二、测试门禁

必须通过：

1. route allowlist 和 secret 不落盘；
2. Provider 结构化 plan schema；
3. model call journal 幂等、digest 冲突和 pending 处理；
4. usage 四类 Token 粒度与事件去重；
5. context projection 分区和总预算；
6. compacted 事件幂等；
7. 正常 XLSX、Runtime 重启和无进展停止；
8. 模型不能返回脚本或未知动作；
9. Phase 0/1 测试继续通过；
10. `npm run check`、`npm test`、`git diff --check` 通过。

## 十三、明确不做

- 不接生产 LibreChat、生产 CodeAPI 或生产模型 Key；
- 不开发 LibreChat Connector、usage ingestion 或下载卡交付；
- 不把 Runtime usage 当作已扣费 transaction；
- 不支持多个 route、模型切换或 fallback；
- 不支持模型直接生成 shell/Python；
- 不增加固定三次、五次工具调用作为主调度逻辑；
- 不实现 Word、PPT、PDF 通用 Agent；
- 不复用 Codex app-server、SDK、协议或运行进程；
- 不修改 Admin Panel、模型价格或现有 Office 上传链路。

## 十四、停止条件

任一条件成立时停止 Phase 2，不进入 Phase 3：

- Provider prompt 必须包含完整脚本或历史 stdout 才能工作；
- 模型响应无法限制在动作 schema；
- provider call 重放可能无控制地重复计费；
- usage replay 会重复发事件；
- 相同失败指纹仍会重复执行相同 action；
- Runtime 需要访问 LibreChat Mongo、价格或消息对象；
- Phase 0/1 回归失败；
- 真实非生产 relay 不能提供受限测试 Key 和预算。

## 十五、提交与发布约束

设计文档先单独提交并推送。Phase 2A 实现、测试和实施记录再作为独立 commit。

本阶段继续使用 `light` 治理，不创建生产 release，不运行 deploy 或 production
acceptance。Phase 2B 如启动，必须另有审批和独立验收记录。
