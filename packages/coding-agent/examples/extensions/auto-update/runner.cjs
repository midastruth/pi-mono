#!/usr/bin/env node

const { spawn } = require("node:child_process");
const { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mkdirForFile(filePath) {
	mkdirSync(dirname(filePath), { recursive: true });
}

function writeJsonFile(filePath, value) {
	mkdirForFile(filePath);
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function appendLog(logFile, message) {
	mkdirForFile(logFile);
	appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`, "utf8");
}

function parseInstallMethod(value) {
	return value === "npm" || value === "pnpm" || value === "yarn" || value === "bun" || value === "unknown"
		? value
		: undefined;
}

function parseCommandSpec(value) {
	if (!value || typeof value !== "object") {
		throw new Error("Invalid command spec");
	}

	if (value.kind === "shell" && typeof value.command === "string" && value.command.trim().length > 0) {
		return {
			kind: "shell",
			command: value.command.trim(),
		};
	}

	if (
		value.kind === "exec" &&
		typeof value.command === "string" &&
		value.command.trim().length > 0 &&
		Array.isArray(value.args) &&
		value.args.every((arg) => typeof arg === "string")
	) {
		return {
			kind: "exec",
			command: value.command.trim(),
			args: value.args,
		};
	}

	throw new Error("Invalid command spec");
}

function loadPosixPayload(payloadFile) {
	const parsed = JSON.parse(readFileSync(payloadFile, "utf8"));
	if (!isRecord(parsed)) {
		throw new Error("Invalid POSIX auto-update payload");
	}

	if (
		typeof parsed.updateId !== "string" ||
		parsed.updateId.trim().length === 0 ||
		typeof parsed.parentPid !== "number" ||
		!Number.isInteger(parsed.parentPid) ||
		parsed.parentPid <= 0 ||
		typeof parsed.cwd !== "string" ||
		parsed.cwd.trim().length === 0 ||
		typeof parsed.stateFile !== "string" ||
		parsed.stateFile.trim().length === 0 ||
		typeof parsed.statusFile !== "string" ||
		parsed.statusFile.trim().length === 0 ||
		typeof parsed.latestVersion !== "string" ||
		parsed.latestVersion.trim().length === 0 ||
		(parsed.mode !== "helper-update-only" && parsed.mode !== "helper-update-and-restart") ||
		typeof parsed.logFile !== "string" ||
		parsed.logFile.trim().length === 0 ||
		typeof parsed.updateCommandDisplay !== "string" ||
		parsed.updateCommandDisplay.trim().length === 0 ||
		typeof parsed.restartCommandDisplay !== "string" ||
		parsed.restartCommandDisplay.trim().length === 0
	) {
		throw new Error("Invalid POSIX auto-update payload");
	}

	return {
		updateId: parsed.updateId,
		parentPid: parsed.parentPid,
		cwd: parsed.cwd,
		stateFile: parsed.stateFile,
		statusFile: parsed.statusFile,
		latestVersion: parsed.latestVersion,
		mode: parsed.mode,
		updateCommand: parseCommandSpec(parsed.updateCommand),
		restartCommand: parseCommandSpec(parsed.restartCommand),
		updateCommandDisplay: parsed.updateCommandDisplay,
		restartCommandDisplay: parsed.restartCommandDisplay,
		logFile: parsed.logFile,
		validatedInstallMethod: parseInstallMethod(parsed.validatedInstallMethod),
	};
}

function loadWindowsPayload(payloadFile) {
	const parsed = JSON.parse(readFileSync(payloadFile, "utf8"));
	if (!isRecord(parsed)) {
		throw new Error("Invalid Windows auto-update payload");
	}

	if (
		typeof parsed.updateId !== "string" ||
		parsed.updateId.trim().length === 0 ||
		typeof parsed.parentPid !== "number" ||
		!Number.isInteger(parsed.parentPid) ||
		parsed.parentPid <= 0 ||
		typeof parsed.cwd !== "string" ||
		parsed.cwd.trim().length === 0 ||
		typeof parsed.stateFile !== "string" ||
		parsed.stateFile.trim().length === 0 ||
		typeof parsed.statusFile !== "string" ||
		parsed.statusFile.trim().length === 0 ||
		typeof parsed.latestVersion !== "string" ||
		parsed.latestVersion.trim().length === 0 ||
		(parsed.mode !== "helper-update-only" && parsed.mode !== "helper-update-and-restart") ||
		typeof parsed.logFile !== "string" ||
		parsed.logFile.trim().length === 0 ||
		typeof parsed.updateCommandDisplay !== "string" ||
		parsed.updateCommandDisplay.trim().length === 0 ||
		typeof parsed.restartCommandDisplay !== "string" ||
		parsed.restartCommandDisplay.trim().length === 0
	) {
		throw new Error("Invalid Windows auto-update payload");
	}

	return {
		updateId: parsed.updateId,
		parentPid: parsed.parentPid,
		cwd: parsed.cwd,
		stateFile: parsed.stateFile,
		statusFile: parsed.statusFile,
		latestVersion: parsed.latestVersion,
		mode: parsed.mode,
		updateCommand: parseCommandSpec(parsed.updateCommand),
		restartCommand: parseCommandSpec(parsed.restartCommand),
		logFile: parsed.logFile,
		updateCommandDisplay: parsed.updateCommandDisplay,
		restartCommandDisplay: parsed.restartCommandDisplay,
		validatedInstallMethod: parseInstallMethod(parsed.validatedInstallMethod),
	};
}

function writeValidatedState(payload) {
	let nextState = {};

	try {
		if (existsSync(payload.stateFile)) {
			const current = JSON.parse(readFileSync(payload.stateFile, "utf8"));
			if (current && typeof current === "object" && !Array.isArray(current)) {
				nextState = { ...current };
			}
		}
	} catch {
		nextState = {};
	}

	nextState.validatedUpdateCommand = payload.updateCommand;
	nextState.validatedRestartCommand = payload.restartCommand;
	nextState.validatedAt = Date.now();
	nextState.lastUpdatedVersion = payload.latestVersion;

	if (payload.validatedInstallMethod) {
		nextState.validatedInstallMethod = payload.validatedInstallMethod;
	}

	writeJsonFile(payload.stateFile, nextState);
}

function readStatus(statusFile) {
	try {
		const parsed = JSON.parse(readFileSync(statusFile, "utf8"));
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function writeWindowsStatus(payload, patch) {
	const current = readStatus(payload.statusFile);
	const nextStatus = {
		...current,
		updateId: payload.updateId,
		latestVersion: payload.latestVersion,
		mode: payload.mode,
		updateCommandDisplay: payload.updateCommandDisplay,
		restartCommandDisplay: payload.restartCommandDisplay,
		logFile: payload.logFile,
		...patch,
		lastTransitionAt: Date.now(),
	};
	writeJsonFile(payload.statusFile, nextStatus);
}

async function waitForParentExit(pid, logFile) {
	while (true) {
		try {
			process.kill(pid, 0);
			await delay(200);
		} catch (error) {
			if (!logFile) {
				return;
			}
			if (error && typeof error === "object" && error.code === "ESRCH") {
				return;
			}
			appendLog(logFile, "waitForParentExit continuing after error: " + (error instanceof Error ? error.message : String(error)));
			return;
		}
	}
}

function runCommand(spec, cwd, waitForExit, logFile) {
	return new Promise((resolve, reject) => {
		mkdirForFile(logFile);
		const logFd = openSync(logFile, "a");
		let closed = false;
		const closeLog = () => {
			if (closed) {
				return;
			}
			closed = true;
			closeSync(logFd);
		};
		const options = {
			cwd,
			stdio: ["ignore", logFd, logFd],
			env: process.env,
			shell: false,
			detached: !waitForExit,
		};
		const child =
			spec.kind === "shell"
				? process.platform === "win32"
					? spawn(spec.command, [], { ...options, shell: true })
					: spawn("sh", ["-lc", spec.command], options)
				: spawn(spec.command, spec.args, {
						...options,
						shell: process.platform === "win32",
				  });

		child.on("error", (error) => {
			closeLog();
			reject(error);
		});
		if (!waitForExit) {
			child.unref();
			closeLog();
			resolve(0);
			return;
		}

		child.on("close", (code) => {
			closeLog();
			resolve(code ?? 0);
		});
	});
}

function quoteWindowsArg(arg) {
	if (arg.length === 0) {
		return '""';
	}
	if (!/[\s"]/u.test(arg)) {
		return arg;
	}
	return '"' + arg.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1") + '"';
}

function toWindowsCommandLine(spec) {
	if (spec.kind === "shell") {
		return spec.command;
	}

	return [quoteWindowsArg(spec.command), ...spec.args.map((arg) => quoteWindowsArg(arg))].join(" ");
}

function runWindowsCommand(spec, cwd, waitForExit, logFile) {
	return new Promise((resolve, reject) => {
		mkdirForFile(logFile);
		const logFd = openSync(logFile, "a");
		let closed = false;
		const closeLog = () => {
			if (closed) {
				return;
			}
			closed = true;
			closeSync(logFd);
		};
		const commandLine = toWindowsCommandLine(spec);
		const child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", commandLine], {
			cwd,
			env: process.env,
			stdio: ["ignore", logFd, logFd],
			shell: false,
			windowsHide: true,
			detached: !waitForExit,
		});

		child.on("error", (error) => {
			closeLog();
			reject(error);
		});
		if (!waitForExit) {
			child.unref();
			closeLog();
			resolve(0);
			return;
		}

		child.on("close", (code) => {
			closeLog();
			resolve(code ?? 0);
		});
	});
}

async function runScheduledUpdate(payload) {
	appendLog(payload.logFile, "POSIX updater helper started for version " + payload.latestVersion + ".");
	writeWindowsStatus(payload, {
		phase: "updating",
		error: undefined,
	});

	appendLog(payload.logFile, "Waiting for pi process " + payload.parentPid + " to exit.");
	await waitForParentExit(payload.parentPid, payload.logFile);
	appendLog(payload.logFile, "pi process exited. Running update command: " + payload.updateCommandDisplay);

	const updateCode = await runCommand(payload.updateCommand, payload.cwd, true, payload.logFile);
	if (updateCode !== 0) {
		const errorMessage = "Update command failed with exit code " + updateCode + ". Run manually: " + payload.updateCommandDisplay;
		appendLog(payload.logFile, errorMessage);
		writeWindowsStatus(payload, {
			phase: "failed",
			error: errorMessage,
			failedAt: Date.now(),
		});
		process.exit(updateCode || 1);
	}

	writeValidatedState(payload);
	appendLog(payload.logFile, "Update command completed successfully.");
	writeWindowsStatus(payload, {
		phase: "updated",
		error: undefined,
		updatedAt: Date.now(),
	});
	appendLog(
		payload.logFile,
		"Update completed. Automatic restart disabled for the detached POSIX updater; restart pi manually using: " + payload.restartCommandDisplay,
	);
}

async function runWindowsScheduledUpdate(payload) {
	appendLog(payload.logFile, "Windows updater helper started for version " + payload.latestVersion + ".");
	writeWindowsStatus(payload, {
		phase: "updating",
		error: undefined,
	});

	appendLog(payload.logFile, "Waiting for pi process " + payload.parentPid + " to exit.");
	await waitForParentExit(payload.parentPid, payload.logFile);
	appendLog(payload.logFile, "pi process exited. Running update command: " + payload.updateCommandDisplay);

	const updateCode = await runWindowsCommand(payload.updateCommand, payload.cwd, true, payload.logFile);
	if (updateCode !== 0) {
		const errorMessage = "Update command failed with exit code " + updateCode + ". Run manually: " + payload.updateCommandDisplay;
		appendLog(payload.logFile, errorMessage);
		writeWindowsStatus(payload, {
			phase: "failed",
			error: errorMessage,
			failedAt: Date.now(),
		});
		process.exit(updateCode || 1);
	}

	writeValidatedState(payload);
	appendLog(payload.logFile, "Update command completed successfully.");
	writeWindowsStatus(payload, {
		phase: "updated",
		error: undefined,
		updatedAt: Date.now(),
	});

	if (payload.mode === "helper-update-only") {
		appendLog(payload.logFile, "Update completed. Automatic restart disabled; restart pi manually.");
		return;
	}

	appendLog(payload.logFile, "Launching restart command: " + payload.restartCommandDisplay);
	writeWindowsStatus(payload, {
		phase: "restarting",
		error: undefined,
	});

	try {
		await runWindowsCommand(payload.restartCommand, payload.cwd, false, payload.logFile);
		appendLog(payload.logFile, "Restart command launched successfully.");
		writeWindowsStatus(payload, {
			phase: "completed",
			error: undefined,
			completedAt: Date.now(),
		});
	} catch (error) {
		const errorMessage = "Restart command failed: " + (error instanceof Error ? error.message : String(error));
		appendLog(payload.logFile, errorMessage);
		writeWindowsStatus(payload, {
			phase: "failed",
			error: errorMessage,
			failedAt: Date.now(),
		});
		throw error;
	}
}

async function main() {
	if (process.argv[2] === "--windows-payload") {
		const payloadFile = process.argv[3];
		if (!payloadFile) {
			throw new Error("Missing Windows auto-update payload path");
		}
		const payload = loadWindowsPayload(payloadFile);
		await runWindowsScheduledUpdate(payload);
		return;
	}

	if (process.argv[2] === "--posix-payload") {
		const payloadFile = process.argv[3];
		if (!payloadFile) {
			throw new Error("Missing POSIX auto-update payload path");
		}
		const payload = loadPosixPayload(payloadFile);
		await runScheduledUpdate(payload);
		return;
	}

	throw new Error("Missing auto-update payload argument");
}

if (require.main === module) {
	main()
		.then(() => {
			process.exit(0);
		})
		.catch((error) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		});
}

module.exports = {
	loadPosixPayload,
	loadWindowsPayload,
	runCommand,
	runScheduledUpdate,
	runWindowsCommand,
	runWindowsScheduledUpdate,
	waitForParentExit,
	writeValidatedState,
	writeWindowsStatus,
};
