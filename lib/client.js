/**
 * dsh-simple-auth client bundle (hand-written; no build step).
 *
 * Registers:
 * - a global lock overlay in `shell.overlay`: Ctrl+Shift+L (or Cmd+Shift+L on
 *   macOS) locks the interface; unlocking re-verifies the password against the
 *   host.
 * - a lock button in the sidebar footer (`sidebar.footer.action`), right
 *   aligned, for one-click locking.
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
		var ReactDOM = require("react-dom");
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
			"lock": "锁定界面（Ctrl+Shift+L）",
			"lock.short": "锁定",
			"logout": "退出登录",
			"change.title": "修改密码",
			"oldPassword": "原密码",
			"newPassword": "新密码（至少 6 位）",
			"confirmPassword": "确认新密码",
			"change.submit": "确认修改",
			"cancel": "取消",
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
			"unlock.sub": "请输入密码解锁",
			"unlock.placeholder": "输入密码解锁",
			"unlock.submit": "解锁",
			"unlock.error": "密码错误",
			"unlock.locked": "尝试过多，已临时锁定，请 {seconds} 秒后重试",
			"appearance.title": "锁定界面外观",
			"appearance.hint": "背景可设为纯色或背景图；纯色模式会自动适配文字颜色，输入框会自然融入背景。",
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
			"lock": "Lock (Ctrl+Shift+L)",
			"lock.short": "Lock",
			"logout": "Sign out",
			"change.title": "Change password",
			"oldPassword": "Current password",
			"newPassword": "New password (min 6 chars)",
			"confirmPassword": "Confirm new password",
			"change.submit": "Change password",
			"cancel": "Cancel",
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
			"unlock.sub": "Enter your password to unlock",
			"unlock.placeholder": "Enter password to unlock",
			"unlock.submit": "Unlock",
			"unlock.error": "Incorrect password",
			"unlock.locked": "Too many attempts; try again in {seconds}s",
			"appearance.title": "Lock screen appearance",
			"appearance.hint": "Background can be a solid color or an image; solid colors adapt the text contrast automatically and the input melts into the background.",
			"appearance.mode.color": "Color",
			"appearance.mode.image": "Image",
			"appearance.color": "Background color",
			"appearance.image.placeholder": "https://… background image URL (applies as you type)",
			"generic.error": "Request failed; please retry",
		};

		// ── lock store (module-scoped, shared by the overlay and the shortcut) ──
		// The lock is persisted so a page reload or a new tab does not silently
		// unlock it (an active lock must be cleared by unlocking).
		var LOCKED_KEY = "dsh-simple-auth.locked";
		var locked = loadLocked();
		var lockListeners = new Set();
		function loadLocked() {
			try {
				return window.localStorage.getItem(LOCKED_KEY) === "1";
			} catch (_) {
				return false;
			}
		}
		function setLocked(value) {
			if (locked === value) return;
			locked = value;
			try {
				if (value) window.localStorage.setItem(LOCKED_KEY, "1");
				else window.localStorage.removeItem(LOCKED_KEY);
			} catch (_) {}
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
		// mode: "color" (default, solid color with auto-contrast) | "image"
		//       (background image URL). No translucent mask / backdrop blur.
		var PREF_KEY = "dsh-simple-auth.lockScreen";
		var DEFAULT_PREFS = { mode: "color", color: "#f2f3f5", image: "" };
		var lockPrefs = loadLockPrefs();
		var prefListeners = new Set();
		function loadLockPrefs() {
			try {
				var raw = window.localStorage.getItem(PREF_KEY);
				if (!raw) return Object.assign({}, DEFAULT_PREFS);
				var parsed = JSON.parse(raw);
				return {
					// legacy "mask" mode collapses to the solid-color default
					mode: parsed.mode === "image" ? "image" : "color",
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
		// dsh-consistent button look: subtle elevated fills / outlines, rounded,
		// medium size — restrained, not heavy solid blocks.
		function button(background, border, color) {
			return {
				display: "inline-flex",
				alignItems: "center",
				gap: 6,
				padding: "8px 14px",
				borderRadius: 10,
				border: border,
				background: background,
				color: color,
				fontFamily: "inherit",
				fontSize: 13,
				fontWeight: 500,
				lineHeight: 1,
				cursor: "pointer",
				whiteSpace: "nowrap",
			};
		}
		// Neutral / primary action (same family as dsh's own elevated buttons).
		var BTN = button(
			"var(--dsw-alias-button-elevated-fill, #23262c)",
			"1px solid var(--dsw-alias-border-l2, #2c3037)",
			"var(--dsw-alias-label-primary, #e8eaed)"
		);
		// Quiet outline action.
		var BTN_OUTLINE = button(
			"transparent",
			"1px solid var(--dsw-alias-border-l2, #2c3037)",
			"var(--dsw-alias-label-primary, #e8eaed)"
		);
		// Destructive action, softened: a light red tint rather than a solid block.
		var BTN_DANGER = button(
			"color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 12%, transparent)",
			"1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 30%, transparent)",
			"var(--dsw-alias-state-error-primary, #e5484d)"
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

		// ── lock screen (full-page, no card box / mask) ──────────────────────────
		var unlockArrow = h("svg", {
			viewBox: "0 0 24 24",
			width: 18,
			height: 18,
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 2,
			strokeLinecap: "round",
			strokeLinejoin: "round",
			"aria-hidden": "true",
		},
			h("line", { x1: 5, y1: 12, x2: 19, y2: 12 }),
			h("polyline", { points: "12 5 19 12 12 19" })
		);
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
					// Auth disabled: nothing to protect — dismiss the overlay.
					if (res.status === 403) {
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

			// Solid color (auto-contrast) layered under an optional full-bleed
			// background image — never a translucent mask, never a card box. The
			// solid color is always present as a fallback so a broken image URL
			// cannot leave a transparent overlay.
			var layer = { position: "fixed", inset: 0, zIndex: 2147483000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 };
			var fg = contrastColor(prefs.color);
			layer.background = prefs.color;
			if (prefs.mode === "image" && prefs.image !== "") {
				layer.backgroundImage = "linear-gradient(rgba(250,251,252,.55), rgba(250,251,252,.55)), url(" + JSON.stringify(prefs.image) + ")";
				layer.backgroundSize = "cover";
				layer.backgroundPosition = "center";
			}
			// The input melts into the background: transparent fill, near-invisible border.
			var faintBorder = "rgba(0, 0, 0, .14)";
			if (fg === "#f2f4f7") {
				faintBorder = "rgba(255, 255, 255, .28)";
			}
			var inputStyle = {
				width: "100%",
				boxSizing: "border-box",
				padding: "12px 46px 12px 14px",
				borderRadius: 10,
				border: "1px solid " + faintBorder,
				background: "transparent",
				color: fg,
				fontFamily: "inherit",
				fontSize: 15,
				outline: "none",
			};
			return h("div", { style: layer },
				h("form", { onSubmit: submit, style: { width: "min(92vw, 320px)" } },
					h("div", { style: { position: "relative" } },
						h("input", {
							ref: inputRef,
							type: "password",
							value: password,
							placeholder: t("unlock.placeholder"),
							autoComplete: "current-password",
							disabled: busy,
							onChange: function (e) { setPassword(e.target.value); },
							style: inputStyle,
						}),
						h("button", {
							type: "submit",
							disabled: busy || password === "",
							"aria-label": t("unlock.submit"),
							title: t("unlock.submit"),
							style: {
								position: "absolute",
								right: 4,
								top: "50%",
								transform: "translateY(-50%)",
								width: 36,
								height: 36,
								border: 0,
								borderRadius: 8,
								background: "transparent",
								color: fg,
								cursor: "pointer",
								display: "inline-flex",
								alignItems: "center",
								justifyContent: "center",
							},
						}, unlockArrow)
					),
					message !== null && h("div", { style: { marginTop: 12, fontSize: 13, color: "#cf3f3f", textAlign: "center" } }, message)
				)
			);
		}

		function LockOverlay() {
			var isLocked = useSyncExternalStore(subscribeLock, getLocked);
			// Portal to document.body so the lock covers the whole viewport —
			// including any terminal / panel the app renders as a top-level
			// layer — instead of being confined to the AppFrame shell.
			if (!isLocked) return null;
			return ReactDOM.createPortal(h(LockScreen, null), document.body);
		}

		// ── sidebar footer lock button (one-click lock, right aligned) ──────────
		var lockIcon = h("svg", {
			viewBox: "0 0 24 24",
			width: 16,
			height: 16,
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 2,
			strokeLinecap: "round",
			strokeLinejoin: "round",
			"aria-hidden": "true",
		},
			h("rect", { x: 3, y: 11, width: 18, height: 11, rx: 2, ry: 2 }),
			h("path", { d: "M7 11V7a5 5 0 0 1 10 0v4" })
		);

		function SidebarLockButton(props) {
			var wide = props.wide !== false;
			var _a = useState(null), enabled = _a[0], setEnabled = _a[1];
			var _b = useState(false), hover = _b[0], setHover = _b[1];
			useEffect(function () {
				var cancelled = false;
				fetch("/auth/status").then(function (r) {
					return r.json();
				}).then(function (body) {
					if (!cancelled) setEnabled(body.enabled === true);
				}).catch(function () {
					if (!cancelled) setEnabled(true);
				});
				return function () {
					cancelled = true;
				};
			}, []);
			if (enabled !== true) return null;
			return h("button", {
				type: "button",
				title: t("lock"),
				"aria-label": t("lock"),
				onClick: function () { setLocked(true); },
				onMouseEnter: function () { setHover(true); },
				onMouseLeave: function () { setHover(false); },
				style: {
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					gap: 6,
					height: 32,
					flex: "none",
					marginLeft: wide ? "auto" : 0,
					padding: wide ? "0 12px" : 0,
					width: wide ? undefined : 32,
					border: 0,
					borderRadius: 8,
					background: hover ? "var(--dsw-alias-interactive-bg-hover, #1f2228)" : "transparent",
					color: "var(--dsw-alias-label-secondary, #9aa0a8)",
					cursor: "pointer",
					fontFamily: "inherit",
					fontSize: 13,
				},
			}, lockIcon, wide ? h("span", null, t("lock.short")) : null);
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
			var _o = useState(false), open = _o[0], setOpen = _o[1];
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
			if (!open) {
				return h("button", {
					type: "button",
					style: Object.assign({}, BTN, { marginTop: 2, marginRight: 8 }),
					onClick: function () { setOpen(true); },
				}, t("change.title"));
			}
			return h("div", { style: CARD },
				h("div", { style: TITLE }, t("change.title")),
				h("form", { onSubmit: submit },
					h("label", { style: LABEL }, t("oldPassword")),
					h("input", { type: "password", value: oldPw, autoComplete: "current-password", onChange: function (e) { setOldPw(e.target.value); }, style: INPUT }),
					h("label", { style: LABEL }, t("newPassword")),
					h("input", { type: "password", value: newPw, autoComplete: "new-password", onChange: function (e) { setNewPw(e.target.value); }, style: INPUT }),
					h("label", { style: LABEL }, t("confirmPassword")),
					h("input", { type: "password", value: confirmPw, autoComplete: "new-password", onChange: function (e) { setConfirmPw(e.target.value); }, style: INPUT }),
					h("div", { style: { display: "flex", gap: 8 } },
						h("button", { type: "submit", disabled: busy, style: Object.assign({}, BTN, { marginTop: 0 }) }, t("change.submit")),
						h("button", { type: "button", style: Object.assign({}, BTN_OUTLINE, { marginTop: 0 }), onClick: function () { setOpen(false); } }, t("cancel"))
					),
					msg !== null && h("div", { style: msg.kind === "ok" ? MSG_OK : MSG_ERR }, msg.text)
				)
			);
		}

		function DisableForm() {
			var _o = useState(false), open = _o[0], setOpen = _o[1];
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
			if (!open) {
				return h("button", {
					type: "button",
					style: Object.assign({}, BTN_DANGER, { marginTop: 2, marginRight: 8 }),
					onClick: function () { setOpen(true); },
				}, t("disable.title"));
			}
			return h("div", { style: CARD },
				h("div", { style: TITLE }, t("disable.title")),
				h("div", { style: TEXT }, t("disable.hint")),
				h("form", { onSubmit: submit },
					h("input", { type: "password", value: password, autoComplete: "current-password", placeholder: t("unlock.placeholder"), onChange: function (e) { setPassword(e.target.value); }, style: Object.assign({}, INPUT, { marginTop: 12 }) }),
					h("div", { style: { display: "flex", gap: 8 } },
						h("button", { type: "submit", disabled: busy, style: Object.assign({}, BTN_DANGER, { marginTop: 0 }) }, t("disable.submit")),
						h("button", { type: "button", style: Object.assign({}, BTN_OUTLINE, { marginTop: 0 }), onClick: function () { setOpen(false); } }, t("cancel"))
					),
					msg !== null && h("div", { style: msg.kind === "ok" ? MSG_OK : MSG_ERR }, msg.text)
				)
			);
		}

		// ── lock-screen appearance settings ──────────────────────────────────────
		function LockAppearanceCard() {
			var prefs = useSyncExternalStore(subscribePrefs, getPrefs);
			var modes = [
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
							style: Object.assign({}, active ? BTN : BTN_OUTLINE, { marginTop: 0 }),
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
									h("button", { type: "submit", style: Object.assign({}, BTN_DANGER, { marginTop: 0 }) }, t("logout"))
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

			// Lock shortcut: Ctrl/Cmd+Shift+L (deliberately not Ctrl+L, which
			// browsers reserve for the address bar). No auto-lock on tab switch.
			ctx.effect(function () {
				var onKeyDown = function (e) {
					if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "l" || e.key === "L")) {
						e.preventDefault();
						setLocked(true);
					}
				};
				window.addEventListener("keydown", onKeyDown, true);
				return function () {
					window.removeEventListener("keydown", onKeyDown, true);
				};
			}, "dsh-simple-auth: lock shortcut");

			ctx.effect(function () {
				return ctx.locale.register(NS, { zh: zh, en: en });
			}, "dsh-simple-auth: dictionaries");

			// Place the sidebar lock action on the SAME line as the settings
			// trigger (settings left, lock right). The core sidebar renders the
			// footer actions and the settings area as two stacked rows, so a small
			// CSS rule flattens them while the sidebar is expanded.
			//
			// The sidebar classes are CSS-Module names whose scope hash (hHd-Xa,
			// uWBG, ...) changes between dsh builds, so a hardcoded prefix (e.g.
			// ".hHd-Xa_root") silently stops matching and the footer reverts to a
			// stacked layout. Instead we match the stable class-name suffix
			// ("_footArea", "_settingsArea", "_footerActions", "_root",
			// "_collapsed"), scoped to the sidebar's stable data-slot wrapper —
			// this holds across dsh releases without re-pinning a hash.
			ctx.effect(function () {
				var el = document.createElement("style");
				el.setAttribute("data-dsh-simple-auth", "sidebar-footer");
				el.textContent = [
					'[data-slot="sidebar"] [class*="_root"]:not([class*="_collapsed"]) [class*="_footArea"]{flex-direction:row-reverse;align-items:center;gap:8px;}',
					'[data-slot="sidebar"] [class*="_root"]:not([class*="_collapsed"]) [class*="_settingsArea"]{flex:1;width:auto;min-width:0;}',
					'[data-slot="sidebar"] [class*="_root"]:not([class*="_collapsed"]) [class*="_footerActions"]{width:auto;flex:none;}',
				].join("");
				document.head.appendChild(el);
				return function () {
					if (el.parentNode !== null) el.parentNode.removeChild(el);
				};
			}, "dsh-simple-auth: sidebar footer layout");

			var slots = ctx.get("slots");
			if (slots === undefined) return;
			slots.inject("shell.overlay", function () {
				return slots.register({ name: "shell.overlay", id: "dsh-simple-auth-lock", order: 1000 }, LockOverlay);
			});
			slots.inject("sidebar.footer.action", function () {
				return slots.register({
					name: "sidebar.footer.action",
					id: "dsh-simple-auth-lock",
					order: 100,
					locale: NS,
				}, SidebarLockButton);
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
