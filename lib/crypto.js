import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

/** Minimum password length enforced by setup, change-password, and the CLI. */
export const MIN_PASSWORD_LENGTH = 6;

/** scrypt cost parameters (same family as dsh-auth-gate). */
export const SCRYPT_N = 65536;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_KEYLEN = 32;
/** Memory cap for scrypt derivation; must exceed 128 * N * r bytes. */
export const SCRYPT_MAXMEM = 128 * 1024 * 1024;

/**
 * Derive a stored representation: `scrypt$<N>$<r>$<p>$<salt b64url>$<key b64url>`
 * with a fresh random 16-byte salt. The encoded parameters let future cost
 * changes verify old hashes (the parser re-derives with the stored values).
 */
export async function hashPassword(password) {
	const salt = randomBytes(16);
	const key = await scrypt(password, salt, SCRYPT_KEYLEN, {
		N: SCRYPT_N,
		r: SCRYPT_R,
		p: SCRYPT_P,
		maxmem: SCRYPT_MAXMEM,
	});
	return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/** Parse and bound the scrypt parameters of a stored value (blocks memory-amplifying values). */
function parseParams(parts) {
	if (parts.length !== 6 || parts[0] !== "scrypt") return undefined;
	const n = Number(parts[1]);
	const r = Number(parts[2]);
	const p = Number(parts[3]);
	if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return undefined;
	if (n <= 0 || n > 2 ** 17 || r <= 0 || r > 32 || p <= 0 || p > 4) return undefined;
	return { n, r, p };
}

/** Parse a stored string; malformed formats or parameters yield undefined. */
function parseStored(stored) {
	const parts = stored.split("$");
	const params = parseParams(parts);
	if (params === undefined) return undefined;
	const salt = Buffer.from(parts[4] ?? "", "base64url");
	const expected = Buffer.from(parts[5] ?? "", "base64url");
	if (salt.length !== 16 || expected.length !== SCRYPT_KEYLEN) return undefined;
	return { ...params, salt, expected };
}

/**
 * Constant-time verification against a stored hash. Malformed stored values
 * and derivation errors both resolve to false (never throw).
 */
export async function verifyPassword(password, stored) {
	const parsed = parseStored(stored);
	if (parsed === undefined) return false;
	try {
		const key = await scrypt(password, parsed.salt, SCRYPT_KEYLEN, {
			N: parsed.n,
			r: parsed.r,
			p: parsed.p,
			maxmem: SCRYPT_MAXMEM,
		});
		return timingSafeEqual(key, parsed.expected);
	} catch {
		return false;
	}
}
