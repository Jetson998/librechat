# Fable 文件工具别名兼容修复方案

## 一、问题范围

目标对话：`9b947fcc-8e44-4220-a48f-5e5a39a5a3b1`。

已确认该对话中的 DOCX、XLSX 和 Markdown 附件均已进入 LibreChat 文件链路。
DOCX 与 XLSX 具有有效的 `metadata.codeEnvRef`，Office 受控预解析也已完成。
因此本次故障不属于上传失败、CodeAPI 不可用或 `/mnt/data` 未挂载。

生产日志和消息记录显示 Fable 发起了以下工具调用：

```text
Read  {"file_path":"/mnt/data/New_Chat.md"}
Bash  {"command":"ls /mnt/data/ ..."}
Grep  {...}
Skill {"skill":"office-document-parser", ...}
```

当前 LibreChat Agent 实际注册的对应工具为：

```text
bash_tool
read_file
skill
```

其中参数契约也存在两处差异：

- `Read.file_path` 应为 `read_file.path`。
- `Skill.skill` 应为 `skill.skillName`。

## 二、根因

1. Fable 的生产模型提示词仍写着“Anthropic 端代码工具名通常显示为 Bash”，
   与当前 LibreChat `bash_tool + read_file + skill` 工具注册表不一致。
2. Agent 的事件执行入口按模型返回的工具名直接调用 `loadTools()`，没有对已知的
   Claude Code 旧工具名做兼容归一化，因此返回 `Tool not found`。
3. Office 预解析按设计只注入每个文件最多 20,000 字符的受控清单。完整 DOCX
   正文应由代码工具从 `/mnt/data` 读取；工具调用失败后，模型只能看到清单预览。

## 三、修复设计

### 3.1 后端确定性别名归一化

在 Agent `ON_TOOL_EXECUTE` 入口、调用 `loadTools()` 之前，只转换以下精确别名：

| 旧调用 | LibreChat 调用 | 参数转换 |
|---|---|---|
| `Bash` | `bash_tool` | 保留 `command` |
| `Read` | `read_file` | `file_path` 改为 `path` |
| `Skill` | `skill` | `skill` 改为 `skillName` |

保留工具调用 ID、step、turn、代码会话和附件注入信息。日志只记录工具名映射，
不记录命令、路径、正文或工具参数。

`Grep` 本次不做自动转换。其 Claude Code 参数结构与 shell 命令并非一一对应，
隐式拼接命令会扩大执行面并引入转义风险。模型应通过 `read_file` 或 `bash_tool`
完成明确的读取和搜索。

### 3.2 修正 Fable 模型提示词

只修改 `claude-fable-5` 的 `preset.promptPrefix`：

- 明确真实工具名为 `bash_tool`、`read_file`、`skill`。
- 明确禁止使用 `Bash`、`Read`、`Skill`、`Grep`、`Glob`、`Edit`、`LS` 等
  Claude Code CLI 名称。
- 将“调用 Bash 运行 Python”改为“调用 bash_tool 运行 Python”。

不修改 GPT 模型、不修改价格、不修改 Office Skill 内容、不扩大预解析清单。

## 四、测试与验收

仓库回归测试使用生产对话中记录的原始调用载荷，验证：

1. 三个旧别名及参数均被正确转换。
2. 已使用规范工具名的调用保持原样。
3. `Grep` 和未知工具保持原样并继续走现有错误处理。
4. 原始调用对象不被就地修改。
5. Fable 提示词中的旧说明被移除，新工具名说明唯一存在。
6. 候选 `api-index.cjs` 通过 `node --check`，部署脚本和 Mongo 操作脚本通过语法检查。

生产验收范围：

- `/api/config` 和主页保持正常。
- `LibreChat-CodeAPI` 容器 ID、启动时间和健康状态保持不变。
- 使用 `vip998` 最多执行一次受控 DOCX 读取验收：新对话上传 DOCX 后，Fable
  能调用规范工具读取 `/mnt/data` 中的正文，并返回来自正文的指定段落内容。
- 日志出现别名归一化记录，且不再出现该轮的 `Tool "Read/Bash/Skill" not found`。

## 五、发布与回滚

本变更属于模型工具路由，按 LibreChat 发布治理解析为 `enhanced + heavy`。
发布只重建 `LibreChat-API`；不重建 CodeAPI、RAG、MongoDB 或 NGINX。

发布前备份：

- `/opt/librechat/compose.override.yaml`。
- 当前 Mongo 基础配置文档。
- 当前 `/app/packages/api/dist/index.cjs` 挂载来源及哈希。

失败时恢复 Compose override 和 Mongo 配置，并仅重建 API。没有生产热补路径。
