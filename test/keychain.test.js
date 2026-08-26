"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
  keychainHasApiKey,
  promptAndStoreApiKey,
  readHiddenLine,
  readKeychainApiKey,
  removeKeychainApiKey,
  resolveApiKey,
  validateApiKey,
} = require("../lib/keychain");

const API_KEY = `crib_ag_${"b".repeat(64)}`;

test("validateApiKey rejects malformed secrets before network use", () => {
  assert.equal(validateApiKey(API_KEY), API_KEY);
  assert.throws(() => validateApiKey("personal-key"), /must start with crib_ag_/);
  assert.throws(() => validateApiKey(`crib_ag_${"z".repeat(64)}`), /64 hex/);
});

test("resolveApiKey prefers the explicit environment override", () => {
  let keychainRead = false;
  const resolved = resolveApiKey(
    { CRIBBLE_API_KEY: API_KEY },
    {
      platform: "darwin",
      readKeychainApiKeyFn: () => {
        keychainRead = true;
        return null;
      },
    },
  );

  assert.equal(resolved, API_KEY);
  assert.equal(keychainRead, false);
});

test("readKeychainApiKey reads only stdout and validates the stored value", () => {
  let invocation;
  const key = readKeychainApiKey({
    platform: "darwin",
    spawnSyncFn: (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0, stdout: `${API_KEY}\n`, stderr: "" };
    },
  });

  assert.equal(key, API_KEY);
  assert.equal(invocation.command, "/usr/bin/security");
  assert.deepEqual(invocation.args, [
    "find-generic-password",
    "-a",
    KEYCHAIN_ACCOUNT,
    "-s",
    KEYCHAIN_SERVICE,
    "-w",
  ]);
});

test("hidden Agent-key input uses Cribble wording and never echoes the secret", async () => {
  class FakeInput extends EventEmitter {
    isTTY = true;
    isRaw = false;
    paused = true;

    isPaused() {
      return this.paused;
    }

    pause() {
      this.paused = true;
    }

    resume() {
      this.paused = false;
    }

    setRawMode(enabled) {
      this.isRaw = enabled;
    }
  }

  const input = new FakeInput();
  const writes = [];
  const output = { isTTY: true, write: (value) => writes.push(value) };
  const reading = readHiddenLine({ input, output });
  input.emit("data", `${API_KEY}\n`);

  assert.equal(await reading, API_KEY);
  assert.match(writes.join(""), /Cribble Agent key/);
  assert.doesNotMatch(writes.join(""), /password/i);
  assert.doesNotMatch(writes.join(""), new RegExp(API_KEY));
  assert.equal(input.isRaw, false);
  assert.equal(input.paused, true);
});

test("hidden Agent-key input accepts terminal bracketed paste markers", async () => {
  class FakeInput extends EventEmitter {
    isTTY = true;
    isRaw = false;
    isPaused() { return false; }
    pause() {}
    resume() {}
    setRawMode(enabled) { this.isRaw = enabled; }
  }

  const input = new FakeInput();
  const output = { isTTY: true, write: () => {} };
  const reading = readHiddenLine({ input, output });
  input.emit("data", `\u001b[200~${API_KEY}\u001b[201~\n`);

  assert.equal(await reading, API_KEY);
  assert.equal(input.isRaw, false);
});

test("hidden Agent-key input restores terminal state when input ends", async () => {
  class FakeInput extends EventEmitter {
    isTTY = true;
    isRaw = false;
    paused = true;
    isPaused() { return this.paused; }
    pause() { this.paused = true; }
    resume() { this.paused = false; }
    setRawMode(enabled) { this.isRaw = enabled; }
  }

  const input = new FakeInput();
  const output = { isTTY: true, write: () => {} };
  const reading = readHiddenLine({ input, output });
  input.emit("end");

  await assert.rejects(reading, /ended before a key/);
  assert.equal(input.isRaw, false);
  assert.equal(input.paused, true);
});

