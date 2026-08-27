"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  backgroundStatus,
  installBackground,
  pauseBackground,
  resumeBackground,
  uninstallBackground,
} = require("../lib/background");
const { linuxBackgroundPaths, systemdUnits } = require("../lib/background-linux");
const {
  WINDOWS_TASK_NAME,
  quoteWindowsArgument,
  windowsTaskCommand,
} = require("../lib/background-windows");

test("Linux systemd units schedule sync without embedding credentials", () => {
  const units = systemdUnits({
    nodePath: "/opt/node%u bin/node",
    entryPath: "/opt/cribble agent/index.js",
    intervalMinutes: 15,
    days: 7,
    hermesHome: "/home/alice/.hermes,/mnt/hermes archive",
    ccusageTimeoutMs: 180_000,
    claudeConfigDirs: "/home/alice/.claude,/home/alice/.claude-work",
  });

  assert.match(units.service, /sync/);
  assert.match(units.service, /--background/);
  assert.match(units.service, /node%%u/);
  assert.match(units.service, /--hermes-home/);
  assert.match(units.service, /\/home\/alice\/\.hermes/);
  assert.match(units.service, /--ccusage-timeout-ms/);
  assert.match(units.service, /180000/);
  assert.match(units.service, /CRIBBLE_CLAUDE_CONFIG_DIRS=\/home\/alice\/\.claude,\/home\/alice\/\.claude-work/);
  assert.match(units.timer, /OnUnitActiveSec=15min/);
  assert.doesNotMatch(units.timer, /Persistent=true/);
  assert.doesNotMatch(units.service + units.timer, /CRIBBLE_API_KEY|crib_ag_/);
  assert.equal(
    linuxBackgroundPaths("/home/alice", {
      XDG_CONFIG_HOME: "relative",
    }).timerPath,
    join(
      "/home/alice",
      ".config",
      "systemd",
      "user",
      "dev.cribble.agent.sync.timer",
    ),
  );
});

