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

## 一、三个阶段和完成状态

团队统一使用以下口径：

```text
开发完成，待打包代码
→ 候选版本已就绪，待上线
→ 上线发布并验收完成
```

阶段决定现在做什么，状态说明这一阶段做到什么程度。不要为每个检查点增加
一个独立状态；发布风险只决定检查深度，不改变三个阶段。

### 1. 开发阶段

```text
开发实现 → 自测 → 提交可评审代码 → 集中代码评审 → 修复 → 复测 → 最终提交
```

一个功能或开发批次稳定后，再由其他模型或同事集中评审这个 commit 或 diff，
不需要评审每个小提交。修复后只复查受影响部分。最终通过评审的 commit 才能
进入发版准备阶段。

阶段产物只保留已提交代码、功能和修改范围、聚焦测试结果、评审结论以及已知
限制。此阶段不创建正式制品、不检查生产环境。完成状态为：

```text
开发完成，待打包代码
```

后续源码发生变化时，状态回到“开发中”。

### 2. 发版准备阶段

```text
选择发布批次 → 锁定代码和范围 → 一次必要 CI → 构建镜像或制品
→ 校验代码与制品对应关系 → 确认可回退版本 → 等待上线
```

阶段产物包括锁定的代码版本、发布功能清单、CI 和测试结果、镜像标签及摘要、
构建证明、可回退的上一稳定版本和已知限制。完成状态为：

```text
候选版本已就绪，待上线
```

候选完成后必须暂停。没有明确的“上线”或“部署”指令，不检查生产环境，也不
执行生产写操作。源码、依赖、构建配置或发布范围变化时，旧候选版本作废；
单纯的生产环境变化通常只阻塞上线，不要求重新构建镜像。

### 3. 上线发布阶段

```text
收到明确上线指令 → 一次线上只读检查 → 必要备份 → 定向更新服务
→ 技术冒烟测试 → 相关业务验收 → 记录实际结果
```

阶段产物包括生产预检结果、备份或回滚位置、实际上线版本、更新前后运行状态、
技术 smoke、业务验收和最终发布记录。正常显示状态为：

```text
发布中 → 已上线，待验收 → 发布完成
```

镜像生成不代表已上线，容器更新成功也不代表发布完成。只有相关业务验收通过、
回滚信息有效且实际结果已经记录，才可以显示“发布完成”。

现有 `light / release / protected / enhanced` 是项目适配层的实现方式，不是团队
生命周期：普通开发保持轻量，`release` 对应发版准备，`protected / enhanced`
用于不同风险强度的上线发布。

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

以下命令从发版准备阶段开始。开发阶段只做代码、测试和集中评审，不创建一次
发布记录。步骤 1 至 5 生成候选版本；候选就绪后必须停止。只有收到明确上线
指令，才执行步骤 6 至 8 的生产预检、部署和验收。

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

完成构建证明后，对外状态应为“候选版本已就绪，待上线”，主线程停止并等待
明确上线指令。

### 6. 生产只读预检

只有收到明确上线指令后，才进入这一步。不要为了提前证明生产可达而在开发或
候选制作过程中反复连接服务器。

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
