# LibreChat 项目适配契约

项目配置位于仓库根目录的 `release-governance.json`。本适配层只处理
LibreChat 自托管部署：

- GitHub 仓库：`git@github.com:Jetson998/librechat.git`
- 默认分支：`main`
- 公开目标：LibreChat 主站、`/api/config`、受保护的 `/office/` 和 Admin
  页面
- 生产保护对象：API、Nginx、CodeAPI、RAG API、Admin Panel 和 MongoDB
- 生产验收：只读 HTTP/API 检查，不创建对话，不发送模型请求

实际的部署 runner 必须由单次 `RELEASE.json` 指定，且只能来自配置允许的
生产补丁或生产操作目录。适配层不会根据用户文字猜测容器、Compose 文件
或生产路径。
