import { parseCookieHeader } from "./sessions.js";
import { AUTH_PATH_PREFIX } from "./gate.js";
import { corruptPageHtml, disabledPageHtml, loginPageHtml, setupPageHtml } from "./pages.js";

/**
 * /auth endpoints for the dsh-simple-auth gate. Registered through the wrapped
 * webserver register, so the routes themselves pass the gate (the /auth prefix
 * is whitelisted) but every other request stays guarded.
 *
 * Routes:
 *   GET  /auth/login             login page, or the setup page on first run
 *   POST /auth/login             { password, remember? } → session cookie
 *   POST /auth/logout            revoke the session cookie, redirect to `next`
 *   GET  /auth/status            { enabled, needsSetup, authenticated, ... }
 *   POST /auth/setup             { password } first-run password init (auto-login)
 *   POST /auth/change-password   { oldPassword, newPassword } (requires session)
 *   POST /auth/disable           { password } disable auth (requires session)
 *   POST /auth/unlock            { password } unlock after an active lock
 *
 * Every password verification shares the brute-force lockout; while locked all
 * of them answer 429 with `retryAfterSeconds`.
 */

const BODY_LIMIT = 64 * 1024;

class BodyError extends Error {}

/** Read a JSON or form-urlencoded request body into a plain object. */
async function readBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > BODY_LIMIT) throw new BodyError("body too large");
		chunks.push(chunk);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text === "") return {};
	const type = String(req.headers["content-type"] ?? "");
	if (type.includes("application/json")) {
		try {
			return JSON.parse(text);
		} catch {
			throw new BodyError("invalid json body");
		}
	}
	const out = {};
	for (const [key, value] of new URLSearchParams(text)) out[key] = value;
	return out;
}

/** Validate a redirect target: only same-origin absolute paths. */
export function validateNext(value) {
	if (typeof value !== "string" || value === "") return "/";
	if (!value.startsWith("/")) return "/";
	if (value.startsWith("//") || value.startsWith("/\\")) return "/";
	return value;
}

function json(res, status, body) {
	res.setHeader("cache-control", "no-store");
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

function html(res, status, text) {
	res.setHeader("cache-control", "no-store");
	res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
	res.end(text);
}

function methodNotAllowed(res, allow) {
	res.setHeader("cache-control", "no-store");
	res.writeHead(405, { allow, "content-type": "text/plain" });
	res.end("method not allowed");
}

/** Register all /auth routes on a (wrapped) webserver; returns the combined disposer. */
export function registerAuthEndpoints(server, deps) {
	const disposers = [];
	const track = (route) => disposers.push(server.register(route));

	track({ kind: "prefix", path: AUTH_PATH_PREFIX, handler: catchAll });
	track({ kind: "exact", path: "/auth/login", handler: (req, res) => handleLogin(deps, req, res) });
	track({ kind: "exact", path: "/auth/logout", handler: (req, res) => handleLogout(deps, req, res) });
	track({ kind: "exact", path: "/auth/status", handler: (req, res) => handleStatus(deps, req, res) });
	track({ kind: "exact", path: "/auth/setup", handler: (req, res) => handleSetup(deps, req, res) });
	track({ kind: "exact", path: "/auth/change-password", handler: (req, res) => handleChangePassword(deps, req, res) });
	track({ kind: "exact", path: "/auth/disable", handler: (req, res) => handleDisable(deps, req, res) });
	track({ kind: "exact", path: "/auth/unlock", handler: (req, res) => handleUnlock(deps, req, res) });

	return () => {
		for (const disposer of [...disposers].reverse()) disposer();
	};
}

/** Unregistered /auth/* paths answer 404 instead of falling through to the SPA. */
function catchAll(_req, res) {
	res.setHeader("cache-control", "no-store");
	res.writeHead(404, { "content-type": "text/plain" });
	res.end("not found");
}

function queryOf(req) {
	return new URL(req.url ?? "/", "http://x").searchParams;
}

/** Session token from the cookie or a Bearer authorization header. */
function sessionTokenOf(req, cookieName) {
	const cookie = parseCookieHeader(req.headers.cookie, cookieName);
	if (cookie !== undefined) return cookie;
	const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ""));
	if (match !== null && match[1] !== undefined) return match[1];
	return undefined;
}

/** Current auth state snapshot + lockout view (shared by status and the gate). */
function stateView(deps) {
	const state = deps.state();
	const lockout = state.lockout;
	const locked = deps.lockout.isLocked(lockout);
	return {
		state,
		lockout,
		locked,
		retryAfterSeconds: locked ? deps.lockout.remainingMs(lockout) / 1000 : undefined,
	};
}

/**
 * Verify a password against the current hash, applying lockout bookkeeping.
 * The failing attempt itself answers 401 even when it trips the lockout; the
 * per-endpoint locked pre-check refuses every subsequent attempt with 429.
 */
