# File Agent Runtime Phase 1 CodeAPI POC 方案

Date: 2026-07-23

Status: design gate approved for repository implementation. This phase is
non-production only and must not be deployed or connected to production
LibreChat or production CodeAPI.

## 一、目标

Phase 1 验证独立 File Agent Runtime 能否通过正式 ExecutorAdapter 驱动一个
隔离的 CodeAPI session，完成可恢复、可验证且不会重复生成外部文件的确定性
Excel 任务。

本阶段只验证执行器边界，不接模型、不接 LibreChat Connector、不接计费，也不
改变现有 Office 上传、CodeAPI priming、消息保存或下载卡逻辑。

## 二、固定验收场景

只支持一个测试场景：

1. 输入一个 `.xlsx` 文件引用；
2. 在任务工作区持久化一个稳定 Python 脚本；
3. 固定 plan 首次运行该脚本生成一个 `.xlsx` 输出；
4. 第一次验证确定性失败，进入 repair phase；
5. repair plan 对原脚本做一次小范围 patch，不重写整份脚本；
6. 使用同一脚本路径重新生成同一输出路径；
7. 验证工作簿可打开、目标 sheet 和修复标记存在；
8. 返回一个 CodeAPI artifact reference；
9. 在外部执行成功但 Runtime 尚未持久化 item completed 的窗口中模拟中断；
10. Runtime 重启后重放相同 `itemId`，CodeAPI 返回原结果，不产生第二个输出。

固定 plan 由 `DeterministicXlsxProvider` 提供，不调用真实模型。Phase 2 才允许接入
一个模型 Provider。

## 三、接口边界

### 3.1 ExecutorAdapter

Runtime 只依赖以下正式接口：

```text
prepare({ itemId, task, signal }) -> workspace result
execute({ itemId, action, task, signal }) -> action result
verify({ itemId, task, signal }) -> verification result
publish({ itemId, task, signal }) -> artifact refs
```

每个外部调用必须携带 Runtime 生成的确定性 `itemId`。Adapter 不得自行生成
替代幂等键。

返回值必须是 JSON 可序列化对象。Adapter 不得写 Task Store，不得发 Runtime
事件，也不得生成 LibreChat Message、File 或 transaction。

### 3.2 CodeAPI Transport

CodeAPI 网络细节隔离在 transport 中：

```text
execute({
  itemId,
  sessionId,
  command,
  injectedFiles,
  artifactPaths,
  timeoutMs,
  signal
}) -> {
  status,
  exitCode,
  stdout,
  stderr,
  artifacts,
  replayed
}
```

Phase 1 transport 使用隔离测试服务的 `/exec` 兼容协议。它不导入 LibreChat
源码，也不复用生产请求对象、JWT minting 或 Agents ToolNode。以后接真实非生产
CodeAPI 时，只允许在 transport 层适配认证和字段映射。

### 3.3 Artifact reference

Runtime 只返回不透明 CodeAPI 引用：

```json
{
  "name": "phase1-output.xlsx",
  "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "codeEnvRef": {
    "storage_session_id": "isolated-session-id",
    "file_id": "opaque-codeapi-file-id"
  }
}
```

本阶段不调用 `processCodeOutput()`。该引用不会进入 LibreChat 文件库或下载卡。

## 四、错误分类

Executor 必须将错误映射为稳定类型：

| 类型 | 含义 | 默认可重试 |
| --- | --- | --- |
| `ExecutorTransportError` | 网络、超时或服务暂时不可达 | 是 |
| `ExecutorRejectedError` | CodeAPI 拒绝认证、scope 或请求 | 否 |
| `ExecutorExecutionError` | 命令已执行但退出码非零 | 否，由 repair plan 决定 |
| `ExecutorProtocolError` | 响应不是约定结构 | 否 |
| `ExecutorArtifactError` | 预期输出缺失或引用不完整 | 否 |
| `ExecutorCanceledError` | AbortSignal 终止 | 否 |

