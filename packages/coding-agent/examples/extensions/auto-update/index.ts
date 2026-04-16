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
 * 1. Copy this directory to ~/.pi/agent/extensions/auto-update/
 * 2. Run npm install inside ~/.pi/agent/extensions/auto-update/
 * 3. Start pi normally
 * 4. Optional: set PI_AUTO_UPDATE_COMMAND for pnpm/yarn/bun/custom installs
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
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

const require = createRequire(import.meta.url);
const semver: {
	compare: (a: string, b: string) => number;
	valid: (version: string) => string | null;
} = require("semver");
const compareSemver = semver.compare;
const validSemver = semver.valid;

const PACKAGE_NAME = "@mariozechner/pi-coding-agent";
const CHANGELOG_URL = "https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/CHANGELOG.md";
const CHANGELOG_RAW_URL = "https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/CHANGELOG.md";
const CHECK_TIMEOUT_MS = 10_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STATE_FILE = join(getAgentDir(), "pi-auto-update.json");
const INSTALL_METADATA_FILE_NAME = "pi-auto-update-install.json";
const RUNNER_FILE = fileURLToPath(new URL("./runner.cjs", import.meta.url));

type UIContext = ExtensionContext | ExtensionCommandContext;
type InstallMethod = "npm" | "pnpm" | "yarn" | "bun" | "unknown";
type UpdateChoice = "update" | "view-changelog" | "skip" | "dismiss";
type ChoiceHandlingResult = "continue" | "done";
type UpdateCommandSource = "env" | "settings" | "state" | "install-metadata" | "heuristic";
type CommandSource = UpdateCommandSource | "default";

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

interface ResolvedCommand {
	command: CommandSpec;
	source: CommandSource;
}

interface NpmLatestResponse {
	version?: string;
}

interface ScheduledUpdatePayload {
	parentPid: number;
	cwd: string;
	stateFile: string;
	latestVersion: string;
	updateCommand: CommandSpec;
	restartCommand: CommandSpec;
	updateCommandDisplay: string;
	validatedInstallMethod?: InstallMethod;
}

type ScheduleResult =
	| { scheduled: false }
	| {
			scheduled: true;
			updateCommand: CommandSpec;
			restartCommand: CommandSpec;
	  };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseInstallMethod(value: unknown): InstallMethod | undefined {
	return value === "npm" || value === "pnpm" || value === "yarn" || value === "bun" || value === "unknown"
		? value
		: undefined;
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

class VersionService {
	constructor(private readonly stateRepository: UpdateStateRepository) {}

	compare(a: string, b: string): number {
		const left = this.normalizeVersion(a);
		const right = this.normalizeVersion(b);

		if (left && right) {
			return compareSemver(left, right);
		}

		return a.trim().localeCompare(b.trim(), undefined, { numeric: true, sensitivity: "base" });
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

	private normalizeVersion(version: string): string | undefined {
		const trimmed = version.trim();
		return validSemver(trimmed) ?? validSemver(trimmed.replace(/^v/i, "")) ?? undefined;
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

	resolveRestartCommand(cwd: string): ResolvedCommand {
		const envCommand = process.env.PI_AUTO_UPDATE_RESTART_COMMAND?.trim();
		if (envCommand) {
			return {
				command: { kind: "shell", command: envCommand },
				source: "env",
			};
		}

		const settings = this.getSettingsConfig(cwd);
		if (settings.restartCommand) {
			return {
				command: settings.restartCommand,
				source: "settings",
			};
		}

		const state = this.stateRepository.read();
		if (state.validatedRestartCommand) {
			return {
				command: state.validatedRestartCommand,
				source: "state",
			};
		}

		const metadata = this.getInstallMetadata(cwd);
		if (metadata.restartCommand) {
			return {
				command: metadata.restartCommand,
				source: "install-metadata",
			};
		}

		return {
			command: { kind: "exec", command: "pi", args: [] },
			source: "default",
		};
	}

	formatCommand(command: CommandSpec): string {
		if (command.kind === "shell") {
			return command.command;
		}
		return [command.command, ...command.args].join(" ");
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
	constructor(private readonly installStrategyResolver: InstallStrategyResolver) {}

	scheduleForPosix(latestVersion: string, ctx: UIContext): ScheduleResult {
		return this.scheduleDetached(latestVersion, ctx);
	}

	scheduleForWindows(latestVersion: string, ctx: UIContext): ScheduleResult {
		return this.scheduleDetached(latestVersion, ctx);
	}

	private scheduleDetached(latestVersion: string, ctx: UIContext): ScheduleResult {
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
		const payload = this.buildPayload(latestVersion, ctx.cwd, resolvedUpdate, resolvedRestart.command);

		try {
			const child = spawn(process.execPath, [RUNNER_FILE, this.encodePayload(payload)], {
				detached: true,
				stdio: "inherit",
				env: process.env,
			});
			child.unref();
			ctx.ui.notify(`pi will exit, update to ${latestVersion}, then restart automatically.`, "info");
			ctx.shutdown();
			return {
				scheduled: true,
				updateCommand: resolvedUpdate.command,
				restartCommand: resolvedRestart.command,
			};
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Failed to schedule pi restart: ${message}`, "error");
			return { scheduled: false };
		}
	}

	private buildPayload(
		latestVersion: string,
		cwd: string,
		resolvedUpdate: ResolvedUpdateCommand,
		restartCommand: CommandSpec,
	): ScheduledUpdatePayload {
		return {
			parentPid: process.pid,
			cwd,
			stateFile: STATE_FILE,
			latestVersion,
			updateCommand: resolvedUpdate.command,
			restartCommand,
			updateCommandDisplay: this.installStrategyResolver.formatCommand(resolvedUpdate.command),
			validatedInstallMethod: resolvedUpdate.installMethod,
		};
	}

	private encodePayload(payload: ScheduledUpdatePayload): string {
		return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
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
	) {}

	onStartup(event: { reason: string }, ctx: UIContext): void {
		if (event.reason !== "startup") {
			return;
		}

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

	const stateRepository = new UpdateStateRepository(STATE_FILE, getAgentDir());
	const versionService = new VersionService(stateRepository);
	const installStrategyResolver = new InstallStrategyResolver(stateRepository);
	const updateScheduler = new UpdateScheduler(installStrategyResolver);
	const changelogService = new ChangelogService();
	const updatePromptService = new UpdatePromptService(stateRepository, updateScheduler, changelogService);
	const controller = new AutoUpdateController(stateRepository, versionService, updatePromptService);

	pi.on("session_start", async (event, ctx) => {
		controller.onStartup(event, ctx);
	});

	pi.registerCommand("update-pi", {
		description: "Check for a newer pi version and optionally install it",
		getArgumentCompletions: (prefix) => {
			const options = ["check", "now", "clear-skip"];
			const filtered = options.filter((option) => option.startsWith(prefix.trim()));
			return filtered.length > 0 ? filtered.map((option) => ({ value: option, label: option })) : null;
		},
		handler: async (args, ctx) => {
			await controller.onManualCommand(args, ctx);
		},
	});
}