async function verifyWithLockout(deps, view, password) {
	const state = view.state;
	if (state.passwordHash === null) return { ok: false, code: "setup-required", status: 409 };
	const good = await deps.verify(password, state.passwordHash);
	if (!good) {
		deps.lockout.recordFailure(view.lockout);
		await deps.persist();
		return { ok: false, code: "invalid-password", status: 401 };
	}
	deps.lockout.recordSuccess(view.lockout);
	await deps.persist();
	return { ok: true };
}

function sessionOf(deps, req) {
	const token = sessionTokenOf(req, deps.config.cookieName);
	if (token === undefined) return undefined;
	const store = deps.sessions();
	if (store === undefined) return undefined;
	const row = store.getByToken(token);
	return row === undefined ? undefined : { token, row };
}

async function handleLogin(deps, req, res) {
	const view = stateView(deps);
	const state = view.state;

	if (req.method === "GET") {
		const next = validateNext(queryOf(req).get("next") ?? "/");
		if (deps.stateError() !== null) return html(res, 200, corruptPageHtml());
		if (state.enabled !== true) return html(res, 200, disabledPageHtml());
		if (state.passwordHash === null) return html(res, 200, setupPageHtml(next));
		return html(res, 200, loginPageHtml(next));
	}
	if (req.method !== "POST") return methodNotAllowed(res, "GET, POST");

	let body;
	try {
		body = await readBody(req);
	} catch (error) {
		return json(res, 400, { error: error instanceof BodyError ? error.message : "bad request" });
	}
	if (deps.stateError() !== null) return json(res, 503, { error: "auth state unavailable" });
	if (state.enabled !== true) return json(res, 403, { error: "auth disabled" });
	if (view.locked) return json(res, 429, { error: "locked", retryAfterSeconds: Math.ceil(view.retryAfterSeconds) });

	const password = typeof body.password === "string" ? body.password : "";
	if (state.passwordHash === null) return json(res, 409, { error: "setup required" });

	const result = await verifyWithLockout(deps, view, password);
	if (!result.ok) return json(res, result.status, { error: result.code === "invalid-password" ? "密码错误" : result.code, retryAfterSeconds: result.retryAfterSeconds });

	const remember = body.remember === true || body.remember === "true" || body.remember === "on" || body.remember === 1 || body.remember === "1";
	const ttlSeconds = remember ? deps.config.rememberTtl : deps.config.sessionTtl;
	const { token } = deps.sessions().create(ttlSeconds * 1000);
	await deps.persist();
	res.setHeader("cache-control", "no-store");
	res.setHeader("set-cookie", buildSetCookieHeader(deps.config.cookieName, token, ttlSeconds, deps.config.cookieSecure));
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify({ ok: true }));
	deps.log.info("login");
}

async function handleLogout(deps, req, res) {
	if (req.method !== "POST") return methodNotAllowed(res, "POST");
	const next = validateNext(queryOf(req).get("next") ?? "/");
	const token = parseCookieHeader(req.headers.cookie, deps.config.cookieName);
	if (token !== undefined) {
		deps.sessions().revokeByToken(token);
		await deps.persist();
	}
	res.setHeader("cache-control", "no-store");
	res.setHeader("set-cookie", buildSetCookieHeader(deps.config.cookieName, "", 0, deps.config.cookieSecure));
	res.writeHead(302, { location: next });
	res.end();
	deps.log.info("logout");
}

async function handleStatus(deps, req, res) {
	if (req.method !== "GET") return methodNotAllowed(res, "GET");
	const view = stateView(deps);
	const state = view.state;
	const session = sessionOf(deps, req);
	json(res, 200, {
		enabled: state.enabled === true,
		needsSetup: state.enabled === true && state.passwordHash === null,
		authenticated: session !== undefined,
		sessionExpiresAt: session?.row.expiresAt ?? null,
		locked: view.locked,
		retryAfterSeconds: view.locked ? Math.ceil(view.retryAfterSeconds) : null,
		failures: view.lockout.failures,
		maxAttempts: deps.config.maxAttempts,
		sessionTtl: deps.config.sessionTtl,
		rememberTtl: deps.config.rememberTtl,
	});
}

