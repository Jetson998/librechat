# LibreChat 项目适配契约

项目配置位于仓库根目录的 `release-governance.json`。本适配层只处理
LibreChat 自托管部署：

- GitHub 仓库：`git@github.com:Jetson998/librechat.git`
- 默认分支：`main`
- 公开目标：LibreChat 主站、`/api/config`、受保护的 `/office/` 和 Admin
  页面
- 生产保护对象：API、Nginx、CodeAPI、RAG API、Admin Panel 和 MongoDB
- 基础技术 smoke：只读 HTTP/API 检查，不创建对话，不发送模型请求

实际的部署 runner 必须由单次 `RELEASE.json` 指定，且只能来自配置允许的
生产补丁或生产操作目录。适配层不会根据用户文字猜测容器、Compose 文件
或生产路径。runner 必须声明 `release-governance:targets=`，其服务集合必须与
路径计划一致；可以读取依赖服务，但不能顺手重建它们。

## 批量发布边界

日常 AI 开发不创建发布记录，也不执行远端预检、镜像构建或完整业务验收。
相关功能先正常开发、定向测试并提交；准备统一上线时，再把累计修改范围写入
一个 `RELEASE.json`。`release-verify` 只在这时展开目录并依据
`release-governance.json` 计算一次发布计划。

普通 UI、单接口或单服务补丁通常保持 `protected`。数据库、Office/模型工具
链、Nginx/Compose 路由等累计高风险批次要求 `enhanced`。重度门禁按发布批次
执行，不按每个开发任务执行。

普通批次使用 `project_adapter.release_kind: batch`。MVP 转正式版或重大版本
分别使用 `mvp-promotion`、`major-release`；这两类生产发布要求 `enhanced`，
发布治理只校验完整业务验收的证据引用，不在发布任务中重跑整套 UAT。

## 路径规则

本仓库是生产补丁与运维档案仓库，不是完整上游源码树。路径规则因此匹配
`deployment/production-patches/**` 和 `deployment/production-operations/**`：

- `client/`、`public/` 和 UI 资源：客户端制品、客户端测试、API 定向部署及
  浏览器验收；
- `api/` 和 API bundle：API 制品、API 测试和 API smoke；
- Office、`BaseClient`、`ToolService`、模型配置：`enhanced`、文件往返和最多
  一条限额模型请求；
- `package.json`、锁文件、Dockerfile：依赖安装构建和漏洞扫描证明；
- Nginx、Compose：`enhanced`、路由验证和多服务健康引用；
- Mongo、backfill、migration 和生产数据操作：`enhanced`、备份和数据完整性
  验收。

路径规则只生成要求，不在生产服务器编译、安装依赖、构建镜像、执行压测或
清理缓存。CI 或独立构建环境每个发布批次提供一次 attestation；生产预检只
读取受影响服务、依赖接口、可用内存、磁盘和回滚目标。

## 业务验收选择

基础 HTTP 检查只能说明入口和服务仍可访问，不能代替业务验收。每次生产
发布都要根据实际修改选择轻度或重度验收，并允许复用与同一 source
revision、artifact 和配置相匹配的有效证据。

普通文案、样式、单页面布局或单一静态资源变化通常使用轻度验收：只检查
受影响页面、资源和最近的关键保护条件。非 UI 修改不强制打开浏览器。

以下 LibreChat 路径通常需要重度验收：

- 登录、用户权限、管理员操作和会话隔离；
- 计费、额度、模型来源和模型路由；
- 上传、Office 读取、CodeAPI、生成文件和下载卡；
- MongoDB 数据结构或数据迁移；
- API、Nginx、CodeAPI、RAG、Admin 等多服务联动；
- 难以快速回滚的运行时或重大版本变化。

模型或工具链未变化时，不发送付费模型请求。文件链路未变化时，不重复上传
Excel、Word 或 PPT。Admin 未变化时，不遍历全部后台页面和角色。确需
人工判断视觉、权限或业务语义时，才要求人工确认。

模型请求默认由路径计划授权。若已审核的发布记录明确要求模型验收，但路径
规则没有自动选中该条件，必须在 `project_adapter` 中显式记录
`billable_model_request_allowed: true`；验收适配器仍强制最多一条请求，并在
业务证据中记录实际数量。

业务验收失败时停止后续扩散；关键路径或数据安全受到影响时回滚。服务器
清理、镜像裁剪、全服务健康审计、漏洞扫描、性能压测和全仓库格式化由各自
的运维、CI、安全或性能流程承担，业务验收只引用已有有效结果。
