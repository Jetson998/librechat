# 新项目如何使用轻量发布治理

这套方法可以复用到其他自托管项目。核心不是复制 LibreChat 的部署命令，
而是复用同一套发布顺序、失败分类、checkpoint、制品证明和回滚记录。

一句话理解：

> 通用层规定“必须证明什么”；项目适配层规定“如何证明”；单次发布记录保存“这次实际证明了什么”。

## 一、其他项目需要新增什么

每个新项目只需要准备一层薄适配：

```text
新项目仓库/
  release-governance.json
  scripts/release-prepare.sh
  scripts/release-verify.sh
  scripts/release-package.sh
  scripts/release-attest.sh
  scripts/release-preflight.sh
  scripts/release-deploy.sh
  scripts/release-acceptance.sh
  scripts/release-finalize.sh
  scripts/release-status.sh
  scripts/validate-release-governance.sh
  tests/release-governance/
  deployment/release-records/
  .release-state/              # 加入 .gitignore
```

通用 Skill 不需要改成项目专用版本。新项目只填写自己的仓库、目标、制品、
服务、预检、部署、验收和回滚方式。

## 二、最快接入步骤

### 1. 安装或复制通用 Skill

在 Codex 环境中安装 `lightweight-release-governance`。当前仓库内也保留了
完整副本，模板位于：

```text
skills/lightweight-release-governance/
```

### 2. 复制最小适配模板

```sh
cp -R "${CODEX_HOME:-$HOME/.codex}/skills/lightweight-release-governance/assets/project-adapter-template/." /path/to/new-project/
```

然后编辑 `release-governance.json`：

- `project.id` 和 `project.name`
- `repository.expected_remote`、默认分支和仓库边界
- 各风险模式需要的门禁
- 必须进入发布包的文件
- 累计变更路径如何选择构建、测试、目标服务、备份和验收
- 目标预检、部署 runner、验收和回滚位置

模板中的脚本默认会明确失败，表示“适配尚未完成”。它不会假装部署成功，
也不会提供绕过门禁的环境变量。

### 3. 实现项目脚本

建议先实现以下顺序：

```text
prepare -> verify -> package -> attest -> preflight
         -> deploy -> acceptance -> finalize
```

脚本内部可以做多项确定性检查，但输出只返回摘要、状态、警告和证据路径；
完整日志写入 `.release-state/<release-id>/`。

### 4. 加入项目测试

至少测试：

- 配置能被通用 gate 校验；
- 所有必需脚本存在；
- 未完成脚本失败并返回非零状态；
- 发布包来自记录的 source revision；
- 修改 revision、范围或目标后，下游 checkpoint 会失效；
- 生产写入前没有通过变量跳过预检、制品或回滚门禁。

### 5. 第一次只做 release dry-run

首次接入只跑本地或测试环境：

```text
创建记录 -> 验证仓库 -> 从固定 revision 打包 -> 记录制品证明 -> 关闭记录
```

不要在首次接入时直接测试生产部署。`protected` 和 `enhanced` 模式应在
read-only 预检、回滚准备和验收脚本都通过后再启用。

## 三、不同项目替换哪些内容

| 项目类型 | 只读预检 | 写入动作 | 验收 |
|---|---|---|---|
| Web 应用 | 页面、健康接口、版本信息 | 范围服务或静态资源更新 | 页面和 API smoke test |
| API 服务 | 健康、版本、依赖状态 | 版本化服务发布 | 合约和健康检查 |
| 静态站点 | 路由和资源快照 | 发布不可变资源 | 页面和资源状态码 |
| CLI 或库 | 测试、包内容和版本 | 发布到分发渠道 | 安装和命令回归 |
| 数据库迁移 | 兼容性、备份、锁 | 版本化迁移 | 数据完整性和恢复证明 |
| Serverless | 当前版本和流量 | 版本或流量别名切换 | 调用和回退验证 |

状态机和证据字段保持一致，只有这些项目细节需要替换。某个门禁确实不适用
时，在配置中声明 `not_applicable` 并记录原因，不能临时跳过。

## 四、日常怎么判断用哪种模式

| 工作 | 模式 |
|---|---|
| 分析、写代码、写文档、本地实验 | `light` |
| 生成可追溯制品或发布记录 | `release` |
| 修改外部运行环境、重启服务、改配置或数据 | `protected` |
| 数据迁移、共享基础设施、并行高风险发布 | `enhanced` |

普通开发不需要整套发布流程。只有进入发布或外部运行环境写入时，才增加相应
门禁。不要为每个 AI 开发任务创建一次发布；把相关修改合并成一个候选批次，
再解析一次累计路径并执行一次构建、预检和验收。高风险路径可以把该批次提升
为 `enhanced`，但不影响此前的日常开发速度。

## 五、最重要的边界

- 不把某个项目的域名、容器名、路由或云平台写入通用 Skill。
- 不把完整日志塞进模型上下文，证据留在文件中。
- 不用临时命令替代仓库内版本化脚本。
- 不把一次性错误写进长期规则；一次发布的事实写入该 release record。
- 失败先分类，再从最后一个有效 checkpoint 恢复。

LibreChat 的实现可以作为一个项目适配示例，但其他项目只应复用通用协议，
不能复制它的生产对象和专用验收逻辑。
