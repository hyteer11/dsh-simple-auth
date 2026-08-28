/** Marker attached to wrapped handlers (idempotent re-wrap + self-check). */
export const GUARDED = Symbol.for("dsh-simple-auth.guarded");
/** Login page path (302 target when a navigation is denied). */
export const LOGIN_PATH = "/auth/login";
/** Whitelisted prefix: every /auth* path bypasses the gate (login/status/setup/...). */
export const AUTH_PATH_PREFIX = "/auth";

export function isGuarded(target) {
	return target?.[GUARDED] === true;
}

/** Whether a pathname belongs to the auth surface. */
export function isAuthPath(pathname) {
	return pathname === AUTH_PATH_PREFIX || pathname.startsWith(`${AUTH_PATH_PREFIX}/`);
}

/**
 * Wrap one HTTP handler with the gate. Denials are written by
 * {@link denyHttp}; the original handler is never called. Errors are not
 * caught here — the webserver owns error handling.
 */
export function guardHttp(gate, handler) {
	if (isGuarded(handler)) return handler;
	const guarded = (async (req, res) => {
		const pathname = new URL(req.url ?? "/", "http://x").pathname;
		if ((await gate.decide(req, pathname)) === "allow") {
			await handler(req, res);
			return;
		}
		denyHttp(req, res);
	});
	guarded[GUARDED] = true;
	return guarded;
}

/** Wrap one upgrade handler: denials refuse the handshake before the original handler runs. */
export function guardUpgrade(gate, handler) {
	if (isGuarded(handler)) return handler;
	const guarded = (async (req, socket, head) => {
		const pathname = new URL(req.url ?? "/", "http://x").pathname;
		if ((await gate.decide(req, pathname)) === "allow") {
			await handler(req, socket, head);
			return;
		}
		socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
		socket.destroy();
	});
	guarded[GUARDED] = true;
	return guarded;
}

/** Deny an HTTP request: HTML navigation → 302 to the login page; everything else → 401. */
export function denyHttp(req, res) {
	res.setHeader("cache-control", "no-store");
	const pathname = new URL(req.url ?? "/", "http://x").pathname;
	const wantsPage = req.method === "GET" && String(req.headers.accept ?? "").includes("text/html");
	if (wantsPage) {
		res.writeHead(302, { location: `${LOGIN_PATH}?next=${encodeURIComponent(pathname)}` });
		res.end();
		return;
	}
	res.writeHead(401, { "content-type": "text/plain" });
	res.end("unauthorized");
}

const unwrappers = new WeakMap();

/**
 * Wrap a WebServer (dsh-host-webserver) so every existing route, every future
 * registration, and the fallback seat answer through the gate. Idempotent per
 * server instance. Returns the disposer that restores the exact pre-wrap
 * snapshot and the original registration methods.
 */
export function wrapServer(server, gate) {
	const existing = unwrappers.get(server);
	if (existing !== undefined) return existing;

	const original = {
		register: server.register.bind(server),
		registerUpgrade: server.registerUpgrade.bind(server),
		registerFallback: server.registerFallback.bind(server),
	};
	const snapshot = {
		exact: new Map(server.exact),
		prefixes: new Map(server.prefixes),
		upgrades: new Map(server.upgrades),
		fallback: server.fallback,
	};

	const guardRoute = (route) => ({ ...route, handler: guardHttp(gate, route.handler) });
	for (const [path, route] of server.exact) server.exact.set(path, guardRoute(route));
	for (const [path, route] of server.prefixes) server.prefixes.set(path, guardRoute(route));
	for (const [path, route] of server.upgrades) server.upgrades.set(path, { ...route, handler: guardUpgrade(gate, route.handler) });
	if (server.fallback !== undefined) server.fallback = guardHttp(gate, server.fallback);

	const register = (route) => original.register(guardRoute(route));
	const registerUpgrade = (route) => original.registerUpgrade({ ...route, handler: guardUpgrade(gate, route.handler) });
	const registerFallback = (handler) => original.registerFallback(guardHttp(gate, handler));
	for (const fn of [register, registerUpgrade, registerFallback]) fn[GUARDED] = true;

	server.register = register;
	server.registerUpgrade = registerUpgrade;
	server.registerFallback = registerFallback;

	const unwrap = () => {
		server.exact.clear();
		for (const [path, route] of snapshot.exact) server.exact.set(path, route);
		server.prefixes.clear();
		for (const [path, route] of snapshot.prefixes) server.prefixes.set(path, route);
		server.upgrades.clear();
		for (const [path, route] of snapshot.upgrades) server.upgrades.set(path, route);
		server.fallback = snapshot.fallback;
		server.register = original.register;
		server.registerUpgrade = original.registerUpgrade;
		server.registerFallback = original.registerFallback;
		unwrappers.delete(server);
	};
	unwrappers.set(server, unwrap);
	return unwrap;
}

/**
 * Self-check: return the list of entries that are not guarded. The host plugin
 * throws when this list is non-empty (fail loud — an unguarded entry would
 * silently open a hole).
 */
export function assertGuarded(server) {
	const failures = [];
	for (const [path, route] of server.exact) {
		if (!isGuarded(route.handler)) failures.push(`exact:${path}`);
	}
	for (const [path, route] of server.prefixes) {
		if (!isGuarded(route.handler)) failures.push(`prefix:${path}`);
	}
	for (const [path, route] of server.upgrades) {
		if (!isGuarded(route.handler)) failures.push(`upgrade:${path}`);
	}
	if (server.fallback !== undefined && !isGuarded(server.fallback)) failures.push("fallback");
	return failures;
}
