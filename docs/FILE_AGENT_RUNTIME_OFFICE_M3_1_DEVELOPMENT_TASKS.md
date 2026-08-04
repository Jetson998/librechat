# File Agent Runtime Office M3.1 开发任务清单

Date: 2026-08-04

Status: technical task reference; batch and release planning superseded.

The authoritative unified scope, commit policy, and release boundary is
`docs/FILE_AGENT_RUNTIME_M3_M31_UNIFIED_BATCH_PLAN.md`. The task inventory may
be used to implement M3.1, but its separate M3-R/M3.1 release-batch wording is
obsolete.

Architecture source:
`docs/FILE_AGENT_RUNTIME_OFFICE_M3_1_ARCHITECTURE.md`.

## 一、执行原则

- 先契约和 fixture，后 Worker，再 Connector，最后联合验收；
- M3 Word 与 M3.1 开发使用同一个 unified release batch；技术提交可以多个，
  但不产生多个公开发布批次；
- 不修改 `office-file-agent.v1.1` / `word-edit-v1` 既有语义；
- 不删除 XLSX POC，将其保留为回归并新增正式 Excel capability；
- 不复用旧 PPT fallback 作为 Runtime 实现证据；
- 不实现动态 Script、任意 Shell、图片生成、ZIP fallback 或多 Agent；
- 每个任务批次先提交设计/契约，再提交实现和测试；
- 开发完成只形成候选，打包和部署需要独立批准。

## 二、任务批次总览

| 批次 | 目标 | 主要交付 |
| --- | --- | --- |
| T0 | 冻结契约和 fixture | v1.2 contract、profiles、feature matrix、fixtures |
| T1 | 公共 Office 基础层 | Inspector、feature scanner、OOXML helpers、artifact contract |
| T2 | Excel Worker/Verifier | `xlsx-edit-v1` 完整纵向链路 |
| T3 | PowerPoint Worker/Verifier | `pptx-edit-v1` 完整纵向链路 |
| T4 | Office Compose | Excel/Word 到 PPTX 的确定性编排 |
| T5 | Runtime 与 Provider | capability routing、schema、context、progress、recovery |
| T6 | LibreChat Connector | resolver、manifest、billing、delivery、feature flag |
| T7 | 集成与事故回放 | 跨轮次、重启、幂等、unsupported features、性能 |
| T8 | 非生产联合验收 | Word、Excel、PPTX、Compose 四条报告 |

## 三、T0：契约与 fixture 冻结

### 开发任务

- 定义 `office-file-agent.v1.2` JSON contract；
- 新增 capability profiles：`xlsx-edit-v1`、`pptx-edit-v1`、`office-compose-v1`；
- 固定每个 profile 的输入 MIME、输出 MIME、输入数量、主要输出数量和 Worker allowlist；
- 定义统一 Office inspection result、unsupported feature result 和 source fact schema；
- 定义 Excel、PPTX 和 Compose acceptance assertion schema；
- 定义 artifact logical IDs：`candidate:working-xlsx`、`candidate:working-pptx`；
- 定义 Worker、Verifier、render 工具版本和 hash 记录格式；
- 建立 fixture license/source 记录，禁止使用客户文件。

### 最小 fixture

Excel：

1. 普通数据、公式、样式、合并单元格和命名区域；
2. 多 Sheet、Excel Table 和基础图表；
3. 包含宏、外部连接或复杂透视表的拒绝样本；
4. 公式和未授权区域容易被误改的事故样本。

PowerPoint：

1. 文字、表格、图片、notes 和多种 layout；
2. 缺失 media relationship；
3. 文本溢出和字体替换风险；
4. Excel 数据生成完整汇报 PPT 的咨询场景样本。

Compose：

1. 一个 XLSX 生成一个 PPTX；
2. 一个 DOCX 加一个 XLSX 生成一个 PPTX；
3. 来源映射缺失或相互冲突的拒绝样本。

### 验收

- 所有 contract/schema 有正反例测试；
- v1/v1.1 capability discovery 和测试保持通过；
- fixture hash 固定，仓库不包含敏感信息。

### 提交边界

只提交 contract、schema、fixture、测试和设计记录，不提交 Worker 实现。

## 四、T1：公共 Office 基础层

### 开发任务

- 新增 Office format registry，将 MIME、扩展名、profile、Worker 和 Verifier 显式映射；
- 新增只读 `OfficeInputInspector`；
- 新增 unsupported feature scanner，在 task persistence/CodeAPI 副作用前给出确定性结果；
- 抽取 ZIP/OOXML、relationship、content type、路径和 symlink 安全 helper；
- 定义 source snapshot，只保存结构、目标数据和规范化 hash，不保存完整文件正文；
- 定义 render adapter，统一 LibreOffice 调用、超时、输出路径和失败分类；
- 扩展 capability discovery，声明每个 profile 的最大输入、主要输出和 verifier 版本。

