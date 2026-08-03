# File Agent Runtime Word M1 设计记录

Date: 2026-08-03
Status: development-only design record

本记录把 `FILE_AGENT_RUNTIME_IMPLEMENTATION_REQUIREMENTS.md` 中影响 M1 实现的默认决策固化下来。它不授权打包、部署、生产流量或客户文件验收。

## 1. Contract 兼容

- `office-file-agent.v1` 保留给现有 XLSX POC，行为和测试不迁移为 Word 特例。
- `office-file-agent.v1.1` 作为 Word 试点 contract；只有 `word-edit-v1` capability 被实际实现并通过回归后，Runtime capability discovery 才能声明该 profile。
- M1 可以定义 v1.1 的 schema 和验证模块，但不会提前把未实现的 Word capability 宣布为可路由能力。

## 2. Action Envelope

新 Action 使用 `schemaVersion: 1.0`，签名只包含 worker、输入/目标逻辑引用、规范化 parameters、expectedChange、verificationProfile 和 onFailure。summary/objective 只用于模型与 UI 展示，不参与幂等或进展判断。

现有 XLSX 计划暂时保留兼容解析；其 signature 会映射到同一组规范字段，避免继续只按 action kind 判断等价动作。

## 3. Verification 与循环停止

Verifier 结果规范化为 profile/version、required assertion codes、safe error class、artifact logical ID 和确定性 metrics。summary、evidenceRef、artifact revision/hash 不能单独制造进展。

Progress Vector 允许的真实进展只有：失败断言集合严格减少、通过断言集合增加、确定性计划节点关闭。相同失败断言集合和等价 Action signature 在产生新的外部副作用前进入 `needs_input`。

## 4. Word 输入前门

Word 任务在进入 Worker 前必须检查 ZIP/OOXML 容器。声明为 DOCX 但包含 `xl/workbook.xml`、缺少 `word/document.xml` 的文件，归类为 `INPUT_CONTAINER_MISMATCH`，不得进入 Word 修改循环。该规则与 Worker 内部验证同时存在，不能只依赖扩展名或客户端 MIME。

## 5. 非生产拓扑边界

M1-M3 使用单 Runtime 进程和持久本地数据目录验证协议与恢复；不把该拓扑宣称为生产多副本方案。进入真实非生产联合验收前，必须确认 Runtime 数据目录的持久性、CodeAPI/relay 版本、测试账号、fixture 和非生产凭据范围。
