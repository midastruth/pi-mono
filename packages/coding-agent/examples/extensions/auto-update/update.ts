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
 * - Stores skip state in ~/.pi/agent/version.json.
 * - Override the install command with PI_AUTO_UPDATE_COMMAND if you do not use npm.
 * - On "Update now", pi exits its TUI, hands the terminal to the updater, shows an animated progress indicator there, and prints the final result.
 *
 * Usage:
 * 1. Copy this directory to ~/.pi/agent/extensions/auto-update/
 * 2. Run npm install inside ~/.pi/agent/extensions/auto-update/
 * 3. Start pi normally
 * 4. Optional: set PI_AUTO_UPDATE_COMMAND for pnpm/yarn/bun/custom installs
 */

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { getAgentDir, getMarkdownTheme, SettingsManager, VERSION } from "@mariozechner/pi-coding-agent";
import {
	type Component,
	type Keybinding,
	type KeybindingsManager,
	type KeyId,
	Markdown,
	type TUI,
	truncateToWidth,
} from "@mariozechner/pi-tui";

function parseSemverParts(version: string): [number, number, number] | undefined {
	const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[.+-].*)?$/.exec(version.trim());
	if (!match) return undefined;
	return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

function compareSemver(a: string, b: string): number {
	const left = parseSemverParts(a);
	const right = parseSemverParts(b);
	if (left && right) {
		for (let i = 0; i < 3; i++) {
			if (left[i] !== right[i]) return (left[i] as number) - (right[i] as number);
		}
		return 0;
	}
	return a.trim().localeCompare(b.trim(), undefined, { numeric: true, sensitivity: "base" });
}

function validSemver(version: string): string | undefined {
	const trimmed = version.trim();
	return parseSemverParts(trimmed) ? trimmed.replace(/^v/i, "") : undefined;
}

const PACKAGE_NAME = "@mariozechner/pi-coding-agent";
const CHANGELOG_URL = "https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/CHANGELOG.md";
const CHANGELOG_RAW_URL = "https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/CHANGELOG.md";
const CHECK_TIMEOUT_MS = 10_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const WINDOWS_STATUS_STALE_MS = 10 * 60 * 1000;
const AGENT_DIR = getAgentDir();
const STATE_FILE = join(AGENT_DIR, "version.json");
const STATUS_FILE = join(AGENT_DIR, "pi-auto-update-status.json");
const WINDOWS_PAYLOAD_DIR = join(AGENT_DIR, "tmp");
const WINDOWS_LOG_DIR = join(AGENT_DIR, "logs");
const INSTALL_METADATA_FILE_NAME = "pi-auto-update-install.json";
const RUNNER_FILE = fileURLToPath(new URL("./runner.cjs", import.meta.url));

type UIContext = ExtensionContext | ExtensionCommandContext;
type InstallMethod = "npm" | "pnpm" | "yarn" | "bun" | "unknown";
type UpdateChoice = "update" | "view-changelog" | "skip" | "dismiss";
type ChoiceHandlingResult = "continue" | "done";
type UpdateCommandSource = "env" | "settings" | "state" | "install-metadata" | "detected-install-path" | "heuristic";
type CommandSource = UpdateCommandSource | "default";
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
	validatedUpdateCommand?: CommandSpec;
	validatedRestartCommand?: CommandSpec;
	validatedInstallMethod?: InstallMethod;
	validatedAt?: number;
	lastUpdatedVersion?: string;
}

interface AutoUpdateSettingsConfig {
	updateCommand?: CommandSpec;
	restartCommand?: CommandSpec;
}

interface InstallMetadata {
	updateCommand?: CommandSpec;
	restartCommand?: CommandSpec;
	installMethod?: InstallMethod;
}

interface ResolvedUpdateCommand {
	command: CommandSpec;
	source: UpdateCommandSource;
	installMethod?: InstallMethod;
}

interface RestartCommandResolution {
	command: CommandSpec;
	source: CommandSource;
	autoRestartAllowed: boolean;
}

interface DetectedInstall {
	method: Exclude<InstallMethod, "unknown">;
	binPath: string;
	packageRoot: string;
}

interface NpmLatestResponse {
	version?: string;
}

interface ScheduledUpdatePayload {
	updateId: string;
	parentPid: number;
	cwd: string;
	stateFile: string;
	statusFile: string;
	latestVersion: string;
	currentVersion: string;
	mode: WindowsUpdateMode;
	updateCommand: CommandSpec;
	restartCommand: CommandSpec;
	updateCommandDisplay: string;
	restartCommandDisplay: string;
	logFile: string;
	validatedInstallMethod?: InstallMethod;
}