### 验收

- DOCX/XLSX/PPTX MIME 与扩展名不一致时失败关闭；
- path traversal、symlink、跨 task 和未知 OOXML part 处理有回归测试；
- unsupported feature scanner 零模型调用、零写文件退出；
- 公共 helper 不改变 M3 Word Worker 输出 hash 和验收结果。

### 提交边界

公共基础层不得同时提交 Excel/PPT 业务操作。

## 五、T2：Excel Worker/Verifier

### 开发任务

- 实现 `xlsx.inspect.v1`；
- 实现 `xlsx.transform.v1` 的白名单操作 schema；
- 实现带 `expectedBaseSha256` 的 `xlsx.patch.v1`；
- 实现 `xlsx.validate.v1`；
- 将固定 marker POC 与正式 Worker 分离，POC 只保留回归用途；
- 记录 Worker version、parameters digest、before/after hash 和目标范围；
- 对未授权关键范围保存规范化 snapshot 并验证不变；
- 区分公式文本、缓存值和可信重算结果；
- 只发布一个 `.xlsx` artifact。

### 白名单操作测试

- 设置单元格值和公式；
- 新增、重命名、排序和删除授权 Sheet；
- 数字格式、字体、填充、边框、对齐、行高和列宽；
- 基础 Excel Table 和图表；
- 多操作组合在同一候选上累积，不从原文件重新开始。

### Verifier 测试

- 工作簿可打开、关系可解析；
- required Sheet、值、公式和样式断言；
- 未授权范围不变；
- 命名区域有效；
- render 成功；
- 宏、外部连接、复杂透视表和重算不可证明时失败关闭。

### 停止条件

如果库会静默删除未支持 OOXML 特性且无法在执行前识别，停止该文件类型的 transform，
不得以“通常能打开”继续开发。

## 六、T3：PowerPoint Worker/Verifier

### 开发任务

- 实现 `pptx.inspect.v1`；
- 实现 `pptx.transform.v1` 的白名单操作 schema；
- 实现带 `expectedBaseSha256` 的 `pptx.patch.v1`；
- 实现 `pptx.validate.v1`；
- 支持文字、表格、已有图片、页面增删复制排序和基础 layout；
- 支持根据冻结 outline/source facts 生成一个完整 PPTX；
- 记录每页 source mapping 和 required assertion；
- 全部页面渲染到 internal，不把渲染图作为用户 artifact；
- 实现基础文本溢出、页面边界和缺失字体风险检查；
- 只发布一个 `.pptx` artifact。

### Verifier 测试

- OOXML、presentation、slide order、relationship 和 media；
- required sections、标题、关键数据和来源映射；
- notes 和未修改页面保持策略；
- 全部页面渲染；
- 文本明显越界、图片缺失和 font substitution 风险；
- 一个 10-20 页完整 PPTX，不产生逐页 PPTX；
- 无图片生成调用，无 ZIP fallback。

### 停止条件

如果无法稳定渲染全部页面，或只能验证“PPTX 可打开”而无法验证来源和关键内容，
不得进入候选交付。

## 七、T4：Office Compose

### 开发任务

- 实现 `office-compose-v1` capability router；
- 将 Excel/Word inspection 结果转换为有界 source facts；
- 定义 source fact 到 PPT section/slide 的映射；
- 生成冻结的 outline、页数范围和 required section assertions；
- 编排已注册 Worker Action，不生成动态脚本；
- 支持 XLSX -> PPTX、DOCX -> PPTX、XLSX + DOCX -> PPTX；
- 记录 source logical ID、Sheet/section、目标 slide 和数据 hash；
- 只交付最终 PPTX。

### 验收

- 模型上下文不包含完整 Excel、Word 或 PPT 文件正文；
- 来源数据变化时 verification 能识别旧候选；
- 缺少来源映射时进入 `needs_input`；
- 相同 fixture、outline 和 Worker revisions 可重放；
- Excel 数据到 PPT 表格/图表的关键值逐项一致。

## 八、T5：Runtime 与 Provider 集成

### 开发任务

- Runtime manifest validator 支持 v1.2 和三个新 profiles；
- Provider strict schema 按 profile 暴露 Worker allowlist；
- 初始计划强制从 inspect 开始，不能先 transform；
- ContextProjector 增加多个输入的结构化 inspection/source facts；
- Action signature 包含 profile、worker、目标、规范化参数和 verifier；
- Progress Vector 只以 required assertions 改善和计划节点关闭为进展；
- repair 复用同一 candidate，并校验 expected base hash；
- Runtime 重启恢复当前 profile、candidate、inspection 和 verification；
- capability 不匹配在 task 接受前返回明确结果。

