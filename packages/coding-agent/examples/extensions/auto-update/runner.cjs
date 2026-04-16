#!/usr/bin/env node

const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
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

function decodePayload(encodedPayload) {
	const json = Buffer.from(encodedPayload, "base64url").toString("utf8");
	const parsed = JSON.parse(json);

	if (!parsed || typeof parsed !== "object") {
		throw new Error("Invalid auto-update payload");
	}

	if (
		typeof parsed.parentPid !== "number" ||
		!Number.isInteger(parsed.parentPid) ||
		parsed.parentPid <= 0 ||
		typeof parsed.cwd !== "string" ||
		parsed.cwd.length === 0 ||
		typeof parsed.stateFile !== "string" ||
		parsed.stateFile.length === 0 ||
		typeof parsed.latestVersion !== "string" ||
		parsed.latestVersion.length === 0 ||
		typeof parsed.updateCommandDisplay !== "string" ||
		parsed.updateCommandDisplay.length === 0
	) {
		throw new Error("Invalid auto-update payload");
	}

	return {
		parentPid: parsed.parentPid,
		cwd: parsed.cwd,
		stateFile: parsed.stateFile,
		latestVersion: parsed.latestVersion,
		updateCommand: parseCommandSpec(parsed.updateCommand),
		restartCommand: parseCommandSpec(parsed.restartCommand),
		updateCommandDisplay: parsed.updateCommandDisplay,
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

	mkdirSync(dirname(payload.stateFile), { recursive: true });
	writeFileSync(payload.stateFile, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
}

async function waitForParentExit(pid) {
	while (true) {
		try {
			process.kill(pid, 0);
			await delay(200);
		} catch {
			return;
		}
	}
}

function runCommand(spec, cwd, waitForExit) {
	return new Promise((resolve, reject) => {
		const options = { cwd, stdio: "inherit", env: process.env, shell: false };
		const child =
			spec.kind === "shell"
				? process.platform === "win32"
					? spawn(spec.command, [], { ...options, shell: true })
					: spawn("sh", ["-lc", spec.command], options)
				: spawn(spec.command, spec.args, {
						...options,
						shell: process.platform === "win32",
					});

		child.on("error", reject);
		if (!waitForExit) {
			child.unref();
			resolve(0);
			return;
		}

		child.on("close", (code) => resolve(code ?? 0));
	});
}

async function runScheduledUpdate(payload) {
	await waitForParentExit(payload.parentPid);
	console.log(`\nUpdating pi to ${payload.latestVersion}...`);

	const updateCode = await runCommand(payload.updateCommand, payload.cwd, true);
	if (updateCode !== 0) {
		console.error(`\npi auto-update failed. Run manually: ${payload.updateCommandDisplay}`);
		process.exit(updateCode);
	}

	writeValidatedState(payload);
	console.log("\npi updated successfully. Restarting...");
	await runCommand(payload.restartCommand, payload.cwd, false);
}

async function main() {
	const encodedPayload = process.argv[2];
	if (!encodedPayload) {
		throw new Error("Missing auto-update payload argument");
	}

	const payload = decodePayload(encodedPayload);
	await runScheduledUpdate(payload);
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
	decodePayload,
	runCommand,
	runScheduledUpdate,
	waitForParentExit,
	writeValidatedState,
};
