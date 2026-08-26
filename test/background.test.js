"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  BACKGROUND_LABEL,
  backgroundStatus,
  installBackground,
  launchAgentPath,
  launchAgentPlist,
  pauseBackground,
  resolveStableNodePath,
  resumeBackground,
  systemdServicePath,
  systemdServiceUnit,
  systemdTimerPath,
  systemdTimerUnit,
  uninstallBackground,
} = require("../lib/background");

const SYSTEMCTL = "/usr/bin/systemctl";

function linuxOptions(root, spawnSyncFn) {
  return {
    homeDirectory: root,
    env: {},
    platform: "linux",
    systemctlPath: SYSTEMCTL,
    spawnSyncFn,
  };
}

test("launchAgentPlist schedules an opt-in low-priority sync without secrets", () => {
  const plist = launchAgentPlist({
    nodePath: "/usr/local/bin/node",
    entryPath: "/Users/test/cribble-agent/index.js",
    intervalMinutes: 15,
    days: 30,
    endpoint: "https://cribble.dev/api/agent/usage",
  });

  assert.match(plist, new RegExp(`<string>${BACKGROUND_LABEL}</string>`));
  assert.match(plist, /<string>--background<\/string>/);
  assert.match(plist, /<integer>0<\/integer>/);
  assert.match(plist, /<integer>15<\/integer>/);
  assert.match(plist, /<integer>30<\/integer>/);
  assert.match(plist, /<integer>45<\/integer>/);
  assert.match(plist, /<string>Background<\/string>/);
  assert.doesNotMatch(plist, /RunAtLoad/);
  assert.doesNotMatch(plist, /CRIBBLE_API_KEY|crib_ag_/);
});

test("launchAgentPlist rejects intervals that do not map safely to the hour", () => {
  assert.throws(
    () =>
      launchAgentPlist({
        nodePath: "/usr/bin/node",
        entryPath: "/tmp/index.js",
        intervalMinutes: 7,
        days: 7,
      }),
    /must be one of/,
  );
});

