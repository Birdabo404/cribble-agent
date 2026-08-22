# Cribble Agent

Track local coding-agent token usage and optionally sync it to Cribble. The
CLI reads local `ccusage` data; it does not intercept prompts or model traffic.

![Cribble terminal report](assets/usage-report.svg)

## Quick start

Requires Node.js 18 or newer.

```sh
npm ci
node index.js
node index.js --days 30
```

The CLI reads usage through its bundled [`ccusage`](https://ccusage.com/)
dependency. Use `--json` for machine-readable output.

## Sync

Preview the payload without sending it:

```sh
node index.js sync --dry-run
```

To enable syncing, create a token-tracker API key in your signed-in Cribble
Account Settings. Save it in macOS Keychain, then run one manual sync:

```sh
node index.js auth set
node index.js sync
node index.js status
```

The production endpoint is `https://cribble.dev/api/agent/usage`. Endpoint
overrides require HTTPS, except for loopback-only local development. API keys
are never written to sync status or background-service files.

Optional background sync is macOS-only:

```sh
node index.js background install
node index.js background status
node index.js background pause
node index.js background resume
node index.js background uninstall
```

Installing background sync records the current Node executable and this
checkout's `index.js` path. If either moves, uninstall and reinstall the
background job. Nothing is scheduled until `background install` is run.

`CRIBBLE_API_KEY` is available only as an explicit development/CI override;
normal macOS use should keep the key in Keychain.

Run `node index.js --help` for all commands and options.

## Development

```sh
npm test
```

Visit [Cribble.dev](https://cribble.dev) for more.
