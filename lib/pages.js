/**
 * Server-rendered HTML pages for the auth surface. Fully self-contained
 * (inline CSS + vanilla JS, no external assets) so the gate never has to
 * whitelist static files.
 *
 * Views:
 * - login: a minimal unlock that blends into the light-gray page — a password
 *   input with the arrow icon tucked inside its right edge, plus a subtle
 *   "remember me" checkbox. Enter or the icon unlocks. No card box.
 * - setup: first open with auth enabled and no password yet — keeps the
 *   guidance text (the user must understand they are setting a password).
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

// Light-gray (灰白) theme; the login page blends with no card, the rest use a card.
const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #f2f3f5; color: #1c1e21; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .card {
    width: min(92vw, 360px); background: #ffffff; border: 1px solid #e3e5e9; border-radius: 14px;
    padding: 26px 28px; box-shadow: 0 8px 30px rgba(0,0,0,.06);
  }
  h1 { font-size: 16px; margin: 0 0 4px; color: #1c1e21; }
  p.sub { color: #61656b; font-size: 13px; margin: 0 0 18px; line-height: 1.6; }
  label { display: block; font-size: 13px; color: #494d53; margin: 12px 0 6px; }
  input[type=password], input[type=text] {
    width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #d3d6dc;
    background: #ffffff; color: #1c1e21; font-size: 14px; font-family: inherit; outline: none;
  }
  input:focus { border-color: #3b6ef5; }

  /* login page: exactly one blended input with an inline arrow, no card box */
  .login-wrap { width: min(92vw, 320px); }
  .login-row { position: relative; }
  .login-row input[type=password] {
    width: 100%; height: 48px; padding: 0 48px 0 16px;
    border-radius: 12px; border: 1px solid rgba(0,0,0,.12);
    background: rgba(255,255,255,.55); color: #1c1e21; font-size: 16px; font-family: inherit; outline: none;
    transition: background .15s, border-color .15s, box-shadow .15s;
  }
  .login-row input:focus { background: #ffffff; border-color: rgba(0,0,0,.22); box-shadow: 0 0 0 3px rgba(59,110,245,.12); }
  .login-row .icon {
    position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
    width: 36px; height: 36px; border: 0; border-radius: 10px; background: transparent;
    color: #1c1e21; display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
  }
  .login-row .icon:hover { background: rgba(0,0,0,.05); }
  .login-row .icon:disabled { opacity: .5; cursor: default; }
  .remember { display: flex; align-items: center; gap: 6px; margin-top: 10px; font-size: 13px; color: #61656b; }
  .remember input { accent-color: #3b6ef5; }
  .remember label { margin: 0; cursor: pointer; }

  button.wide {
    width: 100%; margin-top: 18px; padding: 11px 12px; border: 0; border-radius: 8px;
    background: #3b6ef5; color: #fff; font-size: 14px; font-weight: 600; font-family: inherit; cursor: pointer;
  }
  button.wide:hover { background: #335fd6; }
  button.wide:disabled { opacity: .55; cursor: default; }
  .error { margin-top: 14px; color: #cf3f3f; font-size: 13px; line-height: 1.5; min-height: 18px; }
  a { color: #3b6ef5; }
  code { background: #eef0f3; padding: 1px 6px; border-radius: 5px; font-size: 12px; }
`;

/** `plain` renders the login page with no card box, so it blends into the gray page. */
function shell(title, sub, body, script, plain) {
	const wrap = plain ? "login-wrap" : "card";
	const heading = plain || title === "" ? "" : `<h1>${esc(title)}</h1>`;
	const subline = plain ? "" : sub === "" ? "" : `<p class="sub">${sub}</p>`;
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="${wrap}">
${heading}
${subline}
${body}
<div class="error" id="error" role="alert"></div>
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

const ARROW_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>`;

/** Login page: one blended input with an inline arrow — no card box. */
export function loginPageHtml(next) {
	const safeNext = esc(next);
	return shell(
		"",
		"",
		`
		<form id="form">
			<div class="login-row">
				<input type="password" id="password" autocomplete="current-password" placeholder="输入密码解锁" autofocus>
				<button type="submit" class="icon" aria-label="解锁" title="解锁" id="submit">${ARROW_ICON}</button>
			</div>
			<div class="remember">
				<input type="checkbox" id="remember">
				<label for="remember">记住我（延长免认证有效期）</label>
			</div>
		</form>
		`,
		`
		const POST_JSON = ${PAGE_FETCH};
		const renderError = ${PAGE_RENDER_ERROR};
		const next = ${JSON.stringify(safeNext)};
		const form = document.getElementById("form");
		const password = document.getElementById("password");
		const remember = document.getElementById("remember");
		const submit = document.getElementById("submit");
		const error = document.getElementById("error");
		form.addEventListener("submit", async (e) => {
			e.preventDefault();
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
		password.focus();
		`,
		true
	);
}

/** First-open setup page: keeps the guidance text (a password is being set). */
export function setupPageHtml(next) {
	const safeNext = esc(next);
	return shell(
		"初始化密码",
		"这是认证插件（dsh-simple-auth）首次运行：请设置一个用于解锁 dsh 的密码（至少 6 位）。以后可在命令行用 <code>dsh-simple-auth passwd</code> 重置。",
		`
		<label for="password">密码</label>
		<input type="password" id="password" autocomplete="new-password" autofocus>
		<label for="confirm">确认密码</label>
		<input type="password" id="confirm" autocomplete="new-password">
		<button id="submit" type="button" class="wide">设置密码并进入</button>
		`,
		`
		const POST_JSON = ${PAGE_FETCH};
		const renderError = ${PAGE_RENDER_ERROR};
		const next = ${JSON.stringify(safeNext)};
		const password = document.getElementById("password");
		const confirm = document.getElementById("confirm");
		const submit = document.getElementById("submit");
		const error = document.getElementById("error");
		async function doSetup() {
			error.textContent = "";
			if (password.value.length < 6) { error.textContent = "密码至少 6 位"; return; }
			if (password.value !== confirm.value) { error.textContent = "两次输入的密码不一致"; return; }
			submit.disabled = true;
			const setup = await POST_JSON("/auth/setup", { password: password.value });
			if (!setup.ok) { error.textContent = renderError(setup); submit.disabled = false; return; }
			const login = await POST_JSON("/auth/login", { password: password.value });
			if (!login.ok) { error.textContent = renderError(login); submit.disabled = false; return; }
			window.location.href = new URL(next, location.origin).pathname + location.search;
		}
		submit.addEventListener("click", doSetup);
		password.addEventListener("keydown", (e) => { if (e.key === "Enter") doSetup(); });
		confirm.addEventListener("keydown", (e) => { if (e.key === "Enter") doSetup(); });
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
