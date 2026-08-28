/**
 * Server-rendered HTML pages for the auth surface. Fully self-contained
 * (inline CSS + vanilla JS, no external assets) so the gate never has to
 * whitelist static files.
 *
 * Views:
 * - setup: first open with auth enabled and no password yet — set the password.
 * - login: enter the password; optional "remember me" extends the validity.
 * - disabled: auth is off via the CLI — informational page.
 * - corrupt: the state file is unreadable/invalid — fail-closed recovery info.
 */

function esc(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

const STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0b0d10; color: #e8eaed; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .card {
    width: min(92vw, 380px); background: #14161a; border: 1px solid #26292f; border-radius: 14px;
    padding: 28px; box-shadow: 0 12px 40px rgba(0,0,0,.45);
  }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.sub { color: #9aa0a8; font-size: 13px; margin: 0 0 18px; line-height: 1.5; }
  label { display: block; font-size: 13px; color: #b8bdc5; margin: 12px 0 6px; }
  input[type=password], input[type=text] {
    width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #2c3037;
    background: #0e1013; color: #e8eaed; font-size: 14px; font-family: inherit; outline: none;
  }
  input:focus { border-color: #4d7cfe; }
  .row { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
  .row input[type=checkbox] { accent-color: #4d7cfe; }
  .row label { margin: 0; font-size: 13px; cursor: pointer; }
  button {
    width: 100%; margin-top: 18px; padding: 11px 12px; border: 0; border-radius: 8px;
    background: #4d7cfe; color: #fff; font-size: 14px; font-weight: 600; font-family: inherit; cursor: pointer;
  }
  button:disabled { opacity: .55; cursor: default; }
  .error { margin-top: 14px; color: #ff8b8b; font-size: 13px; line-height: 1.5; min-height: 18px; }
  .ok { margin-top: 14px; color: #8bd48b; font-size: 13px; min-height: 18px; }
  a { color: #4d7cfe; }
  code { background: #1b1e24; padding: 1px 6px; border-radius: 5px; font-size: 12px; }
`;

function shell(title, sub, body, script) {
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="card">
<h1>${esc(title)}</h1>
<p class="sub">${sub}</p>
${body}
<div class="error" id="error" role="alert"></div>
<div class="ok" id="ok" hidden></div>
</div>
<script>${script}</script>
</body>
</html>`;
}

/** Page-side fetch helper source (interpolated into each page's script). */
const PAGE_FETCH = `(path, data) => fetch(path, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(data)
}).then(async (res) => {
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
})`;

/** Page-side error renderer source. */
const PAGE_RENDER_ERROR = `(err) => {
  const text = err?.body?.error ?? (err?.status ? "request failed (" + err.status + ")" : "network error");
  return err?.body?.retryAfterSeconds ? text + " — 请 " + err.body.retryAfterSeconds + " 秒后重试" : text;
}`;

/** First-open setup page: no password is configured yet. */
export function setupPageHtml(next) {
	const safeNext = esc(next);
	return shell(
		"初始化密码",
		"这是认证插件（dsh-simple-auth）首次运行：请设置一个用于解锁 dsh 的密码（至少 6 位）。以后可以在命令行用 <code>dsh-simple-auth passwd</code> 重置。",
		`
		<label for="password">密码</label>
		<input type="password" id="password" autocomplete="new-password" autofocus>
		<label for="confirm">确认密码</label>
		<input type="password" id="confirm" autocomplete="new-password">
		<button id="submit" type="button">设置密码并进入</button>
		`,
		`
		const POST_JSON = ${PAGE_FETCH};
		const renderError = ${PAGE_RENDER_ERROR};
		const next = ${JSON.stringify(safeNext)};
		const password = document.getElementById("password");
		const confirm = document.getElementById("confirm");
		const submit = document.getElementById("submit");
		const error = document.getElementById("error");
		submit.addEventListener("click", async () => {
			error.textContent = "";
			if (password.value.length < 6) { error.textContent = "密码至少 6 位"; return; }
			if (password.value !== confirm.value) { error.textContent = "两次输入的密码不一致"; return; }
			submit.disabled = true;
			const setup = await POST_JSON("/auth/setup", { password: password.value });
			if (!setup.ok) { error.textContent = renderError(setup); submit.disabled = false; return; }
			const login = await POST_JSON("/auth/login", { password: password.value });
			if (!login.ok) { error.textContent = renderError(login); submit.disabled = false; return; }
			window.location.href = new URL(next, location.origin).pathname + location.search;
		});
		password.addEventListener("keydown", (e) => { if (e.key === "Enter") submit.click(); });
		confirm.addEventListener("keydown", (e) => { if (e.key === "Enter") submit.click(); });
		password.focus();
		`
	);
}

/** Login page. */
export function loginPageHtml(next) {
	const safeNext = esc(next);
	return shell(
		"dsh 已锁定",
		"请输入密码以继续使用 dsh。连续输错会被临时锁定，届时请在命令行用 <code>dsh-simple-auth unlock</code> 或 <code>dsh-simple-auth disable</code> 处理。",
		`
		<label for="password">密码</label>
		<input type="password" id="password" autocomplete="current-password" autofocus>
		<div class="row">
			<input type="checkbox" id="remember">
			<label for="remember">记住我（延长免认证有效期）</label>
		</div>
		<button id="submit" type="button">解锁</button>
		`,
		`
		const POST_JSON = ${PAGE_FETCH};
		const renderError = ${PAGE_RENDER_ERROR};
		const next = ${JSON.stringify(safeNext)};
		const password = document.getElementById("password");
		const remember = document.getElementById("remember");
		const submit = document.getElementById("submit");
		const error = document.getElementById("error");
		submit.addEventListener("click", async () => {
			error.textContent = "";
			if (password.value === "") { error.textContent = "请输入密码"; return; }
			submit.disabled = true;
			const login = await POST_JSON("/auth/login", { password: password.value, remember: remember.checked });
			if (!login.ok) {
				error.textContent = renderError(login);
				password.select();
				submit.disabled = false;
				return;
			}
			window.location.href = new URL(next, location.origin).pathname + location.search;
		});
		password.addEventListener("keydown", (e) => { if (e.key === "Enter") submit.click(); });
		password.focus();
		`
	);
}

/** Auth is disabled (CLI `dsh-simple-auth disable`) — informational page. */
export function disabledPageHtml() {
	return shell(
		"认证已禁用",
		"认证插件（dsh-simple-auth）当前处于禁用状态，访问不受限。可在命令行用 <code>dsh-simple-auth enable</code> 重新启用。",
		`<a href="/" style="font-size:14px">进入 dsh →</a>`,
		""
	);
}

/** The state file is corrupt — fail-closed; recovery is via the CLI. */
export function corruptPageHtml() {
	return shell(
		"认证状态异常",
		"认证状态文件无法读取或已损坏，为安全起见 dsh 已被拒绝访问。请在命令行修复：",
		`
		<p class="sub" style="margin-top:0"><code>dsh-simple-auth status</code> 查看问题<br><code>dsh-simple-auth init --force</code> 重新初始化密码</p>
		`,
		""
	);
}
