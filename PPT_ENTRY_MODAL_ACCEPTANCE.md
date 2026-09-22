# PPT 弹窗复用版验收清单

## 本地代码验收

- [ ] `npm run typecheck --workspace @librechat/frontend`
- [ ] PPT 弹窗与固定目标测试通过
- [ ] 完成消息错误 origin、错误 source、null source、无 iframe 均被拒绝
- [ ] 原站登录、登录表单、启动路由和重定向回归通过
- [ ] `npm run build:ppt-entry --workspace @librechat/frontend`
- [ ] 原站完整 Client 生产构建通过，制品随包交付
- [ ] `git diff --check`

## 浏览器验收

1. 打开 `https://ppt.152.32.172.162.sslip.io/`，显示 PPT 素材首页。
2. 点击右上角“登录”，PPT 首页仍在背景，出现弹窗。
3. 弹窗 iframe URL 为原站 `/login?entry=ppt`。
4. 输入错误账号时，错误提示仍来自原站，弹窗不关闭。
5. 输入正常账号密码后，需要 2FA 时，弹窗继续显示原站 2FA 页面。
6. 2FA 成功后，顶层浏览器地址为 `https://152.32.172.162.sslip.io/c/new`。
7. 不启用 2FA 的账号登录成功后，同样进入原站 `/c/new`。
8. 直接打开原站 `/login`，原有登录行为不变。
9. PPT 域名不发起 `/api/auth/login` 请求，不代理 `/api/*`。

## 失败边界

当前线上登录路由只读核对未发现 `X-Frame-Options` 或 CSP 阻止嵌入。若后续配置变化导致阻止，先按交接说明仅调整两个登录路由；不要复制一套登录表单，也不要新增认证后端或 Cookie 共享方案。