### 验收

- Word M3 Runtime 61 项基线测试全部保持通过；
- 新 profiles 不能调用其他 profile Worker；
- 多输入 scope、路径和 session 校验失败关闭；
- candidate hash 改变但断言不改善时停止等价 repair。

## 九、T6：LibreChat Connector 集成

### 开发任务

- 扩展 upstream resolver，识别 `.xlsx`、`.pptx` 和组合任务；
- 为每个输入读取可信 storage-backed SHA-256；
- 新增 Excel/PPT/Compose acceptance resolvers；
- manifest builder 使用 v1.2/profile，不修改 v1.1 Word manifest；
- capability discovery 在持久化 user turn 前确认输入/输出/数量支持；
- billing snapshot 冻结当前模型价格；
- 继续使用 task/turn delivery、usage、artifact 和 message receipts；
- 继续通过 `processCodeOutput()` 持久化一个主要输出；
- 增加按 capability 控制的 feature flags：Word、Excel、PPT、Compose；
- task 接受后失败关闭，不回退旧 Agent 双执行。

### 验收

- 普通聊天、图片理解和不支持格式不创建 Runtime task；
- Word capability 开关不受其他 M3.1 capability 开关影响；
- 不同用户、conversation 和 storage session 无法混用文件；
- usage、file、message、final 重放不重复；
- 生成文件出现在下载卡和“生成的文件”。

## 十、T7：集成、恢复与事故回放

### 必测场景

1. Excel 修改成功后 Runtime 重启；
2. PPTX 已生成、artifact receipt 前 Connector 中断；
3. Compose 第二轮用户补充要求后继续同一 task/workspace；
4. CodeAPI session stale 后 rebind；
5. 相同 repair plan 不产生第二次 CodeAPI 副作用；
6. unsupported feature 在模型调用前停止；
7. 多输入中一个文件越权时整个任务拒绝；
8. assistant message 已保存、final event 未完成时恢复；
9. 浏览器刷新前后下载卡一致；
10. 旧 Agent 的 10K-20K 脚本循环 fixture 不进入 Runtime Worker 路径。

### 性能证据

每个固定 fixture 记录：

```text
model calls
input/cache read/cache write/output tokens
CodeAPI calls
first candidate latency
total delivery latency
artifact bytes and sha256
render page/slide count
repair count and progress decisions
```

性能目标不使用未经基线测量的绝对数字。必须与同 fixture 的旧链路比较上下文、调用次数、
耗时和成功状态。

## 十一、T8：真实非生产联合验收

在独立批准后，使用测试账号和非生产 relay/CodeAPI，串行执行：

1. M3 Word 回归任务；
2. Excel 修改和下载任务；
3. 已有 PPTX 修改任务；
4. Excel 数据生成完整 PPTX 任务；
5. 每条任务至少一个中断恢复或幂等重放探针。

每条报告记录 source revision、fixture hash、Worker/Verifier version、调用次数、Token、
耗时、artifact hash、恢复证据和 secret scan。不得使用生产 Key、客户文件或生产写入。

## 十二、提交计划

建议提交顺序：

```text
1. docs/contracts: freeze M3.1 schemas and fixtures
2. feat(runtime): add common Office inspection foundation
3. feat(runtime): add deterministic Excel worker and verifier
4. feat(runtime): add deterministic PowerPoint worker and verifier
5. feat(runtime): add Office compose capability
6. feat(runtime): integrate M3.1 profiles and recovery
7. feat(connector): route and deliver M3.1 Office tasks
8. test(file-agent): add M3.1 integration and accident replay
9. docs(file-agent): record M3.1 implementation results
```

每次提交推送 `origin/main` 后报告测试和剩余门禁。不得将全部实现压成一个提交，也不得
把旧的独立 M3-R 发布文件、M4 Script 实现或无关生产补丁混入统一批次提交。

## 十三、开发完成门

开发完成必须同时满足：

- Runtime、Connector 和 M3 Word 全量测试通过；
- M3.1 新增 contract、Worker、Verifier、resolver 和恢复测试通过；
- source fixture hash 和原始 Office 输入不变；
- 所有用户可见 artifact 均有独立 Verifier passed receipt；
- unsupported Office 特性失败关闭；
- 语法、类型、格式和 `git diff --check` 通过；
- 仓库无 Key、Authorization、客户正文或原始模型响应；
- 形成实现记录、能力矩阵、已知限制和回滚说明；
- 明确停在“开发完成，待非生产联合验收”，不得自动打包或部署。
