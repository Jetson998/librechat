# File Agent Runtime Phase 3D-C 非生产真实接入验收方案

Date: 2026-07-24

Status: approved implementation plan. This document does not approve production
wiring, deployment, customer traffic, customer files, or production credentials.

## 一、目标

在不接入生产 LibreChat 的前提下，用一个仓库内固定 XLSX fixture 验证：

1. File Agent Runtime 能通过真实非生产 OpenAI-compatible model relay 取得严格计划；
2. 同一任务能通过真实非生产 LibreChat CodeAPI 协议完成 XLSX 生成与验证；
3. Connector 能把四类 Token、单个 artifact 和最终 assistant delivery 幂等写入临时 MongoDB；
4. 报告只保留协议、延迟、usage、artifact SHA-256 和状态，不泄露外部地址或凭据。

Phase 3D-B 已证明完整 LibreChat 页面、恢复、下载卡和 native fallback。3D-C 不重复浏览器
验收，也不重复启动完整 LibreChat build。

## 二、固定输入与外部前置条件

输入固定为：

```text
services/file-agent-runtime/test/fixtures/phase2b-source.xlsx
SHA-256: f082ebb1a704ed9b65d16e8a44b41b6f07377979e684f4fc7464966a975aedc3
customerData: false
```

外部依赖必须同时满足：

- model relay 使用 HTTPS、隔离测试 Key 和明确模型名；
- CodeAPI 是非生产实例，使用 HTTPS 或 loopback 地址；
- fixture 已通过非生产上传流程 prime，操作员提供对应的 `storage_session_id`、`file_id`、
  `kind` 和 resource ID；
- CodeAPI 接受 LibreChat 原生 `/exec` 请求：`lang`、`code`、`session_id`、`files`；
- CodeAPI 测试身份只能访问本次 fixture session，不允许访问客户或生产 session；
- MongoDB 仅允许临时 memory-server 或显式 loopback URI。

缺少任一前置条件时，验收器必须在模型请求之前退出。

## 三、执行预算

单次批准只允许一个任务：

| 项目 | 上限 |
| --- | ---: |
| Runtime task | 1 |
| model relay calls | 2 |
| 单次输入 Token | 6,000 |
| 总输入 Token | 12,000 |
| 单次输出 Token | 256 |
| 总输出 Token | 512 |
| context projection | 8,000 characters |
| CodeAPI `/exec` calls | 7: 1 preflight + 6 task calls |
| 单次 CodeAPI timeout | 30 seconds |
| 总墙钟时间 | 180 seconds |
| 可见 artifact | 1 XLSX |

六次任务 CodeAPI 调用对应稳定 worker 的 `prepare -> execute -> verify -> repair execute ->
verify -> publish`。模型只选择白名单 action，不生成或重写长脚本。

## 四、执行顺序

### Gate A：零费用本地门禁

1. 校验 Git 工作区、fixture hash、环境变量形状和非生产确认短语；
2. 校验 URL 不含 credential、query 或 fragment；
3. 校验 MongoDB 仅为 loopback；
4. 运行 Runtime、Connector 和新协议适配器测试；
5. 对运行目录做 credential 扫描。

Gate A 未通过时不访问 model relay 或 CodeAPI。

### Gate B：CodeAPI 预检

使用已 prime 的 fixture ref 执行只读命令，确认：

- fixture 在 `/mnt/data` 可见；
- fixture SHA-256 与仓库固定值一致；
- `/exec` 返回 stdout、stderr、session 和 files 的可解析结构；
- 身份不能枚举其他 session 或全局存储。

CodeAPI 预检失败时不调用模型。

### Gate C：一个真实任务

1. 启动临时 MongoDB、loopback Runtime HTTP 和 Connector；
2. 提交一个固定 XLSX transform task；
3. 最多执行两次真实模型调用、一次 CodeAPI 预检和六次任务 CodeAPI 调用；
4. 等待 verified artifact 和 completed delivery；
5. 重放 reconcile，确认 transaction、file、message 和 final event 不重复；
6. 下载并计算 artifact SHA-256，不保存文件正文或原始模型输出。

## 五、停止条件

出现以下任一情况立即停止，不自动重试外部副作用：

- 外部 scope 不是 `non-production`；
- fixture ref 缺失、跨 session 或 hash 不匹配；
- model relay 或 CodeAPI URL 不符合地址限制；
- model call、Token、CodeAPI call 或墙钟预算达到上限；
- 上游不保证幂等且 journal 留下 pending model call；
- CodeAPI 返回未知 artifact、超过一个可见文件或非 XLSX；
- usage 缺失、artifact 验证失败、delivery 重放产生重复记录；
- 运行目录检测到 Key、Authorization、外部 URL 或原始模型回复。

失败后只记录脱敏错误分类，不切换生产 endpoint，不改生产配置，不用客户文件重试。

## 六、验收记录

通过后新增 `docs/FILE_AGENT_RUNTIME_PHASE3DC_ACCEPTANCE.md`，只记录：

- source revision 和相关 source blob hash；
- endpoint contract 类型，不记录 URL；
- model 名、请求次数、四类 Token 和预算是否超限；
- CodeAPI 调用次数、延迟区间和协议字段；
- artifact MIME、大小、SHA-256 和验证状态；
- Mongo delivery、transaction、file、message、final event 的数量与重放结果；
- 明确的生产未授权声明。

## 七、通过后的边界

Phase 3D-C 通过只说明真实非生产依赖与现有 Runtime/Connector 契约兼容。后续生产接入
仍需独立的生产架构、secret 管理、网络策略、容量、监控、回滚和发布验收方案；不得从
本阶段直接生成 production patch 或部署。
