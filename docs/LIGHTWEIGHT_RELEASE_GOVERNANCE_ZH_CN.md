# 轻量发布治理说明

这套流程解决五个实际问题：改了什么看得见，结果是否通过有证据，生产和
仓库是否一致，失败后从哪里恢复，以及如何快速回滚。

它不是新的开发平台。普通分析、写代码、写文档和本地测试不需要经过生产
门禁。只有准备发布或要修改外部运行环境时，才进入对应保护模式。

LibreChat 的项目规则集中在仓库根目录的 `release-governance.json`，日常
操作通过 `scripts/release-*.sh` 完成。

修改治理方案后，用一条命令完成本地检查：

```sh
scripts/validate-release-governance.sh
```

## 一、三种常用模式

| 模式 | 什么时候用 | 说明 |
|---|---|---|
| `light` | 分析、文档、本地实验 | 不接触生产，不执行部署门禁 |
| `release` | 准备版本、打包或发布记录 | 需要基线、变更记录、验证和可追溯制品 |
| `protected` | 修改生产文件、服务、配置或数据 | 需要只读预检、范围限制、部署、验收和结果记录 |

`enhanced` 用于数据库迁移、共享基础设施或并行发布等更高风险场景。

## 二、一次 LibreChat 发布怎么做

### 1. 创建发布记录

```sh
scripts/release-prepare.sh 2026-07-19-example protected
```

编辑生成的：

```text
deployment/release-records/2026-07-19-example/RELEASE.json
```

至少填写：原因、功能清单、修改范围、预期结果、风险、基线、验证计划、
回滚方式、source_revision 和项目适配信息。不要在记录里写密码、令牌、
Cookie 或原始用户数据。

### 2. 提交并推送计划

```sh
git add deployment/release-records/2026-07-19-example/RELEASE.json
git commit -m "Record release plan"
git push origin main
```

### 3. 验证仓库和发布范围

```sh
scripts/release-verify.sh 2026-07-19-example
```

它会检查当前项目、分支、远端、source revision、远端主线和修改范围。
在这些比较之前，它先确认所需本地命令和远端只读引用确实可用。命令根本
没有启动时，应记录为执行环境阻塞，不能误判为仓库或凭据失败。
远端主线发生变化且影响发布范围时，流程会停止，不会自动覆盖并行修改。

### 4. 从指定 revision 打包

```sh
scripts/release-package.sh 2026-07-19-example
```

包来自记录的 source revision，不来自当前未提交工作区。输出位于：

```text
.release-state/2026-07-19-example/artifacts/
```

### 5. 记录构建证明

有 CI 或制品证明时，准备一个不含秘密的 JSON：

```json
{
  "status": "passed",
  "source_revision": "完整版本号",
  "artifact_sha256": "manifest 中的制品摘要",
  "provider": "构建系统名称",
  "details": {}
}
```

然后执行：

```sh
scripts/release-attest.sh 2026-07-19-example /path/to/attestation.json
```

只有项目配置明确允许时，才可以使用 `not_applicable`，并写出原因。

### 6. 生产只读预检

```sh
scripts/release-preflight.sh 2026-07-19-example
```

这个步骤只读取仓库和公开运行状态，检查主页、`/api/config`、`/office/`
认证边界和 Admin 页面，不发送模型请求，不创建新对话。

### 7. 受控部署

部署记录必须指定一个版本化 runner，并且 runner 必须位于允许目录、包含
范围部署标记。执行时必须显式确认 release id：

```sh
scripts/release-deploy.sh 2026-07-19-example \
  --confirm 2026-07-19-example
```

如果发布记录没有合法 runner，脚本会停止。它不会猜测要重建哪个服务，
也不会通过 `PREFLIGHT_ONLY` 一类变量绕过预检。

### 8. 验收和收尾

```sh
scripts/release-acceptance.sh 2026-07-19-example
```

填写实际备份路径、部署结果、验收结果和已知问题，提交并推送
`RELEASE.json`，最后执行：

```sh
scripts/release-finalize.sh 2026-07-19-example
```

## 三、失败后怎么恢复

先查看：

```sh
scripts/release-status.sh <release-id>
```

状态文件位于：

```text
.release-state/<release-id>/checkpoint.json
```

不要从头盲目重跑，也不要直接跳过失败步骤。只要 source revision、发布
范围、制品摘要、远端状态或生产快照发生变化，后续 checkpoint 会自动失效，
从第一个失效门禁重新验证。

完整日志和快照保存在 `.release-state/`，对话中只需要汇报状态、摘要、警告
和文件路径。

## 四、最重要的规则

```text
普通工作保持轻量；任何生产写入都有最低保护；高风险发布启用完整保护。
```
