/**
 * dsh-simple-auth test suite. Run with: node test/run.js
 *
 * Covers the pure modules (crypto, state, lockout, sessions), the gate
 * wrapping, the CLI, and a full HTTP integration flow through a real
 * node:http server wired with the same pieces index.js composes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from "../lib/crypto.js";
import { defaultState, loadState, saveState, StateFileError, validateState, pruneExpiredSessions, defaultStateFilePath } from "../lib/state.js";
import { Lockout } from "../lib/lockout.js";
import { SessionStore, buildSetCookie, parseCookieHeader } from "../lib/sessions.js";
import { wrapServer, assertGuarded, denyHttp, isGuarded, AUTH_PATH_PREFIX } from "../lib/gate.js";
import { registerAuthEndpoints } from "../lib/endpoints.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ── helpers ──────────────────────────────────────────────────────────────────

async function tmpStateDir() {
	return mkdtemp(path.join(tmpdir(), "dsh-simple-auth-test-"));
}

/** Minimal WebServer-shaped object: the same route tables + register methods. */
function makeServer() {
	return {
		exact: new Map(),
		prefixes: new Map(),
		upgrades: new Map(),
		fallback: undefined,
		register(route) {
			const table = route.kind === "exact" ? this.exact : this.prefixes;
			if (table.has(route.path)) throw new Error(`duplicate ${route.kind} route ${route.path}`);
			table.set(route.path, route);
			return () => table.delete(route.path);
		},
		registerUpgrade(route) {
			if (this.upgrades.has(route.path)) throw new Error(`duplicate upgrade route ${route.path}`);
			this.upgrades.set(route.path, route);
			return () => this.upgrades.delete(route.path);
		},
		registerFallback(handler) {
			if (this.fallback !== undefined) throw new Error("fallback already registered");
			this.fallback = handler;
			return () => {
				this.fallback = undefined;
			};
		},
		match(pathname) {
			const exact = this.exact.get(pathname);
			if (exact !== undefined) return exact;
			for (const [prefix, route] of this.prefixes) {
				if (pathname.startsWith(prefix)) return route;
			}
			return undefined;
		},
		async handle(req, res) {
			const pathname = new URL(req.url ?? "/", "http://x").pathname;
			const route = this.match(pathname);
			if (route !== undefined) return route.handler(req, res);
			if (this.fallback !== undefined) return this.fallback(req, res);
			res.writeHead(404);
			res.end();
		},
	};
}

/** The exact runtime wiring index.js composes, minus cordis. */
function makeRuntime(statePath, config) {
	const runtime = {
		state: undefined,
		stateError: null,
		sessions: new SessionStore(() => runtime.state.sessions),
		lockout: new Lockout({ maxAttempts: config.maxAttempts, lockoutSeconds: config.lockoutSeconds }),
	};
	let chain = Promise.resolve();
	runtime.persist = () => {
		chain = chain.then(() => saveState(statePath, runtime.state));
		return chain;
	};
	return runtime;
}

function makeGate(runtime, config) {
	return {
		decide(req, pathname) {
			if (pathname === AUTH_PATH_PREFIX || pathname.startsWith(`${AUTH_PATH_PREFIX}/`)) return "allow";
			if (runtime.stateError !== null) return "deny";
			if (runtime.state.enabled !== true) return "allow";
			const cookie = parseCookieHeader(req.headers.cookie, config.cookieName);
			if (cookie !== undefined && runtime.sessions.getByToken(cookie) !== undefined) return "allow";
			const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ""));
			if (match !== null && match[1] !== undefined && runtime.sessions.getByToken(match[1]) !== undefined) return "allow";
			return "deny";
		},
	};
}

const TEST_CONFIG = {
	sessionTtl: 600,
	rememberTtl: 3600,
	cookieName: "dsh-simple-auth",
	cookieSecure: false,
	maxAttempts: 3,
	lockoutSeconds: 3600,
	minPasswordLength: 6,
	stateFile: "",
};

