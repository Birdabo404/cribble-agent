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
const { join, posix, win32 } = require("node:path");

const {
  BACKGROUND_LABEL,
  installBackground,
  launchAgentPath,
  launchAgentPlist,
  pauseBackground,
  resolveStableNodePath,
  resumeBackground,
  scheduledTaskXml,
  uninstallBackground,
  windowsTaskPath,
} = require("../lib/background");

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
        resolveFn: posix.resolve,
        delimiterValue: ":",
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

test("scheduledTaskXml schedules an opt-in Windows sync without secrets", () => {
  const xml = scheduledTaskXml({
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    entryPath: "C:\\Users\\test\\cribble-agent\\index.js",
    intervalMinutes: 15,
    days: 30,
    endpoint: "https://cribble.dev/api/agent/usage",
  });

  assert.match(xml, new RegExp(`\\\\${BACKGROUND_LABEL}`));
  assert.match(xml, /--background/);
  assert.match(xml, /PT15M/);
  assert.match(xml, /InteractiveToken/);
  assert.match(xml, /IgnoreNew/);
  assert.doesNotMatch(xml, /cmdkey/i);
  assert.doesNotMatch(xml, /CRIBBLE_API_KEY|crib_ag_/);
});

test("scheduledTaskXml rejects intervals that do not map safely to the hour", () => {
  assert.throws(
    () =>
      scheduledTaskXml({
        nodePath: "C:\\nodejs\\node.exe",
        entryPath: "C:\\cribble-agent\\index.js",
        intervalMinutes: 7,
        days: 7,
      }),
    /must be one of/,
  );
});

