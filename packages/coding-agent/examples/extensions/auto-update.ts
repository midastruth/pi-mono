/**
 * Pi Auto Update Extension
 *
 * Checks npm for newer versions of pi on startup and offers a simple:
 * - Update now
 * - View changelog
 * - Skip this version
 *
 * Notes:
 * - Suppresses pi's built-in startup version banner and replaces it with an interactive prompt.
 * - Caches the latest version for a few hours to avoid hitting npm on every launch.
 * - Stores skip state in ~/.pi/agent/pi-auto-update.json.
 * - Override the install command with PI_AUTO_UPDATE_COMMAND if you do not use npm.
 * - On "Update now", pi exits first, updates in a detached runner, then restarts automatically.
 *
 * Usage:
 * 1. Copy this file to ~/.pi/agent/extensions/auto-update.ts
 * 2. Start pi normally
 * 3. Optional: set PI_AUTO_UPDATE_COMMAND for pnpm/yarn/bun/custom installs
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { getAgentDir, getMarkdownTheme, VERSION } from "@mariozechner/pi-coding-agent";
import { type Component, Markdown, matchesKey, type TUI, truncateToWidth } from "@mariozechner/pi-tui";

const PACKAGE_NAME = "@mariozechner/pi-coding-agent";
const CHANGELOG_URL = "https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/CHANGELOG.md";
const CHANGELOG_RAW_URL = "https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/CHANGELOG.md";
const CHECK_TIMEOUT_MS = 10_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const WINDOWS_STATUS_STALE_MS = 10 * 60 * 1000;
const AGENT_DIR = getAgentDir();
const STATE_FILE = join(AGENT_DIR, "pi-auto-update.json");
const STATUS_FILE = join(AGENT_DIR, "pi-auto-update-status.json");
const WINDOWS_HELPER_FILE = join(AGENT_DIR, "pi-auto-update-helper.cjs");
const WINDOWS_PAYLOAD_DIR = join(AGENT_DIR, "tmp");
const WINDOWS_LOG_DIR = join(AGENT_DIR, "logs");

const UPDATE_PHASES = new Set(["scheduled", "updating", "updated", "restarting", "completed", "failed"]);
const WINDOWS_UPDATE_MODES = new Set(["helper-update-only", "helper-update-and-restart"]);

type UIContext = ExtensionContext | ExtensionCommandContext;
type InstallMethod = "npm" | "pnpm" | "yarn" | "bun" | "unknown";
type UpdateChoice = "update" | "view-changelog" | "skip" | "dismiss";
type ChoiceHandlingResult = "continue" | "done";
type CommandSource = "env" | "state" | "default";
type WindowsUpdateMode = "helper-update-only" | "helper-update-and-restart";
type UpdatePhase = "scheduled" | "updating" | "updated" | "restarting" | "completed" | "failed";

type ShellCommandSpec = {
	kind: "shell";
	command: string;
};

type ExecCommandSpec = {
	kind: "exec";
	command: string;
	args: string[];
};

type CommandSpec = ShellCommandSpec | ExecCommandSpec;

interface UpdateState {
	lastCheckedAt?: number;
	latestVersion?: string;
	skippedVersion?: string;
	installMethod?: InstallMethod;
	updateCommand?: string;
	restartCommand?: string;
}

interface NpmLatestResponse {
	version?: string;
}

interface ScheduledUpdatePayload {
	parentPid: number;
	cwd: string;
	latestVersion: string;
	updateCommand: CommandSpec;
	restartCommand: CommandSpec;
	updateCommandDisplay: string;
}

interface RestartCommandResolution {
	command: CommandSpec;
	source: CommandSource;
	autoRestartAllowed: boolean;
}

interface WindowsUpdateStatus {
	updateId: string;
	phase: UpdatePhase;
	latestVersion: string;
	mode: WindowsUpdateMode;
	updateCommandDisplay: string;
	restartCommandDisplay?: string;
	logFile: string;
	error?: string;
	scheduledAt: number;
	lastTransitionAt: number;
	updatedAt?: number;
	completedAt?: number;
	failedAt?: number;
}

interface WindowsUpdatePayload {
	updateId: string;
	parentPid: number;
	cwd: string;
	latestVersion: string;
	mode: WindowsUpdateMode;
	updateCommand: CommandSpec;
	restartCommand: CommandSpec;
	statusFile: string;
	logFile: string;
	updateCommandDisplay: string;
	restartCommandDisplay: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseInstallMethod(value: unknown): InstallMethod | undefined {
	return value === "npm" || value === "pnpm" || value === "yarn" || value === "bun" || value === "unknown"
		? value
		: undefined;
}

function parseUpdatePhase(value: unknown): UpdatePhase | undefined {
	return typeof value === "string" && UPDATE_PHASES.has(value) ? (value as UpdatePhase) : undefined;
}

function parseWindowsUpdateMode(value: unknown): WindowsUpdateMode | undefined {
	return typeof value === "string" && WINDOWS_UPDATE_MODES.has(value) ? (value as WindowsUpdateMode) : undefined;
}

function writeJsonFile(filePath: string, value: unknown): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeTextFile(filePath: string, content: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, content, "utf8");
}

class UpdateStateRepository {
	constructor(
		private readonly stateFile: string,
		private readonly agentDir: string,
	) {}

	read(): UpdateState {
		try {
			const content = readFileSync(this.stateFile, "utf8");
			const parsed = JSON.parse(content) as UpdateState;
			return {
				lastCheckedAt: typeof parsed.lastCheckedAt === "number" ? parsed.lastCheckedAt : undefined,
				latestVersion: typeof parsed.latestVersion === "string" ? parsed.latestVersion : undefined,
				skippedVersion: typeof parsed.skippedVersion === "string" ? parsed.skippedVersion : undefined,
				installMethod: parseInstallMethod(parsed.installMethod),
				updateCommand: typeof parsed.updateCommand === "string" ? parsed.updateCommand : undefined,
				restartCommand: typeof parsed.restartCommand === "string" ? parsed.restartCommand : undefined,
			};
		} catch {
			return {};
		}
	}

	write(state: UpdateState): void {
		try {
			mkdirSync(this.agentDir, { recursive: true });
			writeFileSync(this.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
		} catch {
			// Best-effort only. Failing to persist state should not break pi startup.
		}
	}

	clearSkip(): UpdateState {
		const nextState = {
			...this.read(),
			skippedVersion: undefined,
		};
		this.write(nextState);
		return nextState;
	}
}

class WindowsUpdateStatusRepository {
	constructor(
		private readonly statusFile: string,
		private readonly agentDir: string,
	) {}

	read(): WindowsUpdateStatus | undefined {
		try {
			const parsed = JSON.parse(readFileSync(this.statusFile, "utf8")) as unknown;
			if (!isRecord(parsed)) {
				return undefined;
			}

			const phase = parseUpdatePhase(parsed.phase);
			const mode = parseWindowsUpdateMode(parsed.mode);
			if (
				typeof parsed.updateId !== "string" ||
				parsed.updateId.trim().length === 0 ||
				!phase ||
				typeof parsed.latestVersion !== "string" ||
				parsed.latestVersion.trim().length === 0 ||
				!mode ||
				typeof parsed.updateCommandDisplay !== "string" ||
				parsed.updateCommandDisplay.trim().length === 0 ||
				typeof parsed.logFile !== "string" ||
				parsed.logFile.trim().length === 0 ||
				typeof parsed.scheduledAt !== "number" ||
				typeof parsed.lastTransitionAt !== "number"
			) {
				return undefined;
			}

			return {
				updateId: parsed.updateId,
				phase,
				latestVersion: parsed.latestVersion,
				mode,
				updateCommandDisplay: parsed.updateCommandDisplay,
				restartCommandDisplay:
					typeof parsed.restartCommandDisplay === "string" ? parsed.restartCommandDisplay : undefined,
				logFile: parsed.logFile,
				error: typeof parsed.error === "string" ? parsed.error : undefined,
				scheduledAt: parsed.scheduledAt,
				lastTransitionAt: parsed.lastTransitionAt,
				updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : undefined,
				completedAt: typeof parsed.completedAt === "number" ? parsed.completedAt : undefined,
				failedAt: typeof parsed.failedAt === "number" ? parsed.failedAt : undefined,
			};
		} catch {
			return undefined;
		}
	}

	write(status: WindowsUpdateStatus): void {
		try {
			mkdirSync(this.agentDir, { recursive: true });
			writeFileSync(this.statusFile, `${JSON.stringify(status, null, 2)}\n`, "utf8");
		} catch {
			// Best-effort only. Failing to persist status should not break pi startup.
		}
	}

	clear(): void {
		try {
			unlinkSync(this.statusFile);
		} catch {
			// Best-effort only.
		}
	}
}

class VersionService {
	constructor(private readonly stateRepository: UpdateStateRepository) {}

	compare(a: string, b: string): number {
		const normalize = (version: string): { parts: number[]; prerelease?: string } => {
			const trimmed = version.trim().replace(/^v/i, "");
			const [core, prerelease] = trimmed.split("-", 2);
			const parts = core.split(".").map((part) => Number.parseInt(part, 10) || 0);
			return { parts, prerelease };
		};

		const left = normalize(a);
		const right = normalize(b);
		const length = Math.max(left.parts.length, right.parts.length);

		for (let index = 0; index < length; index += 1) {
			const diff = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
			if (diff !== 0) {
				return diff;
			}
		}

		if (left.prerelease === right.prerelease) return 0;
		if (!left.prerelease && right.prerelease) return 1;
		if (left.prerelease && !right.prerelease) return -1;

		return (left.prerelease ?? "").localeCompare(right.prerelease ?? "", undefined, { numeric: true });
	}

	isDifferentFromCurrent(latestVersion: string, currentVersion: string): boolean {
		return latestVersion.trim() !== currentVersion.trim();
	}

	hasNewerVersion(latestVersion: string, currentVersion: string): boolean {
		if (!this.isDifferentFromCurrent(latestVersion, currentVersion)) {
			return false;
		}

		return this.compare(latestVersion, currentVersion) > 0;
	}

	isSameOrNewer(candidateVersion: string, baselineVersion: string): boolean {
		if (!this.isDifferentFromCurrent(candidateVersion, baselineVersion)) {
			return true;
		}

		return this.compare(candidateVersion, baselineVersion) >= 0;
	}

	async fetchLatest(): Promise<string | undefined> {
		const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`, {
			signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
		});
		if (!response.ok) {
			return undefined;
		}

		const data = (await response.json()) as NpmLatestResponse;
		return typeof data.version === "string" && data.version.trim().length > 0 ? data.version.trim() : undefined;
	}

	async getLatestWithCache(force: boolean): Promise<string | undefined> {
		const state = this.stateRepository.read();
		const now = Date.now();

		if (!force && state.latestVersion && state.lastCheckedAt && now - state.lastCheckedAt < CHECK_INTERVAL_MS) {
			return state.latestVersion;
		}

		try {
			const latestVersion = await this.fetchLatest();
			if (!latestVersion) {
				return undefined;
			}
			this.stateRepository.write({
				...state,
				lastCheckedAt: now,
				latestVersion,
			});
			return latestVersion;
		} catch {
			return undefined;
		}
	}
}

class InstallStrategyResolver {
	constructor(private readonly stateRepository: UpdateStateRepository) {}

	detectMethod(): InstallMethod {
		const haystack = [process.execPath, process.argv[0] ?? "", process.argv[1] ?? ""].join("\0").toLowerCase();

		if (haystack.includes("/pnpm/") || haystack.includes("/.pnpm/") || haystack.includes("\\pnpm\\")) {
			return "pnpm";
		}
		if (haystack.includes("/yarn/") || haystack.includes("/.yarn/") || haystack.includes("\\yarn\\")) {
			return "yarn";
		}
		if (process.versions.bun) {
			return "bun";
		}
		if (
			haystack.includes("/npm/") ||
			haystack.includes("/node_modules/") ||
			haystack.includes("\\npm\\") ||
			haystack.includes("\\node_modules\\")
		) {
			return "npm";
		}

		return "unknown";
	}

	getUpdateCommand(): CommandSpec | undefined {
		const envCommand = process.env.PI_AUTO_UPDATE_COMMAND?.trim();
		if (envCommand) {
			return { kind: "shell", command: envCommand };
		}

		const state = this.stateRepository.read();
		if (state.updateCommand?.trim()) {
			return { kind: "shell", command: state.updateCommand.trim() };
		}

		if (state.installMethod) {
			const commandFromState = this.commandForMethod(state.installMethod);
			if (commandFromState) {
				return commandFromState;
			}
		}

		return this.commandForMethod(this.detectMethod());
	}

	getRestartCommand(): CommandSpec {
		return this.getRestartCommandResolution().command;
	}

	getRestartCommandResolution(): RestartCommandResolution {
		const envCommand = process.env.PI_AUTO_UPDATE_RESTART_COMMAND?.trim();
		if (envCommand) {
			return {
				command: { kind: "shell", command: envCommand },
				source: "env",
				autoRestartAllowed: true,
			};
		}

		const state = this.stateRepository.read();
		if (state.restartCommand?.trim()) {
			return {
				command: { kind: "shell", command: state.restartCommand.trim() },
				source: "state",
				autoRestartAllowed: process.platform !== "win32",
			};
		}

		if (process.platform === "win32") {
			return {
				command: { kind: "shell", command: "pi" },
				source: "default",
				autoRestartAllowed: true,
			};
		}

		return {
			command: { kind: "exec", command: "pi", args: [] },
			source: "default",
			autoRestartAllowed: true,
		};
	}

	formatCommand(command: CommandSpec): string {
		if (command.kind === "shell") {
			return command.command;
		}
		return [command.command, ...command.args].join(" ");
	}

	private commandForMethod(method: InstallMethod): CommandSpec | undefined {
		switch (method) {
			case "pnpm":
				return { kind: "exec", command: "pnpm", args: ["add", "-g", `${PACKAGE_NAME}@latest`] };
			case "yarn":
				return { kind: "exec", command: "yarn", args: ["global", "add", `${PACKAGE_NAME}@latest`] };
			case "bun":
				return { kind: "exec", command: "bun", args: ["install", "-g", `${PACKAGE_NAME}@latest`] };
			case "npm":
				return { kind: "exec", command: "npm", args: ["install", "-g", `${PACKAGE_NAME}@latest`] };
			default:
				return undefined;
		}
	}
}

class UpdateScheduler {
	constructor(
		private readonly installStrategyResolver: InstallStrategyResolver,
		private readonly windowsStatusRepository: WindowsUpdateStatusRepository,
	) {}

	scheduleForPosix(latestVersion: string, ctx: UIContext): boolean {
		const updateCommand = this.installStrategyResolver.getUpdateCommand();
		if (!updateCommand) {
			ctx.ui.notify(
				"Could not determine a safe pi update command. Set PI_AUTO_UPDATE_COMMAND to enable auto-update.",
				"warning",
			);
			return false;
		}

		const restartCommand = this.installStrategyResolver.getRestartCommand();
		const payload: ScheduledUpdatePayload = {
			parentPid: process.pid,
			cwd: ctx.cwd,
			latestVersion,
			updateCommand,
			restartCommand,
			updateCommandDisplay: this.installStrategyResolver.formatCommand(updateCommand),
		};

		try {
			const child = spawn(process.execPath, ["-e", this.buildRunnerScript(payload)], {
				detached: true,
				stdio: "inherit",
				env: process.env,
			});
			child.unref();
			ctx.ui.notify(`pi will exit, update to ${latestVersion}, then restart automatically.`, "info");
			ctx.shutdown();
			return true;
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Failed to schedule pi restart: ${message}`, "error");
			return false;
		}
	}

	scheduleForWindows(latestVersion: string, ctx: UIContext): boolean {
		const updateCommand = this.installStrategyResolver.getUpdateCommand();
		if (!updateCommand) {
			ctx.ui.notify(
				"Could not determine a safe pi update command. Set PI_AUTO_UPDATE_COMMAND to enable auto-update.",
				"warning",
			);
			return false;
		}

		const restartResolution = this.installStrategyResolver.getRestartCommandResolution();
		const mode: WindowsUpdateMode = restartResolution.autoRestartAllowed
			? "helper-update-and-restart"
			: "helper-update-only";
		const updateId = randomUUID();
		const logFile = join(WINDOWS_LOG_DIR, `pi-auto-update-${updateId}.log`);
		const payloadFile = join(WINDOWS_PAYLOAD_DIR, `pi-auto-update-${updateId}.json`);
		const updateCommandDisplay = this.installStrategyResolver.formatCommand(updateCommand);
		const restartCommandDisplay = this.installStrategyResolver.formatCommand(restartResolution.command);
		const scheduledAt = Date.now();
		const scheduledStatus: WindowsUpdateStatus = {
			updateId,
			phase: "scheduled",
			latestVersion,
			mode,
			updateCommandDisplay,
			restartCommandDisplay,
			logFile,
			scheduledAt,
			lastTransitionAt: scheduledAt,
		};
		const payload: WindowsUpdatePayload = {
			updateId,
			parentPid: process.pid,
			cwd: ctx.cwd,
			latestVersion,
			mode,
			updateCommand,
			restartCommand: restartResolution.command,
			statusFile: STATUS_FILE,
			logFile,
			updateCommandDisplay,
			restartCommandDisplay,
		};

		try {
			writeTextFile(WINDOWS_HELPER_FILE, this.buildWindowsHelperScript());
			writeJsonFile(payloadFile, payload);
			this.windowsStatusRepository.write(scheduledStatus);

			const child = spawn(process.execPath, [WINDOWS_HELPER_FILE, payloadFile], {
				detached: true,
				stdio: "ignore",
				windowsHide: true,
				env: process.env,
			});
			child.unref();

			if (mode === "helper-update-and-restart") {
				ctx.ui.notify(
					`pi will exit, update to ${latestVersion}, then restart automatically. Log: ${logFile}`,
					"info",
				);
			} else {
				ctx.ui.notify(
					`pi will exit and update to ${latestVersion} in the background. Restart pi manually after the update completes. Log: ${logFile}`,
					"info",
				);
			}
			ctx.shutdown();
			return true;
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			this.windowsStatusRepository.write({
				...scheduledStatus,
				phase: "failed",
				error: message,
				failedAt: Date.now(),
				lastTransitionAt: Date.now(),
			});
			ctx.ui.notify(`Failed to schedule the Windows updater: ${message}`, "error");
			return false;
		}
	}

	private buildRunnerScript(payload: ScheduledUpdatePayload): string {
		const serializedPayload = JSON.stringify(payload);
		return [
			`const payload = ${serializedPayload};`,
			"const { spawn } = require('node:child_process');",
			"const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
			"async function waitForParentExit(pid) {",
			"  while (true) {",
			"    try {",
			"      process.kill(pid, 0);",
			"      await delay(200);",
			"    } catch {",
			"      return;",
			"    }",
			"  }",
			"}",
			"function runCommand(spec, cwd, waitForExit) {",
			"  return new Promise((resolve, reject) => {",
			"    const options = { cwd, stdio: 'inherit', env: process.env, shell: false };",
			"    const child = spec.kind === 'shell' ? spawn('sh', ['-lc', spec.command], options) : spawn(spec.command, spec.args, options);",
			"    child.on('error', reject);",
			"    if (!waitForExit) {",
			"      child.unref();",
			"      resolve(0);",
			"      return;",
			"    }",
			"    child.on('close', (code) => resolve(code ?? 0));",
			"  });",
			"}",
			"(async () => {",
			"  await waitForParentExit(payload.parentPid);",
			"  console.log('\\nUpdating pi to ' + payload.latestVersion + '...');",
			"  const updateCode = await runCommand(payload.updateCommand, payload.cwd, true);",
			"  if (updateCode !== 0) {",
			"    console.error('\\npi auto-update failed. Run manually: ' + payload.updateCommandDisplay);",
			"    process.exit(updateCode);",
			"  }",
			"  console.log('\\npi updated successfully. Restarting...');",
			"  await runCommand(payload.restartCommand, payload.cwd, false);",
			"  process.exit(0);",
			"})().catch((error) => {",
			"  console.error(error instanceof Error ? error.message : String(error));",
			"  process.exit(1);",
			"});",
		].join("\n");
	}

	private buildWindowsHelperScript(): string {
		return String.raw`#!/usr/bin/env node

const { spawn } = require("node:child_process");
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
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
	writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function appendLog(logFile, message) {
	mkdirForFile(logFile);
	appendFileSync(logFile, "[" + new Date().toISOString() + "] " + message + "\n", "utf8");
}

function parseCommandSpec(value) {
	if (!isRecord(value)) {
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

function loadPayload(payloadFile) {
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
		typeof parsed.latestVersion !== "string" ||
		parsed.latestVersion.trim().length === 0 ||
		(parsed.mode !== "helper-update-only" && parsed.mode !== "helper-update-and-restart") ||
		typeof parsed.statusFile !== "string" ||
		parsed.statusFile.trim().length === 0 ||
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
		latestVersion: parsed.latestVersion,
		mode: parsed.mode,
		updateCommand: parseCommandSpec(parsed.updateCommand),
		restartCommand: parseCommandSpec(parsed.restartCommand),
		statusFile: parsed.statusFile,
		logFile: parsed.logFile,
		updateCommandDisplay: parsed.updateCommandDisplay,
		restartCommandDisplay: parsed.restartCommandDisplay,
	};
}

function readStatus(statusFile) {
	try {
		const parsed = JSON.parse(readFileSync(statusFile, "utf8"));
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function writeStatus(payload, patch) {
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

async function waitForParentExit(parentPid, logFile) {
	while (true) {
		try {
			process.kill(parentPid, 0);
			await delay(200);
		} catch (error) {
			if (error && typeof error === "object" && error.code === "ESRCH") {
				return;
			}
			appendLog(logFile, "waitForParentExit continuing after error: " + (error instanceof Error ? error.message : String(error)));
			return;
		}
	}
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

function runWindowsCommand(spec, cwd, waitForExit) {
	return new Promise((resolve, reject) => {
		const commandLine = toWindowsCommandLine(spec);
		const child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", commandLine], {
			cwd,
			env: process.env,
			stdio: "ignore",
			shell: false,
			windowsHide: true,
			detached: !waitForExit,
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

async function main() {
	const payloadFile = process.argv[2];
	if (!payloadFile) {
		throw new Error("Missing Windows auto-update payload path");
	}

	const payload = loadPayload(payloadFile);
	appendLog(payload.logFile, "Windows updater helper started for version " + payload.latestVersion + ".");
	writeStatus(payload, {
		phase: "updating",
		error: undefined,
	});

	appendLog(payload.logFile, "Waiting for pi process " + payload.parentPid + " to exit.");
	await waitForParentExit(payload.parentPid, payload.logFile);
	appendLog(payload.logFile, "pi process exited. Running update command: " + payload.updateCommandDisplay);

	const updateCode = await runWindowsCommand(payload.updateCommand, payload.cwd, true);
	if (updateCode !== 0) {
		const errorMessage = "Update command failed with exit code " + updateCode + ". Run manually: " + payload.updateCommandDisplay;
		appendLog(payload.logFile, errorMessage);
		writeStatus(payload, {
			phase: "failed",
			error: errorMessage,
			failedAt: Date.now(),
		});
		process.exit(updateCode || 1);
	}

	appendLog(payload.logFile, "Update command completed successfully.");
	writeStatus(payload, {
		phase: "updated",
		error: undefined,
		updatedAt: Date.now(),
	});

	if (payload.mode === "helper-update-only") {
		appendLog(payload.logFile, "Update completed. Automatic restart disabled; restart pi manually.");
		return;
	}

	appendLog(payload.logFile, "Launching restart command: " + payload.restartCommandDisplay);
	writeStatus(payload, {
		phase: "restarting",
		error: undefined,
	});

	try {
		await runWindowsCommand(payload.restartCommand, payload.cwd, false);
		appendLog(payload.logFile, "Restart command launched successfully.");
		writeStatus(payload, {
			phase: "completed",
			error: undefined,
			completedAt: Date.now(),
		});
		return;
	} catch (error) {
		const errorMessage = "Restart command failed: " + (error instanceof Error ? error.message : String(error));
		appendLog(payload.logFile, errorMessage);
		writeStatus(payload, {
			phase: "failed",
			error: errorMessage,
			failedAt: Date.now(),
		});
		throw error;
	}
}

if (require.main === module) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
`;
	}
}

class ChangelogViewer implements Component {
	private readonly markdown: Markdown;
	private scrollOffset = 0;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly title: string,
		markdownText: string,
		private readonly onClose: () => void,
	) {
		this.markdown = new Markdown(markdownText, 0, 0, getMarkdownTheme());
	}

	handleInput(data: string): void {
		const pageSize = this.getPageSize();
		const contentHeight = this.markdown.render(this.tui.terminal.columns).length;
		const maxScroll = Math.max(0, contentHeight - pageSize);

		if (matchesKey(data, "escape") || matchesKey(data, "enter") || data === "q") {
			this.onClose();
			return;
		}

		if (matchesKey(data, "down")) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "up")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + pageSize);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - pageSize);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "home")) {
			this.scrollOffset = 0;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "end")) {
			this.scrollOffset = maxScroll;
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const pageSize = this.getPageSize();
		const allLines = this.markdown.render(width);
		const maxScroll = Math.max(0, allLines.length - pageSize);
		this.scrollOffset = Math.min(this.scrollOffset, maxScroll);

		const visibleLines = allLines.slice(this.scrollOffset, this.scrollOffset + pageSize);
		while (visibleLines.length < pageSize) {
			visibleLines.push("");
		}

		const titleLine = truncateToWidth(this.theme.fg("accent", this.theme.bold(this.title)), width);
		const helpLine = truncateToWidth(
			this.theme.fg("dim", "↑↓ scroll • PgUp/PgDn page • Home/End jump • Enter/Esc close"),
			width,
		);
		const footerLine = truncateToWidth(
			this.theme.fg(
				"dim",
				`Lines ${Math.min(this.scrollOffset + 1, Math.max(allLines.length, 1))}-${Math.min(this.scrollOffset + pageSize, allLines.length)} / ${allLines.length}`,
			),
			width,
		);

		return [titleLine, helpLine, ...visibleLines, footerLine];
	}

	invalidate(): void {
		this.markdown.invalidate();
	}

	private getPageSize(): number {
		return Math.max(8, this.tui.terminal.rows - 3);
	}
}

class ChangelogService {
	async showReleaseNotes(version: string, ctx: UIContext): Promise<void> {
		if (!ctx.hasUI) {
			return;
		}

		const markdown = await this.fetchReleaseNotes(version);
		if (!markdown) {
			ctx.ui.notify(`Changelog: ${CHANGELOG_URL}`, "info");
			return;
		}

		await ctx.ui.custom((tui, theme, _kb, done) => {
			return new ChangelogViewer(tui, theme, `Changelog ${version}`, markdown, () => done(undefined));
		});
	}

	private async fetchReleaseNotes(version: string): Promise<string | undefined> {
		try {
			const response = await fetch(CHANGELOG_RAW_URL, {
				signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
			});
			if (!response.ok) {
				return undefined;
			}

			const markdown = await response.text();
			return this.extractVersionSection(markdown, version) ?? markdown.trim();
		} catch {
			return undefined;
		}
	}

	private extractVersionSection(markdown: string, version: string): string | undefined {
		const headingPattern = new RegExp(`^##\\s+\\[?${this.escapeRegExp(version)}\\]?[^\\n]*$`, "m");
		const headingMatch = headingPattern.exec(markdown);
		if (!headingMatch || headingMatch.index === undefined) {
			return undefined;
		}

		const start = headingMatch.index;
		const rest = markdown.slice(start + headingMatch[0].length);
		const nextSectionMatch = /^##\s+/m.exec(rest);
		const end =
			nextSectionMatch?.index !== undefined
				? start + headingMatch[0].length + nextSectionMatch.index
				: markdown.length;
		return markdown.slice(start, end).trim();
	}

	private escapeRegExp(value: string): string {
		return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
}

class WindowsUpdateStatusService {
	constructor(
		private readonly statusRepository: WindowsUpdateStatusRepository,
		private readonly versionService: VersionService,
	) {}

	handleStartup(ctx: UIContext): void {
		if (!ctx.hasUI || process.platform !== "win32") {
			return;
		}

		const status = this.statusRepository.read();
		if (!status) {
			return;
		}

		const currentMatchesOrNewer = this.versionService.isSameOrNewer(VERSION, status.latestVersion);
		const isStale = Date.now() - status.lastTransitionAt > WINDOWS_STATUS_STALE_MS;

		switch (status.phase) {
			case "failed":
				ctx.ui.notify(
					`Last pi auto-update failed: ${status.error ?? "Unknown error"}. Log: ${status.logFile}. Use /update-pi now to retry or /update-pi clear-status to dismiss.`,
					"warning",
				);
				return;
			case "updated":
				if (currentMatchesOrNewer) {
					ctx.ui.notify(`pi updated successfully to ${status.latestVersion}.`, "info");
					this.statusRepository.clear();
					return;
				}
				ctx.ui.notify(
					`pi was updated to ${status.latestVersion}. Restart pi to use the new version. Log: ${status.logFile}.`,
					"info",
				);
				return;
			case "completed":
				if (currentMatchesOrNewer) {
					ctx.ui.notify(`pi updated and restarted successfully (${status.latestVersion}).`, "info");
					this.statusRepository.clear();
					return;
				}
				ctx.ui.notify(
					`pi update completed for ${status.latestVersion}, but the current session is still on ${VERSION}. Log: ${status.logFile}.`,
					"warning",
				);
				return;
			case "scheduled":
			case "updating":
			case "restarting":
				if (!isStale) {
					return;
				}
				ctx.ui.notify(
					`Previous pi auto-update may have been interrupted during ${status.phase}. Log: ${status.logFile}. Use /update-pi status for details or /update-pi now to retry.`,
					"warning",
				);
				return;
		}
	}

	showStatus(ctx: UIContext): void {
		const status = this.statusRepository.read();
		if (!status) {
			ctx.ui.notify("No pending pi auto-update status is recorded.", "info");
			return;
		}

		const summary = [
			`phase=${status.phase}`,
			`target=${status.latestVersion}`,
			`mode=${status.mode}`,
			`log=${status.logFile}`,
			status.error ? `error=${status.error}` : undefined,
		]
			.filter((part) => part !== undefined)
			.join(" | ");
		ctx.ui.notify(summary, status.phase === "failed" ? "warning" : "info");
	}

	clearStatus(ctx: UIContext): void {
		const status = this.statusRepository.read();
		if (!status) {
			ctx.ui.notify("No pending pi auto-update status is recorded.", "info");
			return;
		}

		this.statusRepository.clear();
		ctx.ui.notify("Cleared pi auto-update status.", "info");
	}
}

class UpdatePromptService {
	constructor(
		private readonly stateRepository: UpdateStateRepository,
		private readonly installStrategyResolver: InstallStrategyResolver,
		private readonly updateScheduler: UpdateScheduler,
		private readonly changelogService: ChangelogService,
	) {}

	async promptUser(currentVersion: string, latestVersion: string, ctx: UIContext): Promise<UpdateChoice> {
		const updateOption = `Update now (${currentVersion} -> ${latestVersion})`;
		const changelogOption = `View changelog (${latestVersion})`;
		const skipOption = `Skip ${latestVersion}`;
		const choice = await ctx.ui.select("pi update available", [updateOption, changelogOption, skipOption]);

		if (choice === updateOption) return "update";
		if (choice === changelogOption) return "view-changelog";
		if (choice === skipOption) return "skip";
		return "dismiss";
	}

	async handleChoice(choice: UpdateChoice, latestVersion: string, ctx: UIContext): Promise<ChoiceHandlingResult> {
		if (choice === "update") {
			const scheduled =
				process.platform === "win32"
					? this.updateScheduler.scheduleForWindows(latestVersion, ctx)
					: this.updateScheduler.scheduleForPosix(latestVersion, ctx);
			if (scheduled) {
				const updateCommand = this.installStrategyResolver.getUpdateCommand();
				const restartCommandResolution = this.installStrategyResolver.getRestartCommandResolution();
				this.stateRepository.write({
					...this.stateRepository.read(),
					lastCheckedAt: Date.now(),
					latestVersion,
					skippedVersion: undefined,
					installMethod: this.installStrategyResolver.detectMethod(),
					updateCommand: updateCommand?.kind === "shell" ? updateCommand.command : undefined,
					restartCommand:
						restartCommandResolution.source !== "default" && restartCommandResolution.command.kind === "shell"
							? restartCommandResolution.command.command
							: undefined,
				});
			}
			return "done";
		}

		if (choice === "view-changelog") {
			await this.changelogService.showReleaseNotes(latestVersion, ctx);
			return "continue";
		}

		if (choice === "skip") {
			this.stateRepository.write({
				...this.stateRepository.read(),
				lastCheckedAt: Date.now(),
				latestVersion,
				skippedVersion: latestVersion,
			});
			ctx.ui.notify(`Skipping ${latestVersion}. Use /update-pi to check again later.`, "info");
		}

		return "done";
	}
}

class AutoUpdateController {
	private promptInFlight: Promise<void> | undefined;

	constructor(
		private readonly stateRepository: UpdateStateRepository,
		private readonly versionService: VersionService,
		private readonly updatePromptService: UpdatePromptService,
		private readonly windowsStatusService: WindowsUpdateStatusService,
	) {}

	onStartup(event: unknown, ctx: UIContext): void {
		const reason = isRecord(event) && typeof event.reason === "string" ? event.reason : "startup";
		if (reason !== "startup") {
			return;
		}

		this.windowsStatusService.handleStartup(ctx);
		void this.runPrompt(ctx, false);
	}

	async onManualCommand(args: string, ctx: UIContext): Promise<void> {
		const mode = args.trim();

		if (mode === "clear-skip") {
			const state = this.stateRepository.read();
			if (!state.skippedVersion) {
				ctx.ui.notify("No skipped pi version is recorded.", "info");
				return;
			}
			this.stateRepository.clearSkip();
			ctx.ui.notify("Cleared skipped pi version.", "info");
			return;
		}

		if (mode === "clear-status") {
			this.windowsStatusService.clearStatus(ctx);
			return;
		}

		if (mode === "status") {
			this.windowsStatusService.showStatus(ctx);
			return;
		}

		if (mode === "now") {
			const latestVersion = await this.versionService.getLatestWithCache(true);
			if (!latestVersion) {
				ctx.ui.notify("Could not check for pi updates.", "warning");
				return;
			}
			if (!this.versionService.isDifferentFromCurrent(latestVersion, VERSION)) {
				ctx.ui.notify(`Already on the latest version (${VERSION}).`, "info");
				return;
			}
			if (!this.versionService.hasNewerVersion(latestVersion, VERSION)) {
				ctx.ui.notify(
					`Current version (${VERSION}) differs from npm latest (${latestVersion}), but npm latest is not newer.`,
					"info",
				);
				return;
			}
			await this.updatePromptService.handleChoice("update", latestVersion, ctx);
			return;
		}

		await this.runPrompt(ctx, true);
	}

	private runPrompt(ctx: UIContext, force: boolean): Promise<void> {
		if (this.promptInFlight) {
			return this.promptInFlight;
		}

		const promise = this.prompt(ctx, force).finally(() => {
			if (this.promptInFlight === promise) {
				this.promptInFlight = undefined;
			}
		});
		this.promptInFlight = promise;
		return promise;
	}

	private async prompt(ctx: UIContext, force: boolean): Promise<void> {
		if (!ctx.hasUI || process.env.PI_OFFLINE) {
			return;
		}

		const latestVersion = await this.versionService.getLatestWithCache(force);
		if (!latestVersion) {
			if (force) {
				ctx.ui.notify("Could not check for pi updates.", "warning");
			}
			return;
		}

		if (!this.versionService.isDifferentFromCurrent(latestVersion, VERSION)) {
			this.stateRepository.write({
				...this.stateRepository.read(),
				lastCheckedAt: Date.now(),
				latestVersion,
				skippedVersion: undefined,
			});
			if (force) {
				ctx.ui.notify(`Already on the latest version (${VERSION}).`, "info");
			}
			return;
		}

		if (!this.versionService.hasNewerVersion(latestVersion, VERSION)) {
			this.stateRepository.write({
				...this.stateRepository.read(),
				lastCheckedAt: Date.now(),
				latestVersion,
			});
			if (force) {
				ctx.ui.notify(
					`Current version (${VERSION}) differs from npm latest (${latestVersion}), but npm latest is not newer.`,
					"info",
				);
			}
			return;
		}

		const state = this.stateRepository.read();
		if (!force && state.skippedVersion === latestVersion) {
			return;
		}

		while (true) {
			const choice = await this.updatePromptService.promptUser(VERSION, latestVersion, ctx);
			const result = await this.updatePromptService.handleChoice(choice, latestVersion, ctx);
			if (result === "done") {
				return;
			}
		}
	}
}

export default function autoUpdateExtension(pi: ExtensionAPI) {
	process.env.PI_SKIP_VERSION_CHECK = "1";

	const stateRepository = new UpdateStateRepository(STATE_FILE, AGENT_DIR);
	const windowsStatusRepository = new WindowsUpdateStatusRepository(STATUS_FILE, AGENT_DIR);
	const versionService = new VersionService(stateRepository);
	const installStrategyResolver = new InstallStrategyResolver(stateRepository);
	const updateScheduler = new UpdateScheduler(installStrategyResolver, windowsStatusRepository);
	const changelogService = new ChangelogService();
	const windowsStatusService = new WindowsUpdateStatusService(windowsStatusRepository, versionService);
	const updatePromptService = new UpdatePromptService(
		stateRepository,
		installStrategyResolver,
		updateScheduler,
		changelogService,
	);
	const controller = new AutoUpdateController(
		stateRepository,
		versionService,
		updatePromptService,
		windowsStatusService,
	);

	pi.on("session_start", async (event, ctx) => {
		controller.onStartup(event, ctx);
	});

	pi.registerCommand("update-pi", {
		description: "Check for a newer pi version and optionally install it",
		getArgumentCompletions: (prefix) => {
			const options = ["check", "now", "status", "clear-skip", "clear-status"];
			const filtered = options.filter((option) => option.startsWith(prefix.trim()));
			return filtered.length > 0 ? filtered.map((option) => ({ value: option, label: option })) : null;
		},
		handler: async (args, ctx) => {
			await controller.onManualCommand(args, ctx);
		},
	});
}
