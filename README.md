# dsh-simple-auth — dsh 单密码认证插件

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）网页版加一道
**单密码登录门**：不登录就碰不到你的 agent、会话与 LLM 凭证；登录一次后，在可配置的
**免认证有效期**内无需再次认证（手动退出 / 主动锁定除外）。

## 功能

| # | 需求 | 实现 |
| --- | --- | --- |
| 1 | 可配置免认证有效期 | `sessionTtl`（默认 7 天）；登录页勾选「记住我」用更长的 `rememberTtl`（默认 30 天）。有效期内无需再认证；**手动退出**（设置 → 退出登录）立即失效；**主动锁定**（Ctrl+Shift+L）后必须重新输入密码 |
| 2 | Ctrl+Shift+L 快捷锁定界面 | 客户端快捷键 Ctrl/Cmd+Shift+L（避开浏览器保留的 Ctrl+L）全屏锁定，解锁需验证密码；左下角侧边栏底部「锁定」按钮与「设置」同一水平，一键锁定 |
| 3 | 两种初始化密码方式 | ① 命令行 `dsh-simple-auth init`；② 安装后首次打开 dsh：未设置密码时访问会被带到初始化页面，设置后自动登录 |
| 4 | 命令行重置密码 | `dsh-simple-auth passwd`（机器管理员权限，无需原密码） |
| 5 | 命令行禁用/启用认证 | `dsh-simple-auth disable` / `dsh-simple-auth enable`。禁用后门禁完全放行，效果等同未安装插件；**这也是错误锁定后的应急出口** |
| 6 | 多次密码错误临时锁定 | 连续 `maxAttempts`（默认 5）次失败后，登录/解锁/改密/禁用接口在 `lockoutSeconds`（默认 300s）内全部返回 429；锁定状态落盘，**重启 dsh 不会重置倒计时**（应急出口：`dsh-simple-auth disable` 或 `dsh-simple-auth unlock`） |
| 7 | 界面修改密码 / 禁用认证需原密码 | 设置 → **安全与认证**：修改密码（原密码 + 新密码）、禁用认证（当前密码），均要求原密码；改密成功后其它会话自动退出 |

其它安全特性：

- 密码只存 **scrypt** 哈希（`scrypt$N$r$p$salt$key`，成本 N=65536，与 dsh-auth-gate 同族）；
- 会话 token 32 字节随机，落盘只存 sha256 摘要；cookie 带 `HttpOnly; SameSite=Lax`（`Secure` 可配置）；
- 门禁包装 webserver 的全部路由（HTTP + WebSocket upgrade + SPA fallback + 未来注册），
  启动自检：任何未守卫入口都会让插件启动失败（fail loud）；
- 状态文件损坏/不可读时**拒绝一切访问**（fail-closed），登录页提示 CLI 修复方式；
- 状态文件写入原子化（同目录 tmp + rename）且权限 0600，读取时校验权限位；
- 支持脚本访问：`Authorization: Bearer <会话token>` 与浏览器 cookie 等价；
- CLI 修改（enable/disable/init/passwd/unlock）通过文件监听**实时生效**，无需重启 dsh。

## 快速开始

```sh
# 1. 安装到你的 dsh profile（以 web 为例）。
#    包声明了 dsh.bundle，`dsh plugin add` 会自动注册挂载行，无需手写 patch：
dsh plugin --profile web add /path/to/dsh-simple-auth          # 或 link:/path/to/dsh-simple-auth 便于开发迭代

# 2. （可选）初始化密码。不做这步也可以：重启 dsh 后首次打开会看到初始化页面。
printf '%s\n' '选一个强密码' | dsh-simple-auth init --password-stdin

# 3. 纯 http 部署时关闭 Secure cookie 标志（https 部署保持默认 true）：
#    在 $DSH_HOME/cordis.patch.yml（或 profile 的 cordis.patch.yml）追加：
#
#     - id: dsh-simple-auth
#       config:
#         cookieSecure: false
#
#    注意：覆盖条目不要带 `insert`，否则会二次挂载插件。

# 4. 重启 dsh，打开你的站点——会先要求登录（或首次初始化密码）。
```

> 插件装进 profile 的 node_modules 后，`dsh-simple-auth` 二进制不会进入你的 PATH；
> 请经由 profile 调用：
> `pnpm --dir "$DSH_HOME/profiles/web" exec dsh-simple-auth <命令>`，
> 或加一次别名 `alias dsh-simple-auth='pnpm --dir "$DSH_HOME/profiles/web" exec dsh-simple-auth'`。

## 配置

bundle 挂载行（id `dsh-simple-auth`，由 `dsh plugin add` 自动插入）使用默认配置。按 id 覆盖
`config`（放在 `$DSH_HOME/cordis.patch.yml` 或 profile 的 `cordis.patch.yml`）：

