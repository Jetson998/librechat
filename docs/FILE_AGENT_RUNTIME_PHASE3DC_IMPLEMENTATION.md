# File Agent Runtime Phase 3D-C 实现记录

Date: 2026-07-24

Status: implementation complete and pushed. External non-production acceptance
has not run because no non-production CodeAPI endpoint, credential, or primed
fixture reference is configured. Production remains unchanged and unauthorized.

## 一、实现内容

1. 新增 `LibreChatCodeApiTransport`，把 Runtime executor 请求映射为 LibreChat
   CodeAPI 原生 `/exec` 协议：`lang`、`code`、`session_id`、`files`。
2. 只在 publish 阶段把明确请求的 artifact path 映射为 CodeAPI ref；中间文件不会进入
   Connector delivery。
3. CodeAPI response 对 HTTP、JSON、exit code、file list、artifact identity 和 timeout
   失败关闭，不把未知文件作为输出。
4. 将原 Phase 3D-A 验收器抽成可注入依赖的公共 runner；原隔离 relay/CodeAPI 行为保留，
   3D-C 只注入外部非生产 transport、预算器和报告器。
5. 新增 disabled-by-default `npm run phase3dc:accept`：
   - 固定仓库 XLSX fixture 和 SHA-256；
   - CodeAPI 预检失败时零模型调用；
   - 最多两次模型调用、7 次 CodeAPI `/exec`、180 秒总预算；
   - 汇总 input/cache read/cache write/output Token；
   - 下载单个 XLSX 并记录大小和 SHA-256；
   - 扫描临时运行目录，拒绝持久化 Key、Authorization、外部 URL 或原始模型输出。

## 二、验证结果

```text
File Agent Runtime tests: 35 passed
LibreChat Connector tests: 53 passed
LibreChat CodeAPI adapter focused tests: 5 passed
Runtime syntax checks: passed
Connector syntax checks: passed
Release governance tests: 32 passed
Release governance config and Skills validation: passed
git diff check: passed
```

`phase3dc:accept` 的禁用门禁已验证：缺少 `FILE_AGENT_PHASE3DC_SCOPE` 时在任何网络
请求之前退出。

原 Phase 3D-A 隔离 acceptance 的脚本级复跑尝试未启动：本地提权自动审批服务连续返回
`503 Service Unavailable`。这不是应用测试失败。公共 Runtime 和 Connector HTTP 链路已由
上述 35 + 53 项完整测试覆盖，但该脚本复跑不记为 passed。

## 三、尚未执行的真实门禁

真实 Phase 3D-C 仍需要以下非生产 CodeAPI 运行时参数：

```text
FILE_AGENT_PHASE3DC_CODEAPI_BASE_URL
FILE_AGENT_PHASE3DC_CODEAPI_BEARER_TOKEN
FILE_AGENT_PHASE3DC_CODEAPI_SESSION_ID
FILE_AGENT_PHASE3DC_CODEAPI_FILE_ID
FILE_AGENT_PHASE3DC_CODEAPI_RESOURCE_ID
```

其中 session/file 必须指向已经通过非生产上传流程 prime 的仓库 fixture
`phase2b-source.xlsx`。当前仓库、本机环境和 `/private/tmp` 均没有这些配置。生产
`LibreChat-CodeAPI` 的存在不构成非生产验收授权，不会用于替代。

Model relay 的测试地址和 Key 只在上述 CodeAPI 预检通过后才会使用。当前没有执行真实
model relay 或 CodeAPI 请求，也没有产生模型费用。

## 四、提交

```text
4101570 docs: define phase3dc external acceptance gate
daf19d6 feat: add phase3dc external acceptance gate
```

两个提交均已推送 `origin/main`。

## 五、边界

本阶段没有 production wiring、启动 hook、feature flag、生产 secret、部署包或生产发布
记录。真实非生产报告通过前，不进入生产设计；生产设计另行批准后仍需独立发布门禁。
