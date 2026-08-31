<p align="center">
  <a href="https://cribble.dev">
    <img src="assets/cribble-lockup.svg" alt="Cribble Agent" width="420">
  </a>
</p>

<p align="center">Local coding-agent usage, synced to <a href="https://cribble.dev">Cribble</a> on your terms.</p>

![Cribble terminal report](assets/usage-report.svg)

## <img src="assets/cribble-mark.svg" width="16" height="16" alt=""> Get started

Requires Node.js 18+ on arm64 or x64 macOS, Linux, or Windows.

Cross-platform support is currently in the opt-in `beta` lane. The `latest`
lane remains the stable macOS-only 1.3 release until the same beta build has
been validated on real macOS, Linux, and Windows machines.

```sh
npm install --global cribble-agent@beta
cribble connect
cribble sync
cribble start
```

Create an Agent key in your Cribble account before `cribble connect`. The key
is stored in macOS Keychain, Linux Secret Service, or Windows DPAPI-protected
storage; it is never placed in a background-service definition. `cribble start`
enables optional automatic sync through launchd, a systemd user timer, or
Windows Task Scheduler.

Linux key storage requires `secret-tool` (usually packaged as
`libsecret-tools`) and background sync requires a systemd user session.

## <img src="assets/cribble-mark.svg" width="16" height="16" alt=""> Use it

```sh
cribble                 # View the latest 7 usage days
cribble --days 30       # Choose a history window
cribble --all           # View all available usage history
cribble status           # Check your key and sync state
cribble sync --dry-run  # Preview a sync without sending it
cribble sync --all --dry-run  # Preview all history without sending it
```

Pause, resume, or remove background sync whenever you want:

```sh
cribble pause
cribble resume
cribble background uninstall
```

Cribble uses [`ccusage`](https://ccusage.com/) as its primary collector. It also
supports Prime Agent and Cursor, which ccusage does not currently cover. The
passive Prime reader and the Cursor reader retain only token counts,
timestamps, provider, model, and cost; prompts, responses, tool output, and
Cursor session cookies are never retained or uploaded. Cursor totals come from
Cursor's official usage export, authenticated with the login already stored in
the local Cursor app on macOS, Linux, or Windows. A machine-local,
metadata-only event ledger preserves those totals when Prime rotates old
session files or Cursor's local state is temporarily missing; incomplete or
unreadable Prime scans fail instead of uploading a lower replacement total,
and Cursor refresh problems (signed out, expired session, offline) keep the
last complete ledger and print a warning instead of blocking the sync. Set
`CRIBBLE_CURSOR=0` to skip refreshing Cursor while keeping the last complete
ledger. Cursor SQLite reading uses the system `sqlite3` CLI when available and
falls back to `node:sqlite` on Node.js 22+.

Set `HERMES_HOME` to one Hermes root, or to ccusage's comma-separated list of
roots, when named Hermes profiles live outside the default location. Cribble
passes the explicit value through unchanged while continuing to remove unrelated
API keys and credentials from the collector environment. Collection uses the
requested `--days` window, or every available day with `--all`, and a 120-second
timeout. For unusually large local histories, set
`CRIBBLE_CCUSAGE_TIMEOUT_MS` to a whole number from 1000 to 900000. Run
`cribble start` again after changing either variable so the opt-in background
job captures the same values as foreground sync.

On Windows, Cribble defaults to `CRIBBLE_WSL_MODE=wsl-first`: it uses discovered
WSL usage when present and otherwise falls back to native Windows usage. Use
`native-only`, `wsl-only`, or `native-first` to change that behavior. The unsafe
`both` mode is rejected because ccusage's daily aggregates do not expose enough
record identity to deduplicate mirrored logs. ccusage always wins when two
collectors identify the same provider and day, preventing duplicate Claude,
Codex, Cursor, or Prime Agent totals.

The first non-empty Windows or WSL scope is persisted in machine-local Cribble
state so a temporary source failure cannot silently switch scopes and replace
complete totals. Set `CRIBBLE_WSL_MODE=native-only` or `wsl-only` deliberately
to override automatic selection. Do not enroll both the Windows installation
and a separate Cribble installation inside WSL against the same account; they
have different machine identities and can scan the same logs.

Run `cribble --help` for every option.

Interactive syncs use Cribble colors, a small progress animation, and a final
receipt with the synced range, token total, estimated cost, and server result.
Background runs, CI, pipes, and redirected output stay plain. Use
`--no-color` on any command or set `NO_COLOR=1` when needed.

## <img src="assets/cribble-mark.svg" width="16" height="16" alt=""> Update

```sh
npm install --global cribble-agent@beta
cribble start
cribble status
```

Running `cribble start` after an update refreshes the explicit background job
to the current installed CLI and Node paths. Your Agent key remains in the
operating system's secure credential storage.

## <img src="assets/cribble-mark.svg" width="16" height="16" alt=""> Develop

```sh
npm ci
npm link
npm test
```

`npm link` exposes this checkout as `cribble`; it is not needed after the
global install. The private-beta operating checklist is in
[`docs/BETA_RUNBOOK.md`](docs/BETA_RUNBOOK.md). Visit
[Cribble.dev](https://cribble.dev) to get started.

Third-party adaptations and license notices are listed in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