interface WindowsUpdatePayload {
	updateId: string;
	parentPid: number;
	cwd: string;
	stateFile: string;
	statusFile: string;
	latestVersion: string;
	currentVersion: string;
	mode: WindowsUpdateMode;
	updateCommand: CommandSpec;
	restartCommand: CommandSpec;
	updateCommandDisplay: string;
	restartCommandDisplay: string;
	logFile: string;
	validatedInstallMethod?: InstallMethod;
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

type ScheduleResult =
	| { scheduled: false }
	| {
			scheduled: true;
			updateCommand: CommandSpec;
			restartCommand: CommandSpec;
	  };

interface AutoUpdateProcessState {
	exitHookInstalled: boolean;
	foregroundRunnerStarted: boolean;
	pendingForegroundPayloadFile?: string;
}

type AutoUpdateProcessGlobal = typeof globalThis & {
	__piAutoUpdateProcessState__?: AutoUpdateProcessState;
};

function getAutoUpdateProcessState(): AutoUpdateProcessState {
	const globalState = globalThis as AutoUpdateProcessGlobal;
	const processState = globalState.__piAutoUpdateProcessState__;
	if (processState) {
		return processState;
	}

	const nextState: AutoUpdateProcessState = {
		exitHookInstalled: false,
		foregroundRunnerStarted: false,
	};
	globalState.__piAutoUpdateProcessState__ = nextState;
	return nextState;
}

function queueForegroundUpdate(payloadFile: string): void {
	const processState = getAutoUpdateProcessState();
	processState.pendingForegroundPayloadFile = payloadFile;
}

function installForegroundUpdateExitHook(): void {
	const processState = getAutoUpdateProcessState();
	if (processState.exitHookInstalled) {
		return;
	}

	process.on("exit", () => {
		const currentState = getAutoUpdateProcessState();
		const payloadFile = currentState.pendingForegroundPayloadFile;
		if (!payloadFile || currentState.foregroundRunnerStarted) {
			return;
		}

		currentState.foregroundRunnerStarted = true;
		currentState.pendingForegroundPayloadFile = undefined;
		const result = spawnSync(process.execPath, [RUNNER_FILE, "--foreground-payload", payloadFile], {
			stdio: "inherit",
			env: process.env,
			windowsHide: false,
		});
		if (result.error) {
			console.error(`Failed to start foreground pi updater: ${result.error.message}`);
			process.exitCode = 1;
			return;
		}

		const status = typeof result.status === "number" ? result.status : 1;
		if (status !== 0) {
			process.exitCode = status;
		}
	});

	processState.exitHookInstalled = true;
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
	return value === "scheduled" ||
		value === "updating" ||
		value === "updated" ||
		value === "restarting" ||
		value === "completed" ||
		value === "failed"
		? value
		: undefined;
}

function parseWindowsUpdateMode(value: unknown): WindowsUpdateMode | undefined {
	return value === "helper-update-only" || value === "helper-update-and-restart" ? value : undefined;
}

function parseCommandSpec(value: unknown): CommandSpec | undefined {
	if (typeof value === "string" && value.trim().length > 0) {
		return { kind: "shell", command: value.trim() };
	}

	if (!isRecord(value)) {
		return undefined;
	}

	if (value.kind === "shell" && typeof value.command === "string" && value.command.trim().length > 0) {
		return { kind: "shell", command: value.command.trim() };
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

	return undefined;
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
	try {
		const content = readFileSync(path, "utf8");
		const parsed = JSON.parse(content) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function writeJsonFile(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function mergeSettingsConfig(
	base: AutoUpdateSettingsConfig,
	override: AutoUpdateSettingsConfig,
): AutoUpdateSettingsConfig {
	return {
		updateCommand: override.updateCommand ?? base.updateCommand,
		restartCommand: override.restartCommand ?? base.restartCommand,
	};
}

function mergeInstallMetadata(base: InstallMetadata, override: InstallMetadata): InstallMetadata {
	return {
		updateCommand: override.updateCommand ?? base.updateCommand,
		restartCommand: override.restartCommand ?? base.restartCommand,
		installMethod: override.installMethod ?? base.installMethod,
	};
}

function normalizePath(path: string): string {
	const normalized = path.replace(/[\\/]+$/u, "");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathsEqual(left: string, right: string): boolean {
	return normalizePath(left) === normalizePath(right);
}

function addUniquePath(paths: string[], candidate: string | undefined): void {
	if (!candidate) {
		return;
	}

	const trimmed = candidate.trim();
	if (trimmed.length === 0 || paths.some((existing) => pathsEqual(existing, trimmed))) {
		return;
	}
	paths.push(trimmed);
}

function isPiExecutablePath(path: string): boolean {
	const fileName = basename(path).toLowerCase();
	return (
		fileName === "pi" ||
		fileName === "pi.cmd" ||
		fileName === "pi.ps1" ||
		fileName === "pi.exe" ||
		fileName === "pi.bat"
	);
}

function resolveExecutableOnPath(command: string): string | undefined {
	const rawPath = process.env.PATH;
	if (!rawPath) {
		return undefined;
	}

	const pathEntries = rawPath.split(delimiter).filter((entry) => entry.trim().length > 0);
	const windowsExtensions =
		process.platform === "win32"
			? (process.env.PATHEXT?.split(";").filter((entry) => entry.trim().length > 0) ?? [
					".COM",
					".EXE",
					".BAT",
					".CMD",
					".PS1",
				])
			: [""];

	for (const entry of pathEntries) {
		const directCandidate = join(entry, command);
		if (existsSync(directCandidate)) {
			return directCandidate;
		}

		if (process.platform !== "win32") {
			continue;
		}

		for (const extension of windowsExtensions) {
			const candidate = join(entry, `${command}${extension}`);
			if (existsSync(candidate)) {
				return candidate;
			}
		}
	}

	return undefined;
}

function runCommandCaptureLines(command: string, args: string[]): string[] {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 2_000,
		windowsHide: true,
	});
	if (result.status !== 0 || typeof result.stdout !== "string") {
		return [];
	}

	return result.stdout
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && line !== "undefined" && line !== "null");
}

function runCommandCapture(command: string, args: string[]): string | undefined {
	return runCommandCaptureLines(command, args).at(-1);
}

function listPiExecutableCandidates(): string[] {
	const candidates: string[] = [];
	const currentCommand = process.env._?.trim();
	if (currentCommand && isPiExecutablePath(currentCommand)) {
		addUniquePath(candidates, currentCommand);
	}

	addUniquePath(candidates, resolveExecutableOnPath("pi"));
	for (const candidate of runCommandCaptureLines(
		process.platform === "win32" ? "where" : "which",
		process.platform === "win32" ? ["pi"] : ["-a", "pi"],
	)) {
		if (isPiExecutablePath(candidate)) {
			addUniquePath(candidates, candidate);
		}
	}

	return candidates;
}

function collectQuotedPackageTargets(content: string, baseDir: string): string[] {
	const targets: string[] = [];
	const matches = content.matchAll(/["']([^"'\r\n]*@mariozechner[\\/]+pi-coding-agent[^"'\r\n]*)["']/gu);
	for (const match of matches) {
		const rawTarget = match[1]?.trim();
		if (!rawTarget) {
			continue;
		}
		addUniquePath(targets, resolve(baseDir, rawTarget));
	}
	return targets;
}

function resolveWindowsCmdShimTargets(path: string, content: string): string[] {
	const baseDir = dirname(path);
	const normalized = content.replace(/%~dp0/giu, `${baseDir}\\`).replace(/%dp0%/giu, `${baseDir}\\`);
	return collectQuotedPackageTargets(normalized, baseDir);
}

function resolveWindowsPowerShellShimTargets(path: string, content: string): string[] {
	const baseDir = dirname(path);
	const normalized = content
		.replace(/\$PSScriptRoot/giu, baseDir)
		.replace(/\$\{basedir\}/gu, baseDir)
		.replace(/\$basedir/gu, baseDir);
	return collectQuotedPackageTargets(normalized, baseDir);
}

function resolveGenericShimTargets(path: string, content: string): string[] {
	const baseDir = dirname(path);
	const normalized = content.replace(/\$\{?basedir\}?/gu, baseDir);
	return collectQuotedPackageTargets(normalized, baseDir);
}

function resolveShimTargets(path: string): string[] {
	try {
		const content = readFileSync(path, "utf8");
		const fileName = basename(path).toLowerCase();
		if (fileName.endsWith(".cmd") || fileName.endsWith(".bat")) {
			return resolveWindowsCmdShimTargets(path, content);
		}
		if (fileName.endsWith(".ps1")) {
			return resolveWindowsPowerShellShimTargets(path, content);
		}
		return resolveGenericShimTargets(path, content);
	} catch {
		return [];
	}
}

function resolveExecutableTargets(path: string): string[] {
	const targets: string[] = [];
	addUniquePath(targets, path);

	try {
		addUniquePath(targets, realpathSync(path));
	} catch {
		// Ignore realpath failures and keep probing the original path.
	}

	for (const shimTarget of resolveShimTargets(path)) {
		addUniquePath(targets, shimTarget);
		try {
			addUniquePath(targets, realpathSync(shimTarget));
		} catch {
			// Ignore shim target realpath failures and keep the resolved shim target.
		}
	}

	return targets;
}

function hasPiBinMapping(pkg: Record<string, unknown>): boolean {
	if (pkg.name !== PACKAGE_NAME || !isRecord(pkg.bin)) {
		return false;
	}

	return typeof pkg.bin.pi === "string" && pkg.bin.pi.trim().length > 0;
}

function findPackageRootForExecutable(path: string): string | undefined {
	for (const target of resolveExecutableTargets(path)) {
		let current = dirname(target);
		while (true) {
			const packageJson = readJsonFile(join(current, "package.json"));
			if (packageJson && hasPiBinMapping(packageJson)) {
				return current;
			}

			const parent = dirname(current);
			if (parent === current) {
				break;
			}
			current = parent;
		}
	}

	return undefined;
}

class UpdateStateRepository {
	constructor(
		private readonly stateFile: string,
		private readonly agentDir: string,
	) {}

	read(): UpdateState {
		try {
			const content = readFileSync(this.stateFile, "utf8");
			const parsed = JSON.parse(content) as Record<string, unknown>;
			const validatedAt = typeof parsed.validatedAt === "number" ? parsed.validatedAt : undefined;
			const legacyValidated = validatedAt !== undefined;
			return {
				lastCheckedAt: typeof parsed.lastCheckedAt === "number" ? parsed.lastCheckedAt : undefined,
				latestVersion: typeof parsed.latestVersion === "string" ? parsed.latestVersion : undefined,
				skippedVersion: typeof parsed.skippedVersion === "string" ? parsed.skippedVersion : undefined,
				validatedUpdateCommand:
					parseCommandSpec(parsed.validatedUpdateCommand) ??
					(legacyValidated ? parseCommandSpec(parsed.updateCommand) : undefined),
				validatedRestartCommand:
					parseCommandSpec(parsed.validatedRestartCommand) ??
					(legacyValidated ? parseCommandSpec(parsed.restartCommand) : undefined),
				validatedInstallMethod:
					parseInstallMethod(parsed.validatedInstallMethod) ??
					(legacyValidated ? parseInstallMethod(parsed.installMethod) : undefined),
				validatedAt,
				lastUpdatedVersion: typeof parsed.lastUpdatedVersion === "string" ? parsed.lastUpdatedVersion : undefined,
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
	constructor(private readonly statusFile: string) {}

	read(): WindowsUpdateStatus | undefined {
		const parsed = readJsonFile(this.statusFile);
		if (!parsed) {
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
	}

	write(status: WindowsUpdateStatus): void {
		try {
			writeJsonFile(this.statusFile, status);
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
		return compareSemver(a, b);
	}

	async fetchLatest(): Promise<string | undefined> {
		const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`, {
			signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
		});
		if (!response.ok) {
			return undefined;
		}

		const data = (await response.json()) as NpmLatestResponse;
		return typeof data.version === "string" ? validSemver(data.version) : undefined;
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

	isSameOrNewer(candidateVersion: string, baselineVersion: string): boolean {
		return this.compare(candidateVersion, baselineVersion) >= 0;
	}
}

class InstallStrategyResolver {
	constructor(private readonly stateRepository: UpdateStateRepository) {}

	resolveUpdateCommand(cwd: string): ResolvedUpdateCommand | undefined {
		const envCommand = process.env.PI_AUTO_UPDATE_COMMAND?.trim();
		if (envCommand) {
			return {
				command: { kind: "shell", command: envCommand },
				source: "env",
			};
		}

		const settings = this.getSettingsConfig(cwd);
		if (settings.updateCommand) {
			return {
				command: settings.updateCommand,
				source: "settings",
			};
		}

		const state = this.stateRepository.read();
		if (state.validatedUpdateCommand) {
			return {
				command: state.validatedUpdateCommand,
				source: "state",
				installMethod: state.validatedInstallMethod,
			};
		}

		const metadata = this.getInstallMetadata(cwd);
		if (metadata.updateCommand) {
			return {
				command: metadata.updateCommand,
				source: "install-metadata",
				installMethod: metadata.installMethod,
			};
		}

		const installedCommand = this.detectInstalledCommand();
		if (installedCommand) {
			return installedCommand;
		}

		const heuristicMethod = this.detectMethod();
		const heuristicCommand = this.commandForMethod(heuristicMethod);
		if (heuristicCommand) {
			return {
				command: heuristicCommand,
				source: "heuristic",
				installMethod: heuristicMethod,
			};
		}

		return undefined;
	}

	resolveRestartCommand(cwd: string): RestartCommandResolution {
		const envCommand = process.env.PI_AUTO_UPDATE_RESTART_COMMAND?.trim();
		if (envCommand) {
			return {
				command: { kind: "shell", command: envCommand },
				source: "env",
				autoRestartAllowed: true,
			};
		}

		const settings = this.getSettingsConfig(cwd);
		if (settings.restartCommand) {
			return {
				command: settings.restartCommand,
				source: "settings",
				autoRestartAllowed: true,
			};
		}

		const state = this.stateRepository.read();
		if (state.validatedRestartCommand) {
			return {
				command: state.validatedRestartCommand,
				source: "state",
				autoRestartAllowed: process.platform !== "win32",
			};
		}

		const metadata = this.getInstallMetadata(cwd);
		if (metadata.restartCommand) {
			return {
				command: metadata.restartCommand,
				source: "install-metadata",
				autoRestartAllowed: true,
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

	private detectInstalledCommand(): ResolvedUpdateCommand | undefined {
		const detectedInstall = this.detectInstalledPi();
		if (!detectedInstall) {
			return undefined;
		}

		const command = this.commandForMethod(detectedInstall.method);
		if (!command) {
			return undefined;
		}

		return {
			command,
			source: "detected-install-path",
			installMethod: detectedInstall.method,
		};
	}

	private detectMethod(): InstallMethod {
		const userAgent = process.env.npm_config_user_agent?.toLowerCase() ?? "";
		if (userAgent.startsWith("pnpm/")) {
			return "pnpm";
		}
		if (userAgent.startsWith("yarn/")) {
			return "yarn";
		}
		if (userAgent.startsWith("bun/")) {
			return "bun";
		}
		if (userAgent.startsWith("npm/")) {
			return "npm";
		}

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

	private detectInstalledPi(): DetectedInstall | undefined {
		const currentPackageRoot = this.getCurrentPackageRoot();
		const globalBinDirectories = this.getGlobalBinDirectories();
		for (const binPath of listPiExecutableCandidates()) {
			const packageRoot = findPackageRootForExecutable(binPath);
			if (!packageRoot) {
				continue;
			}
			if (currentPackageRoot && !pathsEqual(packageRoot, currentPackageRoot)) {
				continue;
			}

			const method = this.detectInstalledMethod(binPath, globalBinDirectories);
			if (!method) {
				continue;
			}

			return {
				method,
				binPath,
				packageRoot,
			};
		}

		return undefined;
	}

	private getCurrentPackageRoot(): string | undefined {
		try {
			return findPackageRootForExecutable(fileURLToPath(import.meta.resolve("@mariozechner/pi-coding-agent")));
		} catch {
			return undefined;
		}
	}

	private getGlobalBinDirectories(): Partial<Record<Exclude<InstallMethod, "unknown">, string>> {
		const npmPrefix = runCommandCapture("npm", ["config", "get", "prefix"]);
		const pnpmBinDir = runCommandCapture("pnpm", ["bin", "-g"]);
		const yarnBinDir = runCommandCapture("yarn", ["global", "bin"]);
		const bunBinDir = process.env.BUN_INSTALL
			? join(process.env.BUN_INSTALL, "bin")
			: runCommandCapture("bun", ["pm", "bin", "-g"]);

		return {
			npm: npmPrefix ? (process.platform === "win32" ? npmPrefix : join(npmPrefix, "bin")) : undefined,
			pnpm: pnpmBinDir,
			yarn: yarnBinDir,
			bun: bunBinDir,
		};
	}

	private detectInstalledMethod(
		binPath: string,
		globalBinDirectories: Partial<Record<Exclude<InstallMethod, "unknown">, string>>,
	): Exclude<InstallMethod, "unknown"> | undefined {
		const matches = (
			Object.entries(globalBinDirectories) as Array<[Exclude<InstallMethod, "unknown">, string | undefined]>
		)
			.filter(([, directory]) => typeof directory === "string" && pathsEqual(dirname(binPath), directory))
			.map(([method]) => method);
		if (matches.includes("pnpm")) {
			return "pnpm";
		}
		if (matches.includes("bun")) {
			return "bun";
		}

		const hasNpm = matches.includes("npm");
		const hasYarn = matches.includes("yarn");
		if (hasNpm && hasYarn) {
			return undefined;
		}
		if (hasNpm) {
			return "npm";
		}
		if (hasYarn) {
			return "yarn";
		}

		return undefined;
	}

	private getSettingsConfig(cwd: string): AutoUpdateSettingsConfig {
		const settingsManager = SettingsManager.create(cwd, getAgentDir());
		const globalConfig = this.parseSettingsConfig(settingsManager.getGlobalSettings() as unknown);
		const projectConfig = this.parseSettingsConfig(settingsManager.getProjectSettings() as unknown);
		return mergeSettingsConfig(globalConfig, projectConfig);
	}

	private parseSettingsConfig(value: unknown): AutoUpdateSettingsConfig {
		if (!isRecord(value)) {
			return {};
		}

		const rawConfig = isRecord(value.piAutoUpdate)
			? value.piAutoUpdate
			: isRecord(value.autoUpdate)
				? value.autoUpdate
				: undefined;
		if (!rawConfig) {
			return {};
		}

		return {
			updateCommand: parseCommandSpec(rawConfig.updateCommand),
			restartCommand: parseCommandSpec(rawConfig.restartCommand),
		};
	}

	private getInstallMetadata(cwd: string): InstallMetadata {
		const globalMetadata = this.parseInstallMetadata(readJsonFile(join(getAgentDir(), INSTALL_METADATA_FILE_NAME)));
		const projectMetadata = this.parseInstallMetadata(readJsonFile(join(cwd, ".pi", INSTALL_METADATA_FILE_NAME)));
		return mergeInstallMetadata(globalMetadata, projectMetadata);
	}

	private parseInstallMetadata(value: Record<string, unknown> | undefined): InstallMetadata {
		if (!value) {
			return {};
		}

		const installMethod = parseInstallMethod(value.installMethod);
		return {
			installMethod,
			updateCommand:
				parseCommandSpec(value.updateCommand) ?? (installMethod ? this.commandForMethod(installMethod) : undefined),
			restartCommand: parseCommandSpec(value.restartCommand),
		};
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

	scheduleForPosix(latestVersion: string, ctx: UIContext): ScheduleResult {
		if (!existsSync(RUNNER_FILE)) {
			ctx.ui.notify(
				`Auto-update runner not found: ${RUNNER_FILE}. Copy the full auto-update extension directory.`,
				"warning",
			);
			return { scheduled: false };
		}

		const resolvedUpdate = this.installStrategyResolver.resolveUpdateCommand(ctx.cwd);
		if (!resolvedUpdate) {
			ctx.ui.notify(
				"Could not determine a safe pi update command. Configure PI_AUTO_UPDATE_COMMAND, add piAutoUpdate.updateCommand to settings.json, or provide install metadata.",
				"warning",
			);
			return { scheduled: false };
		}

		const resolvedRestart = this.installStrategyResolver.resolveRestartCommand(ctx.cwd);
		const updateId = randomUUID();
		const logFile = join(WINDOWS_LOG_DIR, `pi-auto-update-${updateId}.log`);
		const payloadFile = join(WINDOWS_PAYLOAD_DIR, `pi-auto-update-${updateId}.json`);
		const scheduledAt = Date.now();
		const mode: WindowsUpdateMode = "helper-update-only";
		const scheduledStatus: WindowsUpdateStatus = {
			updateId,
			phase: "scheduled",
			latestVersion,
			mode,
			updateCommandDisplay: this.installStrategyResolver.formatCommand(resolvedUpdate.command),
			restartCommandDisplay: this.installStrategyResolver.formatCommand(resolvedRestart.command),
			logFile,
			scheduledAt,
			lastTransitionAt: scheduledAt,
		};
		const payload = this.buildPosixPayload(
			updateId,
			latestVersion,
			ctx.cwd,
			resolvedUpdate,
			resolvedRestart.command,
			mode,
			logFile,
		);

		try {
			writeJsonFile(payloadFile, payload);
			this.windowsStatusRepository.write(scheduledStatus);
			if (this.shouldUseForegroundTerminalHandoff()) {
				queueForegroundUpdate(payloadFile);
				ctx.ui.notify(
					`pi will exit and this terminal will show the update progress to ${latestVersion}. Command output is still written to ${logFile}.`,
					"info",
				);
				ctx.shutdown();
				return {
					scheduled: true,
					updateCommand: resolvedUpdate.command,
					restartCommand: resolvedRestart.command,
				};
			}

			const child = spawn(process.execPath, [RUNNER_FILE, "--posix-payload", payloadFile], {
				detached: true,
				stdio: ["ignore", "ignore", "ignore", "ipc"],
				env: process.env,
			});
			child.unref();
			ctx.ui.notify(
				`pi will exit and update to ${latestVersion} in the background. Restart pi manually after the update completes. Log: ${logFile}`,
				"info",
			);
			ctx.shutdown();
			return {
				scheduled: true,
				updateCommand: resolvedUpdate.command,
				restartCommand: resolvedRestart.command,
			};
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			this.windowsStatusRepository.write({
				...scheduledStatus,
				phase: "failed",
				error: message,
				failedAt: Date.now(),
				lastTransitionAt: Date.now(),
			});
			ctx.ui.notify(`Failed to schedule the POSIX updater: ${message}`, "error");
			return { scheduled: false };
		}
	}

	scheduleForWindows(latestVersion: string, ctx: UIContext): ScheduleResult {
		if (!existsSync(RUNNER_FILE)) {
			ctx.ui.notify(
				`Auto-update runner not found: ${RUNNER_FILE}. Copy the full auto-update extension directory.`,
				"warning",
			);
			return { scheduled: false };
		}

		const resolvedUpdate = this.installStrategyResolver.resolveUpdateCommand(ctx.cwd);
		if (!resolvedUpdate) {
			ctx.ui.notify(
				"Could not determine a safe pi update command. Configure PI_AUTO_UPDATE_COMMAND, add piAutoUpdate.updateCommand to settings.json, or provide install metadata.",
				"warning",
			);
			return { scheduled: false };
		}

		const resolvedRestart = this.installStrategyResolver.resolveRestartCommand(ctx.cwd);
		const useForegroundTerminalHandoff = this.shouldUseForegroundTerminalHandoff();
		const mode: WindowsUpdateMode = useForegroundTerminalHandoff
			? "helper-update-only"
			: resolvedRestart.autoRestartAllowed
				? "helper-update-and-restart"
				: "helper-update-only";
		const updateId = randomUUID();
		const logFile = join(WINDOWS_LOG_DIR, `pi-auto-update-${updateId}.log`);
		const payloadFile = join(WINDOWS_PAYLOAD_DIR, `pi-auto-update-${updateId}.json`);
		const scheduledAt = Date.now();
		const scheduledStatus: WindowsUpdateStatus = {
			updateId,
			phase: "scheduled",
			latestVersion,
			mode,
			updateCommandDisplay: this.installStrategyResolver.formatCommand(resolvedUpdate.command),
			restartCommandDisplay: this.installStrategyResolver.formatCommand(resolvedRestart.command),
			logFile,
			scheduledAt,
			lastTransitionAt: scheduledAt,
		};
		const payload = this.buildWindowsPayload(
			updateId,
			latestVersion,
			ctx.cwd,
			resolvedUpdate,
			resolvedRestart,
			mode,
			logFile,
		);

		try {
			writeJsonFile(payloadFile, payload);
			this.windowsStatusRepository.write(scheduledStatus);
			if (useForegroundTerminalHandoff) {
				queueForegroundUpdate(payloadFile);
				ctx.ui.notify(
					`pi will exit and this terminal will show the update progress to ${latestVersion}. After the update completes, restart pi manually. Command output is still written to ${logFile}.`,
					"info",
				);
				ctx.shutdown();
				return {
					scheduled: true,
					updateCommand: resolvedUpdate.command,
					restartCommand: resolvedRestart.command,
				};
			}

			const child = spawn(process.execPath, [RUNNER_FILE, "--windows-payload", payloadFile], {
				detached: true,
				stdio: ["ignore", "ignore", "ignore", "ipc"],
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
			return {
				scheduled: true,
				updateCommand: resolvedUpdate.command,
				restartCommand: resolvedRestart.command,
			};
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
			return { scheduled: false };
		}
	}

	private shouldUseForegroundTerminalHandoff(): boolean {
		return (
			process.stdout.isTTY === true && process.stderr.isTTY === true && process.env.PI_AUTO_UPDATE_BACKGROUND !== "1"
		);
	}

	private buildPosixPayload(
		updateId: string,
		latestVersion: string,
		cwd: string,
		resolvedUpdate: ResolvedUpdateCommand,
		restartCommand: CommandSpec,
		mode: WindowsUpdateMode,
		logFile: string,
	): ScheduledUpdatePayload {
		return {
			updateId,
			parentPid: process.pid,
			cwd,
			stateFile: STATE_FILE,
			statusFile: STATUS_FILE,
			latestVersion,
			currentVersion: VERSION,
			mode,
			updateCommand: resolvedUpdate.command,
			restartCommand,
			updateCommandDisplay: this.installStrategyResolver.formatCommand(resolvedUpdate.command),
			restartCommandDisplay: this.installStrategyResolver.formatCommand(restartCommand),
			logFile,
			validatedInstallMethod: resolvedUpdate.installMethod,
		};
	}

	private buildWindowsPayload(
		updateId: string,
		latestVersion: string,
		cwd: string,
		resolvedUpdate: ResolvedUpdateCommand,
		resolvedRestart: RestartCommandResolution,
		mode: WindowsUpdateMode,
		logFile: string,
	): WindowsUpdatePayload {
		return {
			updateId,
			parentPid: process.pid,
			cwd,
			stateFile: STATE_FILE,
			statusFile: STATUS_FILE,
			latestVersion,
			currentVersion: VERSION,
			mode,
			updateCommand: resolvedUpdate.command,
			restartCommand: resolvedRestart.command,
			updateCommandDisplay: this.installStrategyResolver.formatCommand(resolvedUpdate.command),
			restartCommandDisplay: this.installStrategyResolver.formatCommand(resolvedRestart.command),
			logFile,
			validatedInstallMethod: resolvedUpdate.installMethod,
		};
	}
}

class ChangelogViewer implements Component {
	private readonly markdown: Markdown;
	private scrollOffset = 0;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
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

		if (this.matchesAny(data, ["tui.select.cancel", "tui.select.confirm"])) {
			this.onClose();
			return;
		}

		if (this.keybindings.matches(data, "tui.select.down")) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + pageSize);
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - pageSize);
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.cursorLineStart")) {
			this.scrollOffset = 0;
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.cursorLineEnd")) {
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
		const helpLine = truncateToWidth(this.theme.fg("dim", this.getHelpText()), width);
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

	private matchesAny(data: string, bindings: readonly Keybinding[]): boolean {
		return bindings.some((binding) => this.keybindings.matches(data, binding));
	}

	private getHelpText(): string {
		return [
			this.formatHelpSegment(["tui.select.up", "tui.select.down"], "scroll"),
			this.formatHelpSegment(["tui.select.pageUp", "tui.select.pageDown"], "page"),
			this.formatHelpSegment(["tui.editor.cursorLineStart", "tui.editor.cursorLineEnd"], "jump"),
			this.formatHelpSegment(["tui.select.confirm", "tui.select.cancel"], "close"),
		].join(" • ");
	}

	private formatHelpSegment(bindings: readonly Keybinding[], description: string): string {
		const keys = this.formatBindings(bindings);
		return keys.length > 0 ? `${keys} ${description}` : description;
	}

	private formatBindings(bindings: readonly Keybinding[]): string {
		const keys: KeyId[] = [];
		const seen = new Set<KeyId>();
		for (const binding of bindings) {
			for (const key of this.keybindings.getKeys(binding)) {
				if (!seen.has(key)) {
					seen.add(key);
					keys.push(key);
				}
			}
		}
		return keys.join("/");
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

		await ctx.ui.custom((tui, theme, keybindings, done) => {
			return new ChangelogViewer(tui, theme, keybindings, `Changelog ${version}`, markdown, () => done(undefined));
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
		if (!ctx.hasUI) {
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
			const scheduleResult =
				process.platform === "win32"
					? this.updateScheduler.scheduleForWindows(latestVersion, ctx)
					: this.updateScheduler.scheduleForPosix(latestVersion, ctx);
			if (scheduleResult.scheduled) {
				this.stateRepository.write({
					...this.stateRepository.read(),
					lastCheckedAt: Date.now(),
					latestVersion,
					skippedVersion: undefined,
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
			if (this.versionService.compare(latestVersion, VERSION) <= 0) {
				ctx.ui.notify(`Already on the latest version (${VERSION}).`, "info");
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

		if (this.versionService.compare(latestVersion, VERSION) <= 0) {
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
	installForegroundUpdateExitHook();

	const stateRepository = new UpdateStateRepository(STATE_FILE, AGENT_DIR);
	const windowsStatusRepository = new WindowsUpdateStatusRepository(STATUS_FILE);
	const versionService = new VersionService(stateRepository);
	const installStrategyResolver = new InstallStrategyResolver(stateRepository);
	const updateScheduler = new UpdateScheduler(installStrategyResolver, windowsStatusRepository);
	const changelogService = new ChangelogService();
	const windowsStatusService = new WindowsUpdateStatusService(windowsStatusRepository, versionService);
	const updatePromptService = new UpdatePromptService(stateRepository, updateScheduler, changelogService);
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
