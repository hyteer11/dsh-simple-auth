/**
 * Brute-force lockout over the persisted `lockout` object of the state file.
 *
 * After `maxAttempts` consecutive failures the login surface (login, unlock,
 * change-password, disable) is refused until `lockoutMs` elapses. The state is
 * persisted, so a process restart does not reset the countdown (the documented
 * escape hatch is `dsh-simple-auth disable` / `dsh-simple-auth unlock` from the command line).
 * Failures decay when no failure has occurred for a full lockout window.
 */
export class Lockout {
	maxAttempts;
	lockoutMs;
	now;
	constructor(options = {}) {
		this.maxAttempts = options.maxAttempts ?? 5;
		this.lockoutMs = (options.lockoutSeconds ?? 300) * 1000;
		this.now = options.now ?? Date.now;
	}

	/** Remaining locked milliseconds; 0 when not locked. Also decays stale failure counts. */
	remainingMs(lockout) {
		const now = this.now();
		if (lockout.lockedUntil > now) return lockout.lockedUntil - now;
		if (lockout.failures > 0 && now - lockout.lastFailureAt > this.lockoutMs) {
			lockout.failures = 0;
			lockout.lastFailureAt = 0;
			lockout.lockedUntil = 0;
		}
		return 0;
	}

	/** True while the lockout is active. */
	isLocked(lockout) {
		return this.remainingMs(lockout) > 0;
	}

	/**
	 * Record one failed attempt (mutates the lockout object) and return the
	 * resulting state: `{ locked, retryAfterSeconds }`. The lockout never
	 * re-locks while already locked (refused attempts do not extend it).
	 */
	recordFailure(lockout) {
		const now = this.now();
		if (lockout.lockedUntil > now) {
			return { locked: true, retryAfterSeconds: Math.max(1, Math.ceil((lockout.lockedUntil - now) / 1000)) };
		}
		lockout.failures += 1;
		lockout.lastFailureAt = now;
		if (lockout.failures >= this.maxAttempts) {
			lockout.lockedUntil = now + this.lockoutMs;
		}
		return this.afterRecord(lockout, now);
	}

	/** Successful verification clears the counters. */
	recordSuccess(lockout) {
		lockout.failures = 0;
		lockout.lastFailureAt = 0;
		lockout.lockedUntil = 0;
	}

	/** Derived view after a mutation. */
	afterRecord(lockout, now = this.now()) {
		const locked = lockout.lockedUntil > now;
		return {
			locked,
			retryAfterSeconds: locked ? Math.max(1, Math.ceil((lockout.lockedUntil - now) / 1000)) : undefined,
		};
	}
}
