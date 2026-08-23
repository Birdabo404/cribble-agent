# Cribble Agent

Track local coding-agent token usage and optionally sync it to Cribble. The
CLI reads local `ccusage` data; it does not intercept prompts or model traffic.

![Cribble terminal report](assets/usage-report.svg)

## Quick start

Requires Node.js 18 or newer.

```sh
npm install --global cribble-agent
cribble connect
cribble sync
cribble start
```

That installs the `cribble` command, securely connects this Mac to your
Cribble account, proves the first sync works, and then opts in to automatic
background syncing. Check it any time with:

```sh
cribble status
cribble
cribble --days 30
```

The CLI reads usage through its bundled [`ccusage`](https://ccusage.com/)
dependency. Use `--json` for machine-readable output.

## Sync

Preview the payload without sending it:

```sh
cribble sync --dry-run
```

To enable syncing, create an Agent key in your signed-in Cribble Account
Settings. Connect it to this Mac, then run one manual sync:

```sh
cribble connect
cribble sync
cribble status
```

That three-command path is intentional: `connect` stores the key, the first
`sync` proves the key and local collector work, and `start` is the explicit
opt-in for automatic background syncing.

The production endpoint is `https://cribble.dev/api/agent/usage`. Endpoint
overrides require HTTPS, except for loopback-only local development. A custom
endpoint never receives the Agent key stored in Keychain: development syncs
must supply `CRIBBLE_API_KEY` explicitly. Custom endpoints cannot be saved in
the background job. Agent keys are never written to sync status or
background-service files or inherited by the `ccusage` collector process.

Optional background sync is macOS-only:

```sh
cribble start
cribble status
cribble pause
cribble resume
```

Use `cribble background uninstall` to remove automatic syncing completely.
The older `cribble auth ...` and `cribble background ...` forms remain
available for scripts and advanced management.

Installing background sync records a stable Node command path when one is
available and this checkout's `index.js` path. If the checkout moves, run
`cribble start` again from its new location. Nothing is scheduled until that
command is run explicitly.

`CRIBBLE_API_KEY` is available only as an explicit development/CI override;
normal macOS use should keep the key in Keychain.

Run `cribble --help` for all commands and options.

## Development

```sh
npm ci
npm link
npm test
```

`npm link` makes a development checkout available as the `cribble` command.
It is not needed for the published package.

Visit [Cribble.dev](https://cribble.dev) for more.
