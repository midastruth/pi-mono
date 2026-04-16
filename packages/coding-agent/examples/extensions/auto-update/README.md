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

## Update command resolution order

The extension resolves the update command in this order:

1. `PI_AUTO_UPDATE_COMMAND`
2. `piAutoUpdate.updateCommand` (or `autoUpdate.updateCommand`) in `settings.json`
3. The last successfully validated command stored in `~/.pi/agent/pi-auto-update.json`
4. Install metadata from `~/.pi/agent/pi-auto-update-install.json` or `.pi/pi-auto-update-install.json`
5. Heuristic detection (`npm_config_user_agent`, then process path hints)

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

## Notes

- `runner.cjs` is a detached helper process used for waiting on pi to exit, performing the update, and restarting pi on both POSIX and Windows.
- After a successful update, the runner writes the validated update and restart commands back to `~/.pi/agent/pi-auto-update.json` so future launches prefer proven commands over heuristics.
- The changelog viewer uses pi's configured keybindings (`tui.select.*` plus `tui.editor.cursorLineStart/cursorLineEnd`) instead of hardcoded keys.
- `package.json` is required so the extension can carry its own `semver` dependency when copied out of the monorepo.
