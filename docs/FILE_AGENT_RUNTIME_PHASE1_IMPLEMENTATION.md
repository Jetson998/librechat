# File Agent Runtime Phase 1 实施记录

Date: 2026-07-23

Status: implemented and locally verified against an isolated non-production
CodeAPI fixture. No production integration or deployment was performed.

## 一、完成范围

Phase 1 在 `services/file-agent-runtime/` 内完成以下能力：

- 正式 `ExecutorAdapter` 接口与结构校验；
- transport、拒绝、执行、协议、artifact 和取消错误分类；
- HTTP CodeAPI transport，所有调用透传确定性 `itemId`；
- 固定 `DeterministicXlsxProvider`，不调用模型；
- 单 XLSX 输入约束与 session 一致性校验；
- 稳定脚本与稳定输出路径；
- 首次执行、确定性验证失败、一次增量 patch、重新执行和最终验证；
- 一个完整 XLSX artifact ref；
- 测试 checkpoint hook，用于模拟外部成功后 Runtime 尚未持久化的中断窗口；
- 隔离 CodeAPI fixture 的持久 item response 和 replay；
- Phase 0 fake adapters 与原状态机测试继续兼容。

## 二、新增文件

```text
services/file-agent-runtime/src/executor-adapter.js
services/file-agent-runtime/src/codeapi-transport.js
services/file-agent-runtime/src/deterministic-xlsx.js
services/file-agent-runtime/test/isolated-codeapi.js
services/file-agent-runtime/test/phase1-codeapi.test.js
docs/FILE_AGENT_RUNTIME_PHASE1_CODEAPI_POC_PLAN.md
docs/FILE_AGENT_RUNTIME_PHASE1_IMPLEMENTATION.md
```

更新文件：

```text
services/file-agent-runtime/src/runtime.js
services/file-agent-runtime/src/fake-adapters.js
services/file-agent-runtime/src/http-server.js
services/file-agent-runtime/src/index.js
services/file-agent-runtime/package.json
services/file-agent-runtime/README.md
docs/INDEPENDENT_FILE_AGENT_RUNTIME_ARCHITECTURE.md
docs/FILE_AGENT_RUNTIME_PHASE0_IMPLEMENTATION.md
```

## 三、执行流程

固定 plan 如下：

```text
prepare workspace and stable script
  -> run stable XLSX transform
  -> verify workbook
  -> repair required
  -> patch one script marker and rerun
  -> verify workbook
  -> publish one CodeAPI artifact ref
```

稳定路径：

```text
/mnt/data/.agent/<taskId>/scripts/transform_workbook.py
/mnt/data/.agent/<taskId>/output/phase1-output.xlsx
```

prepare 只在脚本不存在时写入。repair 断言旧 marker 恰好出现一次，只替换该
marker，不重写整份程序。重复 prepare 不会覆盖已经 patch 的脚本。

## 四、隔离 CodeAPI fixture

fixture 只监听 `127.0.0.1` 的随机端口，并为每个测试使用独立临时目录：

```text
<tmp>/codeapi/
  idempotency/<sha256-item-id>.json
  sessions/<session-id>/mnt/data/
```

它只接受 allowlist session 和预注册文件引用，将虚拟 `/mnt/data` 映射到测试目录，
并按 `itemId` 原子持久化执行响应。相同 item 再次请求时返回原响应和
`replayed: true`。

fixture 不读取生产凭据、不访问远端网络，也不属于可部署组件。

## 五、恢复验收结果

测试在 `xlsx_transform` 外部执行成功后、Runtime 写入 `completedItemIds` 前抛出
`RuntimeShutdownError`：

1. 第一个 Runtime 持久化 `item.started`；
2. CodeAPI 实际执行一次并保存响应；
3. Runtime 未持久化 item completed；
4. 第二个 Runtime 从 Task Store 恢复；
5. 同一确定性 `itemId` 再次发送；
6. CodeAPI 返回 `replayed: true`；
7. 该 item 的实际执行计数保持为一；
8. 最终只有一个 artifact ref 和一个 `artifact.ready` 事件。

这证明 Phase 1 解决的是外部副作用幂等，而不只是 Runtime 内部去重。

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
tests: 13 passed, 0 failed
```

测试覆盖：

1. 完整 XLSX transform、repair、verify 和 artifact ref；
2. 重复 prepare 不覆盖已经 patch 的稳定脚本；
3. 每个 CodeAPI 请求携带 Runtime item ID；
4. Runtime 重启重放相同 item 且外部实际执行一次；
5. transport 对拒绝、上游、协议和命令退出错误的分类；
6. 不完整 ExecutorAdapter 在任务启动前被拒绝；
7. Phase 0 的提交幂等、事件游标、steer、cancel、恢复、repair、失败和 HTTP API
   回归测试。

## 七、无生产影响审计

本阶段未修改：

- `deployment/production-patches/`；
- `deployment/production-operations/`；
- LibreChat API bundle 或 client bundle；
- Docker Compose、Nginx、Mongo、Admin Panel；
- Office 上传、pre-parse、CodeAPI priming；
- LibreChat Message、File、transaction 或下载卡；
- 生产主机、生产 CodeAPI 或用户会话。

默认 `npm start` 仍使用 fake adapters。Phase 1 CodeAPI executor 没有接入启动参数，
因此不能被误配置为生产服务。

## 八、已知限制

- HTTP `/exec` 字段是 Phase 1 隔离 transport 契约，尚未对接真实非生产 CodeAPI
  的认证与最终字段映射；
- fixture 使用单进程文件锁语义，不证明多副本协调；
- Python `openpyxl` 只属于隔离执行环境依赖；
- 只有一个确定性 XLSX 场景；
- 没有模型 usage、上下文投影或进展判断；
- artifact 尚未经过 LibreChat `processCodeOutput()` 持久化。

## 九、下一步门禁

进入 Phase 2 前必须先形成单模型集成设计，至少解决：

1. ProviderAdapter 的结构化计划与 usage 契约；
2. 真实非生产 CodeAPI transport 的认证和协议映射；
3. context projection、脚本摘要和错误摘要预算；
4. progress fingerprint 与无进展 repair 条件；
5. model tool output 不得包含整份脚本和无界 stdout；
6. usage 只回传 LibreChat 入账，不在 Runtime 保存价格；
7. Phase 2 仍不得接生产流量。

未通过这些门禁，不允许把 Runtime 路由接入 LibreChat。

## 十、回滚

本阶段没有生产写入。回滚只需撤销 Phase 1 实现提交；设计提交可保留作为决策记录。
