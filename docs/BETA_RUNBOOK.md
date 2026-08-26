# Cribble Agent private-beta runbook

This is the safe path for enrolling one computer at a time. Installing the
package does not connect an account and does not enable background syncing.

## Enroll a tester

1. Confirm the tester uses arm64 or x64 macOS, Linux, or Windows with Node.js
   18 or newer.
   Linux testers also need `secret-tool` for secure key storage and a systemd
   user session for automatic sync.
2. Ask them to create a new Agent key in signed-in Cribble Account Settings.
3. Install and connect the CLI:

   ```sh
   npm install --global cribble-agent@beta
   cribble connect
   cribble sync
   cribble status
   ```

   If npm reports a root-owned cache, do not rerun the install with `sudo`.
   Use a fresh user-owned cache instead:

   ```sh
   npm --cache "$HOME/.npm-user-cache" install --global cribble-agent@beta
   ```

4. Confirm the foreground receipt has the expected date range and totals.
5. Only after that succeeds, explicitly enable automatic syncing:

   ```sh
   cribble start
   cribble status
   ```

`cribble connect` hides the key while it is pasted and stores it in macOS
Keychain, Linux Secret Service, or Windows DPAPI-protected storage. Never
request an Agent key in chat, email, screenshots, logs, or a bug report.

## Diagnose without exposing secrets

Run these commands and share their ordinary output:

```sh
cribble --version
cribble status --no-color
cribble --days 7 --no-color
```

`cribble status` contains operational timestamps and results, but never the
Agent key. A foreground `cribble sync --no-color` is the preferred way to get
an actionable collection, authentication, payload, or network error.

If the local report has no data, verify the coding agent has produced local
usage records that `ccusage` supports. Do not work around a collector error by
uploading raw prompt or conversation files.

For named Hermes profiles, set `HERMES_HOME` to the explicit root or ccusage's
comma-separated root list. If valid collection exceeds the default 120-second
ceiling, set `CRIBBLE_CCUSAGE_TIMEOUT_MS` between 1000 and 900000 milliseconds.
Run `cribble start` again after either change so scheduled and foreground sync
use the same collector configuration.

On Windows, the default `CRIBBLE_WSL_MODE=wsl-first` uses discovered WSL homes
when they contain usage and otherwise falls back to native Windows. Use
`native-only`, `wsl-only`, or `native-first` while diagnosing path issues.
Cribble rejects `both` because ccusage daily aggregates cannot safely
deduplicate mirrored native and WSL records.

Automatic selection persists the first non-empty scope in
`%LOCALAPPDATA%\Cribble\usage-scope`; later syncs fail rather than switching
away from that scope and replacing complete totals. An explicit `native-only`
or `wsl-only` mode bypasses automatic selection. Enroll either the Windows
installation or an installation inside WSL, never both for the same account
and logs.

Prime Agent support retains only token counts, timestamps, provider, and model
from local records. Never request session or conversation files from a tester.

## Pause, remove, or rotate access

Pause without disconnecting:

```sh
cribble pause
```

Resume and immediately queue a sync:

```sh
cribble resume
```

Fully remove automatic syncing, then remove the local key:

```sh
cribble background uninstall
cribble disconnect
```

If a key may have been exposed, revoke it in Cribble Account Settings first,
uninstall or pause the background job, then create and connect a replacement.

## Update a tester

```sh
npm install --global cribble-agent@beta
cribble start
cribble status
```

Re-running `cribble start` is deliberate: it refreshes the launchd job,
systemd user timer, or Windows scheduled task to the current installed CLI and
Node paths. It does not create or replace the Agent key.

## Rollout gate

Expand beyond the current pilot only when all of the following are true:

- foreground sync succeeds with a valid receipt;
- scheduled sync has a recent success in `cribble status`;
- revoke, pause, resume, uninstall, and reconnect paths are understood;
- no Agent key appears in logs, process arguments, background-service
  definitions, or collector environment variables;
- server rate limiting, tenant isolation, and idempotent replacement remain
  green in backend tests and production monitoring.
