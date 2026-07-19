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
| `protected` | 普通生产文件、服务、配置或数据变更 | 需要只读预检、范围限制、风险自适应业务验收和结果记录 |

`enhanced` 用于数据库迁移、认证权限、核心路由、共享基础设施或并行发布等
更高风险场景，并使用重度业务验收。

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

这个步骤只读取仓库和公开运行状态，提供主页、`/api/config`、`/office/`
认证边界和 Admin 页面的基础技术 smoke，不发送模型请求，不创建新对话。
它不能替代按本次修改范围选择的业务验收。

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

根据第二节选择轻度或重度验收。已有证据可以复用，但必须确认 revision、
artifact、配置和环境假设仍然一致。只有本次修改影响模型或工具路径时才发送
模型请求，只有影响 UI 时才要求浏览器验证。

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
