<p align="center">
  <a href="https://cribble.dev">
    <img src="assets/cribble-lockup.svg" alt="Cribble Agent" width="420">
  </a>
</p>

<p align="center">Local coding-agent usage, synced to <a href="https://cribble.dev">Cribble</a> on your terms.</p>

![Cribble terminal report](assets/usage-report.svg)

## <img src="assets/cribble-mark.svg" width="16" height="16" alt=""> Get started

Requires macOS or Windows, and Node.js 18+.

```sh
npm install --global cribble-agent
cribble connect
cribble sync
cribble start
```

Create an Agent key in your Cribble account before `cribble connect`. The key
is stored in macOS Keychain or Windows Credential Manager; it is never placed
in the LaunchAgent or Scheduled Task. `cribble start` enables optional
automatic sync.

## <img src="assets/cribble-mark.svg" width="16" height="16" alt=""> Use it

```sh
cribble                 # View the latest 7 usage days
cribble --days 30       # Choose a history window
cribble status           # Check your key and sync state
cribble sync --dry-run  # Preview a sync without sending it
```

Automatic sync is opt-in on macOS (LaunchAgent) and Windows (Scheduled Task
`dev.cribble.agent.sync`). Pause, resume, or remove it whenever you want:

```sh
cribble pause
cribble resume
cribble background uninstall
```

Cribble reads local [`ccusage`](https://ccusage.com/) data only—it does not
intercept prompts or model traffic. Run `cribble --help` for every option.

Interactive syncs use Cribble colors, a small progress animation, and a final
receipt with the synced range, token total, estimated cost, and server result.
LaunchAgent and Scheduled Task runs, CI, pipes, and redirected output stay
plain. Use `--no-color` on any command or set `NO_COLOR=1` when needed.

## <img src="assets/cribble-mark.svg" width="16" height="16" alt=""> Update

```sh
npm install --global cribble-agent@latest
cribble start
cribble status
```

Running `cribble start` after an update refreshes the explicit background job
to the current installed CLI and Node paths. Your Agent key remains in macOS
Keychain or Windows Credential Manager.

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
