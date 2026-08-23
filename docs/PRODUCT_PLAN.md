# Cribble agent product plan

## Product goal

Cribble should collect coding-agent token usage on a user's Mac, sync it to
their Cribble account automatically after an explicit opt-in, and display the
history in the Cribble dashboard. A menu-bar application is the final visual
layer, not a prerequisite for collection or syncing.

```text
agent logs -> ccusage -> reusable Cribble engine -> Cribble ingest API
                                                   -> token dashboard
                                                   -> menu-bar UI (last)
```

## Architectural boundaries

- `cribble-agent` owns local collection, normalization, local identity,
  scheduling, sync status, retries, and the eventual menu-bar client.
- `Cribble` owns personal access keys, authenticated ingestion, isolated daily
  storage, account deletion, and the future dashboard read model.
- Token usage never writes to browser-extension events, scores, achievements,
  insights, devices, or leaderboard tables.
- The menu-bar app must call the same reusable local engine as the CLI. It must
  not introduce a second collector or a second wire protocol.
- Background sync is opt-in. Installing, pausing, resuming, or removing the
  background job must always be an explicit user command or UI action.
- Secrets belong in macOS Keychain. They must not be embedded in a LaunchAgent
  property list, command-line argument, log, state file, or client identifier.

## What phases 1-4 produced

1. Isolated database tables and hashed personal access keys.
2. Session-authenticated key creation, listing, and revocation.
3. A bearer-authenticated, idempotent daily ingest endpoint.
4. A manual terminal report and manual `sync` command, plus Settings key UI.

The production foundation is now live. The token-usage migrations through 046
are applied to Cribble's production Supabase project, the authenticated
key-management and bearer-ingest routes are deployed at `cribble.dev`, and
Account Settings contains the token tracker key and sharing controls. The
opt-in Burn Board renders aggregate public usage; the private personal token
dashboard described in Phase 7 is not built yet.

## Revised remaining phases

### Phase 5 - unattended CLI foundation

- Split the one-file CLI into reusable collection, payload, identity, HTTP,
  state, Keychain, and background-service modules.
- Preserve `show`, manual `sync`, endpoint overrides, and dry-run behavior.
- Add secure Keychain credential setup and lookup on macOS while keeping the
  environment variable as an explicit development/CI override.
- Add overlap protection, bounded retry behavior, durable last-sync status,
  and an opt-in macOS LaunchAgent lifecycle.
- Unit-test generated service definitions and system-command calls without
  installing a real service or writing to a real Keychain.

### Phase 6 - controlled beta activation

- [x] Review and commit each repository separately.
- [x] Apply migration 041 through the controlled production database process.
- [x] Deploy Cribble routes and Settings UI before enabling any scheduled client.
- [x] Complete the CLI production-hardening pass and live pilot verification.
- [x] Publish `cribble-agent@1.2.0` to npm so beta users do not clone a mutable
  development checkout, then publish `1.3.0` as the hardened Phase 6 release.
- [x] Add CI across supported Node versions and Apple Silicon/Intel macOS.
- [x] Add npm trusted publishing with provenance-ready, tokenless GitHub
  releases.
- [x] Require 2FA for direct publishing and disallow traditional npm publish
  tokens after verifying the trusted release path.
- [ ] Provide a Homebrew tap for a more Mac-native install. Intentionally
  deferred until Phase 7 is complete.
- [x] Create the pilot's one-time key through signed-in Account Settings and
  save it to macOS Keychain.
- [x] Verify one manual sync end to end, then enable background sync for one
  pilot account and observe it before expanding the beta.
- [x] After the pilot data path is proven, give foreground CLI commands a focused
  presentation pass: semantic Cribble colors for collection/sync/success/error
  states, a compact animated progress indicator while work is active, and a
  polished final receipt showing the synced date range and totals.
- [x] Keep presentation separate from sync logic. Disable animation automatically
  for LaunchAgent runs, CI, redirected output, and non-interactive terminals;
  honor `--no-color` and `NO_COLOR`; and snapshot-test both styled and plain
  output so visual polish cannot hide failures or corrupt logs.
- [x] Add a private-beta runbook with manual-first onboarding, diagnostics,
  update, key-revocation, pause, and uninstall procedures.
- [x] Keep a documented stop/uninstall path and never silently enroll users.

The production deployment itself does not enroll a machine. No scheduled sync
is installed until the pilot explicitly runs `background install`.

### Phase 7 - token dashboard

- Add an authenticated read endpoint and server-side aggregation for machines.
- Define dashboard totals, date ranges, timezone rules, empty states, and data
  freshness from real pilot data.
- Render token, cost, model, agent, and client views without connecting them to
  scores or the leaderboard.

### Phase 8 - menu-bar application

- Wrap the reusable local engine in a small macOS menu-bar interface.
- Show current totals, last-sync state, sync-now, pause/resume, and settings.
- Package, sign, test, and distribute it through the private-beta process.

## Release gates

Each phase stops for tests and review. Production migration, deployment,
Keychain mutation, LaunchAgent installation, and beta enrollment are explicit
approval boundaries; local code generation and mocked tests do not cross them.
