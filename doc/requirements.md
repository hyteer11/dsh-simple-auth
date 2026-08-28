# 需求记录（Requirements）

> 本文档记录插件最初要满足的需求及其实现方式，作为历史参考。使用说明见
> [README](../README.md)，实现原理见 [design.md](./design.md)。

## 需求清单

| # | 需求 | 实现 |
| --- | --- | --- |
| 1 | 可配置认证后的免认证有效期；除非手动退出，有效期内无需再认证；主动锁定除外 | `sessionTtl`（默认 7 天）；登录页勾选「记住我」用更长的 `rememberTtl`（默认 30 天）。有效期内无需再认证；**手动退出**（设置 → 退出登录）立即失效；**主动锁定**（Ctrl+Shift+L）后必须重新输密码 |
| 2 | Ctrl+L 快捷锁定界面 | 客户端快捷键 Ctrl/Cmd+Shift+L（特意避开浏览器保留的 Ctrl+L）全屏锁定，解锁需验证密码；左下角侧边栏底部「锁定」按钮与「设置」同一水平，一键锁定 |
| 3 | 两种初始化密码方式：命令行初始化，或安装后首次打开 dsh 时设置 | ① 命令行 `dsh-simple-auth init`；② 安装后首次打开：未设置密码时访问会被带到初始化页，设置后自动登录 |
| 4 | 命令行重置密码 | `dsh-simple-auth passwd`（机器管理员权限，无需原密码） |
| 5 | 命令行禁用/启用认证；禁用后效果等同未安装插件 | `dsh-simple-auth disable` / `dsh-simple-auth enable`。禁用后门禁完全放行；也是错误锁定后的应急出口 |
| 6 | 多次密码错误后一定时间内无法登录；除非禁用插件 | 连续 `maxAttempts`（默认 5）次失败后，登录/解锁/改密/禁用接口在 `lockoutSeconds`（默认 300s）内全部返回 429；锁定状态落盘，重启 dsh 不重置倒计时（应急出口：`dsh-simple-auth disable` 或 `unlock`） |
| 7 | 界面修改密码 / 禁用认证，需提供原密码 | 设置 → **安全与认证**：修改密码（原密码 + 新密码）、禁用认证（当前密码），均要求原密码；改密成功后其它会话自动退出 |

## 其它安全特性

- 密码只存 **scrypt** 哈希（`scrypt$N$r$p$salt$key`，成本 N=65536）；
- 会话 token 32 字节随机，落盘只存 sha256 摘要；cookie 带 `HttpOnly; SameSite=Lax`（`Secure` 可配置）；
- 门禁包装 webserver 的全部路由（HTTP + WebSocket upgrade + SPA fallback + 未来注册），
  启动自检：任何未守卫入口都会让插件启动失败（fail loud）；
- 状态文件损坏/不可读时**拒绝一切访问**（fail-closed），登录页提示 CLI 修复方式；
- 状态文件写入原子化（同目录 tmp + rename）且权限 0600，读取时校验权限位；
- 支持脚本访问：`Authorization: Bearer <会话token>` 与浏览器 cookie 等价；
- CLI 修改（enable/disable/init/passwd/unlock）通过文件监听**实时生效**，无需重启 dsh。