test("installBackground on Windows registers a Scheduled Task and starts it", () => {
  const commands = [];
  const spawnSyncFn = (command, args, options) => {
    commands.push({ command, args, options });
    if (args.includes("query")) {
      return {
        status: 0,
        stdout: '{"installed":false,"loaded":false,"disabled":false}',
        stderr: "",
      };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  const result = installBackground({
    nodePath: process.execPath,
    entryPath: join(__dirname, "..", "index.js"),
    intervalMinutes: 15,
    days: 7,
    platform: "win32",
    spawnSyncFn,
  });

  assert.equal(result.filePath, windowsTaskPath());
  assert.deepEqual(
    commands.map((invocation) => invocation.args.find((argument) =>
      ["query", "export", "register", "unregister", "disable", "enable", "stop", "start"].includes(argument),
    )),
    ["query", "register", "enable", "start"],
  );
  const register = commands.find((invocation) => invocation.args.includes("register"));
  assert.match(String(register.command), /powershell\.exe$/i);
  assert.equal(register.args.some((argument) => /cmdkey/i.test(String(argument))), false);
  assert.match(register.options.input, /--background/);
  assert.match(register.options.input, new RegExp(BACKGROUND_LABEL));
  assert.doesNotMatch(register.options.input, /CRIBBLE_API_KEY|crib_ag_/);
  assert.equal(
    commands.some((invocation) =>
      [invocation.command, ...invocation.args, invocation.options?.input]
        .some((value) => String(value ?? "").startsWith("crib_ag_")),
    ),
    false,
  );
});

test("Windows background install does not require a Unix uid", () => {
  const spawnSyncFn = (_command, args) => {
    if (args.includes("query")) {
      return {
        status: 0,
        stdout: '{"installed":false,"loaded":false,"disabled":false}',
        stderr: "",
      };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  assert.doesNotThrow(() =>
    installBackground({
      nodePath: process.execPath,
      entryPath: join(__dirname, "..", "index.js"),
      platform: "win32",
      spawnSyncFn,
    }),
  );
});

test("installBackground restores a previous Windows task after a failed update", () => {
  const previous = scheduledTaskXml({
    nodePath: process.execPath,
    entryPath: join(__dirname, "..", "index.js"),
    intervalMinutes: 30,
    days: 3,
  });
  const commands = [];
  let registerCalls = 0;
  const spawnSyncFn = (command, args, options) => {
    commands.push({ command, args, options });
    if (args.includes("query")) {
      return {
        status: 0,
        stdout: '{"installed":true,"loaded":true,"disabled":false}',
        stderr: "",
      };
    }
    if (args.includes("export")) {
      return { status: 0, stdout: previous, stderr: "" };
    }
    if (args.includes("register")) {
      registerCalls += 1;
      return registerCalls === 1
        ? { status: 5, stdout: "", stderr: "new definition failed" }
        : { status: 0, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  assert.throws(
    () =>
      installBackground({
        nodePath: process.execPath,
        entryPath: join(__dirname, "..", "index.js"),
        intervalMinutes: 15,
        days: 7,
        platform: "win32",
        spawnSyncFn,
      }),
    /new definition failed/,
  );

  assert.equal(registerCalls, 2);
  const restored = commands.filter((invocation) => invocation.args.includes("register"))[1];
  assert.equal(restored.options.input, previous);
  assert.equal(commands.at(-2).args.includes("enable"), true);
  assert.equal(commands.at(-1).args.includes("start"), true);
});

test("resumeBackground on Windows enables and starts a paused task", () => {
  const actions = [];
  const spawnSyncFn = (_command, args) => {
    const action = args.find((argument) =>
      ["query", "enable", "disable", "start", "stop"].includes(argument),
    );
    actions.push(action);
    if (action === "query") {
      return {
        status: 0,
        stdout: '{"installed":true,"loaded":false,"disabled":true}',
        stderr: "",
      };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  assert.doesNotThrow(() => resumeBackground({ platform: "win32", spawnSyncFn }));
  assert.deepEqual(actions, ["query", "enable", "start"]);
});

test("resumeBackground restores a paused Windows task when startup fails", () => {
  const actions = [];
  const spawnSyncFn = (_command, args) => {
    const action = args.find((argument) =>
      ["query", "enable", "disable", "start", "stop"].includes(argument),
    );
    actions.push(action);
    if (action === "query") {
      return {
        status: 0,
        stdout: '{"installed":true,"loaded":false,"disabled":true}',
        stderr: "",
      };
    }
    if (action === "start") {
      return { status: 5, stdout: "", stderr: "start failed" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  assert.throws(
    () => resumeBackground({ platform: "win32", spawnSyncFn }),
    /start failed/,
  );
  assert.deepEqual(actions, ["query", "enable", "start", "disable"]);
});

test("pauseBackground rolls back a Windows disable when stopping fails", () => {
  const actions = [];
  const spawnSyncFn = (_command, args) => {
    const action = args.find((argument) => ["disable", "enable", "stop"].includes(argument));
    actions.push(action);
    if (action === "stop") {
      return { status: 5, stdout: "", stderr: "permission denied\u001b[31m" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  assert.throws(
    () => pauseBackground({ platform: "win32", spawnSyncFn }),
    /Stopping background sync failed: permission denied/,
  );
  assert.deepEqual(actions, ["disable", "stop", "enable"]);
});

test("pauseBackground accepts an already stopped Windows task", () => {
  assert.doesNotThrow(() =>
    pauseBackground({
      platform: "win32",
      spawnSyncFn: (_command, args) =>
        args.includes("stop")
          ? { status: 0, stdout: "", stderr: "The task is not currently running." }
          : { status: 0, stdout: "", stderr: "" },
    }),
  );
});

test("unsupported platforms cannot install background sync", () => {
  assert.throws(
    () =>
      installBackground({
        platform: "linux",
        spawnSyncFn: () => {
          throw new Error("spawn should not run");
        },
      }),
    /macOS or Windows/,
  );
});

test("uninstallBackground on Windows unregisters the Scheduled Task", () => {
  const actions = [];
  const spawnSyncFn = (_command, args) => {
    const action = args.find((argument) =>
      ["query", "stop", "unregister", "disable", "enable"].includes(argument),
    );
    actions.push(action);
    if (action === "query") {
      return {
        status: 0,
        stdout: '{"installed":true,"loaded":true,"disabled":false}',
        stderr: "",
      };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  const result = uninstallBackground({
    platform: "win32",
    spawnSyncFn,
  });
  assert.equal(result.removed, true);
  assert.equal(result.filePath, windowsTaskPath());
  assert.deepEqual(actions, ["query", "stop", "unregister"]);
  assert.equal(actions.some((action) => action === "cmdkey"), false);
});

test("resolveStableNodePath prefers a Windows PATH shim targeting the running Node binary", () => {
  const targets = new Map([
    ["C:\\nvm\\nodejs\\node.exe", "C:\\nvm\\nodejs\\node.exe"],
    ["C:\\nodejs\\node.exe", "C:\\nvm\\nodejs\\node.exe"],
  ]);

  assert.equal(
    resolveStableNodePath("C:\\nvm\\nodejs\\node.exe", "C:\\nodejs;C:\\Windows", {
      existsSyncFn: (filePath) => targets.has(filePath),
      realpathSyncFn: (filePath) => targets.get(filePath),
      resolveFn: win32.resolve,
      delimiterValue: ";",
    }),
    "C:\\nodejs\\node.exe",
  );
});