test("Linux keyring read uses secret-tool lookup with Cribble attributes", () => {
  let invocation;
  const key = readKeychainApiKey({
    platform: "linux",
    secretToolPath: "/usr/bin/secret-tool",
    spawnSyncFn: (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0, stdout: `${API_KEY}\n`, stderr: "" };
    },
  });

  assert.equal(key, API_KEY);
  assert.equal(invocation.command, "/usr/bin/secret-tool");
  assert.deepEqual(invocation.args, [
    "lookup",
    "service",
    KEYCHAIN_SERVICE,
    "account",
    KEYCHAIN_ACCOUNT,
  ]);
});

test("Linux keyring setup sends the secret over stdin and never puts it in argv", async () => {
  let invocation;
  await promptAndStoreApiKey({
    platform: "linux",
    secretToolPath: "/usr/bin/secret-tool",
    readSecretFn: async () => API_KEY,
    spawnSyncFn: (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0 };
    },
  });

  assert.equal(invocation.args[0], "store");
  assert.deepEqual(invocation.options.stdio, ["pipe", "pipe", "pipe"]);
  // secret-tool keeps stdin bytes verbatim, so the key is sent bare with no
  // trailing newline that would corrupt the stored secret.
  assert.equal(invocation.options.input, API_KEY);
  assert.equal(invocation.args.some((argument) => argument.startsWith("crib_ag_")), false);
});

test("Linux keyring distinguishes a missing key from an unreachable keyring", () => {
  const missing = readKeychainApiKey({
    platform: "linux",
    secretToolPath: "/usr/bin/secret-tool",
    spawnSyncFn: () => ({ status: 1, stdout: "", stderr: "" }),
  });
  assert.equal(missing, null);

  assert.equal(
    keychainHasApiKey({
      platform: "linux",
      secretToolPath: "/usr/bin/secret-tool",
      spawnSyncFn: () => ({ status: 1, stdout: "", stderr: "" }),
    }),
    false,
  );

  assert.throws(
    () =>
      readKeychainApiKey({
        platform: "linux",
        secretToolPath: "/usr/bin/secret-tool",
        spawnSyncFn: () => ({
          status: 1,
          stdout: "",
          stderr: "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY",
        }),
      }),
    /Secret Service/,
  );
});

test("Linux keyring removal reports whether a key was stored", () => {
  assert.equal(
    removeKeychainApiKey({
      platform: "linux",
      secretToolPath: "/usr/bin/secret-tool",
      spawnSyncFn: (command, args) => {
        assert.equal(args[0], "clear");
        return { status: 0, stdout: "", stderr: "" };
      },
    }),
    true,
  );
  assert.equal(
    removeKeychainApiKey({
      platform: "linux",
      secretToolPath: "/usr/bin/secret-tool",
      spawnSyncFn: () => ({ status: 1, stdout: "", stderr: "" }),
    }),
    false,
  );
});

test("Linux keyring explains how to install a missing secret-tool", () => {
  assert.throws(
    () =>
      keychainHasApiKey({
        platform: "linux",
        existsSyncFn: () => false,
        spawnSyncFn: () => ({ status: 0, stdout: "", stderr: "" }),
      }),
    /libsecret/,
  );
});

test("resolveApiKey reads the Linux keyring when no override is set", () => {
  const resolved = resolveApiKey(
    {},
    {
      platform: "linux",
      readKeychainApiKeyFn: ({ platform }) => {
        assert.equal(platform, "linux");
        return API_KEY;
      },
    },
  );
  assert.equal(resolved, API_KEY);
});

test("Keychain setup sends the secret over stdin and never puts it in argv", async () => {
  let invocation;
  await promptAndStoreApiKey({
    platform: "darwin",
    readSecretFn: async () => API_KEY,
    spawnSyncFn: (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0 };
    },
  });

  assert.equal(invocation.args.at(-1), "-w");
  assert.deepEqual(invocation.options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(invocation.options.input, `${API_KEY}\n${API_KEY}\n`);
  assert.equal(invocation.args.some((argument) => argument.startsWith("crib_ag_")), false);
});
