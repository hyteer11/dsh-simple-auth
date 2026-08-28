import { promises as fs } from "node:fs";
import path from "node:path";
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from "./crypto.js";
import { Lockout } from "./lockout.js";
import { registerAuthEndpoints } from "./endpoints.js";
import { assertGuarded, AUTH_PATH_PREFIX, wrapServer } from "./gate.js";
import { SessionStore, parseCookieHeader } from "./sessions.js";
import { defaultStateFilePath, loadState, saveState } from "./state.js";

/** Stable Cordis plugin id (host row id / client bundle id). */
export const name = "dsh-simple-auth";
/** Hard dependency: the webServer route table the gate wraps. */
export const inject = ["webServer"];

// No schemastery Config schema on purpose: the package stays dependency-free
// (only Node built-ins on the host side), and the loader passes the raw YAML
// config through untouched. Values are normalized defensively in apply().

/** Defensive numeric config coercion: finite non-negative numbers only. */
function num(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
/** Defensive boolean config coercion. */
function bool(value, fallback) {
	return typeof value === "boolean" ? value : fallback;
}
/** Defensive string config coercion: non-empty strings only. */
function str(value, fallback) {
	return typeof value === "string" && value !== "" ? value : fallback;
}

/** Resolve the effective config with defaults; tolerates missing/partial entries. */
export function normalizeConfig(raw = {}) {
	return {
		/** Auth-free validity after login (seconds); re-auth is required after expiry. */
		sessionTtl: num(raw.sessionTtl, 604800),
		/** Validity when "remember me" was checked at login (seconds). */
		rememberTtl: num(raw.rememberTtl, 2592000),
		/** Session cookie name. */
		cookieName: str(raw.cookieName, "dsh-simple-auth"),
		/** Add the Secure flag (keep false for plain-http deployments). */
		cookieSecure: bool(raw.cookieSecure, true),
		/** Consecutive wrong passwords that trigger the lockout (min 1). */
		maxAttempts: Math.max(1, Math.floor(num(raw.maxAttempts, 5))),
		/** Lockout duration after maxAttempts failures (seconds). */
		lockoutSeconds: num(raw.lockoutSeconds, 300),
		/** Minimum password length for setup / change-password / CLI init. */
		minPasswordLength: Math.max(1, Math.floor(num(raw.minPasswordLength, MIN_PASSWORD_LENGTH))),
		/** State file path; empty = $DSH_HOME/auth/state.json. */
		stateFile: typeof raw.stateFile === "string" ? raw.stateFile : "",
	};
}

/**
 * The dsh-simple-auth gate: /auth/* is whitelisted; a disabled auth opens everything;
 * otherwise a valid session cookie or Bearer token allows, everything else is
 * denied. Fail-closed on a corrupt state file.
 */
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

export async function apply(ctx, rawConfig) {
	const config = normalizeConfig(rawConfig);
	const server = ctx.get("webServer");
	if (server === undefined) return;
	const log = ctx.logger("dsh-simple-auth");

	const statePath = config.stateFile === "" ? defaultStateFilePath() : config.stateFile;

	/** Live runtime: the current state object, the session store, and the lockout policy. */
	const runtime = {
		state: undefined,
		stateError: null,
		sessions: new SessionStore(() => runtime.state.sessions),
		lockout: new Lockout({ maxAttempts: config.maxAttempts, lockoutSeconds: config.lockoutSeconds }),
		persist: () => persist(),
	};

	// Serialized writes: mutations in flight never interleave with each other.
	let writeChain = Promise.resolve();
	function persist() {
		writeChain = writeChain
			.then(() => saveState(statePath, runtime.state))
			.catch((error) => {
				log.error(`state save failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		return writeChain;
	}

	async function reload() {
		try {
			const { state } = await loadState(statePath);
			runtime.state = state;
			runtime.stateError = null;
			runtime.sessions.repoint(() => runtime.state.sessions);
			log.info("state reloaded");
		} catch (error) {
			log.error(`state reload failed (keeping previous state): ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// Initial load: fail-closed when the file is unreadable/corrupt.
	try {
		const { state } = await loadState(statePath);
		runtime.state = state;
	} catch (error) {
		runtime.state = undefined;
		runtime.stateError = error instanceof Error ? error : new Error(String(error));
		log.error(`state load failed; gate denies everything (fail-closed): ${runtime.stateError.message}`);
	}
	runtime.sessions.repoint(() => runtime.state.sessions);

	// Watch the state directory so CLI changes (enable/disable/init/passwd/
	// unlock) apply live without a restart. Atomic renames replace the file,
	// so the directory is watched, filtered by basename, and debounced.
	let reloadTimer;
	let watcher;
	const dir = path.dirname(statePath);
	const scheduleReload = () => {
		clearTimeout(reloadTimer);
		reloadTimer = setTimeout(() => void reload(), 100);
	};
	(async () => {
		try {
			await fs.mkdir(dir, { recursive: true });
			watcher = fs.watch(dir, (event, filename) => {
				if (filename !== path.basename(statePath)) return;
				scheduleReload();
			});
			watcher.on("error", (error) => {
				log.warn(`state watcher error (falling back to manual reload): ${error instanceof Error ? error.message : String(error)}`);
				clearTimeout(reloadTimer);
			});
		} catch (error) {
			log.warn(`state watch unavailable (CLI changes need a restart): ${error instanceof Error ? error.message : String(error)}`);
		}
	})();

	ctx.effect(() => () => {
		clearTimeout(reloadTimer);
		void watcher?.close();
	}, "dsh-simple-auth: state watcher");

	// Small observability service.
	ctx.provide("dsh-simple-auth", {
		status() {
			const state = runtime.state;
			return {
				enabled: state?.enabled === true,
				needsSetup: state?.enabled === true && state?.passwordHash === null,
				authenticated: false,
				stateError: runtime.stateError?.message ?? null,
				sessionTtl: config.sessionTtl,
				rememberTtl: config.rememberTtl,
				maxAttempts: config.maxAttempts,
				lockoutSeconds: config.lockoutSeconds,
			};
		},
	});

	// Wrap the webserver (idempotent per instance) and restore on stop.
	const unwrap = wrapServer(server, makeGate(runtime, config));
	ctx.effect(() => unwrap, "dsh-simple-auth: guard unwrap");

	// Register /auth endpoints through the wrapped register.
	ctx.effect(
		() =>
			registerAuthEndpoints(server, {
				state: () => runtime.state,
				stateError: () => runtime.stateError,
				sessions: () => runtime.sessions,
				lockout: runtime.lockout,
				persist,
				config,
				hash: (password) => hashPassword(password),
				verify: (password, stored) => verifyPassword(password, stored),
				log,
			}),
		"dsh-simple-auth: auth endpoints"
	);

	// Self-check: every webserver entry must be guarded; fail loud otherwise.
	const failures = assertGuarded(server);
	if (failures.length > 0) {
		for (const failure of failures) log.error(`unguarded entry: ${failure}`);
		throw new Error(`dsh-simple-auth: guard self-check failed: ${failures.join(", ")}`);
	}

	log.info(`gate mounted (state=${statePath})`);
}
