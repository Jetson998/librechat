# Agent Runtime 与 Codex App Server 架构研究记录

## 一、记录目的

本文件记录 LibreChat 文件 Agent 当前已确认的问题、已否定的早期方案、
Codex CLI / app-server 可参考的架构方向，以及进入开发前必须完成的研究工作。

本阶段只形成诊断和研究门禁，不修改 LibreChat、CodeAPI、Office 文件链路或
生产环境。

## 二、问题样本与已确认事实

问题样本：

```text
conversationId: 4ba5e3cd-a659-4cae-b2e7-40b1f2db83c5
model: gpt-5.6-sol
task type: 多文件读取、复杂 Excel 修改、结果验证与交付
```

页面级检查确认：

- 第 2 个 Assistant 响应执行了 6 次代码工具调用；
- 第 4 个 Assistant 响应执行了 6 次代码工具调用；
- 第 6 个 Assistant 响应执行了 2 次代码工具调用；
- 多次完整脚本长度约为 10K 至 20K 字符；
- 出现过 `MergedCell` 只读错误、父目录不存在、临时脚本路径失效等问题；
- 部分失败后没有修改已有脚本，而是重新生成整份脚本；
- 第 6 个响应采用一次轻量检查和一次主脚本执行，成功生成文件；
- 检查时对话上下文已使用约 71%，约为 25.8 万 / 36.1 万 Token；
- CodeAPI 能执行 Python、读取输入文件并生成最终 Excel，不是本次重复执行的
  根因。

另有一个独立问题：文件已经生成后，前端可能继续显示“生成中”，刷新后才能
恢复最终回复和下载卡。该问题属于 LibreChat 流式任务收尾，不等同于 Agent
执行链路过长。

## 三、当前 Agent 问题的正确表述

工具调用次数多本身不是故障。一个正常工程任务可能需要检查、修改、执行、
验证、修复和再次验证。

本次真正的问题是：

1. 任务状态主要存在于聊天上下文，而不是独立的持久任务状态中；
2. 脚本没有被稳定复用，修复时重复传输和重写完整代码；
3. 工具结果持续进入模型上下文，缺少自动压缩和相关内容投影；
4. 执行器没有判断一次调用是否让任务状态取得实际进展；
5. 相同错误、相近脚本和相同输出状态没有触发重新规划；
6. 文件已生成后，Agent 缺少明确的验证和交付阶段边界；
7. 提示词声明了“一次预检和一次确定性批处理”，但后端没有提供对应的
   状态模型和执行能力。

因此，根因不能简化为“工具次数太多”，也不能只靠降低递归次数解决。

## 四、对早期限制方案的修正

以下规则不能作为主执行架构：

```text
固定最多 N 次工具调用
固定只允许一次完整脚本
固定最多 N 次修复
超过固定时长立即停止
```

这些规则可以保留为资源保护和异常熔断，但不能替代正常 Agent 执行链路。

主判断应从“调用次数”改为“是否取得进展”，至少观察：

- 任务阶段是否前进；
- 脚本或目标文件是否发生有效变化；
- 错误签名是否重复；
- 新调用是否复用了已有工作区和脚本；
- 输出文件是否已经满足验收标准；
- 上下文增长是否与实际进展匹配。

## 五、Codex 可参考的公开架构

Codex app-server 公开提供以下核心对象：

- `Thread`：持久对话及历史；
- `Turn`：一次用户请求及其完整执行过程；
- `Item`：计划、命令执行、文件修改、工具调用和 Agent 消息等执行单元；
- `item/started`、`item/completed`：单个执行单元的生命周期；
- `turn/completed`：一次 Turn 的权威完成状态；
- `thread/compact/start`：压缩历史上下文；
- `thread/resume`、`thread/fork`：恢复或分支持久任务；
- `turn/steer`、`turn/interrupt`：在执行中补充要求或中断任务；
- 独立的命令执行、后台进程、文件修改和流式事件模型。

Codex 的公开长任务工作方式还包括：

- 使用 `/plan` 明确执行方案；
- 使用 `/goal` 保存持续目标和完成标准；
- 使用 `/compact` 压缩长对话；
- 使用持久工作目录作为外部状态，而不是让全部状态依赖聊天记录；
- 使用 Skill 封装可复用、可版本化、可测试的流程和脚本；
- 将限制作为安全边界，而不是正常执行流程的主要调度方式。

官方参考：

- https://learn.chatgpt.com/docs/app-server
- https://learn.chatgpt.com/docs/long-running-work
- https://learn.chatgpt.com/docs/reference/slash-commands
- https://developers.openai.com/cookbook/examples/skills_in_api
- https://github.com/openai/codex/tree/main/codex-rs/app-server

## 六、候选目标架构

