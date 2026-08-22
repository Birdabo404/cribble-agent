# Cribble Agent

Track local coding-agent token usage and optionally sync it to Cribble. The
CLI reads local `ccusage` data; it does not intercept prompts or model traffic.

![Cribble terminal report](assets/usage-report.svg)

## Quick start

Requires Node.js 18 or newer.

```sh
npm ci
npm link
cribble
cribble --days 30
```

`npm link` makes this checkout available as the `cribble` command. Run it once
per Node installation.

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

The production endpoint is `https://cribble.dev/api/agent/usage`. Endpoint
overrides require HTTPS, except for loopback-only local development. Agent keys
are never written to sync status or background-service files.

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

Installing background sync records the current Node executable and this
checkout's `index.js` path. If either moves, uninstall and reinstall the
background job. Nothing is scheduled until `cribble start` is run.

`CRIBBLE_API_KEY` is available only as an explicit development/CI override;
normal macOS use should keep the key in Keychain.

Run `cribble --help` for all commands and options.

## Development

```sh
npm test
```

Visit [Cribble.dev](https://cribble.dev) for more.
