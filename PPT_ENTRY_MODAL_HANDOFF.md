# PPT 弹窗复用版交接说明

## 用户路径

```text
https://ppt.152.32.172.162.sslip.io/
→ PPT 素材首页
→ 点击右上角“登录”
→ 首页仍在背景，弹窗加载原站 https://152.32.172.162.sslip.io/login?entry=ppt
→ 原站完成账号密码登录；需要 2FA 时继续显示原站 /login/2fa
→ 原站登录前端发送受限完成消息
→ PPT 父页面固定跳转 https://152.32.172.162.sslip.io/c/new
```

## 复用边界

- PPT 站点只提供首页、遮罩、弹窗和 iframe 容器。
- 账号密码、登录 API、2FA、Cookie、会话和工作区仍由原 LibreChat 域名处理。
- PPT 静态构建不包含 `AuthContext`、`LoginForm`、`TwoFactorScreen` 或认证 API。
- 原站直接访问 `/login` 的行为保持不变。
- 只有带 `entry=ppt` 且确实运行在 iframe 中的原站登录页面发送完成通知。
- 通知只发送固定消息 `librechat:ppt-authenticated`，目标 origin 固定为 PPT 域名，不传递密码、Token、Cookie 或用户数据。
- PPT 收到消息后只跳固定的原站 `/c/new`，不接受任意回跳地址。

## 原站站点配置要求

本地交付前已对线上 `/login?entry=ppt` 和 `/login/2fa` 做只读响应头核对：当前没有发现 `X-Frame-Options` 或 `Content-Security-Policy` 阻断，因此本候选不要求改原站响应头。

如果后续原站站点配置新增了禁止跨站嵌入的响应头，只能针对 `/login` 和 `/login/2fa` 放行 `https://ppt.152.32.172.162.sslip.io`；精确示例随包放在 `PPT_ENTRY_MODAL_NGINX.conf.example`。不要对 `/c/*`、`/api/*`、文件、管理页或整个原站放开嵌入。PPT 域名也不得代理原站 API。

不要对 `/c/*`、`/api/*`、文件、管理页或整个原站放开嵌入。PPT 域名也不得代理原站 API。

## 本地候选范围

- 候选工作树：`/Users/jets2026/Documents/Codex/LibreChat/tmp/agent-ui-upstream`
- 独立 PPT 构建：`client/dist-ppt-entry/`
- 本地预览脚本：`tmp/ppt-modal-preview.mjs`
- 原站前端变更：`client/src/hooks/AuthContext.tsx`、`client/src/components/Auth/TwoFactorScreen.tsx`、`client/src/ppt-entry/routing.ts`
- PPT 入口变更：`client/src/routes/PptMaterialsHome.tsx`、`client/src/routes/PptMaterialsHome.css`

## 部署边界

本候选只做本地开发和验证。未连接生产、未修改生产站点、未重启服务、未推送，也不覆盖已交付的纯跳转包。
