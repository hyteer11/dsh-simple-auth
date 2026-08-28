# dsh-simple-auth — dsh 单密码认证插件

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）网页版加一道
**单密码登录门**：不登录就碰不到你的 agent、会话与 LLM 凭证；登录一次后，在可配置的
**免认证有效期**内无需再次认证（手动退出 / 主动锁定除外）。

> 📦 已发布到 npm：`npm i dsh-simple-auth`（然后 `dsh plugin --profile web add dsh-simple-auth`）。

## 核心特点

- **单密码登录门**：所有页面/API/WebSocket 都先检查，未登录跳转登录页；密码只存 scrypt 哈希。
- **可配置免认证有效期**：`sessionTtl`（默认 7 天）；勾选「记住我」用更长的 `rememberTtl`（默认 30 天）。
  手动退出立即失效；主动锁定后必须重新输密码。
- **一键锁定**：Ctrl+Shift+L（或左下角「锁定」按钮）全屏锁定；解锁需重新验证密码；刷新/新标签页不会自动解锁。
- **可定制锁定背景**：纯色（默认灰白，自动适配文字对比度）或背景图，输入框自然融入背景。
- **命令行密码管理**：初始化/重置/禁用/启用/解除锁定，实时生效无需重启。
- **错误锁定**：连续输错触发临时锁定，状态落盘，重启不重置。
- **界面改密/禁用**：均要求原密码，改密后其它会话自动退出。

> 需求记录见 [doc/requirements.md](doc/requirements.md)，实现原理见 [doc/design.md](doc/design.md)。

## 安装（从易到难）

### 方式一：从 npm（推荐）

```sh
dsh plugin --profile web add dsh-simple-auth
```

包声明了 `dsh.bundle`，`dsh plugin add` 会自动注册挂载行，无需手写 patch。

### 方式二：本地目录（开发迭代）

```sh
dsh plugin --profile web add link:/path/to/dsh-simple-auth   # 改动即时生效，适合改代码
```

### 方式三：从 Git 源码

```sh
git clone https://github.com/hyteer11/dsh-simple-auth && cd dsh-simple-auth
dsh plugin --profile web add link:$PWD
```

## 快速开始

```sh
# 1. 安装（见上，任选一种）
# 2. （可选）初始化密码；不做这步，重启后首次打开会看到初始化页面：
printf '%s\n' '选一个强密码' | dsh-simple-auth init --password-stdin
# 3. 纯 http 部署关闭 Secure cookie（https 保持默认 true）：
#    在 $DSH_HOME/cordis.patch.yml 或 profile 的 cordis.patch.yml 追加：
#     - id: dsh-simple-auth
#       config:
#         cookieSecure: false
#     注意：覆盖条目不要带 `insert`，否则会二次挂载插件。
# 4. 重启 dsh，打开站点——先要求登录（或首次初始化密码）。
```

> 插件装进 profile 的 node_modules 后，`dsh-simple-auth` 二进制不在 PATH：
> `pnpm --dir "$DSH_HOME/profiles/web" exec dsh-simple-auth <命令>`，
> 或加别名 `alias dsh-simple-auth='pnpm --dir "$DSH_HOME/profiles/web" exec dsh-simple-auth'`。

## 配置

按 id 覆盖 `config`（放在 `$DSH_HOME/cordis.patch.yml` 或 profile 的 `cordis.patch.yml`）：

```yaml
- id: dsh-simple-auth
  config:
    sessionTtl: 604800        # 免认证有效期（秒）
    rememberTtl: 2592000      # 「记住我」有效期（秒）
    cookieName: "dsh-simple-auth"
    cookieSecure: true        # 纯 http 设为 false
    maxAttempts: 5            # 连续错误触发锁定
    lockoutSeconds: 300       # 锁定时长（秒）
    minPasswordLength: 6
    stateFile: ""             # 状态文件；默认 $DSH_HOME/auth/state.json
```

## CLI

```sh
dsh-simple-auth init [--force] [--password-stdin]   初始化密码（首次；--force 覆盖）
dsh-simple-auth passwd [--password-stdin]           重置密码（无需原密码）
dsh-simple-auth enable / disable                    启用 / 禁用认证
dsh-simple-auth unlock                              清除错误锁定
dsh-simple-auth status                              查看状态
```

密码从 stdin 读取：`printf '%s\n' '密码' | dsh-simple-auth init`。

## 界面

设置 → **安全与认证**：

- 状态：认证开关、会话到期、错误计数/锁定倒计时；
- 操作：**锁定界面（Ctrl+Shift+L）**、**退出登录**；左下角侧边栏「锁定」按钮一键锁定；
- **锁定界面外观**：纯色（默认灰白）或背景图；
- **修改密码 / 禁用认证**：默认只显示按钮，点击展开表单，可取消。

## 故障排查

- **状态异常/起不来**：`dsh-simple-auth status` 查看；`dsh-simple-auth init --force` 修复。
- **忘了密码又锁定**：`dsh-simple-auth unlock`，或 `dsh-simple-auth disable` 关认证。
- **快捷键不生效**：用 Ctrl+Shift+L（避开浏览器保留的 Ctrl+L），或用「锁定」按钮。
- **彻底移除**：`dsh plugin --profile web remove dsh-simple-auth`，删除 `$DSH_HOME/auth/state.json`。

## 开发

```sh
node test/run.js   # 单元 + 集成测试
```
