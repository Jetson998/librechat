# 公共代码工具契约收口方案

## 一、目标

将代码与文件工具的真实名称约束从单个模型提示词迁移到 LibreChat Agent 的
公共初始化层。任何当前或未来新增的模型，只要本轮实际注册了代码或文件工具，
都会自动收到与本轮工具注册表一致的调用契约，不再要求管理员逐个维护
`gpt-5.6-sol`、`claude-fable-5` 或后续模型的工具名称说明。

本次不修改上传、Office 预解析、CodeAPI、文件预览、模型价格或生成文件链路。

## 二、现状与风险

当前生产后端已经在公共 `ON_TOOL_EXECUTE` 入口严格兼容以下旧调用：

| 旧调用 | 规范调用 | 参数转换 |
|---|---|---|
| `Bash` | `bash_tool` | 保留 `command` |
| `Read` | `read_file` | `file_path` 改为 `path` |
| `Skill` | `skill` | `skill` 改为 `skillName` |

但模型提示词仍由各个 `modelSpecs` 独立维护。GPT 的现有提示词还可能把
`execute_code` 描述为可调用工具，而它在当前 Agent 架构中只是能力标记，
实际展开为 `bash_tool` 与 `read_file`。继续逐个修正模型提示词会在新增模型、
后台覆盖配置或模型迁移时再次产生漂移。

## 三、公共实现

### 3.1 根据实际注册表生成契约

新增无状态公共帮助模块，在 Agent 完成代码工具、文件创作工具和 Skill 注入后，
从本轮 `toolDefinitions` 中读取实际存在的以下工具：

```text
bash_tool
read_file
skill
create_file
edit_file
```

只有至少一个相关工具真实存在时才生成契约。契约包含：

- 本轮可调用工具的精确名称；
- `execute_code` 是能力标记，不是可调用工具名；
- 必须使用工具定义中的参数结构；
- 禁止调用 `Bash`、`Read`、`Skill`、`Grep`、`Glob`、`Edit`、`LS` 等
  Claude Code CLI 名称。

契约通过公共 `appendAdditionalInstructions()` 追加到 Agent，覆盖所有 Provider、
模型规格和未来新增模型，不按模型名称分支。

### 3.2 保留严格别名兼容

继续保留公共执行入口现有的 `Bash/Read/Skill` 三个确定性转换，作为模型偶发输出
旧名称时的兼容层。不得新增 `Grep`、`Glob`、`Edit`、`LS` 或任意 shell 拼接转换，
避免扩大执行面。

### 3.3 清理现有模型冲突文案

生产 Mongo 基础配置只清理 `gpt-5.6-sol` 与 `claude-fable-5` 中已经过时或重复的
工具名称句子，并将业务进度文案改为不绑定工具名称的表达。Office 使用约束、
`/mnt/data` 隔离、生成文件要求和其他模型参数保持不变。

未来新增模型无需再写代码工具名称；公共契约是唯一运行时事实来源。

## 四、测试

仓库测试覆盖：

1. 无代码/文件工具时不追加契约。
2. 只列出本轮真实注册的规范工具名，顺序稳定且不重复。
3. `execute_code` 被明确标记为不可调用的能力标记。
4. 未注册 `skill` 时契约不声称它可用。
5. 旧别名转换继续只支持 `Bash/Read/Skill`。
6. Mongo 迁移只修改两个目标模型的冲突句子，保留其他配置，并支持回滚。
7. 候选 API 文件、帮助模块、部署与 Mongo 脚本通过语法检查。

## 五、发布与验收

本变更影响公共 Agent 工具提示与执行契约，按 `enhanced + heavy` 发布。只重建
`LibreChat-API`，不重建 CodeAPI、MongoDB、RAG 或 NGINX。

生产验收：

- 主页与 `/api/config` 正常；
- CodeAPI 容器 ID、启动时间和健康状态保持不变；
- Mongo 目标模型不再包含 `Bash 或 execute_code`、`通常显示为 Bash` 等冲突文案；
- 公共帮助模块根据模拟工具注册表生成正确契约；
- 使用 `vip998` 至多执行一次受控代码工具请求，确认模型能直接调用规范工具；
- 验收窗口无新增 `Tool execute_code/Bash/Read/Skill not found`。

## 六、回滚

发布前备份 Compose override、当前 API 挂载文件和 Mongo 基础配置。失败时恢复
上述备份并仅重建 API。不得直接在容器内修改文件，也不得只改生产提示词救火。
