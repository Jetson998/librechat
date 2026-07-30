# 预置 Agent 运行与分类去重修复方案

日期：2026-07-30

发布 ID：`20260730-preset-agent-runtime-category-fix`

## 问题

7 个预置 Agent 的持久化记录使用 `workflow_<templateId>`。LibreChat 仅把
`agent_` 前缀识别为持久化 Agent，因此新对话初始化没有读取 MongoDB 中的
`provider=anthropic` 和 `model=claude-fable-5`，最终返回 `missing_model`。

同时生产数据只有一个业务分类 `automation-workflow`，且 7 个 Agent 全部被
推荐，所以“精选 Agent”“Agent”“全部”三个页签展示完全相同的 7 条记录。

## 修复边界

- 编译后的正式 ID 改为 `agent_workflow_<templateId>`；
- 编译产物保留 `legacyId=workflow_<templateId>`，仅供受控迁移和回滚使用；
- MongoDB 迁移保留 7 个 Agent 的 `_id`、owner 和 14 条 ACL，只更新顶层 `id`
  与 `versions[].id`；
- 迁移前必须确认会话、消息、文件、Action、Skill、MCP、Checkpoint、收藏和
  其他 Agent 不引用旧 ID；发现未规划引用立即停止；
- Client 的联系人隐藏名单和引导语 fallback 同步到新 ID；
- 当仅有一个真实业务分类、且其数量等于“全部”时，隐藏该业务分类页签；出现
  多个真实分类时自动恢复分类页签；
- 不修改普通 Agent、个人 Agent、联系人显示、模型配置、文件、Skill 或历史
  会话数据。

## 部署与回滚

本批使用 `enhanced`：先保存 7 个目标 Agent、ACL 和分类的 Extended JSON
快照，再迁移 Agent ID并切换已验证 Client，仅重建 `LibreChat-API`。NGINX、
CodeAPI、RAG、Admin、Mongo 容器本身和 Office Converter 不重建。

任何数据校验、Client 校验或服务健康检查失败时，恢复目标 Mongo 快照、上一版
Compose override 和 Client mount，再仅重建 `LibreChat-API`。

## 验收

- 7 个 Agent 的 ID 均为 `agent_workflow_...`，Mongo `_id` 与 ACL 不变；
- Agent 初始化能够从持久化记录读取 provider/model，不再出现 `missing_model`；
- `/agents` 只显示“精选 Agent / 全部”，两个页面各 7 条且无重复业务分类页签；
- 预置 Agent 详情和新对话仍隐藏联系人并显示三条引导语；
- 普通或个人 Agent 联系人仍显示；
- 不点击引导语、不发送模型请求，`billable_model_requests=0`。
