# OpenCode Provider Usage

An experimental OpenCode desktop plugin that shows subscription usage for OpenCode Go, Codex, Claude, and xAI in the session header and a detail panel.

- Header rings show the most-used available limit for each provider; hover for the period and percentage.
- Switch between remaining and used percentages in the detail panel, which also shows reset times when available.
- Usage is refreshed approximately once a minute.

## Installation

Clone this repository and add its absolute directory path to the `plugins` array in your OpenCode configuration, preserving existing entries.
For example, after cloning into `~/.config/opencode/plugins/provider-usage`, add the full path to `~/.config/opencode/opencode.json`.
The included `gui-experimental.cjs` is the GUI bundle; do not install a separate copy of the OpenCode plugin SDK or Effect into this directory.

```jsonc
{
  "plugins": ["/absolute/path/to/provider-usage"]
}
```

Requires an OpenCode version supporting the experimental GUI plugin and RPC APIs.
The interface currently uses Japanese labels.

## Authentication and privacy

The plugin uses the active OpenCode provider connections where available.
It can also read Codex credentials from `~/.codex/auth.json` and Claude Code OAuth credentials from the macOS keychain or `~/.claude/.credentials.json`.
It sends access tokens directly to the corresponding provider's usage endpoint; tokens are not displayed in the UI.
Use this plugin only on a machine and account where you trust the OpenCode server.

The usage endpoints and plugin APIs are unofficial or experimental and may change without notice.
Provider access, subscription availability, and login expiry can affect which meters are shown.

## License

[MIT](LICENSE)