test("public background API installs and controls a Linux user timer", () => {
  const root = mkdtempSync(join(tmpdir(), "cribble-linux-background-"));
  const commands = [];
  const spawnSyncFn = (_command, args) => {
    commands.push(args);
    return { status: 0, stdout: "", stderr: "" };
  };
  const options = {
    platform: "linux",
    homeDirectory: root,
    env: {},
    entryPath: join(__dirname, "..", "index.js"),
    nodePath: process.execPath,
    spawnSyncFn,
  };

  try {
    const installed = installBackground(options);
    const paths = linuxBackgroundPaths(root, {});
    assert.equal(installed.filePath, paths.timerPath);
    assert.equal(existsSync(paths.servicePath), true);
    assert.equal(existsSync(paths.timerPath), true);
    assert.doesNotMatch(readFileSync(paths.servicePath, "utf8"), /crib_ag_/);

    const status = backgroundStatus(options);
    assert.deepEqual(status, {
      installed: true,
      loaded: true,
      disabled: false,
      filePath: paths.timerPath,
    });

    pauseBackground(options);
    resumeBackground(options);
    assert.equal(uninstallBackground(options).removed, true);
    assert.equal(existsSync(paths.timerPath), false);
    assert.equal(
      commands.some((args) => args.includes(`${"dev.cribble.agent.sync"}.timer`)),
      true,
    );
    assert.equal(
      commands.some(
        (args) =>
          args[1] === "start" &&
          args.includes("--no-block") &&
          args.includes("dev.cribble.agent.sync.service"),
      ),
      true,
    );
    assert.equal(
      commands.some(
        (args) =>
          args[1] === "stop" &&
          args.includes("dev.cribble.agent.sync.service"),
      ),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed Linux initial start disables the timer and removes new units", () => {
  const root = mkdtempSync(join(tmpdir(), "cribble-linux-rollback-"));
  const commands = [];
  const spawnSyncFn = (_command, args) => {
    commands.push(args);
    if (args[1] === "start" && args.includes("dev.cribble.agent.sync.service")) {
      return { status: 1, stdout: "", stderr: "start failed" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const paths = linuxBackgroundPaths(root, {});
  try {
    assert.throws(
      () =>
        installBackground({
          platform: "linux",
          homeDirectory: root,
          env: {},
          entryPath: join(__dirname, "..", "index.js"),
          nodePath: process.execPath,
          spawnSyncFn,
        }),
      /Starting Linux background sync failed/,
    );
    assert.equal(existsSync(paths.servicePath), false);
    assert.equal(existsSync(paths.timerPath), false);
    assert.equal(
      commands.some(
        (args) =>
          args[1] === "disable" &&
          args.includes("dev.cribble.agent.sync.timer"),
      ),
      true,
    );
    assert.equal(
      commands.some(
        (args) =>
          args[1] === "stop" &&
          args.includes("dev.cribble.agent.sync.service"),
      ),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows Task Scheduler command safely quotes paths and excludes credentials", () => {
  assert.equal(quoteWindowsArgument("C:\\Program Files\\node.exe"), '"C:\\Program Files\\node.exe"');
  const command = windowsTaskCommand({
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    entryPath: "C:\\Users\\Alice\\Cribble Agent\\index.js",
    days: 14,
    hermesHome: "C:\\Users\\Alice\\.hermes,D:\\Hermes Archive",
    ccusageTimeoutMs: 180_000,
  });
  assert.match(command, /^"C:\\Program Files\\nodejs\\node\.exe"/);
  assert.match(command, /--days 14/);
  assert.match(command, /--hermes-home "C:\\Users\\Alice\\\.hermes,D:\\Hermes Archive"/);
  assert.match(command, /--ccusage-timeout-ms 180000/);
  assert.doesNotMatch(command, /CRIBBLE_API_KEY|crib_ag_/);
});

test("public background API installs and controls a Windows scheduled task", () => {
  const calls = [];
  let installed = false;
  let disabled = false;
  const spawnSyncFn = (_command, args) => {
    calls.push(args);
    const action = args[0];
    if (action === "/Create") installed = true;
    if (action === "/Delete") installed = false;
    if (action === "/Change") disabled = args.includes("/Disable");
    if (action === "/Query") {
      return installed
        ? {
            status: 0,
            stdout: `<Task><Settings><Enabled>${disabled ? "false" : "true"}</Enabled></Settings></Task>`,
            stderr: "",
          }
        : { status: 1, stdout: "", stderr: "cannot find the task" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const options = {
    platform: "win32",
    entryPath: "C:\\Cribble\\index.js",
    nodePath: "C:\\Node\\node.exe",
    existsSyncFn: () => true,
    spawnSyncFn,
  };

  installBackground(options);
  assert.equal(backgroundStatus(options).loaded, true);
  pauseBackground(options);
  assert.equal(backgroundStatus(options).disabled, true);
  resumeBackground(options);
  assert.equal(backgroundStatus(options).disabled, false);
  assert.equal(uninstallBackground(options).removed, true);
  assert.equal(backgroundStatus(options).installed, false);

  const create = calls.find((args) => args[0] === "/Create");
  assert.equal(create[create.indexOf("/TN") + 1], WINDOWS_TASK_NAME);
  assert.doesNotMatch(create.join(" "), /CRIBBLE_API_KEY|crib_ag_/);
  assert.equal(calls.some((args) => args[0] === "/End"), true);
});

test("Windows status does not misreport access failures as an absent task", () => {
  assert.throws(
    () =>
      backgroundStatus({
        platform: "win32",
        spawnSyncFn: () => ({
          status: 1,
          stdout: "",
          stderr: "ERROR: Access is denied.",
        }),
      }),
    /Inspecting Windows background sync failed: ERROR: Access is denied/,
  );
});

test("failed Windows initial start removes the newly created task", () => {
  let installed = false;
  const calls = [];
  const spawnSyncFn = (_command, args) => {
    calls.push(args);
    if (args[0] === "/Query") {
      return { status: 1, stdout: "", stderr: "cannot find the task" };
    }
    if (args[0] === "/Create") {
      installed = true;
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "/Run") {
      return { status: 1, stdout: "", stderr: "start failed" };
    }
    if (args[0] === "/Delete") {
      installed = false;
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  assert.throws(
    () =>
      installBackground({
        platform: "win32",
        entryPath: "C:\\Cribble\\index.js",
        nodePath: "C:\\Node\\node.exe",
        existsSyncFn: () => true,
        spawnSyncFn,
      }),
    /Starting Windows background sync failed/,
  );
  assert.equal(installed, false);
  assert.equal(calls.some((args) => args[0] === "/Delete"), true);
});
