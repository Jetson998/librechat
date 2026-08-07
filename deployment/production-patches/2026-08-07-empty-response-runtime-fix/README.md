# Empty-response runtime fix

状态：开发候选。该批次修复生产中“模型请求成功但语义内容为空”被系统误报为
`generation_failed`，并修复失败后预响应父消息长期处于 `saving` 导致后续
`FOLLOWUP_REJECTED_PARENT_SAVING` 的连带状态问题。

## 变更范围

- `BaseClient.js` 对语义空响应抛出稳定的 `EMPTY_MODEL_RESPONSE`，只附带受限的
  `responseShape` 诊断摘要，不记录原始响应、prompt、文件、工具输出或密钥。
- Agent 请求错误路径只根据真正的 `AbortController` 状态判定用户主动 Stop；系统错误
  不再被错误归类为中断。
- 生成失败时持久化终态助手错误消息并发送 `final`，用户可直接重新生成；内部错误细节
  不会原样显示给用户。
- `DiagnosticEvents` 对 `responseShape` 使用严格白名单和边界限制。

## 目标与回滚

只重建 `LibreChat-API`，替换 `SOURCE_MANIFEST.json` 中的四个只读挂载。以下服务的
容器 ID 必须保持不变：`LibreChat-CodeAPI`、`LibreChat-NGINX`、`LibreChat-RAG-API`、
`chat-mongodb`、`LibreChat-Admin-Panel`。远端 runner 在写入前锁定 Compose 基线，并在
写后校验失败时自动恢复时间戳匹配的 `compose.override.yaml`，只重新创建 API。

## 本地开发检查

```sh
node deployment/production-patches/2026-08-07-empty-response-runtime-fix/scripts/test-diagnostic-events.js
node deployment/production-patches/2026-08-07-empty-response-runtime-fix/scripts/test-empty-response-runtime.js
python3 deployment/production-patches/2026-08-07-empty-response-runtime-fix/scripts/test-release.py
git diff --check
```

## 轻量发布顺序

开发完成并提交一个稳定 revision 后，按项目适配器执行：

```sh
scripts/release-prepare.sh 20260807-empty-response-runtime-fix protected
scripts/release-verify.sh 20260807-empty-response-runtime-fix
scripts/release-package.sh 20260807-empty-response-runtime-fix
scripts/release-attest.sh 20260807-empty-response-runtime-fix .release-state/20260807-empty-response-runtime-fix/build-attestation.json
```

完成一次新鲜的只读 target preflight 后再部署。`collect-preflight.sh` 参数为：

```text
<source revision> <artifact sha256> <release plan sha256> <output path>
```

部署必须由发布适配器调用候选目录中的 `scripts/deploy.sh`，并通过精确的 release ID
确认。不要对 CodeAPI、MongoDB、NGINX、RAG 或 Admin Panel 执行 Compose recreate。

## 验收边界

发布后检查主页、`/api/config`、Office 认证边界和四个挂载 hash；使用 `vip998` 做一次
受控 Agent 请求，确认空响应时页面展示可操作的重新生成提示，失败后重新生成不再
触发父消息仍在保存的 409。另做一次用户主动 Stop 检查。该技术验收不等同于所有模型、
所有 Agent 或完整压力测试。
