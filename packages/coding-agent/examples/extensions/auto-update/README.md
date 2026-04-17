# Auto Update Extension

Auto-update extension for pi with a terminal handoff updater, inline semver comparison (no external dependency), Windows restart support, configurable changelog keybindings, and layered update-command resolution.

## Files

```text
auto-update/
├── package.json
├── package-lock.json
├── README.md
├── runner.cjs
└── update.ts
```

## Install

Copy the whole directory into your extensions folder:

```bash
mkdir -p ~/.pi/agent/extensions
cp -R auto-update ~/.pi/agent/extensions/
```

This example currently has no local runtime dependencies, so `npm install` is not required.

pi will discover the extension entry from `package.json` via `pi.extensions`, which points to `./update.ts`.

You can also install it project-locally under `.pi/extensions/auto-update/`.

## Optional environment variables

- `PI_AUTO_UPDATE_COMMAND` - override the update command
- `PI_AUTO_UPDATE_RESTART_COMMAND` - override the restart command
- `PI_AUTO_UPDATE_BACKGROUND=1` - disable terminal handoff and force the detached background updater

## Commands

- `/update-pi` or `/update-pi check` - check for updates and prompt if available
- `/update-pi now` - force an immediate update attempt
- `/update-pi status` - show the persisted background update status, if any
- `/update-pi clear-skip` - clear the skipped-version marker
- `/update-pi clear-status` - clear the persisted background update status

## Update command resolution order

The extension resolves the update command in this order:

1. `PI_AUTO_UPDATE_COMMAND`
2. `piAutoUpdate.updateCommand` (or `autoUpdate.updateCommand`) in `settings.json`
3. The last successfully validated command stored in `~/.pi/agent/version.json`
4. Install metadata from `~/.pi/agent/pi-auto-update-install.json` or `.pi/pi-auto-update-install.json`
5. Detected install path (`pi` from the current environment plus `which -a`/`where`, realpath + shim probing, package-root validation against `@mariozechner/pi-coding-agent`, then global bin matching)
6. Heuristic detection (`npm_config_user_agent`, then process path hints)

If no safe command can be resolved, the extension does not auto-update and instead asks for explicit configuration.

## settings.json example

Add this to `~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{
  "piAutoUpdate": {
    "updateCommand": "pnpm add -g @mariozechner/pi-coding-agent@latest",
    "restartCommand": "pi"
  }
}
```

`autoUpdate` is also accepted for compatibility, but `piAutoUpdate` is the preferred namespace.

## Install metadata example

If you want installation-time provisioning, write one of these files:

- `~/.pi/agent/pi-auto-update-install.json`
- `.pi/pi-auto-update-install.json`

Example:

```json
{
  "installMethod": "pnpm",
  "updateCommand": {
    "kind": "exec",
    "command": "pnpm",
    "args": ["add", "-g", "@mariozechner/pi-coding-agent@latest"]
  },
  "restartCommand": {
    "kind": "exec",
    "command": "pi",
    "args": []
  }
}
```

If `updateCommand` is omitted but `installMethod` is present, the extension derives the default command for that package manager.

## Update flow behavior

In interactive TTY sessions the extension uses a terminal handoff flow:

1. pi writes a payload file to `~/.pi/agent/tmp/`
2. pi writes update status to `~/.pi/agent/pi-auto-update-status.json`
3. pi exits its TUI
4. `runner.cjs` takes over the same terminal, shows an animated elapsed-time progress indicator, and finishes with a clear success or failure message
5. Detailed command output is still written to `~/.pi/agent/logs/pi-auto-update-<id>.log`

If a TTY handoff is not available, the extension falls back to the detached background flow.

Platform behavior:

- POSIX: terminal handoff updates in the current terminal and prints a final manual-restart message; detached fallback updates in the background and records status/logs
- Windows: terminal handoff updates in the current terminal and prints a final manual-restart message; detached fallback can still auto-restart when the restart command source is trusted

Persisted restart commands recovered from prior validated state are not auto-executed on Windows. In that case the extension downgrades to update-only mode unless the restart command comes from:

- `PI_AUTO_UPDATE_RESTART_COMMAND`
- `settings.json`
- install metadata
- the built-in default restart command

On next startup, the extension inspects `pi-auto-update-status.json` and reports:

- failed updates
- interrupted update flows
- successful update-only flows that still need a restart
- completed restart flows

## Notes

- `runner.cjs` is used both for detached background updates and for terminal handoff updates that keep the current terminal occupied until the update finishes.
- After a successful update, the runner writes the validated update and restart commands back to `~/.pi/agent/version.json` so future launches prefer proven commands over path detection and heuristics.
- Before running the update command, the runner also stores `rollbackCommand` and `rollbackVersion` in `~/.pi/agent/version.json` when the current version is known.
- Background update progress is persisted in `~/.pi/agent/pi-auto-update-status.json` and detailed logs are written under `~/.pi/agent/logs/`.
- The changelog viewer uses pi's configured keybindings (`tui.select.*` plus `tui.editor.cursorLineStart/cursorLineEnd`) instead of hardcoded keys.
- `package.json` is required for the `pi.extensions` declaration; semver comparison is now inlined so there are no external runtime dependencies.