/** Compose the full stack on a fresh server; returns { server, runtime, http, base, unwrap } */
async function bootStack(overrides = {}) {
	const config = { ...TEST_CONFIG, ...overrides };
	const dir = await tmpStateDir();
	const statePath = path.join(dir, "state.json");
	const runtime = makeRuntime(statePath, config);
	try {
		const { state } = await loadState(statePath);
		runtime.state = state;
	} catch (error) {
		runtime.state = undefined;
		runtime.stateError = error;
	}
	runtime.sessions.repoint(() => runtime.state.sessions);
	const server = makeServer();
	const gate = makeGate(runtime, config);
	const unwrap = wrapServer(server, gate);
	registerAuthEndpoints(server, {
		state: () => runtime.state,
		stateError: () => runtime.stateError,
		sessions: () => runtime.sessions,
		lockout: runtime.lockout,
		persist: () => runtime.persist(),
		config,
		hash: (p) => hashPassword(p),
		verify: (p, s) => verifyPassword(p, s),
		log: { info() {}, error() {}, warn() {} },
	});
	server.registerFallback((req, res) => {
		res.writeHead(200, { "content-type": "text/html" });
		res.end("<html>spa</html>");
	});
	const http = createServer((req, res) => {
		server.handle(req, res).catch((error) => {
			if (!res.headersSent) {
				res.writeHead(500);
				res.end("boom");
			} else res.destroy();
		});
	});
	await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${http.address().port}`;
	return { server, runtime, http, base, statePath, unwrap, config };
}

function get(base, pathname, headers = {}) {
	return fetch(base + pathname, { headers, redirect: "manual" });
}

function post(base, pathname, body, cookie) {
	return fetch(base + pathname, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(cookie !== undefined ? { cookie } : {}),
		},
		body: JSON.stringify(body),
		redirect: "manual",
	});
}

// ── crypto ────────────────────────────────────────────────────────────────────

test("crypto: hash/verify roundtrip, wrong password, malformed stored", async () => {
	const hash = await hashPassword("hunter2");
	assert.ok(hash.startsWith("scrypt$"));
	assert.equal(await verifyPassword("hunter2", hash), true);
	assert.equal(await verifyPassword("hunter3", hash), false);
	assert.equal(await verifyPassword("hunter2", "not-a-hash"), false);
	assert.equal(await verifyPassword("hunter2", "scrypt$1$1$1$AAAA$AAAA"), false);
	assert.equal(MIN_PASSWORD_LENGTH, 6);
});

// ── state ─────────────────────────────────────────────────────────────────────

test("state: default, save/load roundtrip, missing, corrupt, permissions", async () => {
	const dir = await tmpStateDir();
	const file = path.join(dir, "state.json");
	const missing = await loadState(file);
	assert.equal(missing.missing, true);
	assert.deepEqual(missing.state, defaultState());

	const state = defaultState();
	state.passwordHash = "scrypt$x";
	state.sessions["ab".repeat(32)] = { createdAt: 1, expiresAt: 2 ** 50 };
	await saveState(file, state);
	const loaded = await loadState(file);
	assert.deepEqual(loaded.state, state);

	// Corrupt JSON
	await writeFile(file, "{oops", "utf8");
	await assert.rejects(() => loadState(file), StateFileError);

	// Invalid schema
	await writeFile(file, JSON.stringify({ version: 99 }), "utf8");
	await assert.rejects(() => loadState(file), StateFileError);

	// Insecure permissions (unix)
	await saveState(file, defaultState());
	if (process.platform !== "win32") {
		const { chmod } = await import("node:fs/promises");
		await chmod(file, 0o644);
		await assert.rejects(() => loadState(file), StateFileError);
		await chmod(file, 0o600);
	}

	// validateState rejects bad sessions
	assert.throws(() => validateState({ version: 1, enabled: true, passwordHash: null, lockout: {}, sessions: { nope: { createdAt: 0, expiresAt: 1 } } }), StateFileError);
});

test("state: pruneExpiredSessions drops expired rows", () => {
	const state = defaultState();
	state.sessions.a = { createdAt: 1, expiresAt: 1 };
	state.sessions.b = { createdAt: 1, expiresAt: 2 ** 40 };
	pruneExpiredSessions(state, 1000);
	assert.deepEqual(Object.keys(state.sessions), ["b"]);
});

test("state: defaultStateFilePath honors DSH_HOME", () => {
	const before = process.env.DSH_HOME;
	try {
		process.env.DSH_HOME = "/x/y";
		assert.equal(defaultStateFilePath(), path.join("/x/y", "auth", "state.json"));
	} finally {
		if (before === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = before;
	}
});

// ── lockout ───────────────────────────────────────────────────────────────────

test("lockout: threshold, window decay, success reset, no extension while locked", () => {
	let now = 1_000_000;
	const lockout = new Lockout({ maxAttempts: 3, lockoutSeconds: 100, now: () => now });
	const state = { failures: 0, lastFailureAt: 0, lockedUntil: 0 };

	assert.equal(lockout.isLocked(state), false);
	let r = lockout.recordFailure(state);
	assert.equal(r.locked, false);
	assert.equal(state.failures, 1);
	r = lockout.recordFailure(state);
	assert.equal(r.locked, false);
	assert.equal(state.failures, 2);
	r = lockout.recordFailure(state);
	assert.equal(r.locked, true);
	assert.equal(r.retryAfterSeconds, 100);

	// While locked, attempts do not extend the lockout.
	const until = state.lockedUntil;
	lockout.recordFailure(state);
	assert.equal(state.lockedUntil, until);

	// Decay after the window elapses.
	now = until + 1;
	assert.equal(lockout.isLocked(state), false);
	assert.equal(state.failures, 0);

	// Success resets.
	lockout.recordFailure(state);
	lockout.recordFailure(state);
	lockout.recordSuccess(state);
	assert.deepEqual(state, { failures: 0, lastFailureAt: 0, lockedUntil: 0 });
});

// ── sessions ──────────────────────────────────────────────────────────────────

test("sessions: create, get, expire, revoke, revokeAllExcept, cookie flags", () => {
	const map = {};
	const store = new SessionStore(() => map);
	const { token, row } = store.create(10_000);
	assert.equal(row.expiresAt, row.createdAt + 10_000);
	assert.equal(store.getByToken(token), row);
	assert.equal(store.getByToken("nope"), undefined);
	assert.equal(store.count(), 1);

	// Expired rows are invisible under a frozen clock.
	const realNow = Date.now;
	Date.now = () => 2;
	try {
		const key = Object.keys(map)[0];
		delete map[key];
		const expired = store.create(1_000); // createdAt = 2, expiresAt = 1002
		Date.now = () => 2000;
		assert.equal(store.getByToken(expired.token), undefined);
	} finally {
		Date.now = realNow;
	}

	// Revoke
	const second = store.create(1000).token;
	assert.equal(store.revokeByToken(second), true);
	assert.equal(store.revokeByToken(second), false);
	assert.equal(store.count(), 0);

	// revokeAllExcept keeps one
	store.create(1000);
	store.create(1000);
	const keep = store.create(1000).token;
	store.revokeAllExcept(keep);
	assert.equal(store.count(), 1);
	assert.ok(store.getByToken(keep) !== undefined);

	// Cookie helpers
	const cookie = buildSetCookie("dsh-simple-auth", "tok", 60, false);
	assert.ok(cookie.startsWith("dsh-simple-auth=tok; Max-Age=60; Path=/; HttpOnly; SameSite=Lax"));
	assert.ok(!cookie.includes("Secure"));
	const secure = buildSetCookie("dsh-simple-auth", "tok", 60, true);
	assert.ok(secure.includes("Secure"));
	assert.equal(parseCookieHeader("a=1; dsh-simple-auth=tok; b=2", "dsh-simple-auth"), "tok");
	assert.equal(parseCookieHeader("dsh-simple-auth=", "dsh-simple-auth"), undefined);
	assert.equal(parseCookieHeader(undefined, "dsh-simple-auth"), undefined);
});

// ── gate ──────────────────────────────────────────────────────────────────────

test("gate: wrapServer guards all entries, is idempotent, unwrap restores", () => {
	const server = makeServer();
	const gate = { decide: () => "deny" };
	server.register({ kind: "exact", path: "/a", handler: (req, res) => res.end() });
	server.register({ kind: "prefix", path: "/b", handler: (req, res) => res.end() });
	server.registerUpgrade({ path: "/ws", handler: (req, socket) => socket.end() });
	server.registerFallback((req, res) => res.end());

	const unwrap = wrapServer(server, gate);
	const unwrap2 = wrapServer(server, gate);
	assert.equal(unwrap, unwrap2);
	assert.deepEqual(assertGuarded(server), []);
	for (const [, route] of server.exact) assert.ok(isGuarded(route.handler));
	assert.ok(isGuarded(server.fallback));
	for (const [, route] of server.upgrades) assert.ok(isGuarded(route.handler));

	// New registrations are guarded too.
	server.register({ kind: "exact", path: "/c", handler: (req, res) => res.end() });
	assert.deepEqual(assertGuarded(server), []);

	unwrap();
	// Unwrapped entries are no longer guarded (the failure list is non-empty).
	assert.ok(assertGuarded(server).length > 0);
	assert.equal(isGuarded(server.exact.get("/a").handler), false);
	assert.equal(isGuarded(server.fallback), false);
});

test("gate: denyHttp 302 for HTML navigation, 401 otherwise", () => {
	const makeRes = () => {
		const res = {
			headers: {},
			status: 0,
			body: "",
			setHeader(k, v) { this.headers[k] = v; },
			writeHead(s, h) { this.status = s; Object.assign(this.headers, h); },
			end(b) { this.body = b ?? ""; },
		};
		return res;
	};
	const res1 = makeRes();
	denyHttp({ url: "/", method: "GET", headers: { accept: "text/html" } }, res1);
	assert.equal(res1.status, 302);
	assert.match(res1.headers.location, /^\/auth\/login\?next=/);

	const res2 = makeRes();
	denyHttp({ url: "/api/x", method: "GET", headers: {} }, res2);
	assert.equal(res2.status, 401);
});

// ── endpoints integration (real HTTP) ────────────────────────────────────────

test("integration: setup → login → session → change password → disable → gate opens", async (t) => {
	const { http, base, runtime, unwrap } = await bootStack();
	t.after(() => {
		http.close();
		unwrap();
	});
	const PASSWORD = "correct horse";

	// Fresh install: gate denies the app, login page is the SETUP page.
	let res = await get(base, "/", { accept: "text/html" });
	assert.equal(res.status, 302);
	assert.match(res.headers.get("location"), /^\/auth\/login\?next=/);
	res = await get(base, "/auth/login");
	const setupHtml = await res.text();
	assert.match(setupHtml, /初始化密码/);

	// Setup rejects short passwords.
	res = await post(base, "/auth/setup", { password: "123" });
	assert.equal(res.status, 400);

	// Setup succeeds and auto-logs-in (set-cookie).
	res = await post(base, "/auth/setup", { password: PASSWORD });
	assert.equal(res.status, 200);
	const cookie = res.headers.get("set-cookie");
	assert.ok(cookie.startsWith("dsh-simple-auth="));
	assert.ok(cookie.includes("HttpOnly"));

	// Authenticated app request now passes the gate.
	res = await get(base, "/", { accept: "text/html", cookie });
	assert.equal(res.status, 200);
	assert.match(await res.text(), /spa/);

	// Status endpoint.
	res = await get(base, "/auth/status", { cookie });
	const status = await res.json();
	assert.equal(status.enabled, true);
	assert.equal(status.needsSetup, false);
	assert.equal(status.authenticated, true);
	assert.equal(status.sessionExpiresAt !== null, true);

	// Logout revokes the session.
	res = await post(base, "/auth/logout", {}, cookie);
	assert.equal(res.status, 302);
	res = await get(base, "/", { accept: "text/html", cookie });
	assert.equal(res.status, 302);

	// Wrong password counts failures.
	for (let i = 0; i < 3; i += 1) {
		res = await post(base, "/auth/login", { password: "wrong" });
		assert.equal(res.status, 401);
	}
	// Next attempt (even a correct one) is locked out.
	res = await post(base, "/auth/login", { password: PASSWORD });
	assert.equal(res.status, 429);
	const locked = await res.json();
	assert.ok(locked.retryAfterSeconds > 0);

	// CLI-equivalent: clear lockout by editing state + persisting.
	runtime.state.lockout.failures = 0;
	runtime.state.lockout.lastFailureAt = 0;
	runtime.state.lockout.lockedUntil = 0;
	await runtime.persist();

	// Login with remember → longer TTL.
	res = await post(base, "/auth/login", { password: PASSWORD, remember: true });
	assert.equal(res.status, 200);
	const cookie2 = res.headers.get("set-cookie");
	assert.match(cookie2, new RegExp(`Max-Age=${TEST_CONFIG.rememberTtl}`));

	// Change password with wrong old password → 401 + failure counted.
	res = await post(base, "/auth/change-password", { oldPassword: "nope", newPassword: "brand new pass" }, cookie2);
	assert.equal(res.status, 401);

	// Change password with correct old password → other sessions revoked, current kept.
	res = await post(base, "/auth/change-password", { oldPassword: PASSWORD, newPassword: "brand new pass" }, cookie2);
	assert.equal(res.status, 200);
	res = await get(base, "/", { accept: "text/html", cookie: cookie2 });
	assert.equal(res.status, 200); // current session survives

	// Old password no longer works.
	res = await post(base, "/auth/login", { password: PASSWORD });
	assert.equal(res.status, 401);

	// Disable requires the (new) password; wrong → 401.
	res = await post(base, "/auth/disable", { password: "nope" }, cookie2);
	assert.equal(res.status, 401);
	res = await post(base, "/auth/disable", { password: "brand new pass" }, cookie2);
	assert.equal(res.status, 200);

	// Gate is now open: unauthenticated requests pass (like no plugin).
	res = await get(base, "/", { accept: "text/html" });
	assert.equal(res.status, 200);
	res = await get(base, "/auth/status");
	const afterDisable = await res.json();
	assert.equal(afterDisable.enabled, false);
});

test("integration: enable/disable via gate state + unlock endpoint", async (t) => {
	const { http, base, runtime, unwrap } = await bootStack();
	t.after(() => {
		http.close();
		unwrap();
	});
	const PASSWORD = "sekrit pass";
	await post(base, "/auth/setup", { password: PASSWORD });
	const res = await post(base, "/auth/login", { password: PASSWORD });
	const cookie = res.headers.get("set-cookie").match(/^dsh-simple-auth=([^;]+)/)[1];

	// Unlock endpoint: wrong → 401 (counts failure), right → 200.
	let r = await post(base, "/auth/unlock", { password: "bad" }, cookie);
	assert.equal(r.status, 401);
	r = await post(base, "/auth/unlock", { password: PASSWORD }, cookie);
	assert.equal(r.status, 200);

	// CLI-equivalent disable: write enabled=false, then simulate the reload.
	runtime.state.enabled = false;
	await runtime.persist();
	r = await get(base, "/", { accept: "text/html" });
	assert.equal(r.status, 200); // open gate
	// Login endpoint refuses while disabled.
	r = await post(base, "/auth/login", { password: PASSWORD });
	assert.equal(r.status, 403);

	// Re-enable via state; gate denies again.
	runtime.state.enabled = true;
	await runtime.persist();
	r = await get(base, "/", { accept: "text/html" });
	assert.equal(r.status, 302);
});

test("integration: Bearer token works for script access", async (t) => {
	const { http, base, unwrap } = await bootStack();
	t.after(() => {
		http.close();
		unwrap();
	});
	await post(base, "/auth/setup", { password: "abc12345" });
	const res = await post(base, "/auth/login", { password: "abc12345" });
	const token = res.headers.get("set-cookie").match(/^dsh-simple-auth=([^;]+)/)[1];
	const r = await fetch(base + "/api/method", { headers: { authorization: `Bearer ${token}` } });
	assert.equal(r.status, 200); // passes the gate (falls through to SPA fallback)
	const denied = await fetch(base + "/api/method");
	assert.equal(denied.status, 401);
});

// ── CLI ───────────────────────────────────────────────────────────────────────

function runCli(args, input, env = {}) {
	return spawnSync(process.execPath, [path.join(ROOT, "lib", "cli.js"), ...args], {
		input,
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
}

test("cli: init/passwd/enable/disable/unlock/status lifecycle", async () => {
	const dir = await tmpStateDir();
	const file = path.join(dir, "state.json");
	const env = { DSH_HOME: dir };
	const args = ["--file", file];

	let r = runCli(["status", ...args], "", env);
	assert.equal(r.status, 0);
	assert.match(r.stdout, /enabled: yes/);
	assert.match(r.stdout, /password: not set/);

	// init via stdin pipe
	r = runCli(["init", ...args], "correct horse\n", env);
	assert.equal(r.status, 0);
	assert.match(r.stdout, /password initialized/);

	// init again without --force fails
	r = runCli(["init", ...args], "another pass\n", env);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /already initialized/);

	r = runCli(["status", ...args], "", env);
	assert.match(r.stdout, /password: set/);

	// reset
	r = runCli(["passwd", ...args], "brand new pass\n", env);
	assert.equal(r.status, 0);
	assert.match(r.stdout, /password reset/);

	// disable/enable
	r = runCli(["disable", ...args], "", env);
	assert.equal(r.status, 0);
	r = runCli(["status", ...args], "", env);
	assert.match(r.stdout, /enabled: no/);
	r = runCli(["enable", ...args], "", env);
	r = runCli(["status", ...args], "", env);
	assert.match(r.stdout, /enabled: yes/);

	// unlock (no-op then with a failure recorded)
	r = runCli(["unlock", ...args], "", env);
	assert.match(r.stdout, /nothing to unlock/);
	const snap = await loadState(file);
	snap.state.lockout.failures = 2;
	snap.state.lockout.lockedUntil = 2 ** 40;
	await saveState(file, snap.state);
	r = runCli(["unlock", ...args], "", env);
	assert.equal(r.status, 0);
	assert.match(r.stdout, /lockout cleared/);
	const after = await loadState(file);
	assert.equal(after.state.lockout.failures, 0);

	// short password rejected
	r = runCli(["passwd", ...args], "123\n", env);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /at least 6/);

	// bad command
	r = runCli(["frobnicate", ...args], "", env);
	assert.equal(r.status, 1);

	await rm(dir, { recursive: true, force: true });
});

// ── pages ─────────────────────────────────────────────────────────────────────

test("pages: setup/login/disabled/corrupt render distinct views", async () => {
	const { setupPageHtml, loginPageHtml, disabledPageHtml, corruptPageHtml } = await import("../lib/pages.js");
	assert.match(setupPageHtml("/"), /初始化密码/);
	// Minimal login page: no heading, placeholder text, and an icon button.
	const login = loginPageHtml("/");
	assert.match(login, /输入密码解锁/);
	assert.ok(!login.includes("<h1>"));
	assert.match(login, /class="icon"/);
	assert.match(disabledPageHtml(), /认证已禁用/);
	assert.match(corruptPageHtml(), /认证状态异常/);
});
