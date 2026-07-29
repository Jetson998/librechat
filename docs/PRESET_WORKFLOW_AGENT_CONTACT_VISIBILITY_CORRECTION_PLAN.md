# LibreChat 预置 Workflow Agent 联系人显示纠正计划

Date: 2026-07-29

Status: 设计门禁；本文件提交并推送前，不允许修改 Client 或生产环境

Supersedes implementation direction in:
`docs/PRESET_WORKFLOW_AGENT_CONTACT_REMOVAL_PLAN.md`

Failed and rolled-back release:
`20260729-preset-agent-contact-removal`

## 一、已确认问题

7 个预置 Workflow Agent 的详情、市场卡片和新对话欢迎区会显示：

```text
联系: LibreChat Workflow Agent
```

第一次修复只删除了 `support_contact`。该数据写入本身成功，但 LibreChat 的联系人链路还包含两层既有行为：

1. `support_contact` 没有有效姓名或邮箱时，API 会从 Agent 所有者补充 `owner_contact`；
2. Client 的 `AgentContact` 会继续渲染 API 返回的联系人。

因此删除字段后，普通用户实际看到的是 `联系: Admin`，验收失败并已完整回滚。空对象或空字符串也不是有效哨兵：现有 `hasSupportContact` 会把它们视为无联系人，仍然触发所有者回退。

## 二、纠正方案

本批采用固定 ID 的 Client 显示策略，不再修改生产 Agent 数据：

- 仅当 Agent ID 属于下列 7 个稳定预置 ID 时，`AgentContact` 返回 `null`；
- 市场卡片、Agent 详情和新对话欢迎区继续共用同一个 `AgentContact` 组件，因此一次修复覆盖三个入口；
- 其他 Agent 仍按现有顺序显示 `support_contact`，缺失时继续回退 `owner_contact`；
- 恢复确定性编译器中的原联系人字段，使仓库目录重新与已回滚的生产数据一致，避免未来重跑种子脚本再次触发所有者回退；
- 不修改 Agent API、MongoDB schema、ACL、分类、会话、文件、Skills、Office、CodeAPI 或 Runtime。

固定 ID：

```text
workflow_meeting-to-action
workflow_knowledge-base-curator
workflow_excel-audit-reconciliation
workflow_policy-change-impact
workflow_feedback-root-cause-analysis
workflow_kyc-periodic-review
workflow_journal-entry-audit
```

该方案只隐藏这 7 个产品预置 Agent 的联系人行，不使用名称、作者、分类或前缀模糊匹配。

## 三、源码与制品边界

实现使用固定上游 LibreChat commit：
`8fcb77fe6fcc91bd82f290b6db604c4c8bdb01c9`。

新增一个独立、可验证的 Client overlay，按顺序应用在已发布的两个 overlay 之后：

1. `agent-platform-p0-ui.patch`；
2. `agent-sidebar-menu-state.patch`；
3. 本批联系人显示纠正 patch。

Client 制品必须由 GitHub Actions 对精确源码 revision 构建，并继续组合仓库保护的上传菜单、登录页、用量、模型市场、搜索 favicon、上下文安全和生成文件下载资产。禁止直接修改生产 `client/dist`。

## 四、测试与验收

本地和 CI 必须验证：

- 7 个固定 ID 均不渲染 `联系:`、联系人名称、邮箱或“暂无联系人”；
- 非名单 Agent 的支持联系人显示不变；
- 非名单 Agent 缺少支持联系人时仍显示所有者联系人；
- 一个名称或分类相似但 ID 不在名单中的 Agent 不会被隐藏；
- 市场、详情和新对话三个入口继续使用同一组件；
- 预置 Agent 编译器重新生成含原联系人字段的稳定目录；
- 旧失败发布保持 `rolled_back`，不复用其 release ID 或生产操作；
- focused tests、Client typecheck、production build、保护资产组合和 release-governance 检查通过。

生产验收使用普通用户 `vip998`：

- `/agents` 仍显示全部 7 个预置 Agent；
- 进入每个详情后不存在任何 `联系:` 行；
- 点击“开始对话”后的欢迎区不存在任何 `联系:` 行；
- 个人 Agent 的支持联系人或作者联系人仍能显示；
- 分类、推荐状态、引导语、创建 Agent、个人 Skills、上传与文件下载入口不变；
- 只替换并重建 `LibreChat-API` 的 Client 挂载，不重启其他服务。

## 五、发布顺序

1. 提交并推送本设计门禁；
2. 实现独立 Client overlay、编译器恢复、测试和生产发布适配；
3. 本地测试通过后提交并推送实现；
4. 等待一次 GitHub Actions 构建并下载精确制品；
5. 生成 release plan、源码制品、构建证明和只读生产预检；
6. 使用 enhanced 门禁替换 Client 挂载；
7. 完成普通用户浏览器验收和服务身份比较；
8. 提交并推送最终发布记录，报告 commit、CI、制品 SHA-256、备份和验收结果。

任一步失败都停止并按该批备份回滚，不允许追加生产热补丁。
