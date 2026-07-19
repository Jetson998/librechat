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
或生产路径。

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

业务验收失败时停止后续扩散；关键路径或数据安全受到影响时回滚。服务器
清理、镜像裁剪、全服务健康审计、漏洞扫描、性能压测和全仓库格式化由各自
的运维、CI、安全或性能流程承担，业务验收只引用已有有效结果。
