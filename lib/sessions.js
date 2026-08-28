import { createHash, randomBytes } from "node:crypto";
import { pruneExpiredSessions } from "./state.js";

/**
 * Session cookie attributes. `secure` is dropped for plain-http deployments
 * (see the `cookieSecure` config option).
 */
export function buildSetCookie(cookieName, token, maxAgeSeconds, secure = true) {
	return `${cookieName}=${token}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax`;
}

/** On-disk session key: sha256 hex of the raw token — the raw token never reaches the state file. */
export function digestToken(token) {
	return createHash("sha256").update(token).digest("hex");
}

/** Read one cookie by name from a `Cookie` request header; undefined when absent. */
export function parseCookieHeader(cookieHeader, name) {
	if (typeof cookieHeader !== "string" || cookieHeader === "") return undefined;
	const prefix = `${name}=`;
	for (const part of cookieHeader.split(";")) {
		const trimmed = part.trim();
		if (trimmed.startsWith(prefix)) {
			const value = trimmed.slice(prefix.length);
			return value === "" ? undefined : value;
		}
	}
	return undefined;
}

/**
 * Session store over the state file's `sessions` map. The map is owned by the
 * caller (host plugin runtime); `repoint` re-attaches after a state reload.
 * Mutations must be persisted by the caller (`persist()`).
 */
export class SessionStore {
	#sessions;
	constructor(getSessions) {
		this.#sessions = getSessions;
	}

	/** Re-attach after the state object was replaced by a reload. */
	repoint(getSessions) {
		this.#sessions = getSessions;
	}

	/** Create a session row and return `{ token, row }`; expired rows are pruned first. */
	create(ttlMs, now = Date.now()) {
		const sessions = this.#sessions();
		pruneExpiredSessions({ sessions }, now);
		const token = randomBytes(32).toString("base64url");
		const row = { createdAt: now, expiresAt: now + ttlMs };
		sessions[digestToken(token)] = row;
		return { token, row };
	}

	/** Valid row for a token, or undefined (missing, expired, or malformed). */
	getByToken(token) {
		if (typeof token !== "string" || token === "") return undefined;
		const sessions = this.#sessions();
		const row = sessions[digestToken(token)];
		if (row === undefined || row.expiresAt <= Date.now()) return undefined;
		return row;
	}

	/** Revoke one session; returns whether a row was removed. */
	revokeByToken(token) {
		if (typeof token !== "string" || token === "") return false;
		const sessions = this.#sessions();
		const key = digestToken(token);
		if (sessions[key] === undefined) return false;
		delete sessions[key];
		return true;
	}

	/** Revoke every session except `keepToken` (undefined revokes all). */
	revokeAllExcept(keepToken) {
		const sessions = this.#sessions();
		const keep = typeof keepToken === "string" && keepToken !== "" ? digestToken(keepToken) : undefined;
		for (const key of Object.keys(sessions)) {
			if (key !== keep) delete sessions[key];
		}
	}

	/** Number of live sessions. */
	count() {
		return Object.keys(this.#sessions()).length;
	}
}
