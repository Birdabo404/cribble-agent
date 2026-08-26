<p align="center">
  <a href="https://cribble.dev">
    <img src="assets/cribble-lockup.svg" alt="Cribble Agent" width="420">
  </a>
</p>

<p align="center">Local coding-agent usage, synced to <a href="https://cribble.dev">Cribble</a> on your terms.</p>

![Cribble terminal report](assets/usage-report.svg)

## <img src="assets/cribble-mark.svg" width="16" height="16" alt=""> Get started

Requires macOS or Linux, and Node.js 18+. Linux also needs `secret-tool`
(package `libsecret-tools` on Debian/Ubuntu, `libsecret` on Fedora/Arch), a
Secret Service keyring such as GNOME Keyring or KWallet, and systemd for
automatic background sync.

```sh
npm install --global cribble-agent
cribble connect
cribble sync
cribble start
```

Create an Agent key in your Cribble account before `cribble connect`. The key
is stored in macOS Keychain or the Linux keyring (Secret Service); it is never
placed in the background-service file. `cribble start` enables optional
automatic sync.

## <img src="assets/cribble-mark.svg" width="16" height="16" alt=""> Use it

```sh
cribble                 # View the latest 7 usage days
cribble --days 30       # Choose a history window
cribble status           # Check your key and sync state
cribble sync --dry-run  # Preview a sync without sending it
```

Automatic sync uses a LaunchAgent on macOS and a systemd user timer on Linux.
Both run only while you are logged in (on Linux, `loginctl enable-linger` opts
into running while logged out). Pause, resume, or remove it whenever you want:

```sh
cribble pause
cribble resume
cribble background uninstall
```

Cribble reads local [`ccusage`](https://ccusage.com/) data only—it does not
intercept prompts or model traffic. Run `cribble --help` for every option.

Interactive syncs use Cribble colors, a small progress animation, and a final
receipt with the synced range, token total, estimated cost, and server result.
Background runs, CI, pipes, and redirected output stay plain. Use
`--no-color` on any command or set `NO_COLOR=1` when needed.

## <img src="assets/cribble-mark.svg" width="16" height="16" alt=""> Update

```sh
npm install --global cribble-agent@latest
cribble start
cribble status
```

Running `cribble start` after an update refreshes the explicit background job
to the current installed CLI and Node paths. Your Agent key remains in the
platform credential store.

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
