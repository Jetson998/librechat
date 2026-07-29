# LibreChat 预置 Workflow Agent 联系人移除计划

Date: 2026-07-29

Status: 设计门禁；本文件提交并推送前，不允许修改生产 Agent 数据

Parent release:
`20260729-preset-workflow-agents`

## 一、问题与根因

7 个预置 Workflow Agent 的确定性编译器统一写入了：

```json
"support_contact": {
  "name": "LibreChat Workflow Agent",
  "email": ""
}
```

因此 Agent 详情会显示“联系: LibreChat Workflow Agent”。该信息不是用户任务所需内容，
也没有实际邮箱或支持入口，应从预置 Agent 数据中删除。

## 二、范围

本批只处理由 `managedBy=librechat-preset-workflow-agents` 管理、且稳定 ID 属于目录清单的
7 个预置 Agent：

- 编译器不再生成 `support_contact`；
- 重新生成确定性 `compiled-agents.json` 和摘要；
- 通过版本化、定向、可回滚的生产操作对这 7 条记录执行 `$unset support_contact`；
- 更新每条记录的模板摘要、版本快照和 `updatedAt`；
- 保留 Agent 名称、描述、指令、模型、工具、分类、ACL 和 21 条引导语不变。

本批明确不做：

- 不删除 LibreChat 通用 Agent schema、API 或创建表单中的联系人能力；
- 不修改用户自建 Agent、非本目录 Agent 或任何 Skill；
- 不修改会话、消息、文件、Office、CodeAPI 或 WebAI；
- 不直接在生产 MongoDB 执行未记录命令；
- 不重启或重建任何容器。

## 三、实现约束

生产操作必须：

1. 使用 7 个稳定 Agent ID 和 `managedBy` 双重限定目标；
2. 在写入前验证目录摘要、目标数量、所有者和现有持久化摘要；
3. 备份 7 个 Agent 的原始 EJSON，并记录备份 SHA-256；
4. 只对存在 `support_contact` 的目标执行更新；
5. 使用 `$unset` 删除字段，并同步新的 `workflowTemplate.persistedDigest`；
6. 将更新后的 payload 写入 `versions`，以保持 Agent 版本记录一致；
7. 写后确认 7 条记录均不存在 `support_contact`，ACL 和分类未改变；
8. 失败时按备份恢复目标 Agent，并验证恢复摘要。

## 四、测试与验收

本地测试：

- 编译产物中 7 个 Agent 均不含 `support_contact`；
- 21 条 `conversation_starters` 保持不变；
- 同一 Manifest 输入生成稳定摘要；
- 生产脚本仅访问 `agents`，不访问会话、文件、消息或 Skills；
- 脚本包含稳定 ID、`managedBy`、漂移停止和定向回滚保护；
- `git diff --check`、操作测试和 release-governance 测试通过。

生产验收：

- 7 个预置 Agent 均存在且 `support_contact` 字段不存在；
- 7 个 Agent 的名称、模型、工具、分类、推荐状态和 ACL 不变；
- 普通用户 `vip998` 打开 Agent 后不再看到“联系: LibreChat Workflow Agent”；
- 用户自建 Agent 的联系人编辑能力仍保留；
- LibreChat 首页和 API 配置健康，受保护容器身份不变。

## 五、发布顺序

1. 提交并推送本设计门禁；
2. 实现编译器修改、确定性目录和版本化生产操作；
3. 本地测试通过后提交并推送实现；
4. 生成精确源码制品并完成 CI/独立测试证明；
5. 执行只读生产预检和 protected 发布；
6. 完成数据与浏览器验收；
7. 提交并推送最终发布记录，报告 commit、制品摘要、备份和验收结果。

任一步失败都停止在当前门禁，不允许使用生产热补丁绕过流程。
