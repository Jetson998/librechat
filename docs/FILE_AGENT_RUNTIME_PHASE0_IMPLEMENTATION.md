# File Agent Runtime Phase 0 实施记录

Date: 2026-07-23

Status: implemented and locally verified; Phase 1 has since been implemented
under `docs/FILE_AGENT_RUNTIME_PHASE1_IMPLEMENTATION.md`. There is still no
production integration or deployment.

## 一、目标

验证独立 File Agent Runtime 的基础状态与恢复契约，不连接 LibreChat、MongoDB、
CodeAPI、模型供应商或生产流量。

实现位置：

```text
services/file-agent-runtime/
```

## 二、已实现能力

- `schemaVersion: 1.0` 任务清单校验；
- `Idempotency-Key` 幂等提交；
- 相同 key、不同规范化 manifest digest 返回 `409`；
- 文件型持久 Task Store 和原子 JSON 写入；
- 单调递增事件 sequence 和 `after` 游标读取；
- accepted、preparing、planning、executing、verifying、repairing、
  needs_input、publishing 和终态转换；
- item started、completed、failed 生命周期；
- cancel；
- steer 去重和等待输入后恢复；
- 非终态任务在 Runtime 重启后自动恢复；
- fake provider、fake executor、验证失败后生成 repair plan；
- artifact.ready 和 task.completed 持久事件；
- 仅绑定 `127.0.0.1` 的本地 HTTP 入口；
- 无监听端口的 Web Request/Response 路由单元测试。

## 三、文件清单

```text
services/file-agent-runtime/package.json
services/file-agent-runtime/.gitignore
services/file-agent-runtime/README.md
services/file-agent-runtime/src/constants.js
services/file-agent-runtime/src/task-store.js
services/file-agent-runtime/src/runtime.js
services/file-agent-runtime/src/fake-adapters.js
services/file-agent-runtime/src/http-server.js
services/file-agent-runtime/src/index.js
services/file-agent-runtime/test/runtime.test.js
```

## 四、持久化结构

```text
<data-dir>/
  tasks/<task-id>.json
  idempotency/<sha256-key>.json
```

Task 文档保存：

- manifest 与 digest；
- phase 和 status；
- plan revision；
- instruction revision；
- execution cursor；
- completed item IDs 和 item results；
- active item；
- result / error；
- 持久事件列表与 last sequence。

写入使用同目录临时文件加原子 rename。原始 Idempotency-Key 不落盘。

## 五、恢复和幂等语义

Runtime 启动时扫描所有非终态任务并继续执行。

每个 Provider 或 Executor 操作接收确定性的 `itemId`。未来真实 CodeAPI、Office
Worker 和模型 Adapter 必须把 `itemId` 当作幂等键。若进程在 item started 后、
item completed 前退出，恢复时可以重放同一个 item，而不会重复产生外部副作用。

Phase 0 的 Fake Executor 不产生外部副作用。真实适配器的幂等实现属于 Phase 1
和 Phase 2 的门禁。

## 六、验证结果

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
tests: 9 passed, 0 failed
```

测试覆盖：

1. 相同请求只创建一个任务和一个 accepted 事件；
2. 相同 key 的规范化相同 manifest 可复用，不同 manifest 被拒绝；
3. 事件游标只返回指定 sequence 之后的事件；
4. needs_input 收到幂等 steer 后继续完成；
5. cancel 终止正在运行的 fake executor；
6. Runtime 停止后从持久检查点恢复；
7. 验证失败后进入 repair plan，而不是重复原 plan；
8. executor 错误持久化 item.failed 和 task.failed；
9. HTTP 路由覆盖提交、查询、事件游标、参数错误和终态 steer 冲突。

## 七、明确限制

Phase 0 不是可部署的生产服务：

- 没有服务身份认证和签名 task scope；
- 没有 Redis、数据库或多副本协调；
- 事件暂存在 Task JSON 内，不适合长期大任务；
- 没有真实模型调用和 usage；
- 没有 CodeAPI、Office Worker 和 artifact persistence；
- 没有 LibreChat Connector 和 GenerationJobManager 对接；
- 没有生产监控、限流、Secret Store 或容器发布物。

不得将当前 HTTP 服务暴露到公网，也不得接入生产 LibreChat。

## 八、Phase 1 门禁（已完成）

Phase 1 只做非生产 CodeAPI 文件 POC：

1. 定义 `ExecutorAdapter` 的正式接口和错误类型；
2. 使用一个隔离的非生产 CodeAPI session；
3. 使用固定 plan，不调用真实模型；
4. 支持一个 XLSX 输入、一个稳定脚本、一次增量 patch、一次验证和一个输出 ref；
5. 验证 `itemId` 在 CodeAPI 调用中的幂等行为；
6. 验证 Runtime 重启后不会重复生成外部 artifact；
7. 不修改生产 Office 上传、CodeAPI priming 或 LibreChat 消息链路。

上述门禁已由 Phase 1 隔离 POC 通过。单模型 Phase 2 仍需独立设计，不得直接接入
生产。

## 九、回滚

本阶段没有生产写入。回滚只需要撤销本次仓库提交，不涉及服务、数据库、容器、
用户文件或生产配置。