```yaml
- id: dsh-simple-auth
  config:
    sessionTtl: 604800        # 免认证有效期（秒），到期需重新登录
    rememberTtl: 2592000      # 勾选「记住我」后的有效期（秒）
    cookieName: "dsh-simple-auth"      # 会话 cookie 名
    cookieSecure: true        # https 保持 true；纯 http 设为 false
    maxAttempts: 5            # 连续错误多少次触发锁定
    lockoutSeconds: 300       # 锁定持续时间（秒）
    minPasswordLength: 6      # 密码最小长度
    stateFile: ""             # 状态文件路径；默认 $DSH_HOME/auth/state.json
```

## CLI

```sh
dsh-simple-auth init [--force] [--password-stdin]   初始化密码（首次；--force 覆盖）
dsh-simple-auth passwd [--password-stdin]           重置密码（无需原密码）
dsh-simple-auth enable                              启用认证
dsh-simple-auth disable                             禁用认证（等同未装插件，访问不再受限）
dsh-simple-auth unlock                              清除错误锁定
dsh-simple-auth status                              查看状态（enabled/password/sessions/lockout）
```

密码从 stdin 读取：`printf '%s\n' '密码' | dsh-simple-auth init`，交互终端会提示输入。

## 界面操作

设置 → **安全与认证**（settings 面板新增一节）：

- 状态：认证开关、会话到期时间、当前错误计数/锁定倒计时；
- 操作：**锁定界面（Ctrl+Shift+L）**、**退出登录**；主界面左下角侧边栏底部右侧有「锁定」按钮，一键锁定；
- **锁定界面外观**：背景可设为 **纯色**（默认灰白，按所选颜色亮度自动切换文字深浅）或 **背景图**；无蒙层/模糊弹窗，输入框自然融入背景。偏好保存在浏览器本地；
- **修改密码**：原密码 + 新密码 ×2；
- **禁用认证**：需当前密码，禁用后页面刷新、访问不受限。

锁定界面为全屏简约布局：一个密码输入框 + 输入框内右侧的小箭头图标按钮，**直接回车或点图标即可解锁**。

## 原理

- **门禁**：包装 dsh-host-webserver 的 `webServer` 服务——存量路由逐个守卫、注册方法
  替换为守卫版本（新路由自动带上）、SPA fallback 与 WebSocket upgrade 一并守卫。
  `/auth/*` 白名单；其余请求按「认证已禁用 → 放行；有效会话 cookie / Bearer → 放行；
  否则拒绝」判定，浏览器导航 302 到登录页，API/脚本 401。
- **会话**：登录创建 32 字节随机 token，落盘只存 sha256 摘要 + 到期时间；cookie
  `Max-Age` 与有效期一致；登出即吊销。
- **锁定**：客户端 Ctrl+Shift+L（或左下角「锁定」按钮）触发全屏锁定，解锁调用 `/auth/unlock` 重新验证密码
  ——即使会话仍在有效期内，主动锁定后也必须重新认证（需求 1 的例外条款）。锁定状态持久化在
  浏览器本地（`localStorage`），**刷新页面或新开标签页不会自动解锁**，必须输入密码解锁；
  锁定界面通过 portal 渲染到 `<body>` 顶层，保证盖住整个视口（含终端等面板）。
- **状态文件**：`$DSH_HOME/auth/state.json`（单文件，0600，原子写入）。CLI 与运行中的
  插件共用；插件监听文件变化实时重载，因此 `dsh-simple-auth disable` 无需重启即刻开门。

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

## 故障排查

- **dsh 起不来 / 登录页提示「认证状态异常」**：状态文件损坏。`dsh-simple-auth status` 查看，
  `dsh-simple-auth init --force` 重新初始化。
- **忘了密码又被锁定**：`dsh-simple-auth unlock` 解除锁定，或 `dsh-simple-auth disable` 直接关掉认证
  （此后可 `dsh-simple-auth init --force` 重设密码再 `dsh-simple-auth enable`）。
- **快捷键不生效**：请使用 **Ctrl+Shift+L**（特意避开浏览器保留的 Ctrl+L）；也可用左下角侧边栏
  的「锁定」按钮或设置面板里的「锁定界面」按钮。
- **想彻底移除**：`dsh plugin --profile web remove dsh-simple-auth`，并删除
  `$DSH_HOME/auth/state.json`。

## 开发

```sh
node test/run.js   # 单元 + 集成测试（真实 HTTP 服务器 + 真实 scrypt）
```

代码为纯 JavaScript ESM，无需构建步骤；client bundle 手写
`window.__ModuleLoader__.load({ id, factory })` 格式（与官方包的编译产物同构）。
