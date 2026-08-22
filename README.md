# Cribble agent

Cribble agent reads local coding-agent usage through
[`ccusage`](https://ccusage.com/), prints a focused terminal report, and can
sync daily usage to the user's Cribble account. On macOS, syncing can be
scheduled through an explicit, removable background service.

There is no menu-bar interface yet. The CLI and its reusable modules are the
engine that a later menu-bar application will call.

## View local usage

```sh
node index.js
node index.js --days 30
node index.js --days 30 --json
```

The default view contains the latest seven usage days. Cribble uses its local
`ccusage` dependency when installed. `CCUSAGE_BIN` can point to another
executable for development.

## Preview a sync

Dry-run builds the real ingest payload but does not need an API key, contact a
server, acquire a sync lock, or update sync status:

```sh
node index.js sync --dry-run
```

On its first run, it creates a random installation ID at
`~/.config/cribble/client-id`. That UUID identifies this installation; it is
not an authentication secret.

## Manual sync

After the Cribble migration and backend are deployed:

1. Open **Cribble → Settings → Account → Token tracker CLI**.
2. Create a personal key for this computer and copy the one-time secret.
3. Save it in macOS Keychain:

   ```sh
   node index.js auth set
   ```

   The macOS `security` tool prompts for the value. The secret is not included
   in command-line arguments.

4. Run a manual sync:

   ```sh
   node index.js sync
   node index.js status
   ```

For local development and CI, `CRIBBLE_API_KEY` overrides Keychain for the
current process. It is not written into a background-service definition.

The default endpoint is `https://cribble.dev/api/agent/usage`.
`CRIBBLE_SYNC_URL` and `--endpoint` override it for a manual sync:

```sh
CRIBBLE_SYNC_URL="http://localhost:3000/api/agent/usage" node index.js sync
node index.js sync --endpoint http://localhost:3000/api/agent/usage
```

## Opt-in macOS background sync

Do not enable this until the backend route and migration are live and one
manual sync has succeeded.

```sh
# Every 15 minutes, syncing the latest 7 usage days
node index.js background install

# Choose a supported interval and history window
node index.js background install --interval 30 --days 14

node index.js background status
node index.js status
node index.js background pause
node index.js background resume
node index.js background uninstall
```

Supported intervals are 5, 10, 15, 20, 30, and 60 minutes. Installation:

- requires an existing Keychain API key;
- writes one user LaunchAgent at
  `~/Library/LaunchAgents/dev.cribble.agent.sync.plist`;
- uses absolute Node and CLI paths;
- schedules low-priority, calendar-based runs that macOS can coalesce after
  sleep;
- starts one sync immediately after installation;
- never places the API key in the property list;
- can be paused, resumed, or completely removed.

The LaunchAgent runs the same `sync` engine as the terminal. A private lock at
`~/.config/cribble/sync.lock` prevents manual and scheduled syncs from
overlapping. Transient network, timeout, rate-limit, and server failures retry
up to three times with bounded backoff. Authentication and payload errors do
not retry.

Last attempt, success, error, endpoint, and ingest counts are recorded at
`~/.config/cribble/sync-state.json`. This state never contains the API key.
Use `node index.js status` instead of relying on unbounded log files.

`background uninstall` removes the scheduler but keeps the Keychain key.
`auth remove` removes the local Keychain key but does not revoke the key in
Cribble; revocation is done from Settings.

## Wire payload

Sync sends only the strict ingest contract:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-22T00:00:00.000Z",
  "clientId": "123e4567-e89b-42d3-a456-426614174000",
  "timezone": "Asia/Manila",
  "provenance": {
    "source": "ccusage",
    "cliVersion": "1.0.0"
  },
  "daily": [
    {
      "date": "2026-08-22",
      "agents": ["codex"],
      "models": ["gpt-5"],
      "inputTokens": 0,
      "outputTokens": 0,
      "cacheCreationTokens": 0,
      "cacheReadTokens": 0,
      "totalTokens": 0,
      "costUsd": 0
    }
  ]
}
```

Invalid date rows are excluded. The server recomputes `totalTokens` and uses
`generatedAt` to make identical retries safe.

## Development

```sh
npm test
node index.js --help
```

The product boundaries and revised phase plan are documented in
[`docs/PRODUCT_PLAN.md`](docs/PRODUCT_PLAN.md).
