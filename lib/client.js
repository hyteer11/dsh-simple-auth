/**
 * dsh-simple-auth client bundle (hand-written; no build step).
 *
 * Registers:
 * - a global lock overlay in `shell.overlay`: Ctrl+L (or Cmd+L on macOS)
 *   locks the interface, and the tab-switch privacy lock also locks when the
 *   page becomes hidden; unlocking re-verifies the password against the host.
 * - a settings section (`settings.section`) with the auth status, lock and
 *   logout actions, a change-password form (requires the original password),
 *   and a disable-auth form (requires the original password).
 *
 * The bundle format mirrors the compiled output of the official packages:
 * `window.__ModuleLoader__.load({ id, factory })`, plain JavaScript, no
 * imports, no JSX.
 */
window.__ModuleLoader__.load({
	id: "dsh-simple-auth",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var React = require("react");
		var h = React.createElement;
		var useState = React.useState;
		var useEffect = React.useEffect;
		var useRef = React.useRef;
		var useSyncExternalStore = React.useSyncExternalStore;

		var NS = "dsh-simple-auth";

		// Locale-bound translator: bound inside apply() to the live locale
		// service; components call t() at render time so translations follow
		// the current snapshot.
		var boundT = null;
		function t(key, params) {
			return boundT !== null ? boundT(key, params) : key;
		}

		// ── dictionaries ────────────────────────────────────────────────────────
		var zh = {
			"section.label": "安全与认证",
			"status.title": "认证状态",
			"status.loading": "加载中…",
			"enabled": "认证已启用",
			"disabled": "认证已禁用",
			"disabled.hint": "访问不受限。可在命令行用 dsh-simple-auth enable 重新启用。",
			"needsSetup": "尚未设置密码",
			"authenticated": "已认证",
			"notAuthenticated": "未认证",
			"expires": "免认证有效期至",
			"never": "无有效会话",
			"locked": "已触发错误锁定",
			"retryAfter": "请 {seconds} 秒后重试",
			"failures": "错误次数 {n}/{max}",
			"actions.title": "操作",
			"lock": "锁定界面（Ctrl+L）",
			"logout": "退出登录",
			"change.title": "修改密码",
			"oldPassword": "原密码",
			"newPassword": "新密码（至少 6 位）",
			"confirmPassword": "确认新密码",
			"change.submit": "确认修改",
			"change.ok": "密码已修改，其它会话已退出登录",
			"change.wrong": "原密码错误",
			"change.mismatch": "两次输入的新密码不一致",
			"change.short": "新密码至少 6 位",
			"change.locked": "尝试过多，已临时锁定",
			"disable.title": "禁用认证",
			"disable.hint": "禁用后访问不再受限。需提供当前密码。",
			"disable.submit": "禁用认证",
			"disable.ok": "认证已禁用，页面即将刷新…",
			"disable.wrong": "密码错误",
			"unlock.title": "dsh 已锁定",
			"unlock.sub": "请输入密码解锁（Ctrl+L / 切换标签页会重新锁定）",
			"unlock.placeholder": "密码",
			"unlock.submit": "解锁",
			"unlock.error": "密码错误",
			"unlock.locked": "尝试过多，已临时锁定，请 {seconds} 秒后重试",
			"appearance.title": "锁定界面外观",
			"appearance.hint": "背景可设为默认遮罩、纯色或背景图；纯色模式会自动适配文字颜色。",
			"appearance.mode.mask": "默认遮罩",
			"appearance.mode.color": "纯色",
			"appearance.mode.image": "背景图",
			"appearance.color": "背景颜色",
			"appearance.image.placeholder": "https://… 背景图 URL（输入即生效）",
			"generic.error": "操作失败，请重试",
		};
		var en = {
			"section.label": "Security & Auth",
			"status.title": "Auth status",
			"status.loading": "Loading…",
			"enabled": "Auth enabled",
			"disabled": "Auth disabled",
			"disabled.hint": "Access is unrestricted. Re-enable with `dsh-simple-auth enable` on the command line.",
			"needsSetup": "No password set yet",
			"authenticated": "Authenticated",
			"notAuthenticated": "Not authenticated",
			"expires": "Session valid until",
			"never": "No active session",
			"locked": "Locked out after too many attempts",
			"retryAfter": "Try again in {seconds}s",
			"failures": "Failures {n}/{max}",
			"actions.title": "Actions",
			"lock": "Lock (Ctrl+L)",
			"logout": "Sign out",
			"change.title": "Change password",
			"oldPassword": "Current password",
			"newPassword": "New password (min 6 chars)",
			"confirmPassword": "Confirm new password",
			"change.submit": "Change password",
			"change.ok": "Password changed; other sessions were signed out",
			"change.wrong": "Current password is incorrect",
			"change.mismatch": "New passwords do not match",
			"change.short": "New password must be at least 6 characters",
			"change.locked": "Too many attempts; temporarily locked",
			"disable.title": "Disable auth",
			"disable.hint": "Access becomes unrestricted. Your current password is required.",
			"disable.submit": "Disable auth",
			"disable.ok": "Auth disabled; reloading…",
			"disable.wrong": "Incorrect password",
			"unlock.title": "dsh is locked",
			"unlock.sub": "Enter your password to unlock (Ctrl+L / switching tabs re-locks)",
			"unlock.placeholder": "Password",
			"unlock.submit": "Unlock",
			"unlock.error": "Incorrect password",
			"unlock.locked": "Too many attempts; try again in {seconds}s",
			"appearance.title": "Lock screen appearance",
			"appearance.hint": "Background can be the default mask, a solid color, or an image; solid colors adapt the text contrast automatically.",
			"appearance.mode.mask": "Mask",
			"appearance.mode.color": "Color",
			"appearance.mode.image": "Image",
			"appearance.color": "Background color",
			"appearance.image.placeholder": "https://… background image URL (applies as you type)",
			"generic.error": "Request failed; please retry",
		};

		// ── lock store (module-scoped, shared by the overlay and the shortcut) ──
		var locked = false;
		var lockListeners = new Set();
		function setLocked(value) {
			if (locked === value) return;
			locked = value;
			for (var _i = 0, _arr = Array.from(lockListeners); _i < _arr.length; _i++) _arr[_i]();
		}
		function subscribeLock(listener) {
			lockListeners.add(listener);
			return function () {
				lockListeners.delete(listener);
			};
		}
		function getLocked() {
			return locked;
		}

		// ── lock-screen appearance preferences (persisted locally) ──────────────
		// mode: "mask" (default blur mask) | "color" (solid color, auto-contrast)
		//       | "image" (background image URL with a readability overlay)
		var PREF_KEY = "dsh-simple-auth.lockScreen";
		var DEFAULT_PREFS = { mode: "mask", color: "#1c2333", image: "" };
		var lockPrefs = loadLockPrefs();
		var prefListeners = new Set();
		function loadLockPrefs() {
			try {
				var raw = window.localStorage.getItem(PREF_KEY);
				if (!raw) return Object.assign({}, DEFAULT_PREFS);
				var parsed = JSON.parse(raw);
				return {
					mode: parsed.mode === "color" || parsed.mode === "image" ? parsed.mode : "mask",
					color: typeof parsed.color === "string" && /^#[0-9a-fA-F]{6}$/.test(parsed.color) ? parsed.color.toLowerCase() : DEFAULT_PREFS.color,
					image: typeof parsed.image === "string" ? parsed.image : "",
				};
			} catch (_) {
				return Object.assign({}, DEFAULT_PREFS);
			}
		}
		function setLockPrefs(patch) {
			lockPrefs = Object.assign({}, lockPrefs, patch);
			try {
				window.localStorage.setItem(PREF_KEY, JSON.stringify(lockPrefs));
			} catch (_) {}
			for (var _i = 0, _arr = Array.from(prefListeners); _i < _arr.length; _i++) _arr[_i]();
		}
		function subscribePrefs(listener) {
			prefListeners.add(listener);
			return function () {
				prefListeners.delete(listener);
			};
		}
		function getPrefs() {
			return lockPrefs;
		}
		/** Relative luminance → readable text color for a given hex background. */
		function contrastColor(hex) {
			var m = /^#([0-9a-fA-F]{6})$/.exec(hex);
			if (m === null) return "#f2f4f7";
			var r = parseInt(m[1].slice(0, 2), 16) / 255;
			var g = parseInt(m[1].slice(2, 4), 16) / 255;
			var b = parseInt(m[1].slice(4, 6), 16) / 255;
			var lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
			return lum > 0.5 ? "#16181d" : "#f2f4f7";
		}

		// ── shared styles (theme tokens with neutral fallbacks) ──────────────────
		var CARD = {
			border: "1px solid var(--dsw-alias-border-l1, #26292f)",
			borderRadius: 12,
			padding: "16px 18px",
			marginBottom: 14,
			background: "var(--dsw-alias-bg-layer-1, #14161a)",
		};
		var TITLE = {
			margin: "0 0 10px",
			fontSize: 15,
			fontWeight: 600,
			color: "var(--dsw-alias-label-primary, #e8eaed)",
		};
		var TEXT = {
			margin: "6px 0 0",
			fontSize: 13,
			lineHeight: 1.5,
			color: "var(--dsw-alias-label-secondary, #9aa0a8)",
		};
		var LABEL = {
			display: "block",
			marginTop: 10,
			fontSize: 13,
			color: "var(--dsw-alias-label-secondary, #9aa0a8)",
		};
		var INPUT = {
			display: "block",
			boxSizing: "border-box",
			width: "100%",
			marginTop: 6,
			padding: "8px 10px",
			borderRadius: 8,
			border: "1px solid var(--dsw-alias-border-l2, #2c3037)",
			background: "var(--dsw-alias-bg-layer-2, #0e1013)",
			color: "var(--dsw-alias-label-primary, #e8eaed)",
			fontFamily: "inherit",
			fontSize: 14,
		};
		function button(background, color, border) {
			return {
				display: "inline-flex",
				alignItems: "center",
				gap: 6,
				marginTop: 12,
				padding: "8px 14px",
				borderRadius: 8,
				border: border !== undefined ? border : 0,
				background: background,
				color: color,
				fontFamily: "inherit",
				fontSize: 14,
				fontWeight: 500,
				cursor: "pointer",
			};
		}
		// High-contrast variants: solid accent, muted danger (darker and less
		// saturated for destructive actions), brand outline.
		var BTN_ACCENT = button("var(--dsw-alias-brand-primary, #4d7cfe)", "#fff");
		var BTN_DANGER_MUTED = button(
			"color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 58%, #1a1011)",
			"rgba(255, 255, 255, .95)"
		);
		var BTN_OUTLINE = button(
			"color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 12%, transparent)",
			"var(--dsw-alias-brand-primary, #4d7cfe)",
			"1px solid var(--dsw-alias-brand-primary, #4d7cfe)"
		);
		var MSG_OK = { marginTop: 10, fontSize: 13, color: "var(--dsw-alias-state-success-primary, #46a758)" };
		var MSG_ERR = { marginTop: 10, fontSize: 13, color: "var(--dsw-alias-state-error-primary, #e5484d)" };

		function post(path, data) {
			return fetch(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(data),
			}).then(function (res) {
				return res.json().catch(function () {
					return {};
				}).then(function (body) {
					return { ok: res.ok, status: res.status, body: body };
				});
			});
		}

		// ── lock screen ───────────────────────────────────────────────────────────
		function LockScreen() {
			var prefs = useSyncExternalStore(subscribePrefs, getPrefs);
			var _a = useState(""), password = _a[0], setPassword = _a[1];
			var _b = useState(null), error = _b[0], setError = _b[1];
			var _c = useState(false), busy = _c[0], setBusy = _c[1];
			var inputRef = useRef(null);
			useEffect(function () {
				var node = inputRef.current;
				if (node !== null && node !== undefined) node.focus();
			}, []);
			var submit = function (e) {
				if (e !== undefined && e.preventDefault !== undefined) e.preventDefault();
				if (busy || password === "") return;
				setBusy(true);
				setError(null);
				post("/auth/unlock", { password: password }).then(function (res) {
					if (res.ok) {
						setPassword("");
						setLocked(false);
						return;
					}
					if (res.status === 429 && res.body && res.body.retryAfterSeconds) {
						setError("unlock.locked:" + res.body.retryAfterSeconds);
					} else if (res.status === 401) {
						setError("unlock.error");
					} else {
						setError("generic.error");
					}
				}).catch(function () {
					setError("generic.error");
				}).finally(function () {
					setBusy(false);
				});
			};
			var message = error === null ? null : (
				String(error).indexOf("unlock.locked:") === 0
					? t("unlock.locked", { seconds: String(error).slice(13) })
					: t(String(error))
			);

			// Background by mode; the solid-color mode adapts text contrast.
			var layer = { position: "fixed", inset: 0, zIndex: 2147483000, display: "flex", alignItems: "center", justifyContent: "center" };
			var fg = "#f2f4f7";
			var cardBg;
			var cardBorder;
			if (prefs.mode === "color") {
				fg = contrastColor(prefs.color);
				layer.background = "linear-gradient(160deg, rgba(255,255,255,.05), rgba(0,0,0,.18)), " + prefs.color;
				cardBg = fg === "#f2f4f7" ? "rgba(10, 12, 16, .42)" : "rgba(255, 255, 255, .55)";
				cardBorder = fg === "#f2f4f7" ? "rgba(255,255,255,.14)" : "rgba(0,0,0,.12)";
			} else if (prefs.mode === "image" && prefs.image !== "") {
				layer.backgroundImage = "linear-gradient(rgba(8,10,14,.55), rgba(8,10,14,.55)), url(" + JSON.stringify(prefs.image) + ")";
				layer.backgroundSize = "cover";
				layer.backgroundPosition = "center";
				cardBg = "rgba(12, 14, 18, .55)";
				cardBorder = "rgba(255,255,255,.14)";
			} else {
				layer.background = "var(--dsw-alias-bg-mask-drop, rgba(0,0,0,.72))";
				layer.backdropFilter = "blur(4px)";
				layer.WebkitBackdropFilter = "blur(4px)";
				cardBg = "var(--dsw-alias-bg-layer-1, #14161a)";
				cardBorder = "var(--dsw-alias-border-l1, #26292f)";
			}
			var subColor = fg === "#f2f4f7" ? "rgba(242, 244, 247, .72)" : "rgba(22, 24, 29, .7)";

			return h("div", { style: layer },
				h("form", {
					onSubmit: submit,
					style: {
						width: "min(92vw, 340px)",
						padding: "22px 24px",
						borderRadius: 14,
						background: cardBg,
						border: "1px solid " + cardBorder,
						boxShadow: "0 16px 48px rgba(0,0,0,.45)",
						backdropFilter: "blur(8px)",
						WebkitBackdropFilter: "blur(8px)",
					},
				},
					h("div", { style: { fontSize: 16, fontWeight: 600, color: fg } }, t("unlock.title")),
					h("div", { style: { marginTop: 4, fontSize: 12.5, lineHeight: 1.5, color: subColor } }, t("unlock.sub")),
					h("div", { style: { display: "flex", gap: 8, marginTop: 16 } },
						h("input", {
							ref: inputRef,
							type: "password",
							value: password,
							placeholder: t("unlock.placeholder"),
							autoComplete: "current-password",
							disabled: busy,
							onChange: function (e) { setPassword(e.target.value); },
							style: {
								flex: 1,
								minWidth: 0,
								padding: "9px 12px",
								borderRadius: 8,
								border: "1px solid " + cardBorder,
								background: "rgba(0,0,0,.18)",
								color: fg,
								fontFamily: "inherit",
								fontSize: 14,
								outline: "none",
							},
						}),
						h("button", {
							type: "submit",
							disabled: busy || password === "",
							style: {
								padding: "9px 16px",
								borderRadius: 8,
								border: 0,
								background: "var(--dsw-alias-brand-primary, #4d7cfe)",
								color: "#fff",
								fontFamily: "inherit",
								fontSize: 14,
								fontWeight: 600,
								cursor: "pointer",
							},
						}, t("unlock.submit"))
					),
					message !== null && h("div", { style: { marginTop: 10, fontSize: 13, color: "var(--dsw-alias-state-error-primary, #ff8b8b)" } }, message)
				)
			);
		}

		function LockOverlay() {
			var isLocked = useSyncExternalStore(subscribeLock, getLocked);
			return isLocked ? h(LockScreen, null) : null;
		}

		// ── settings section ──────────────────────────────────────────────────────
		function useAuthStatus() {
			var _a = useState(null), status = _a[0], setStatus = _a[1];
			useEffect(function () {
				var cancelled = false;
				fetch("/auth/status").then(function (res) {
					return res.json();
				}).then(function (body) {
					if (!cancelled) setStatus(body);
				}).catch(function () {
					if (!cancelled) setStatus({ error: true });
				});
				return function () {
					cancelled = true;
				};
			}, []);
			return status;
		}

		function fmtTime(value) {
			if (value === null || value === undefined) return null;
			try {
				return new Date(value).toLocaleString();
			} catch (_) {
				return null;
			}
		}

		function StatusCard(status) {
			if (status === null) return h("div", { style: CARD }, h("div", { style: TITLE }, t("status.title")), h("div", { style: TEXT }, t("status.loading")));
			var rows = [];
			rows.push(h("div", { key: "enabled", style: TEXT },
				(status.enabled === true ? t("enabled") : t("disabled")) + (status.enabled === true && status.needsSetup === true ? " · " + t("needsSetup") : "")
			));
			if (status.enabled === true) {
				rows.push(h("div", { key: "session", style: TEXT },
					(status.authenticated === true ? t("authenticated") : t("notAuthenticated")) +
					(status.authenticated === true && status.sessionExpiresAt !== null ? " · " + t("expires") + " " + fmtTime(status.sessionExpiresAt) : "")
				));
				rows.push(h("div", { key: "lockout", style: Object.assign({}, TEXT, { color: status.locked === true ? "var(--dsw-alias-state-error-primary, #e5484d)" : undefined }) },
					status.locked === true
						? t("locked") + (status.retryAfterSeconds !== null ? " · " + t("retryAfter", { seconds: status.retryAfterSeconds }) : "")
						: t("failures", { n: status.failures ?? 0, max: status.maxAttempts ?? 0 })
				));
			}
			return h("div", { style: CARD },
				h("div", { style: TITLE }, t("status.title")),
				rows
			);
		}

		function ChangePasswordForm() {
			var _a = useState(""), oldPw = _a[0], setOldPw = _a[1];
			var _b = useState(""), newPw = _b[0], setNewPw = _b[1];
			var _c = useState(""), confirmPw = _c[0], setConfirmPw = _c[1];
			var _d = useState(null), msg = _d[0], setMsg = _d[1];
			var _e = useState(false), busy = _e[0], setBusy = _e[1];
			var submit = function (e) {
				e.preventDefault();
				if (busy) return;
				if (newPw.length < 6) { setMsg({ kind: "error", text: t("change.short") }); return; }
				if (newPw !== confirmPw) { setMsg({ kind: "error", text: t("change.mismatch") }); return; }
				setBusy(true);
				setMsg(null);
				post("/auth/change-password", { oldPassword: oldPw, newPassword: newPw }).then(function (res) {
					if (res.ok) {
						setMsg({ kind: "ok", text: t("change.ok") });
						setOldPw(""); setNewPw(""); setConfirmPw("");
						return;
					}
					if (res.status === 429) {
						setMsg({ kind: "error", text: res.body && res.body.retryAfterSeconds ? t("retryAfter", { seconds: res.body.retryAfterSeconds }) : t("change.locked") });
					} else if (res.status === 401) {
						setMsg({ kind: "error", text: t("change.wrong") });
					} else {
						setMsg({ kind: "error", text: (res.body && res.body.error) || t("generic.error") });
					}
				}).catch(function () {
					setMsg({ kind: "error", text: t("generic.error") });
				}).finally(function () {
					setBusy(false);
				});
			};
			return h("div", { style: CARD },
				h("div", { style: TITLE }, t("change.title")),
				h("form", { onSubmit: submit },
					h("label", { style: LABEL }, t("oldPassword")),
					h("input", { type: "password", value: oldPw, autoComplete: "current-password", onChange: function (e) { setOldPw(e.target.value); }, style: INPUT }),
					h("label", { style: LABEL }, t("newPassword")),
					h("input", { type: "password", value: newPw, autoComplete: "new-password", onChange: function (e) { setNewPw(e.target.value); }, style: INPUT }),
					h("label", { style: LABEL }, t("confirmPassword")),
					h("input", { type: "password", value: confirmPw, autoComplete: "new-password", onChange: function (e) { setConfirmPw(e.target.value); }, style: INPUT }),
					h("button", { type: "submit", disabled: busy, style: BTN_ACCENT }, t("change.submit")),
					msg !== null && h("div", { style: msg.kind === "ok" ? MSG_OK : MSG_ERR }, msg.text)
				)
			);
		}

		function DisableForm() {
			var _a = useState(""), password = _a[0], setPassword = _a[1];
			var _b = useState(null), msg = _b[0], setMsg = _b[1];
			var _c = useState(false), busy = _c[0], setBusy = _c[1];
			var submit = function (e) {
				e.preventDefault();
				if (busy) return;
				setBusy(true);
				setMsg(null);
				post("/auth/disable", { password: password }).then(function (res) {
					if (res.ok) {
						setMsg({ kind: "ok", text: t("disable.ok") });
						setTimeout(function () { window.location.reload(); }, 800);
						return;
					}
					if (res.status === 429) {
						setMsg({ kind: "error", text: res.body && res.body.retryAfterSeconds ? t("retryAfter", { seconds: res.body.retryAfterSeconds }) : t("generic.error") });
					} else if (res.status === 401) {
						setMsg({ kind: "error", text: t("disable.wrong") });
					} else {
						setMsg({ kind: "error", text: (res.body && res.body.error) || t("generic.error") });
					}
				}).catch(function () {
					setMsg({ kind: "error", text: t("generic.error") });
				}).finally(function () {
					setBusy(false);
				});
			};
			return h("div", { style: CARD },
				h("div", { style: TITLE }, t("disable.title")),
				h("div", { style: TEXT }, t("disable.hint")),
				h("form", { onSubmit: submit },
					h("input", { type: "password", value: password, autoComplete: "current-password", placeholder: t("unlock.placeholder"), onChange: function (e) { setPassword(e.target.value); }, style: Object.assign({}, INPUT, { marginTop: 12 }) }),
					h("button", { type: "submit", disabled: busy, style: BTN_DANGER_MUTED }, t("disable.submit")),
					msg !== null && h("div", { style: msg.kind === "ok" ? MSG_OK : MSG_ERR }, msg.text)
				)
			);
		}

		// ── lock-screen appearance settings ──────────────────────────────────────
		function LockAppearanceCard() {
			var prefs = useSyncExternalStore(subscribePrefs, getPrefs);
			var modes = [
				{ key: "mask", label: t("appearance.mode.mask") },
				{ key: "color", label: t("appearance.mode.color") },
				{ key: "image", label: t("appearance.mode.image") },
			];
			return h("div", { style: CARD },
				h("div", { style: TITLE }, t("appearance.title")),
				h("div", { style: TEXT }, t("appearance.hint")),
				h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 } },
					modes.map(function (m) {
						var active = prefs.mode === m.key;
						return h("button", {
							key: m.key,
							type: "button",
							onClick: function () { setLockPrefs({ mode: m.key }); },
							style: Object.assign({}, active ? BTN_ACCENT : BTN_OUTLINE, { marginTop: 0 }),
						}, m.label);
					})
				),
				prefs.mode === "color" && h("div", { style: { display: "flex", alignItems: "center", gap: 10, marginTop: 14 } },
					h("label", { style: { fontSize: 13, color: "var(--dsw-alias-label-secondary, #9aa0a8)" } }, t("appearance.color")),
					h("input", {
						type: "color",
						value: prefs.color,
						onChange: function (e) { setLockPrefs({ color: e.target.value }); },
						style: {
							width: 44,
							height: 30,
							padding: 0,
							border: "1px solid var(--dsw-alias-border-l2, #2c3037)",
							borderRadius: 6,
							background: "none",
							cursor: "pointer",
						},
					}),
					h("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, #6a7078)" } }, prefs.color)
				),
				prefs.mode === "image" && h("input", {
					type: "text",
					value: prefs.image,
					placeholder: t("appearance.image.placeholder"),
					onChange: function (e) { setLockPrefs({ image: e.target.value }); },
					style: Object.assign({}, INPUT, { marginTop: 12 }),
				})
			);
		}

		function SecuritySection() {
			var status = useAuthStatus();
			return h("div", null,
				StatusCard(status),
				status !== null && status.enabled !== true
					? h("div", { style: CARD }, h("div", { style: TITLE }, t("disabled")), h("div", { style: TEXT }, t("disabled.hint")))
					: h("div", null,
						h("div", { style: CARD },
							h("div", { style: TITLE }, t("actions.title")),
							h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
								h("button", { type: "button", style: Object.assign({}, BTN_OUTLINE, { marginTop: 0 }), onClick: function () { setLocked(true); } }, t("lock")),
								// Native form POST: /auth/logout is POST-only; the
								// server clears the cookie and redirects (→ login page).
								h("form", { method: "post", action: "/auth/logout?next=/", style: { margin: 0 } },
									h("button", { type: "submit", style: Object.assign({}, BTN_DANGER_MUTED, { marginTop: 0 }) }, t("logout"))
								)
							)
						),
						h(LockAppearanceCard, null),
						h(ChangePasswordForm, null),
						h(DisableForm, null)
					)
			);
		}

		// ── plugin body ───────────────────────────────────────────────────────────
		var inject = ["slots", "locale"];
		function apply(ctx) {
			boundT = ctx.locale.bind(NS);

			// Lock shortcuts: Ctrl/Cmd+L, plus the privacy lock on tab switch.
			ctx.effect(function () {
				var onKeyDown = function (e) {
					if ((e.ctrlKey || e.metaKey) && (e.key === "l" || e.key === "L")) {
						e.preventDefault();
						setLocked(true);
					}
				};
				var onVisibility = function () {
					if (document.visibilityState === "hidden") setLocked(true);
				};
				window.addEventListener("keydown", onKeyDown, true);
				document.addEventListener("visibilitychange", onVisibility);
				return function () {
					window.removeEventListener("keydown", onKeyDown, true);
					document.removeEventListener("visibilitychange", onVisibility);
				};
			}, "dsh-simple-auth: lock shortcuts");

			ctx.effect(function () {
				return ctx.locale.register(NS, { zh: zh, en: en });
			}, "dsh-simple-auth: dictionaries");

			var slots = ctx.get("slots");
			if (slots === undefined) return;
			slots.inject("shell.overlay", function () {
				return slots.register({ name: "shell.overlay", id: "dsh-simple-auth-lock", order: 1000 }, LockOverlay);
			});
			slots.inject("settings.section", function () {
				return slots.register({
					name: "settings.section",
					id: "dsh-simple-auth-security",
					order: 30,
					label: function () { return t("section.label"); },
					locale: NS,
				}, SecuritySection);
			});
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
