# 轻量发布治理说明

这套流程解决五个实际问题：改了什么看得见，结果是否通过有证据，生产和
仓库是否一致，失败后从哪里恢复，以及如何快速回滚。

它不是新的开发平台。普通分析、写代码、写文档和本地测试不需要经过生产
门禁。只有准备发布或要修改外部运行环境时，才进入对应保护模式。

不要为每个 AI 开发任务创建一次发布。相关模块可以连续开发、定向测试并正常
提交；准备统一上线时，再用一个发布记录覆盖这批累计修改。路径解析、构建
证明、生产预检和业务验收都按这个发布批次执行一次。

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
| `protected` | 普通生产文件、服务、配置或数据变更 | 需要只读预检、范围限制、风险自适应业务验收和结果记录 |

`enhanced` 用于数据库迁移、认证权限、核心路由、共享基础设施或并行发布等
更高风险场景，并使用重度业务验收。它是低频批量门禁，不是每次开发的默认
流程。

## 二、业务验收怎么选

业务验收始终属于生产发布治理，但不等于每次都检查全部页面、角色和功能。
模型应先识别本次修改影响的业务路径，再选择验收强度。

普通正式发布默认使用轻度验收：

- 只覆盖修改相关的页面、接口、角色、数据或服务；
- 复用与同一 source revision、artifact 和配置匹配的 CI 或候选版本证据；
- 部署后执行少量、低成本、可清理的 smoke；
- 非 UI 修改不强制浏览器；
- 非模型或工具链修改不发送模型请求；
- 详细结果写入证据文件，对话只返回摘要、警告和位置。

登录权限、计费额度、模型路由、Office/文件链路、数据库迁移、多服务联动、
难以回滚的变化和重大版本升级使用重度验收。没有独立 UAT 环境时，可以
使用 CI、临时环境、维护窗口或生产定向 smoke；不可逆变化不能在生产首次
验证。

基础主页、`/api/config`、`/office/` 和 Admin 状态检查只是技术 smoke，
不自动证明本次业务路径已经验收。业务验收失败时停止后续扩散；关键路径或
数据安全受到影响时回滚。

服务器清理、全服务健康审计、漏洞扫描、性能压测和全仓库格式化不属于普通
业务验收。可以引用已有结果，不在发布任务中重复执行。

## 三、一次 LibreChat 发布怎么做

### 1. 创建发布记录

```sh
scripts/release-prepare.sh 2026-07-19-example protected
```

编辑生成的：

```text
deployment/release-records/2026-07-19-example/RELEASE.json
```

至少填写：原因、功能清单、修改范围、预期结果、风险、基线、验证计划、
回滚方式、source_revision 和项目适配信息。普通批次保持
`project_adapter.release_kind: batch`；只有 MVP 转正式版或重大版本才改为
`mvp-promotion` 或 `major-release`。不要在记录里写密码、令牌、
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
同时会展开累计修改目录，按 LibreChat 的项目路径规则生成：构建要求、测试
要求、目标服务、生产只读检查、备份条件和业务验收强度。计划保存在：

```text
.release-state/<release-id>/release-plan.json
```

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
  "release_plan_sha256": "release-plan.json 中的摘要",
  "provider": "构建系统名称",
  "build_environment": "ci|independent-build",
  "production_host": false,
  "completed_requirements": ["计划要求的构建和测试 ID"],
  "details": {}
}
```

然后执行：

```sh
scripts/release-attest.sh 2026-07-19-example /path/to/attestation.json
```

生产发布不能把构建证明设为 `not_applicable`。构建、依赖安装、镜像或静态
制品生成必须在 CI 或独立构建环境完成，禁止在生产服务器完成。配置补丁只需
生成并验证对应配置制品，不机械构建无关镜像。

### 6. 生产只读预检

```sh
scripts/release-preflight.sh 2026-07-19-example \
  --evidence /path/to/runtime-preflight.json
```

`runtime-preflight.json` 由仓库内版本化的只读项目检查生成，至少证明计划选中
的服务、依赖接口、可用内存、磁盘和回滚目标。只有路径相关的主页、
`/api/config`、`/office/` 或 Admin 检查会执行。磁盘不足时流程停止，由独立
维护任务清理后恢复；发布脚本不会顺手清理缓存或旧镜像。

```json
{
  "status": "passed",
  "source_revision": "完整版本号",
  "release_plan_sha256": "计划摘要",
  "artifact_sha256": "发布包摘要",
  "checked_services": ["计划中的服务"],
  "checks": [{"id": "计划中的检查 ID", "status": "passed"}],
  "host_resources": {"memory_available_mb": 2048, "disk_free_mb": 8192},
  "rollback_available": true
}
```

### 7. 受控部署

部署记录必须指定一个版本化 runner，并且 runner 必须位于允许目录、包含
范围部署标记和与发布计划完全一致的目标标记，例如：

```sh
# release-governance:scoped-deployment
# release-governance:targets=LibreChat-API
```

执行时必须显式确认 release id：

```sh
scripts/release-deploy.sh 2026-07-19-example \
  --confirm 2026-07-19-example
```

如果发布记录没有合法 runner，脚本会停止。它不会猜测要重建哪个服务，
也不会通过 `PREFLIGHT_ONLY` 一类变量绕过预检。

### 8. 验收和收尾

```sh
scripts/release-acceptance.sh 2026-07-19-example \
  --evidence /path/to/business-acceptance.json
```

根据第二节选择轻度或重度验收。已有证据可以复用，但必须确认 revision、
artifact、配置和环境假设仍然一致。只有本次修改影响模型或工具路径时才发送
模型请求，且最多一条；只有影响 UI 时才要求浏览器验证。若计划只包含自动
HTTP smoke，不要求额外业务证据文件，可省略 `--evidence`。

通常由路径规则自动加入 `billable-model-request`。若发布记录已经明确安排了
模型验收、但补丁文件名未命中对应路径规则，必须在提交并审核过的
`project_adapter` 中显式设置 `billable_model_request_allowed: true`；该开关
不会放宽数量上限，验收证据仍只能记录 0 或 1 条实际请求。

```json
{
  "status": "passed",
  "source_revision": "完整版本号",
  "release_plan_sha256": "计划摘要",
  "artifact_sha256": "发布包摘要",
  "checks": [{"id": "计划中的业务检查 ID", "status": "passed"}],
  "billable_model_requests": 0
}
```

填写实际备份路径、部署结果、验收结果和已知问题，提交并推送
`RELEASE.json`，最后执行：

```sh
scripts/release-finalize.sh 2026-07-19-example
```

## 四、失败后怎么恢复

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

## 五、最重要的规则

```text
普通工作保持轻量；普通生产发布做足够的定向业务验收；高风险发布启用重度验收和完整保护。
```
