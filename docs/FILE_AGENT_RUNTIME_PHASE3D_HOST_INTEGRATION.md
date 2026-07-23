# File Agent Runtime Phase 3D 非生产宿主接入记录

Date: 2026-07-23

Status: Phase 3D-A isolated real-Mongo acceptance and Phase 3D-B pinned full
LibreChat browser acceptance passed. One real external CodeAPI/model task remains
a separate non-production gate. Production was not changed.

## 一、范围

本阶段把 Phase 3C 的 Controller 分流契约推进到可组装的非生产宿主边界：

```text
current request attachments
  -> owner / tenant / CodeAPI ref validation
  -> Runtime capability probe
  -> persist authoritative LibreChat user turn
  -> freeze native model prices in Mongo
  -> submit one durable Runtime task
  -> periodic/immediate reconcile
  -> usage, generated file, assistant message, final event, completed job
```

LibreChat 仍负责聊天、会话、文件、下载卡、消息、计费与 SSE；Runtime 只负责复杂
文件任务。普通聊天或没有显式 app-local bridge 的进程保持原路径。

## 二、已实现

1. 从 `req.body.files` 取得当前请求文件 ID，并且只允许解析初始化后的
   `client.options.attachments`；不新增跨会话文件查询。
2. 校验用户、tenant、CodeAPI user ref、storage session 和 file ref；当前 worker
   只接受一个 XLSX，多文件在保存 user turn 前返回 native。
3. 价格源使用 `client.options.endpointTokenConfig`、`client.options.agent.model` 和
   `client.options.agent.endpoint`。Mongo snapshot 只保存四个有效价格，不保存函数或
   credential；只保留当前模型的 tokenConfig 切片，交付时从 snapshot 重建计价函数。
4. 新增 Runtime FIFO queue，默认最多两个并发任务；Controller 释放请求并发计数后，
   Runtime 自己持有容量与排队状态。
5. 新增立即 wake 与周期扫描 reconciler。相同 delivery 的同时 wake 会合并，重启后
   从 Mongo cursor 恢复。
6. 上游 overlay 同时锁定 Controller 和 Agent route 两个 source blob。route 只读取
   `req.app.locals.fileAgentRuntimeBridge`；没有 app-local 时行为不变。
7. 生成文件消息按 LibreChat 原生 `execute_code` 契约保存：每个 attachment 都有
   同 ID 的 `tool_call` content part，当前会话可在 final SSE 后立即渲染下载卡。

## 三、Phase 3D-A 真实验收

验收器：

```text
services/librechat-file-agent-connector/
  scripts/phase3d-nonproduction-acceptance.js
```

它默认拒绝运行，仅在以下条件同时满足时执行：

```text
FILE_AGENT_PHASE3D_SCOPE=non-production
FILE_AGENT_PHASE3D_CONFIRM=ONE_ISOLATED_NON_PRODUCTION_TASK
FILE_AGENT_PHASE3D_MONGO_MODE=memory-server 或 uri
```

2026-07-23 实际执行使用：

- MongoDB 8.2.1 临时 loopback `mongod`，不是 Map 或 collection double；
- MongoDB Node driver 位于 `/private/tmp`，未写入仓库依赖；
- 真实 loopback Runtime HTTP server 和 `RuntimeClient.fetch`；
- 隔离 recorded model relay，实际产生 plan 与 repair 两次 usage；
- 隔离 CodeAPI execution server，实际执行 XLSX worker 并生成一个文件；
- Mongo delivery/billing snapshot 唯一索引、乐观更新和恢复 cursor；
- reconcile 重放后无重复 transaction、文件、message、final event 或 job completion。

脱敏结果：

```text
status=passed
deliveryStatus=completed
usageEvents=2
generatedFiles=1
replayProducedDuplicates=false
runtimeCapacity=1 running=0 queued=0
```

这证明了 Connector 到独立 Runtime 的持久交付边界，但没有冒充完整 LibreChat E2E。

## 四、验证结果

```text
Connector tests: 53 passed
Connector syntax checks: passed
Runtime tests: 30 passed
Runtime syntax checks: passed
Phase 3D-A isolated real-Mongo acceptance: passed
Phase 3D-B pinned full LibreChat browser acceptance: passed
Pinned upstream overlay apply/source checks: passed
```

## 五、Phase 3D-B 完整 LibreChat 验收

验收器：

```text
services/librechat-file-agent-connector/
  scripts/phase3db-librechat-acceptance.js
```

2026-07-24 在锁定上游 commit
`60eba76375213dafc1874d943e41371201c300ab` 的完整 build 中通过：

1. 安装 overlay 后启动真实 API build；
2. 使用临时 MongoDB、动态测试账号、隔离 model relay 与隔离 CodeAPI；
3. 从 composition root 显式安装 app-local bridge、collections、native ports 和
   reconciler，不增加环境变量自动启用路径；
4. 验证普通聊天零 Runtime 请求；
5. 上传当前轮 XLSX，单次提交只创建一个 Runtime task，页面不刷新即可结束并出现下载卡；
6. 分别重启 Runtime 与 LibreChat API，证明 cursor 恢复且不重复计费/文件；
7. 卸载 app-local bridge 后，新请求完全回到原生 Agent。

脱敏结果：

```text
status=passed
ordinaryChatRuntimeTasks=0
bridgedWorkbookUploads=2
runtimeTaskSubmissions=2
runtimeRestartRecovered=true
apiRestartRecoveredFromMongo=true
completionWithoutRefresh=true
nativeDownloadCard=true
nativeFallbackAfterBridgeRemoval=true
deliveries=2 snapshots=2 transactions=8 generatedFiles=2 outputMessages=2
```

完整记录见 `docs/FILE_AGENT_RUNTIME_PHASE3DB_ACCEPTANCE.md`。

## 六、下一道非生产门禁

Phase 3D-C 再使用隔离测试 Key 执行一次有预算上限的真实外部 model relay 与真实
非生产 CodeAPI 任务。验收报告只保留 endpoint contract、usage、延迟、文件 hash 和
状态，不保存 URL、Key、客户文件或原始模型输出。

Phase 3D-C 通过并另行批准生产方案前，不创建 production patch，不部署生产，不开放
客户流量，也不扩展 Word、PPT、PDF worker。