错误记录只持久化类型、稳定 code、message 和 retryable，不把完整脚本、认证头或
超大 stdout/stderr 写进事件。

## 五、稳定脚本与增量 patch

脚本保存在：

```text
/mnt/data/.agent/<taskId>/scripts/transform_workbook.py
```

输出保存在：

```text
/mnt/data/.agent/<taskId>/output/phase1-output.xlsx
```

首次 prepare 只在脚本不存在时写入固定内容。repair action 只替换一个受控 marker，
并验证替换次数恰好为一；不得让 provider 返回或重写 10K 至 20K 字符的整份脚本。

脚本和输出路径保持稳定。恢复后相同 `itemId` 重放必须返回第一次成功执行的结果，
不能再次运行外部副作用。

## 六、隔离 CodeAPI 验收服务

测试服务只绑定 `127.0.0.1`，每个测试使用独立临时目录和固定 session allowlist。
它负责：

- 将虚拟 `/mnt/data` 映射到测试临时目录；
- 注入唯一授权的 XLSX fixture；
- 执行固定命令；
- 按 `itemId` 持久化成功响应；
- 相同 `itemId` 重放时返回缓存响应并标记 `replayed: true`；
- 为声明的输出路径生成稳定 `file_id`；
- 记录每个 item 的实际执行次数。

测试服务不是新的生产 CodeAPI，也不得打包或部署。

## 七、中断注入与恢复证明

测试必须提供一个仅测试使用的 Runtime checkpoint hook，在 Executor 返回成功后、
`completedItemIds` 持久化前触发一次模拟崩溃。验收顺序：

1. CodeAPI 对目标 `itemId` 实际执行一次并生成输出；
2. Runtime 在持久化完成前停止；
3. 新 Runtime 从同一 Task Store 启动；
4. 同一 item 以相同 `itemId` 重放；
5. CodeAPI 返回缓存结果；
6. 实际执行计数仍为一；
7. 最终只有一个 artifact reference 和一个 `artifact.ready` 事件。

该 hook 默认不存在，不进入 HTTP API，也不形成生产控制面。

## 八、测试门禁

必须通过：

1. ExecutorAdapter 结构校验；
2. transport 错误到 typed error 的映射；
3. 单 XLSX 固定 plan 完成；
4. 首次验证失败后只执行一次增量 patch；
5. 稳定脚本路径不变且 prepare 不重复覆盖；
6. 每次 CodeAPI 调用都携带对应 `itemId`；
7. 中断恢复不重复实际执行、不重复 artifact；
8. artifact ref 包含 session、file ID、名称和 MIME；
9. Runtime 仍兼容 Phase 0 fake adapters；
10. `npm run check`、`npm test` 和 `git diff --check` 通过。

## 九、明确不做

- 不调用生产 `https://152.32.172.162.sslip.io`；
- 不使用生产 SSH、Mongo、CodeAPI session 或用户文件；
- 不修改 LibreChat API bundle、Admin Panel、Nginx 或 Docker Compose；
- 不新增 Office 上传入口、pre-parse、消息 fallback 或下载卡逻辑；
- 不接真实模型或价格配置；
- 不做通用 Word、PPT、PDF 工作流；
- 不公开 Runtime 或测试 CodeAPI 端口；
- 不把 Codex app-server 或 SDK 加入依赖。

## 十、停止条件

出现以下任一情况，Phase 1 停止，不进入 Phase 2：

- 需要修改生产链路才能完成 POC；
- `itemId` 无法成为外部幂等键；
- Runtime 重启会产生第二个外部 artifact；
- Executor 需要访问 LibreChat Mongo 或源码内部对象；
- 真实 CodeAPI 协议无法在 transport 层独立适配；
- XLSX 验证只能依赖模型主观判断。

## 十一、提交与发布约束

设计文档先单独提交并推送。实现完成后再提交代码、测试和实施记录。

本阶段使用日常 `light` 治理：只做仓库提交和聚焦测试，不创建生产 release，
不执行 package、deploy 或 acceptance 命令。