本阶段只记录候选方向，不视为已批准实现。

### 6.1 持久任务工作区

每个文件任务应拥有稳定工作区，例如：

```text
/mnt/data/.agent/<conversation-id>/<turn-id>/
  task.json
  plan.md
  state.json
  inputs/
  scripts/
  outputs/
  verification.json
  errors.json
```

脚本、计划、错误和验证结果由工作区持久保存。模型上下文被压缩后，任务仍能
从工作区继续。

### 6.2 Thread / Turn / Item 状态

LibreChat Conversation 可以映射到 Thread，用户的一次请求映射到 Turn，计划、
工具调用、命令、文件修改和最终交付映射到 Item。

前端应根据权威 Item 和 Turn 状态展示进度，不依赖是否刚好收到某个瞬时 SSE
数据包。

### 6.3 上下文投影和压缩

模型每一步只接收：

- 当前目标和验收标准；
- 当前阶段；
- 输入和输出文件清单；
- 最近一次执行摘要；
- 当前错误及相关代码片段；
- 完成下一步所需的最小历史。

完整脚本、旧工具输出和全部聊天历史保留在持久存储中，不在每轮重复注入。

### 6.4 增量修改和验证

完整脚本应创建一次并保存。失败后读取错误位置，通过增量编辑修改已有脚本，
再执行验证。复杂 Office 处理的稳定逻辑应逐步沉淀为版本化 Skill 或确定性
CLI，而不是每次由模型重新生成公共机械代码。

### 6.5 进展感知与最终熔断

正常执行允许根据任务需要进行多步调用。只有出现以下情况时才触发重新规划、
暂停或熔断：

- 相同错误签名连续出现；
- 脚本高度重复但没有有效差异；
- 任务阶段、文件哈希和验证状态均无变化；
- 已有合格成果后仍重复生成；
- 上下文和成本持续增长但没有可验证进展；
- 达到资源、时间或安全硬上限。

## 七、模块责任边界

| 模块 | 责任 |
| --- | --- |
| LibreChat | 会话、用户、权限、计费、附件、文件卡和 UI |
| Agent Runtime | Thread/Turn/Item、计划、上下文投影、压缩、恢复和进展判断 |
| CodeAPI | 持久工作区、命令和进程执行、文件读写、运行状态 |
| Office Skill / Worker | Excel、Word、PPT 的稳定 CLI、模板和格式验证 |
| Safety Guard | 资源上限、重复错误检测和最终熔断 |
| GenerationJobManager / Client | 流式事件持久化、重连和最终完成状态 |

不得将 Excel 专属业务代码直接堆入 LibreChat core，也不得让 CodeAPI 负责判断
业务任务是否应该继续。CodeAPI 是执行环境，Agent Runtime 才是执行编排层。

## 八、下一步研究门禁

下一步必须先研究 Codex app-server 的开源实现并形成 LibreChat 映射设计，再决定
采用哪条实现路线：

### 路线 A：直接复用 Codex app-server 或 Codex SDK

需要验证：

- 是否支持当前自定义模型端点及 `gpt-5.6-sol`、`claude-fable-5`；
- 多用户和会话隔离方式；
- 与 LibreChat 登录、权限、计费和附件系统的集成成本；
- 与现有 CodeAPI、`/mnt/data` 和生成文件卡的兼容性；
- 部署资源、授权、升级和回滚边界；
- 是否可以只作为复杂文件任务的可选执行后端。

### 路线 B：在 LibreChat Agent Runtime 中实现同类架构

需要映射：

- Conversation / Message 到 Thread / Turn / Item；
- LangGraph 运行和工具事件到 Item 生命周期；
- GenerationJobManager 到权威 Turn 完成状态；
- CodeAPI session 到持久任务工作区；
- 当前消息上下文到可压缩的上下文投影；
- 当前 Skills 到版本化任务程序和确定性 CLI。

### 路线 C：混合模式

LibreChat 保留普通聊天和轻量文件问答；复杂 Office、代码和长任务委托给具备
持久工作区、上下文压缩和可恢复执行能力的专用 Agent Runtime。

## 九、研究输出要求

研究阶段至少产出：

1. Codex app-server 源码模块图；
2. Thread / Turn / Item 和上下文压缩机制说明；
3. 命令执行、文件变更、恢复和完成事件链路说明；
4. LibreChat 当前 Agent 链路的逐项映射；
5. 直接复用、原生实现和混合模式的成本与风险比较；
6. 一个不接生产流量的最小 POC 方案；
7. 明确的采用或不采用结论。

在上述研究和映射设计完成前，不开发新的静态工具次数限制，不进行生产热补，
不修改现有 Office 上传和 CodeAPI 文件挂载链路。
