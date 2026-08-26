#!/usr/bin/env bash
# Live end-to-end test of the Linux keyring and systemd background lifecycle,
# run inside a disposable Docker container so the host's keyring and systemd
# state are never touched.
#
# Requires Docker and a local `npm ci` (the repo is mounted read-only into the
# container). The dummy Agent key never leaves the container: the container
# has no usage data, so the background sync stops before any network call.
#
# Usage: scripts/linux-live-test.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="cribble-linux-live-test"
CONTAINER="cribble-linux-live-test-$$"
TESTER_UID=1001
DUMMY_KEY="crib_ag_$(printf 'a%.0s' {1..64})"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

command -v docker >/dev/null || fail "Docker is required."
[ -d "$REPO_ROOT/node_modules" ] || fail "Run npm ci first; the container mounts the repo read-only."

# ccusage makes its native collector executable on first run. The read-only
# mount would turn that into EROFS, so grant the bit on the host up front.
chmod +x "$REPO_ROOT"/node_modules/@ccusage/*/bin/* 2>/dev/null || true

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  [ -n "${BUILD_DIR:-}" ] && rm -rf "$BUILD_DIR"
}
trap cleanup EXIT

BUILD_DIR="$(mktemp -d)"
cat > "$BUILD_DIR/Dockerfile" <<'EOF'
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    systemd systemd-sysv dbus dbus-user-session \
    gnome-keyring libsecret-tools nodejs \
    util-linux ca-certificates \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash tester
CMD ["/sbin/init"]
EOF

echo "== Building test image =="
docker build -q -t "$IMAGE" "$BUILD_DIR" >/dev/null

echo "== Starting systemd container =="
docker run -d --name "$CONTAINER" --privileged --cgroupns=private \
  --tmpfs /tmp --tmpfs /run --tmpfs /run/lock \
  -v "$REPO_ROOT:/opt/cribble-agent:ro" \
  "$IMAGE" >/dev/null

for _ in $(seq 1 30); do
  state="$(docker exec "$CONTAINER" systemctl is-system-running 2>/dev/null || true)"
  [ "$state" = "running" ] || [ "$state" = "degraded" ] && break
  sleep 1
done
[ "$state" = "running" ] || [ "$state" = "degraded" ] || fail "systemd did not come up ($state)."

docker exec "$CONTAINER" loginctl enable-linger tester
for _ in $(seq 1 15); do
  docker exec "$CONTAINER" test -S "/run/user/$TESTER_UID/bus" && break
  sleep 1
done

as_tester() {
  docker exec -u tester \
    -e "XDG_RUNTIME_DIR=/run/user/$TESTER_UID" \
    -e "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$TESTER_UID/bus" \
    "$CONTAINER" bash -c "$1"
}

echo "== Unlocking a fresh Secret Service keyring =="
# pkill -x, not -f: a -f pattern would match this very shell's command line.
as_tester '
  pkill -u tester -x gnome-keyring-daemon 2>/dev/null || true
  sleep 1
  rm -rf ~/.local/share/keyrings "/run/user/'"$TESTER_UID"'"/keyring*
  printf "live-test-pass\n" | gnome-keyring-daemon --unlock --components=secrets
  sleep 1
  printf probe | secret-tool store --label=probe service probe.svc account probe
  [ "$(secret-tool lookup service probe.svc account probe)" = "probe" ]
  secret-tool clear service probe.svc account probe
' || fail "Secret Service keyring did not come up."

cli='node /opt/cribble-agent/index.js'

echo "== connect =="
as_tester "printf '%s\n' '$DUMMY_KEY' | script -qec '$cli connect' /dev/null" >/dev/null
as_tester "$cli status" | grep -q "Linux keyring" || fail "connect did not reach the keyring."

echo "== start =="
as_tester "$cli start" >/dev/null
[ "$(as_tester 'systemctl --user is-enabled dev.cribble.agent.sync.timer')" = "enabled" ] \
  || fail "timer is not enabled after start."
as_tester 'systemctl --user list-timers --no-pager' | grep -q dev.cribble.agent.sync.timer \
  || fail "timer is not scheduled after start."

echo "== scheduled sync reads the keyring =="
sleep 4
last_error="$(as_tester 'grep -o "\"lastError\": \"[^\"]*\"" ~/.config/cribble/sync-state.json' || true)"
[ -n "$last_error" ] || fail "the kickstarted sync never ran."
case "$last_error" in
  *keyring*|*"Agent key"*) fail "the scheduled sync could not read the keyring: $last_error" ;;
esac
echo "   sync ran past the keyring; stopped at: $last_error"

echo "== pause / resume =="
as_tester "$cli pause" >/dev/null
[ "$(as_tester 'systemctl --user is-enabled dev.cribble.agent.sync.timer || true')" = "disabled" ] \
  || fail "timer is not disabled after pause."
as_tester "$cli status" | grep -q paused || fail "status does not report paused."
as_tester "$cli resume" >/dev/null
[ "$(as_tester 'systemctl --user is-enabled dev.cribble.agent.sync.timer')" = "enabled" ] \
  || fail "timer is not enabled after resume."

echo "== uninstall / disconnect =="
as_tester "$cli background uninstall" >/dev/null
[ "$(as_tester 'ls ~/.config/systemd/user 2>/dev/null | wc -l')" = "0" ] \
  || fail "unit files remain after uninstall."
as_tester "$cli disconnect" >/dev/null
if as_tester 'secret-tool lookup service dev.cribble.agent.api-key account cribble-agent' >/dev/null 2>&1; then
  fail "the Agent key is still in the keyring after disconnect."
fi
as_tester "$cli status" | grep -q "not configured" || fail "status still reports a key."

echo
echo "PASS: connect, start, scheduled keyring read, pause, resume, uninstall, disconnect."