async function handleSetup(deps, req, res) {
	if (req.method !== "POST") return methodNotAllowed(res, "POST");
	const view = stateView(deps);
	const state = view.state;
	let body;
	try {
		body = await readBody(req);
	} catch (error) {
		return json(res, 400, { error: error instanceof BodyError ? error.message : "bad request" });
	}
	if (deps.stateError() !== null) return json(res, 503, { error: "auth state unavailable" });
	if (state.enabled !== true) return json(res, 403, { error: "auth disabled" });
	if (state.passwordHash !== null) return json(res, 409, { error: "already initialized" });

	const password = typeof body.password === "string" ? body.password : "";
	if (password.length < deps.config.minPasswordLength) {
		return json(res, 400, { error: `密码至少 ${deps.config.minPasswordLength} 位` });
	}
	state.passwordHash = await deps.hash(password);
	await deps.persist();

	// Auto-login: the setup page redirects straight into the app.
	const ttlSeconds = deps.config.sessionTtl;
	const { token } = deps.sessions().create(ttlSeconds * 1000);
	await deps.persist();
	res.setHeader("cache-control", "no-store");
	res.setHeader("set-cookie", buildSetCookieHeader(deps.config.cookieName, token, ttlSeconds, deps.config.cookieSecure));
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify({ ok: true }));
	deps.log.info("password initialized");
}

async function handleChangePassword(deps, req, res) {
	if (req.method !== "POST") return methodNotAllowed(res, "POST");
	const view = stateView(deps);
	const state = view.state;
	let body;
	try {
		body = await readBody(req);
	} catch (error) {
		return json(res, 400, { error: error instanceof BodyError ? error.message : "bad request" });
	}
	if (deps.stateError() !== null) return json(res, 503, { error: "auth state unavailable" });
	if (state.enabled !== true) return json(res, 403, { error: "auth disabled" });
	if (view.locked) return json(res, 429, { error: "locked", retryAfterSeconds: Math.ceil(view.retryAfterSeconds) });
	const session = sessionOf(deps, req);
	if (session === undefined) return json(res, 401, { error: "not authenticated" });

	const oldPassword = typeof body.oldPassword === "string" ? body.oldPassword : "";
	const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
	const result = await verifyWithLockout(deps, view, oldPassword);
	if (!result.ok) return json(res, result.status, { error: result.code === "invalid-password" ? "原密码错误" : result.code, retryAfterSeconds: result.retryAfterSeconds });
	if (newPassword.length < deps.config.minPasswordLength) {
		return json(res, 400, { error: `新密码至少 ${deps.config.minPasswordLength} 位` });
	}
	state.passwordHash = await deps.hash(newPassword);
	deps.sessions().revokeAllExcept(session.token);
	await deps.persist();
	json(res, 200, { ok: true });
	deps.log.info("password changed");
}

async function handleDisable(deps, req, res) {
	if (req.method !== "POST") return methodNotAllowed(res, "POST");
	const view = stateView(deps);
	const state = view.state;
	let body;
	try {
		body = await readBody(req);
	} catch (error) {
		return json(res, 400, { error: error instanceof BodyError ? error.message : "bad request" });
	}
	if (deps.stateError() !== null) return json(res, 503, { error: "auth state unavailable" });
	if (state.enabled !== true) return json(res, 403, { error: "auth already disabled" });
	if (view.locked) return json(res, 429, { error: "locked", retryAfterSeconds: Math.ceil(view.retryAfterSeconds) });
	const session = sessionOf(deps, req);
	if (session === undefined) return json(res, 401, { error: "not authenticated" });

	const password = typeof body.password === "string" ? body.password : "";
	const result = await verifyWithLockout(deps, view, password);
	if (!result.ok) return json(res, result.status, { error: result.code === "invalid-password" ? "密码错误" : result.code, retryAfterSeconds: result.retryAfterSeconds });

	state.enabled = false;
	deps.sessions().revokeAllExcept(session.token);
	await deps.persist();
	res.setHeader("cache-control", "no-store");
	res.setHeader("set-cookie", buildSetCookieHeader(deps.config.cookieName, "", 0, deps.config.cookieSecure));
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify({ ok: true }));
	deps.log.info("auth disabled");
}

async function handleUnlock(deps, req, res) {
	if (req.method !== "POST") return methodNotAllowed(res, "POST");
	const view = stateView(deps);
	const state = view.state;
	let body;
	try {
		body = await readBody(req);
	} catch (error) {
		return json(res, 400, { error: error instanceof BodyError ? error.message : "bad request" });
	}
	if (deps.stateError() !== null) return json(res, 503, { error: "auth state unavailable" });
	if (state.enabled !== true) return json(res, 403, { error: "auth disabled" });
	if (view.locked) return json(res, 429, { error: "locked", retryAfterSeconds: Math.ceil(view.retryAfterSeconds) });
	if (state.passwordHash === null) return json(res, 409, { error: "setup required" });

	const password = typeof body.password === "string" ? body.password : "";
	const result = await verifyWithLockout(deps, view, password);
	if (!result.ok) return json(res, result.status, { error: result.code === "invalid-password" ? "密码错误" : result.code, retryAfterSeconds: result.retryAfterSeconds });
	json(res, 200, { ok: true });
	deps.log.info("unlock");
}

function buildSetCookieHeader(cookieName, token, maxAgeSeconds, secure) {
	return `${cookieName}=${token}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax`;
}
