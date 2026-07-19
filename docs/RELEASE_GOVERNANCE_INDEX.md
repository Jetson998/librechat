# LibreChat 发布治理文件索引

这套文件只服务于当前自托管 LibreChat 项目。它不包含 WebAI、OpenWebUI
或其他项目的发布内容。

## 一、整体结构

```text
通用 Skill
  skills/lightweight-release-governance/
        |
        v
LibreChat 项目适配层
  release-governance.json
  scripts/librechat-release-adapter.py
  scripts/release-*.sh
        |
        v
单次发布证据
  deployment/release-records/<release-id>/RELEASE.json
  .release-state/<release-id>/
```

通用层定义“必须证明什么”，项目层定义“如何证明”，单次发布记录保存
“这一次实际证明了什么”。

## 二、文件分布

项目适配配置使用 JSON 而不是 YAML，是为了让当前 Python 标准库可以直接
解析和校验，不额外引入 YAML 运行依赖。字段含义仍由通用适配契约约束。

| 文件或目录 | 所属层 | 用途 |
|---|---|---|
| `skills/lightweight-release-governance/SKILL.md` | 通用 | 轻量模式、发布模式和写保护模式的通用协议 |
| `skills/lightweight-release-governance/scripts/release_gate.py` | 通用 | 配置、失败分类、checkpoint、manifest 和记录校验 |
| `skills/lightweight-release-governance/references/` | 通用 | 失败分类、适配契约和中性证据说明 |
| `skills/lightweight-release-governance/references/new-project-onboarding.md` | 通用 | 新项目接入步骤、项目类型替换点和首次 dry-run |
| `skills/lightweight-release-governance/assets/project-adapter-template/` | 通用 | 可复制的最小适配配置和 fail-closed 脚本模板 |
| `skills/librechat-release-governance/SKILL.md` | LibreChat | 薄入口，只声明项目边界和仓库入口 |
| `release-governance.json` | LibreChat | 仓库、风险模式、目标检查和部署范围契约 |
| `scripts/librechat-release-adapter.py` | LibreChat | Git、制品、公开预检、受控 runner 和验收实现 |
| `scripts/release-prepare.sh` | LibreChat | 创建单次发布记录模板 |
| `scripts/release-verify.sh` | LibreChat | 先做能力预检，再验证记录、分支、远端、revision 和发布范围 |
| `scripts/release-package.sh` | LibreChat | 从记录的 source revision 打包并生成 manifest |
| `scripts/release-attest.sh` | LibreChat | 记录构建或制品证明 |
| `scripts/release-preflight.sh` | LibreChat | 生产只读预检，不执行写操作 |
| `scripts/release-deploy.sh` | LibreChat | 需要明确确认的范围部署包装器 |
| `scripts/release-acceptance.sh` | LibreChat | 只读 HTTP/API 验收，不创建对话 |
| `scripts/release-finalize.sh` | LibreChat | 验证最终记录并关闭 release_record 门禁 |
| `scripts/release-status.sh` | LibreChat | 查看 checkpoint，定位恢复起点 |
| `scripts/validate-release-governance.sh` | LibreChat | 一条命令运行配置、语法、Skill 和回归测试 |
| `deployment/release-records/` | 单次发布 | 应提交、推送的发布计划和最终记录 |
| `.release-state/` | 单次运行 | 本地临时 checkpoint、日志、包和快照，不提交仓库 |
| `docs/RELEASE_EVIDENCE_CONTRACT.md` | 文档 | 发布记录字段和证据生命周期 |
| `docs/LIGHTWEIGHT_RELEASE_GOVERNANCE_ZH_CN.md` | 文档 | 面向操作者的简明中文说明 |
| `docs/RELEASE_GOVERNANCE_NEW_PROJECT_ZH_CN.md` | 文档 | 其他新项目的接入和复用说明 |
| `tests/release-governance/` | 测试 | 通用协议和 LibreChat 适配层静态测试 |
| `.github/workflows/librechat-release-governance.yml` | CI | 防止关键门禁和 Skill 结构被删掉 |

## 三、命令顺序

普通变更不需要执行整套流程。进入发布或生产写操作时，使用：

```text
prepare -> verify(capabilities + repository) -> package -> attest -> preflight -> deploy
         -> acceptance -> finalize
```

`attest` 只有在项目或发布模式要求构建证明时执行。不能通过环境变量
跳过必需门禁；只可以依据配置声明 `not_applicable`，并写明理由。

中断后先执行：

```sh
scripts/release-status.sh <release-id>
```

修改治理文件后统一执行：

```sh
scripts/validate-release-governance.sh
```

## 四、证据位置

- 计划和最终结果：提交到
  `deployment/release-records/<release-id>/RELEASE.json`。
- 临时证据：保存在 `.release-state/<release-id>/`。
- 完整日志不进入对话上下文；对话只返回状态、摘要、警告和证据路径。
- `results/latest` 一类便利指针不能替代不可变的单次记录。

## 五、边界

- 通用 Skill 不规定必须使用某个 Git、CI、制品仓库、部署工具或浏览器。
- LibreChat 适配层可以使用当前仓库的 Git、公开 HTTP 检查和版本化脚本，
  但不得把这些实现细节回写到通用 Skill。
- `release-deploy.sh` 不会自动猜测 runner，也不会通过隐含环境变量进入
  写操作；必须提供发布记录中的版本化 runner 和精确确认值。
- 新项目优先复制通用模板，再实现自己的适配脚本；不要复制 LibreChat 的
  生产服务、路由或目标检查。

## 六、业务验收边界

- 通用选择原则位于 `skills/lightweight-release-governance/SKILL.md` 和
  `references/adapter-contract.md`。
- LibreChat 关键业务路径与轻度、重度验收示例位于
  `skills/librechat-release-governance/references/project-contract.md`。
- 操作者的条件式检查位于 `docs/RELEASE_CHECKLIST.md`。
- 业务验收始终属于生产发布治理，但检查范围由本次修改和风险决定；基础
  HTTP smoke、CI、浏览器、模型请求或人工确认只是可选证据来源，不应机械
  全部执行。
