"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
  promptAndStoreApiKey,
  readHiddenLine,
  readKeychainApiKey,
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
