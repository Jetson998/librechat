# Admin 模型配置来源收敛计划

## 结论

模型端点、模型规格、价格、展示名、默认模型和标题模型属于运营配置，主配置源应为 Admin DB。
`librechat.yaml` 只保留启动级和部署级配置，不再长期承载日常模型端点。

## 已修复的后台行为

- 后端读取 `baseOnly` 配置时，返回 `yamlCustomEndpointNames`。
- 配置页把 YAML 来源的 `endpoints.custom[].name` 作为锁定来源。
- 自定义端点列表中，来自 `librechat.yaml` 的条目不再显示删除按钮，且 `name` 身份字段不可编辑。
- YAML 来源自定义端点的其它连接/模型字段仍可按现有权限编辑，避免为了改 key/baseURL 必须立刻改部署文件。
- 新建或编辑自定义端点时，`name` 不允许与已有端点或 YAML 来源端点重名，避免同名条目被误判来源。
- Admin DB 创建的自定义端点仍然可以删除。

这能避免 `MuskAPI` 这类 YAML base 条目在后台显示成“可删但删不掉”的普通条目。

## 正确配置边界

- `librechat.yaml`：保留启动、服务、认证、基础 feature flag、部署兜底。
- Admin DB：管理 `endpoints.custom`、`modelSpecs.list`、`tokenConfig`、`allowedProviders`、默认模型、图标和展示名。
- Admin UI：展示来源，DB 项可增删改，YAML 项锁定身份并提示需要部署层清理。

## 生产清理步骤

1. 备份 `/opt/librechat/librechat.yaml` 和当前 Mongo `configs` 中 `__base__` 文档。
2. 从 `/opt/librechat/librechat.yaml` 移除旧端点：
   - `MuskAPI`
   - `MuskAPI-Anthropic`
3. 从 `endpoints.agents.allowedProviders` 移除旧名称，只保留当前实际使用的 provider。
4. 确认 Admin DB 中保留：
   - `Muskapis-openai`
   - `Muskapis-Anthropic`
5. 确认 `modelSpecs.list[].preset.endpoint` 不再指向旧 `MuskAPI` / `MuskAPI-Anthropic`。
6. 重启 `LibreChat-API`。
7. 验收：
   - Admin 自定义端点页只剩 `Muskapis-openai` 和 `Muskapis-Anthropic`。
   - 模型规格页的 endpoint 引用均存在。
   - `/api/config` 正常返回。
   - 主页和一次非付费 HTTP smoke 正常。

## 回滚

恢复备份的 `librechat.yaml`，恢复 Mongo `__base__` 文档备份，重启 `LibreChat-API`，再验证 `/api/config` 和 Admin 配置页。
