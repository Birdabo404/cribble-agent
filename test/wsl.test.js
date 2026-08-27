"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  discoverWslHomes,
  parseWslDistributions,
  usageHomes,
  wslMode,
} = require("../lib/wsl");

test("WSL distribution output supports the UTF-16 format emitted by Windows", () => {
  const output = Buffer.from("Ubuntu-24.04\r\nDebian\r\n", "utf16le");
  assert.deepEqual(parseWslDistributions(output), ["Ubuntu-24.04", "Debian"]);
});

test("Windows discovery resolves WSL homes through UNC without a shell", () => {
  const calls = [];
  const execFileSyncFn = (_command, args) => {
    calls.push(args);
    if (args[0] === "-l") return Buffer.from("Ubuntu-24.04\r\n", "utf16le");
    return Buffer.from("/home/alice\n", "utf8");
  };
  const homes = discoverWslHomes({
    platform: "win32",
    env: {},
    execFileSyncFn,
    existsSyncFn: (candidate) =>
      candidate === "\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice",
  });

  assert.deepEqual(homes, [{
    distribution: "Ubuntu-24.04",
    home: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice",
  }]);
  assert.deepEqual(calls[1], [
    "-d",
    "Ubuntu-24.04",
    "--exec",
    "printenv",
    "HOME",
  ]);
});

test("Windows discovery ignores application-managed WSL distributions", () => {
  const calls = [];
  const homes = discoverWslHomes({
    platform: "win32",
    env: {},
    execFileSyncFn: (_command, args) => {
      calls.push(args);
      if (args[0] === "-l") {
        return Buffer.from("docker-desktop\r\nUbuntu\r\n", "utf16le");
      }
      return Buffer.from("/home/alice\n", "utf8");
    },
    existsSyncFn: () => true,
  });

  assert.deepEqual(homes, [{
    distribution: "Ubuntu",
    home: "\\\\wsl.localhost\\Ubuntu\\home\\alice",
  }]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1], "Ubuntu");
});

test("Windows usage homes include a native fallback after preferred WSL homes", () => {
  const options = {
    platform: "win32",
    env: { USERPROFILE: "C:\\Users\\alice" },
    execFileSyncFn: (_command, args) =>
      args[0] === "-l"
        ? Buffer.from("Ubuntu\r\n", "utf16le")
        : Buffer.from("/home/alice\n"),
    existsSyncFn: (candidate) => candidate.startsWith("\\\\wsl.localhost"),
  };
  const homes = usageHomes(options);

  assert.deepEqual(homes, [
    {
      scope: "wsl:Ubuntu",
      home: "\\\\wsl.localhost\\Ubuntu\\home\\alice",
    },
    { scope: "native", home: "C:\\Users\\alice" },
  ]);
  assert.deepEqual(
    usageHomes({
      ...options,
      env: {
        USERPROFILE: "C:\\Users\\alice",
        CRIBBLE_WSL_MODE: "both",
      },
    }),
    [
      { scope: "native", home: "C:\\Users\\alice" },
      {
        scope: "wsl:Ubuntu",
        home: "\\\\wsl.localhost\\Ubuntu\\home\\alice",
      },
    ],
  );
  assert.equal(wslMode({}), "wsl-first");
  assert.equal(wslMode({ CRIBBLE_WSL_MODE: "native-only" }), "native-only");
});
