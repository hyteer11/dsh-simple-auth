import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** State file schema version; bump on incompatible changes. */
export const STATE_VERSION = 1;

/** Error type for unreadable/invalid/insecure state files. */
export class StateFileError extends Error {}

/** Default state file: `$DSH_HOME/auth/state.json` (DSH_HOME env, else `~/.dsh`). */
export function defaultStateFilePath() {
	const home = process.env["DSH_HOME"] ?? path.join(os.homedir(), ".dsh");
	return path.join(home, "auth", "state.json");
}

/** A fresh, empty state: auth enabled, no password, no sessions, no failures. */
export function defaultState() {
	return {
		version: STATE_VERSION,
		enabled: true,
		passwordHash: null,
		lockout: { failures: 0, lastFailureAt: 0, lockedUntil: 0 },
		sessions: {},
	};
}

const SESSION_KEY_RE = /^[0-9a-f]{64}$/;

/**
 * Validate and normalize an arbitrary parsed JSON value into a state object.
 * Throws StateFileError on any structural violation (fail-closed: the host
 * treats an invalid file as "no trusted state" and denies everything).
 */
export function validateState(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new StateFileError("state file must be a JSON object");
	}
	const version = value.version;
	if (version !== STATE_VERSION) {
		throw new StateFileError(`unsupported state file version: ${String(version)}`);
	}
	const enabled = value.enabled;
	if (typeof enabled !== "boolean") {
		throw new StateFileError("state file: enabled must be a boolean");
	}
	const passwordHash = value.passwordHash;
	if (passwordHash !== null && typeof passwordHash !== "string") {
		throw new StateFileError("state file: passwordHash must be a string or null");
	}
	const lockout = value.lockout ?? {};
	if (typeof lockout !== "object" || lockout === null || Array.isArray(lockout)) {
		throw new StateFileError("state file: lockout must be an object");
	}
	for (const key of ["failures", "lastFailureAt", "lockedUntil"]) {
		const field = lockout[key] ?? 0;
		if (!Number.isInteger(field) || field < 0) {
			throw new StateFileError(`state file: lockout.${key} must be a non-negative integer`);
		}
	}
	const sessions = value.sessions ?? {};
	if (typeof sessions !== "object" || sessions === null || Array.isArray(sessions)) {
		throw new StateFileError("state file: sessions must be an object");
	}
	const normalizedSessions = {};
	for (const [key, row] of Object.entries(sessions)) {
		if (!SESSION_KEY_RE.test(key)) {
			throw new StateFileError("state file: invalid session key");
		}
		if (typeof row !== "object" || row === null) {
			throw new StateFileError("state file: invalid session row");
		}
		const createdAt = row.createdAt;
		const expiresAt = row.expiresAt;
		if (!Number.isInteger(createdAt) || createdAt < 0 || !Number.isInteger(expiresAt) || expiresAt < 0) {
			throw new StateFileError("state file: session timestamps must be non-negative integers");
		}
		normalizedSessions[key] = { createdAt, expiresAt };
	}
	return {
		version: STATE_VERSION,
		enabled,
		passwordHash,
		lockout: {
			failures: lockout.failures ?? 0,
			lastFailureAt: lockout.lastFailureAt ?? 0,
			lockedUntil: lockout.lockedUntil ?? 0,
		},
		sessions: normalizedSessions,
	};
}

function isEnoent(error) {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Load the state file. ENOENT yields `{ state: defaultState(), missing: true }`
 * (first run). Any other failure — permission bits, unreadable, invalid JSON,
 * invalid schema — throws StateFileError so callers can fail closed.
 * Expired sessions are pruned during load.
 */
export async function loadState(filePath) {
	let stat;
	try {
		stat = await fs.stat(filePath);
	} catch (error) {
		if (isEnoent(error)) return { state: defaultState(), missing: true };
		throw new StateFileError(`cannot stat state file: ${messageOf(error)}`);
	}
	if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
		throw new StateFileError(`state file has insecure permissions: ${filePath}`);
	}
	let text;
	try {
		text = await fs.readFile(filePath, "utf8");
	} catch (error) {
		throw new StateFileError(`cannot read state file: ${messageOf(error)}`);
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new StateFileError(`invalid state file (not JSON): ${messageOf(error)}`);
	}
	const state = validateState(parsed);
	pruneExpiredSessions(state);
	return { state, missing: false };
}

/** Drop expired session rows in place. */
export function pruneExpiredSessions(state, now = Date.now()) {
	for (const [key, row] of Object.entries(state.sessions)) {
		if (row.expiresAt <= now) delete state.sessions[key];
	}
}

/**
 * Atomically persist the state: same-directory `.tmp` write with mode 0600
 * then rename. The directory is created on demand.
 */
export async function saveState(filePath, state) {
	const text = `${JSON.stringify(state, null, 2)}\n`;
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(`${filePath}.tmp`, text, { mode: 0o600 });
	await fs.rename(`${filePath}.tmp`, filePath);
}
