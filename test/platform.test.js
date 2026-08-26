"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const packageMetadata = require("../package.json");
const {
  UNSUPPORTED_PLATFORM_MESSAGE,
  requireMacOS,
  requireSupportedPlatform,
} = require("../lib/platform");
const { configDirectory } = require("../lib/config-path");
const { clientIdPath } = require("../lib/identity");
const { syncLockPath, syncStatePath } = require("../lib/state");

test("package installation runs the platform validation", () => {
  assert.equal(packageMetadata.scripts.preinstall, "node lib/check-platform.js");
});

test("package platform validation accepts macOS, Windows, and Linux", () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    assert.doesNotThrow(() => requireSupportedPlatform(platform, "x64"));
    assert.doesNotThrow(() => requireSupportedPlatform(platform, "arm64"));
  }
  assert.throws(() => requireSupportedPlatform("freebsd", "x64"), {
    message: UNSUPPORTED_PLATFORM_MESSAGE,
  });
  assert.throws(() => requireSupportedPlatform("win32", "ia32"), {
    message: UNSUPPORTED_PLATFORM_MESSAGE,
  });
});

test("macOS-specific adapters retain their narrow validation", () => {
  assert.doesNotThrow(() => requireMacOS("darwin"));
  assert.throws(() => requireMacOS("win32"), /requires macOS/);
  assert.throws(() => requireMacOS("linux"), /requires macOS/);
});

test("configuration paths preserve macOS and use machine-local Windows storage", () => {
  const windowsOptions = {
    platform: "win32",
    env: {
      APPDATA: "C:\\Users\\alice\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
    },
  };
  assert.equal(
    configDirectory({
      homeDirectory: "C:\\Users\\alice",
      ...windowsOptions,
    }),
    "C:\\Users\\alice\\AppData\\Local\\Cribble",
  );
  assert.equal(
    clientIdPath("C:\\Users\\alice", windowsOptions),
    "C:\\Users\\alice\\AppData\\Local\\Cribble\\client-id",
  );
  assert.equal(
    syncStatePath("C:\\Users\\alice", windowsOptions),
    "C:\\Users\\alice\\AppData\\Local\\Cribble\\sync-state.json",
  );
  assert.equal(
    syncLockPath("C:\\Users\\alice", windowsOptions),
    "C:\\Users\\alice\\AppData\\Local\\Cribble\\sync.lock",
  );
  assert.equal(
    configDirectory({
      homeDirectory: "/home/alice",
      platform: "linux",
      env: { XDG_CONFIG_HOME: "/home/alice/.cfg" },
    }),
    "/home/alice/.cfg/cribble",
  );
  assert.equal(
    configDirectory({
      homeDirectory: "/home/alice",
      platform: "linux",
      env: { XDG_CONFIG_HOME: "relative" },
    }),
    "/home/alice/.config/cribble",
  );
  assert.equal(
    configDirectory({
      homeDirectory: "/Users/alice",
      platform: "darwin",
      env: { XDG_CONFIG_HOME: "/tmp/interactive-only" },
    }),
    "/Users/alice/.config/cribble",
  );
});
