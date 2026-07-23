# File Agent Runtime Phase 3D-B 完整 LibreChat 验收记录

Date: 2026-07-24

Status: passed non-production integration acceptance. This record does not
approve Phase 3D-C, customer traffic, production wiring, or deployment.

## 一、验收范围

本次在固定上游 revision
`60eba76375213dafc1874d943e41371201c300ab` 的完整 LibreChat API/client build
中执行，所有外部依赖均为本机隔离服务：

- 临时 MongoDB 与动态测试账号；
- 真实 Chrome 页面操作；
- loopback File Agent Runtime HTTP；
- 隔离 model relay，不调用付费模型；
- 隔离 CodeAPI，生成真实 XLSX；
- app-local bridge 显式安装和卸载；
- 不访问生产、客户文件、真实模型 Key 或真实 CodeAPI。

## 二、通过结果

```text
ordinary chat Runtime tasks: 0
bridged workbook uploads: 2
Runtime task submissions: 2
Runtime restart recovery: passed
LibreChat API restart recovery: passed
completion without refresh: passed
native download card and download: passed
native fallback after bridge removal: passed
deliveries: 2
billing snapshots: 2
file-agent transactions: 8
generated files: 2
assistant output messages: 2
```

两个 XLSX 请求各只创建一个 Runtime task。恢复、重放和最终化没有重复 delivery、
billing snapshot、transaction、file 或 assistant message。

## 三、验收中发现并修复的问题

1. Connector 最初使用 64 位稳定哈希写 `transaction._id`，与 LibreChat 原生
   `ObjectId` 不兼容。宿主现在把稳定哈希确定性映射为 `ObjectId`，重放仍保持幂等。
2. 生成文件的 `file.user` 是 Mongoose `ObjectId`，delivery user 是字符串。所有权
   比较现在先规范化身份字符串，conversation 与 tenant 校验仍严格保留。
3. Reconciler 批量扫描返回的单 delivery 错误没有上报。`wakeAll()` 现在把批量结果中
   的错误交给 `onError`，不会静默吞掉。
4. assistant 消息虽然保存了 `attachments`，但没有同 ID 的 `tool_call` content part。
   final SSE 能结束文字，却没有前端锚点渲染文件卡。消息构建器现在按 LibreChat 原生
   `execute_code` 契约为每个文件创建对应内容块，下载卡无需刷新即可出现。
5. Runtime 重启时两个同 idempotency key 的请求可能同时到达隔离 relay。测试 relay
   现在合并 in-flight 请求并只实际执行一次，验收能够验证真实的幂等恢复语义。
6. 验收脚本曾使用旧上传入口、宽泛回复定位和旧版下载按钮名称。现在固定浏览器语言、
   限定 messages view、使用 Code Environment 上传入口，并按当前文件卡的可访问名称
   下载。

## 四、门禁结果

```text
File Agent Runtime tests: 30 passed
LibreChat Connector tests: 53 passed
Runtime syntax checks: passed
Connector syntax checks: passed
Pinned upstream overlay verification: passed
Phase 3D-B browser acceptance: passed
git diff check: passed
release governance validation: passed
```

## 五、边界与下一步

本阶段只证明独立 Runtime 能通过显式 bridge 接入完整 LibreChat，并在重启、重放、
计费、文件落库、final SSE 和原生下载卡上保持一致。

下一道门禁是 Phase 3D-C：使用隔离测试 Key，对真实非生产 model relay 与真实
非生产 CodeAPI 各执行一个有预算上限的任务。Phase 3D-C 和单独的生产方案未批准前，
不得创建生产 patch、部署、开放客户流量或扩展 Word/PPT/PDF worker。
