# 设计说明（Design）

> 实现原理与端点说明。需求记录见 [requirements.md](./requirements.md)，使用见
> [README](../README.md)。

## 门禁

包装 dsh-host-webserver 的 `webServer` 服务：存量路由逐个守卫、注册方法替换为守卫版本
（新路由自动带上）、SPA fallback 与 WebSocket upgrade 一并守卫。`/auth/*` 白名单；其余
请求按「认证已禁用 → 放行；有效会话 cookie / Bearer → 放行；否则拒绝」判定，浏览器
导航 302 到登录页，API/脚本 401。

启动自检：任何未守卫入口都会让插件启动失败（fail loud）。

## 会话

登录创建 32 字节随机 token，落盘只存 sha256 摘要 + 到期时间；cookie `Max-Age` 与有效期
一致；登出即吊销；改密后吊销其它会话（保留当前会话）。

## 锁定

客户端 Ctrl+Shift+L（或左下角「锁定」按钮）触发全屏锁定，解锁调用 `/auth/unlock` 重新
验证密码——即使会话仍在有效期内，主动锁定后也必须重新认证（需求 1 的例外条款）。
锁定状态持久化在浏览器本地（`localStorage`），刷新页面或新开标签页不会自动解锁；
锁定界面通过 portal 渲染到 `<body>` 顶层，保证盖住整个视口（含终端等面板）。

## 状态文件

`$DSH_HOME/auth/state.json`（单文件，0600，原子写入）。CLI 与运行中的插件共用；
插件监听文件变化实时重载，因此 `dsh-simple-auth disable` 无需重启即刻开门。
状态文件损坏/不可读时拒绝一切访问（fail-closed）。

## 端点

| 路径 | 说明 |
| --- | --- |
| `GET /auth/login` | 登录页 / 初始化页（无密码时）/ 禁用提示页 / 状态损坏提示页 |
| `POST /auth/login` | `{ password, remember? }` → 会话 cookie |
| `POST /auth/logout?next=/` | 吊销会话并清除 cookie，302 到 next |
| `GET /auth/status` | `{ enabled, needsSetup, authenticated, sessionExpiresAt, locked, failures, maxAttempts, ... }` |
| `POST /auth/setup` | `{ password }` 首次初始化（自动登录） |
| `POST /auth/change-password` | `{ oldPassword, newPassword }`（需会话） |
| `POST /auth/disable` | `{ password }` 禁用认证（需会话） |
| `POST /auth/unlock` | `{ password }` 锁定遮罩解锁 |

## 代码结构

纯 JavaScript ESM，无需构建步骤；client bundle 手写
`window.__ModuleLoader__.load({ id, factory })` 格式（与官方包的编译产物同构）。

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | host 插件：gate 包装 webserver、状态监听、启动自检 |
| `lib/gate.js` | 守卫包装（HTTP / WS / fallback / 增量注册）+ 启动自检 |
| `lib/endpoints.js` | `/auth/*` 端点 |
| `lib/pages.js` | 登录页 / 初始化页 / 禁用提示页 / 损坏提示页 |
| `lib/crypto.js` | scrypt 哈希与恒时校验 |
| `lib/state.js` | 状态文件（0600、原子写、权限校验、fail-closed） |
| `lib/sessions.js` | 会话存储（token 只存 sha256 摘要） |
| `lib/lockout.js` | 错误锁定（持久化，重启不重置） |
| `lib/cli.js` | CLI（init / passwd / enable / disable / unlock / status） |
| `lib/client.js` | client bundle（锁定遮罩、设置界面、快捷键） |
