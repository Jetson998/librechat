# File Agent Runtime Word M2 设计记录

Date: 2026-08-03
Status: development-only implementation record

本记录固化跨轮次 Runtime task 的 Connector 设计。它不授权打包、预检、部署、生产
流量或客户文件验收。

## 1. 事实源和记录边界

- Runtime task 由 Runtime 负责创建和执行。
- `activeTaskStore` 是 Connector 侧 task 绑定的唯一事实源，保存 scope、task/workspace
  绑定、task event cursor、usage receipts、artifact receipts 和 turn 列表。
- delivery record 仍是单个 LibreChat 用户轮次的消息、final event 和 GenerationJob
  finalization 记录；它只复制 task 级 cursor/receipt 供当前轮次交付，不重新拥有这些事实。
- Mongo 生产集成通过 `collections.activeTasks` 使用 `MongoActiveTaskStore`；没有提供该
  collection 时保持旧 XLSX Connector 路径兼容，但不宣称支持跨轮次恢复。

## 2. 跨轮次接口

### `submitTurn`

适用于同一 conversation 没有新输入文件、用户要求“继续/按刚才要求修改”的场景。

- 只从当前用户、租户、conversation 的 active task 中选择目标。
- 只有一个 active task 时自动使用；多个时返回候选摘要并要求显式选择。
- 复用原 taskId、workspace、billing snapshot、model route 和输入授权。
- 为本轮创建新的 user/assistant/stream turn delivery，然后用稳定 instructionId steer 原 task。
- 上游请求解析器只将明确的“继续/按刚才要求”等无文件消息标为 continuation candidate；普通
  无文件聊天仍走原生路径。

### `rebindTurn`

适用于 CodeAPI session 或文件引用失效、用户已经重新 prime 原文件的场景。

- `fileId` 必须映射到原 task 已授权的 LibreChat file ref；不得通过调用方自带 ref 替换身份。
- 文件所有权、conversation、内容 hash 和 MIME 必须保持一致。
- 只允许更新同一输入的 CodeAPI `storage_session_id/file_id`。
- Runtime 在受控 steer 中校验相同 task、相同用户 scope 和原输入集合，随后更新 task
  manifest 的 CodeAPI ref；不会创建第二个 task。

### `steerTurn`

Runtime steer 的 `instructionId` 默认由 task、三条消息身份和指令内容确定性派生；重复
HTTP 请求因此不会产生第二个 Runtime instruction。显式 instructionId 仍可用于调用方
做跨服务幂等。

## 3. 事件和回执

消费顺序为：

```text
读取 task cursor -> 应用当前事件业务副作用 -> 持久 task cursor -> 同步当前 turn delivery
```

usage 和 artifact 写入 LibreChat 成功后，才标记 task receipt。重复事件先检查 task receipt，
重放不会重复 transaction 或生成文件。多轮交付从 task cursor 开始，不重放前一轮已完成的
历史副作用；如果另一实例已经推进 cursor，当前轮次仍会根据 task terminal status 完成自身
消息 finalization。

## 4. 安全和停止边界

- task scope 始终绑定 user、tenant 和 conversation；跨 scope 恢复返回 409。
- completed、failed、canceled task 不会被静默 steer 或 rebind。
- active task 选择不猜测；多个活动 task 必须由调用方给出 `activeTaskId` 或 `taskId`。
- Runtime 接受 task 后 Connector 继续 fail closed，不回退原 Agent。
- 本阶段只验证本地持久 Runtime、内存/Mongo 适配器和非生产 HTTP adapter；不把单 Runtime
  数据目录称为生产多副本方案。

## 5. M2 回归范围

已覆盖：

- 一个 task 跨三个用户轮次，每轮有独立 assistant message 和 turn 绑定；
- 重复 follow-up 只创建一个 turn delivery 和一个 Runtime instruction；
- 多 active task 选择、跨租户拒绝和 task terminal 边界；
- stale CodeAPI ref 在同一 task/workspace 内 rebind；
- task 级 usage/artifact receipt、event cursor 和 Mongo optimistic mutation；
- 旧 XLSX Runtime/Connector 全量回归。

M2 不包含 Word Worker/Verifier、生产部署、真实非生产 relay/CodeAPI 联合验收；这些进入
M3/M4，并需独立门禁。
