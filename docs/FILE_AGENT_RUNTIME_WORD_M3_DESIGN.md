# File Agent Runtime Word M3 设计记录

Date: 2026-08-03

Updated: 2026-08-04

Status: development-only implementation complete and frozen

本记录只授权仓库内 Word Worker/Verifier 的实现与非生产测试，不授权打包、预检、部署、
生产流量或客户文件验收。

M3 已完成并通过独立复审：Runtime 61/61、Connector 79/79、真实 DOCX source-level
handoff、语法检查和 `git diff --check` 通过。该结论不包含真实外部非生产联合验收。

## 1. 能力边界

M3 只支持一个 `.docx` 输入和一个 `.docx` 输出，使用 `word-edit-v1` capability profile
和 `office-file-agent.v1.1` task contract。XLSX 继续使用现有
`office-planner-v1`/`office-file-agent.v1` 路径，两个能力不共享 Worker 脚本或输出目录。

不支持 `.doc`、`.docm`、宏、嵌入可执行对象、未经专项 Verifier 的批注/修订痕迹保证、
像素级 Word 桌面端一致性和多版本候选交付。

## 2. Workspace 契约

每个 task 固定使用以下路径：

```text
/mnt/data/.agent/<taskId>/
  input/source.docx              # 初始化后只读
  scripts/word_worker.py         # 固定 Worker revision
  scripts/word_verifier.py       # 固定 Verifier revision
  internal/worker-history.json   # 参数摘要、before/after hash
  internal/verification/*.json   # 详细断言证据
  internal/render/*.pdf          # 渲染缓存，不发布
  output/working.docx            # 唯一候选/最终 artifact
```

Worker 只在 `input/` 的复制品或当前 `output/working.docx` 上工作，禁止就地修改原始
输入。`word.patch.v1` 必须携带当前候选的 SHA-256，hash 不匹配时以稳定冲突错误结束。

## 3. Action 契约

允许的 Worker ID：

```text
word.inspect.v1
word.transform.v1
word.patch.v1
word.validate.v1
```

普通 Action signature 保留规范化参数；repair semantic signature 对
`word.patch.v1.parameters.expectedBaseSha256` 视为当前候选的并发保护令牌而忽略，避免同一
个修复策略因候选 hash 变化被错误识别为新策略。实际 patch 仍必须携带并校验该 hash。

参数只允许结构化操作：`replace_text`、`append_paragraph`、`replace_table_cell`，以及
有限的索引和文本字段；不接受 shell、脚本、路径、URL、凭据或任意 XML。Action 的
`summary` 只用于展示，不能参与幂等签名或进展判断。

`word.patch.v1` 修改的是候选 DOCX 的结构化内容，不是动态脚本源码 patch。任务级
`script.create.v1` / `script.patch.v1` 必须使用新的版本化 task contract 和 capability
profile，在后续 M4 独立设计、开发和评审，不回填到 M3。

## 4. Deterministic Verifier 契约

`word-structure-v1@1.1.0` 固定执行以下断言：

```text
ooxml.zip.valid
ooxml.content_types.valid
xml.parts.parseable
word.document.present
word.relationships.resolved
word.comments.no_orphans
word.required_changes.applied
word.render.succeeded
```

Verifier 将详细证据写入 `internal/verification/`，向 Runtime 只返回
`Verification Result v1.0`。结构断言、业务断言和渲染断言任一失败都不能进入
`publishing`；渲染不可用也按失败处理，不以“可打开”替代渲染通过。

## 5. 独立业务断言解析

LibreChat Host 在创建 Word task 前调用版本化的
`resolveWordAcceptanceAssertions`，从当前用户指令编译冻结的结构化业务断言；Host 和
验收脚本不得注入固定断言。M3 resolver 只接受无歧义的受控表达：带引号的文本替换、
带引号的段落追加，以及明确的一基表格/行/列单元格替换。无法解析、包含未支持的
修改动作、超过数量或字段预算的指令返回原生路径，禁止猜测、静态复用或让模型自证。

断言在进入 Runtime 前固定为 `word-acceptance` schema，artifact logical ID 必须是
`candidate:working-docx`。断言投影保留完整结构化值；超过聚合或上下文预算时任务失败
关闭，不截断字段后继续执行。

## 6. 发布和测试门

- `publish` 只请求 `output/working.docx`，并校验返回的 MIME、扩展名和唯一 artifact。
- 原始输入 hash 必须在执行前后保持不变。
- 六类 fixture 覆盖普通段落表格、多表格页眉页脚图片、损坏 relationship、孤儿评论、
  渲染失败和事故回放。
- M3 只运行 Runtime/Connector 本地与隔离测试；真实 relay、真实 CodeAPI 和生产文件
  不属于 M3，不能用本地模拟结果替代联合验收。

## 7. 后续边界

- M3-R：只对 Word M3 做受控发布准备，不增加能力范围；
- M3.1：新增 Excel、PowerPoint 和 Office Compose 确定性 Worker，Word v1 保持冻结；
- M4：受控动态脚本核心，复用 M3 状态机、Workspace、Verifier、Progress Vector 和交付；
- M5：完整产品真实非生产联合验收；
- M6：扩大范围前的生产组合、任务状态 UI、持久化拓扑与独立发布候选。

后续阶段不得修改 M3 已冻结的 `office-file-agent.v1.1` / `word-edit-v1` 语义；需要新增
能力时提升 contract/profile 版本，并保持 M3 全量回归通过。
