#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { hashPassword, MIN_PASSWORD_LENGTH } from "./crypto.js";
import { defaultStateFilePath, loadState, saveState, StateFileError } from "./state.js";

const USAGE = `dsh-simple-auth — dsh single-password authentication gate (CLI)

Usage:
  dsh-simple-auth init [--force] [--password-stdin]   初始化密码（首次；--force 覆盖已有密码）
  dsh-simple-auth passwd [--password-stdin]           重置密码（无需原密码，等同于机器管理员）
  dsh-simple-auth enable                              启用认证
  dsh-simple-auth disable                             禁用认证（效果等同未安装插件，访问不再受限）
  dsh-simple-auth unlock                              清除错误锁定（连续输错后的临时封锁）
  dsh-simple-auth status                              查看认证状态
  dsh-simple-auth --file <path> <command>             对指定状态文件操作（调试用）

密码通过 stdin 读取：脚本用 --password-stdin 管道输入，交互终端会提示输入。
密码至少 ${MIN_PASSWORD_LENGTH} 位。`;

const defaultIo = {
	out: (line) => process.stdout.write(`${line}\n`),
	err: (line) => process.stderr.write(`${line}\n`),
	readLine: async (prompt) => {
		if (process.stdin.isTTY && prompt !== "") process.stderr.write(prompt);
		const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
		for await (const line of lines) return line;
		return "";
	},
};

export async function main(argv, io) {
	const file = pickFile(argv);
	if (file === undefined) {
		io.err(USAGE);
		return 1;
	}
	const tokens = argv.filter((token) => token !== "--file" && token !== "--password-stdin" && token !== "--force");
	const command = tokens[0];
	const opts = {
		hasStdin: argv.includes("--password-stdin"),
		force: argv.includes("--force"),
	};
	switch (command) {
		case "init": return initPassword(file, opts, io);
		case "passwd": return resetPassword(file, opts, io);
		case "enable": return setEnabled(file, true, io);
		case "disable": return setEnabled(file, false, io);
		case "unlock": return unlock(file, io);
		case "status": return status(file, io);
		default:
			io.err(USAGE);
			return 1;
	}
}

/** Scan `--file <path>`; missing → default path; `--file` with no value → usage error. */
function pickFile(argv) {
	const at = argv.indexOf("--file");
	if (at === -1) return defaultStateFilePath();
	const value = argv[at + 1];
	if (value === undefined || value.startsWith("--")) return undefined;
	return value;
}

async function readPassword(io, opts, confirm = false) {
	// Reads one line from stdin: interactive terminals get a prompt, scripts
	// pipe the password (--password-stdin is accepted for explicitness).
	const first = await io.readLine(process.stdin.isTTY ? "Password: " : "");
	if (first === "") {
		io.err("empty password");
		return undefined;
	}
	if (first.length < MIN_PASSWORD_LENGTH) {
		io.err(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
		return undefined;
	}
	if (confirm) {
		const second = await io.readLine(process.stdin.isTTY ? "Confirm: " : "");
		if (second !== first) {
			io.err("passwords do not match");
			return undefined;
		}
	}
	return first;
}

async function initPassword(file, opts, io) {
	const snapshot = await loadSnapshot(file, io);
	if (snapshot === undefined) return 1;
	if (snapshot.missing) io.out("(state file does not exist yet — creating)");
	if (snapshot.state.passwordHash !== null && !opts.force) {
		io.err("password already initialized (use --force to overwrite, or dsh-simple-auth passwd)");
		return 1;
	}
	const password = await readPassword(io, opts, process.stdin.isTTY);
	if (password === undefined) return 1;
	snapshot.state.passwordHash = await hashPassword(password);
	snapshot.state.enabled = true;
	try {
		await saveState(file, snapshot.state);
	} catch (error) {
		io.err(messageOf(error));
		return 1;
	}
	io.out(`password initialized (${snapshot.state.enabled ? "auth enabled" : ""})`);
	return 0;
}

async function resetPassword(file, opts, io) {
	const snapshot = await loadSnapshot(file, io);
	if (snapshot === undefined) return 1;
	const password = await readPassword(io, opts, process.stdin.isTTY);
	if (password === undefined) return 1;
	snapshot.state.passwordHash = await hashPassword(password);
	try {
		await saveState(file, snapshot.state);
	} catch (error) {
		io.err(messageOf(error));
		return 1;
	}
	io.out("password reset");
	return 0;
}

async function setEnabled(file, enabled, io) {
	const snapshot = await loadSnapshot(file, io);
	if (snapshot === undefined) return 1;
	snapshot.state.enabled = enabled;
	try {
		await saveState(file, snapshot.state);
	} catch (error) {
		io.err(messageOf(error));
		return 1;
	}
	io.out(enabled ? "auth enabled" : "auth disabled");
	return 0;
}

async function unlock(file, io) {
	const snapshot = await loadSnapshot(file, io);
	if (snapshot === undefined) return 1;
	const lockout = snapshot.state.lockout;
	if (lockout.failures === 0 && lockout.lockedUntil === 0) {
		io.out("nothing to unlock");
		return 0;
	}
	lockout.failures = 0;
	lockout.lastFailureAt = 0;
	lockout.lockedUntil = 0;
	try {
		await saveState(file, snapshot.state);
	} catch (error) {
		io.err(messageOf(error));
		return 1;
	}
	io.out("lockout cleared");
	return 0;
}

async function status(file, io) {
	let snapshot;
	try {
		snapshot = await loadState(file);
	} catch (error) {
		io.err(messageOf(error));
		return 1;
	}
	const state = snapshot.state;
	const lockout = state.lockout;
	const now = Date.now();
	const locked = lockout.lockedUntil > now;
	io.out(`state file: ${file}`);
	io.out(`enabled: ${state.enabled === true ? "yes" : "no"}`);
	io.out(`password: ${state.passwordHash === null ? "not set" : "set"}`);
	io.out(`sessions: ${Object.keys(state.sessions).length}`);
	io.out(
		`lockout: ${locked ? `locked (retry in ${Math.max(1, Math.ceil((lockout.lockedUntil - now) / 1000))}s)` : `${lockout.failures} failure(s)`}`
	);
	if (snapshot.missing) io.out("note: state file does not exist yet — first open of dsh will ask you to set a password (or run: dsh-simple-auth init)");
	return 0;
}

async function loadSnapshot(file, io) {
	try {
		return await loadState(file);
	} catch (error) {
		io.err(messageOf(error));
		return undefined;
	}
}

function messageOf(error) {
	if (error instanceof StateFileError) return error.message;
	if (error instanceof Error) return error.message;
	return String(error);
}

// Entry detection must compare real paths: pnpm installs node_modules as
// symlinks, so argv[1] may be a link while import.meta.url is the real file.
const entryPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (import.meta.url === pathToFileURL(entryPath).href) {
	void main(process.argv.slice(2), defaultIo).then((code) => {
		process.exitCode = code;
	});
}
