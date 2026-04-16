# Auto Update Extension

Auto-update extension for pi with a detached runner, semver-based version comparison, Windows restart support, configurable changelog keybindings, and layered update-command resolution.

## Files

```text
auto-update/
├── index.ts
├── package.json
├── README.md
└── runner.cjs
```

## Install

Copy the whole directory into your extensions folder, then install its local dependencies:

```bash
mkdir -p ~/.pi/agent/extensions
cp -R auto-update ~/.pi/agent/extensions/
cd ~/.pi/agent/extensions/auto-update
npm install
```

pi will auto-discover `index.ts` from that directory.

## Optional environment variables

- `PI_AUTO_UPDATE_COMMAND` - override the update command
- `PI_AUTO_UPDATE_RESTART_COMMAND` - override the restart command

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

## Background updater behavior

On all platforms the extension uses a dedicated background flow:

1. pi writes a payload file to `~/.pi/agent/tmp/`
2. pi writes update status to `~/.pi/agent/pi-auto-update-status.json`
3. `runner.cjs` continues in the background after pi exits
4. The runner writes logs to `~/.pi/agent/logs/pi-auto-update-<id>.log`

Platform behavior:

- POSIX: updates in the background and records status/logs; restart pi manually after the update completes
- Windows: updates in the background and either restarts pi automatically or leaves a status message instructing you to restart manually

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

- `runner.cjs` is a detached helper process used for waiting on pi to exit, performing the update, and writing background status/log files on both POSIX and Windows.
- After a successful update, the runner writes the validated update and restart commands back to `~/.pi/agent/version.json` so future launches prefer proven commands over path detection and heuristics.
- Background update progress is persisted in `~/.pi/agent/pi-auto-update-status.json` and detailed logs are written under `~/.pi/agent/logs/`.
- The changelog viewer uses pi's configured keybindings (`tui.select.*` plus `tui.editor.cursorLineStart/cursorLineEnd`) instead of hardcoded keys.
- `package.json` is required so the extension can carry its own `semver` dependency when copied out of the monorepo.
