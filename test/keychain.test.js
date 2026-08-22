"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
  promptAndStoreApiKey,
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

test("Keychain setup prompts securely and never puts the secret in argv", () => {
  let invocation;
  promptAndStoreApiKey({
    platform: "darwin",
    spawnSyncFn: (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0 };
    },
  });

  assert.equal(invocation.args.at(-1), "-w");
  assert.equal(invocation.options.stdio, "inherit");
  assert.equal(invocation.args.some((argument) => argument.startsWith("crib_ag_")), false);
});