test("installBackground validates, loads, and starts the generated service", () => {
  const root = mkdtempSync(join(tmpdir(), "cribble-agent-background-"));
  const commands = [];
  const spawnSyncFn = (command, args) => {
    commands.push([command, ...args]);
    return { status: 0, stdout: "", stderr: "" };
  };

  try {
    const result = installBackground({
      homeDirectory: root,
      nodePath: process.execPath,
      entryPath: join(__dirname, "..", "index.js"),
      intervalMinutes: 15,
      days: 7,
      platform: "darwin",
      uid: 501,
      spawnSyncFn,
    });

    assert.equal(result.filePath, launchAgentPath(root));
    assert.match(readFileSync(result.filePath, "utf8"), /--background/);
    assert.equal(commands[0][0], "/usr/bin/plutil");
    assert.deepEqual(commands.slice(1).map((command) => command.slice(0, 2)), [
      ["/bin/launchctl", "print-disabled"],
      ["/bin/launchctl", "enable"],
      ["/bin/launchctl", "bootout"],
      ["/bin/launchctl", "bootstrap"],
      ["/bin/launchctl", "kickstart"],
    ]);
    assert.equal(commands.flat().some((value) => String(value).startsWith("crib_ag_")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveStableNodePath prefers a PATH shim targeting the running Node binary", () => {
  const targets = new Map([
    ["/opt/homebrew/Cellar/node/25.2.1/bin/node", "/opt/homebrew/Cellar/node/25.2.1/bin/node"],
    ["/opt/homebrew/bin/node", "/opt/homebrew/Cellar/node/25.2.1/bin/node"],
  ]);

  assert.equal(
    resolveStableNodePath(
      "/opt/homebrew/Cellar/node/25.2.1/bin/node",
      "/opt/homebrew/bin:/usr/bin",
      {
        existsSyncFn: (filePath) => targets.has(filePath),
        realpathSyncFn: (filePath) => targets.get(filePath),
      },
    ),
    "/opt/homebrew/bin/node",
  );
});

test("installBackground removes a new plist when launchctl cannot load it", () => {
  const root = mkdtempSync(join(tmpdir(), "cribble-agent-background-"));
  const spawnSyncFn = (command, args) => {
    if (command === "/bin/launchctl" && args[0] === "bootstrap") {
      return { status: 5, stdout: "", stderr: "load failed" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  try {
    assert.throws(
      () =>
        installBackground({
          homeDirectory: root,
          nodePath: process.execPath,
          entryPath: join(__dirname, "..", "index.js"),
          platform: "darwin",
          uid: 501,
          spawnSyncFn,
        }),
      /Installing background sync failed: load failed/,
    );
    assert.equal(existsSync(launchAgentPath(root)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installBackground restores a previous schedule after a failed update", () => {
  const root = mkdtempSync(join(tmpdir(), "cribble-agent-background-"));
  const filePath = launchAgentPath(root);
  const previous = launchAgentPlist({
    nodePath: process.execPath,
    entryPath: join(__dirname, "..", "index.js"),
    intervalMinutes: 30,
    days: 3,
  });
  let bootstrapCalls = 0;
  const spawnSyncFn = (command, args) => {
    if (command === "/bin/launchctl" && args[0] === "bootstrap") {
      bootstrapCalls += 1;
      return bootstrapCalls === 1
        ? { status: 5, stdout: "", stderr: "new definition failed" }
        : { status: 0, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  try {
    mkdirSync(join(root, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(filePath, previous);
    assert.throws(
      () =>
        installBackground({
          homeDirectory: root,
          nodePath: process.execPath,
          entryPath: join(__dirname, "..", "index.js"),
          intervalMinutes: 15,
          days: 7,
          platform: "darwin",
          uid: 501,
          spawnSyncFn,
        }),
      /new definition failed/,
    );

    assert.equal(readFileSync(filePath, "utf8"), previous);
    assert.equal(bootstrapCalls, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installBackground restores a paused flag after a failed update", () => {
  const root = mkdtempSync(join(tmpdir(), "cribble-agent-background-"));
  const actions = [];
  const spawnSyncFn = (command, args) => {
    actions.push(args[0]);
    if (args[0] === "print-disabled") {
      return { status: 0, stdout: `\"${BACKGROUND_LABEL}\" => true`, stderr: "" };
    }
    if (args[0] === "bootout") {
      return { status: 3, stdout: "", stderr: "No such process" };
    }
    if (args[0] === "bootstrap") {
      return { status: 5, stdout: "", stderr: "load failed" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  try {
    assert.throws(
      () =>
        installBackground({
          homeDirectory: root,
          nodePath: process.execPath,
          entryPath: join(__dirname, "..", "index.js"),
          platform: "darwin",
          uid: 501,
          spawnSyncFn,
        }),
      /load failed/,
    );
    assert.equal(actions.at(-1), "disable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resumeBackground restores the paused state when startup fails", () => {
  const root = mkdtempSync(join(tmpdir(), "cribble-agent-background-"));
  const filePath = launchAgentPath(root);
  const actions = [];
  let bootoutCalls = 0;
  const spawnSyncFn = (_command, args) => {
    actions.push(args[0]);
    if (args[0] === "print-disabled") {
      return { status: 0, stdout: `\"${BACKGROUND_LABEL}\" => true`, stderr: "" };
    }
    if (args[0] === "print") return { status: 3, stdout: "", stderr: "not loaded" };
    if (args[0] === "bootout") {
      bootoutCalls += 1;
      return bootoutCalls === 1
        ? { status: 3, stdout: "", stderr: "No such process" }
        : { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "kickstart") {
      return { status: 5, stdout: "", stderr: "start failed" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  try {
    mkdirSync(join(root, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(filePath, "valid plist placeholder");
    assert.throws(
      () =>
        resumeBackground({
          homeDirectory: root,
          platform: "darwin",
          uid: 501,
          spawnSyncFn,
        }),
      /start failed/,
    );
    assert.equal(actions.at(-1), "disable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pauseBackground rolls back its disabled flag when stopping fails", () => {
  const commands = [];
  const spawnSyncFn = (command, args) => {
    commands.push([command, ...args]);
    if (args[0] === "bootout") {
      return { status: 5, stdout: "", stderr: "permission denied\u001b[31m" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  assert.throws(
    () => pauseBackground({ platform: "darwin", uid: 501, spawnSyncFn }),
    /Stopping background sync failed: permission denied/,
  );
  assert.deepEqual(commands.map((command) => command[1]), ["disable", "bootout", "enable"]);
});

test("pauseBackground accepts an already stopped service", () => {
  assert.doesNotThrow(() =>
    pauseBackground({
      platform: "darwin",
      uid: 501,
      spawnSyncFn: (_command, args) =>
        args[0] === "bootout"
          ? { status: 3, stdout: "", stderr: "Boot-out failed: No such process" }
          : { status: 0, stdout: "", stderr: "" },
    }),
  );
});

test("systemdServiceUnit runs a low-priority background sync without secrets", () => {
  const unit = systemdServiceUnit({
    nodePath: "/usr/bin/node",
    entryPath: "/home/test/cribble agent/index.js",
    intervalMinutes: 15,
    days: 30,
    endpoint: "https://cribble.dev/api/agent/usage",
  });

  assert.match(unit, /Type=oneshot/);
  assert.match(
    unit,
    /ExecStart=\/usr\/bin\/node "\/home\/test\/cribble agent\/index\.js" sync --background --days 30/,
  );
  assert.match(unit, /WorkingDirectory=\/home\/test\/cribble agent/);
  assert.match(unit, /UMask=0077/);
  assert.match(unit, /IOSchedulingClass=idle/);
  assert.doesNotMatch(unit, /CRIBBLE_API_KEY|crib_ag_/);
});

test("systemd units escape percent specifiers and reject line breaks", () => {
  const unit = systemdServiceUnit({
    nodePath: "/opt/100%/node",
    entryPath: "/tmp/index.js",
    intervalMinutes: 15,
    days: 7,
  });
  assert.match(unit, /ExecStart=\/opt\/100%%\/node/);

  assert.throws(
    () =>
      systemdServiceUnit({
        nodePath: "/usr/bin/node",
        entryPath: "/tmp/evil\nExecStart=oops/index.js",
        intervalMinutes: 15,
        days: 7,
      }),
    /line breaks/,
  );
});

test("systemdTimerUnit maps supported intervals onto the hour", () => {
  const unit = systemdTimerUnit({ intervalMinutes: 20, days: 7 });
  assert.match(unit, /OnCalendar=\*-\*-\* \*:0\/20:00/);
  assert.match(unit, /WantedBy=timers\.target/);
  assert.throws(() => systemdTimerUnit({ intervalMinutes: 7, days: 7 }), /must be one of/);
});

test("installBackground on Linux writes units, reloads, enables, and kickstarts", () => {
  const root = mkdtempSync(join(tmpdir(), "cribble-agent-systemd-"));
  const commands = [];
  const spawnSyncFn = (command, args) => {
    commands.push([command, ...args]);
    return { status: 0, stdout: "", stderr: "" };
  };

  try {
    const result = installBackground({
      ...linuxOptions(root, spawnSyncFn),
      nodePath: process.execPath,
      entryPath: join(__dirname, "..", "index.js"),
      intervalMinutes: 15,
      days: 7,
    });

    assert.equal(result.filePath, systemdTimerPath(root, {}));
    assert.match(readFileSync(systemdServicePath(root, {}), "utf8"), /--background/);
    assert.match(readFileSync(result.filePath, "utf8"), /OnCalendar=\*-\*-\* \*:0\/15:00/);
    assert.deepEqual(
      commands.map((command) => command.slice(0, 3)),
      [
        [SYSTEMCTL, "--user", "daemon-reload"],
        [SYSTEMCTL, "--user", "enable"],
        [SYSTEMCTL, "--user", "start"],
        [SYSTEMCTL, "--user", "start"],
      ],
    );
    assert.deepEqual(commands.at(-1).slice(2), [
      "start",
      "--no-block",
      `${BACKGROUND_LABEL}.service`,
    ]);
    assert.equal(commands.flat().some((value) => String(value).startsWith("crib_ag_")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installBackground on Linux removes new units when systemctl cannot arm them", () => {
  const root = mkdtempSync(join(tmpdir(), "cribble-agent-systemd-"));
  const spawnSyncFn = (command, args) => {
    if (args[1] === "enable") return { status: 1, stdout: "", stderr: "enable failed" };
    return { status: 0, stdout: "", stderr: "" };
  };

  try {
    assert.throws(
      () =>
        installBackground({
          ...linuxOptions(root, spawnSyncFn),
          nodePath: process.execPath,
          entryPath: join(__dirname, "..", "index.js"),
        }),
      /Enabling background sync failed: enable failed/,
    );
    assert.equal(existsSync(systemdServicePath(root, {})), false);
    assert.equal(existsSync(systemdTimerPath(root, {})), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pauseBackground on Linux disables the timer and requires an install", () => {
  const root = mkdtempSync(join(tmpdir(), "cribble-agent-systemd-"));
  const commands = [];
  const spawnSyncFn = (command, args) => {
    commands.push([command, ...args]);
    return { status: 0, stdout: "", stderr: "" };
  };

  try {
    assert.throws(
      () => pauseBackground(linuxOptions(root, spawnSyncFn)),
      /not installed/,
    );

    mkdirSync(join(root, ".config", "systemd", "user"), { recursive: true });
    writeFileSync(systemdTimerPath(root, {}), "[Timer]\n");
    pauseBackground(linuxOptions(root, spawnSyncFn));
    assert.deepEqual(
      commands.map((command) => command.slice(2)),
      [
        ["disable", "--now", `${BACKGROUND_LABEL}.timer`],
        ["stop", `${BACKGROUND_LABEL}.service`],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resumeBackground on Linux re-arms the timer and queues a sync", () => {
  const root = mkdtempSync(join(tmpdir(), "cribble-agent-systemd-"));
  const commands = [];
  const spawnSyncFn = (command, args) => {
    commands.push([command, ...args]);
    if (args[1] === "is-enabled") return { status: 1, stdout: "disabled\n", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };

  try {
    assert.throws(
      () => resumeBackground(linuxOptions(root, spawnSyncFn)),
      /not installed/,
    );

    mkdirSync(join(root, ".config", "systemd", "user"), { recursive: true });
    writeFileSync(systemdTimerPath(root, {}), "[Timer]\n");
    resumeBackground(linuxOptions(root, spawnSyncFn));
    assert.deepEqual(
      commands.map((command) => command[2]),
      ["is-enabled", "daemon-reload", "enable", "start", "start"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uninstallBackground on Linux stops the timer and removes both units", () => {
  const root = mkdtempSync(join(tmpdir(), "cribble-agent-systemd-"));
  const commands = [];
  const spawnSyncFn = (command, args) => {
    commands.push([command, ...args]);
    return { status: 0, stdout: "", stderr: "" };
  };

  try {
    mkdirSync(join(root, ".config", "systemd", "user"), { recursive: true });
    writeFileSync(systemdServicePath(root, {}), "[Service]\n");
    writeFileSync(systemdTimerPath(root, {}), "[Timer]\n");

    const result = uninstallBackground(linuxOptions(root, spawnSyncFn));
    assert.equal(result.removed, true);
    assert.equal(existsSync(systemdServicePath(root, {})), false);
    assert.equal(existsSync(systemdTimerPath(root, {})), false);
    assert.deepEqual(
      commands.map((command) => command[2]),
      ["disable", "stop", "daemon-reload"],
    );

    const second = uninstallBackground(linuxOptions(root, spawnSyncFn));
    assert.equal(second.removed, false);
    assert.equal(commands.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backgroundStatus on Linux reports installed, active, and paused states", () => {
  const root = mkdtempSync(join(tmpdir(), "cribble-agent-systemd-"));

  try {
    const empty = backgroundStatus(
      linuxOptions(root, () => ({ status: 1, stdout: "", stderr: "" })),
    );
    assert.deepEqual(empty, {
      installed: false,
      loaded: false,
      disabled: false,
      filePath: systemdTimerPath(root, {}),
    });

    mkdirSync(join(root, ".config", "systemd", "user"), { recursive: true });
    writeFileSync(systemdTimerPath(root, {}), "[Timer]\n");

    const active = backgroundStatus(
      linuxOptions(root, () => ({ status: 0, stdout: "enabled\n", stderr: "" })),
    );
    assert.deepEqual(active, {
      installed: true,
      loaded: true,
      disabled: false,
      filePath: systemdTimerPath(root, {}),
    });

    const paused = backgroundStatus(
      linuxOptions(root, () => ({ status: 1, stdout: "disabled\n", stderr: "" })),
    );
    assert.deepEqual(paused, {
      installed: true,
      loaded: false,
      disabled: true,
      filePath: systemdTimerPath(root, {}),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("systemd unit paths honor XDG_CONFIG_HOME", () => {
  assert.equal(
    systemdTimerPath("/home/test", { XDG_CONFIG_HOME: "/home/test/xdg" }),
    `/home/test/xdg/systemd/user/${BACKGROUND_LABEL}.timer`,
  );
  assert.equal(
    systemdServicePath("/home/test", {}),
    `/home/test/.config/systemd/user/${BACKGROUND_LABEL}.service`,
  );
});
