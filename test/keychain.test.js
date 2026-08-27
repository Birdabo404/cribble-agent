"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

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
  windowsCredentialPath,
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

test("Linux credentials use Secret Service without exposing the key in argv", async () => {
  const calls = [];
  const spawnSyncFn = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === "lookup") return { status: 0, stdout: `${API_KEY}\n`, stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };

  await promptAndStoreApiKey({
    platform: "linux",
    readSecretFn: async () => API_KEY,
    spawnSyncFn,
  });
  assert.equal(
    readKeychainApiKey({ platform: "linux", spawnSyncFn }),
    API_KEY,
  );
  assert.equal(calls[0].command, "/usr/bin/secret-tool");
  assert.equal(calls[0].options.input, API_KEY);
  assert.equal(calls.flatMap((call) => call.args).includes(API_KEY), false);
});

test("Linux Secret Service failures are not reported as a missing key", () => {
  assert.throws(
    () =>
      readKeychainApiKey({
        platform: "linux",
        spawnSyncFn: () => ({
          status: 1,
          stdout: "",
          stderr: "Failed to connect to the Secret Service",
        }),
      }),
    /Could not read the Cribble Agent key/,
  );
});

test("Windows credentials are protected with DPAPI before reaching disk", async () => {
  const root = mkdtempSync(join(tmpdir(), "cribble-windows-credential-"));
  const filePath = join(root, "agent-key.dpapi");
  const calls = [];
  const encrypted = "QUJDREVGR0hJSktMTU5PUA==";
  const spawnSyncFn = (command, args, options) => {
    calls.push({ command, args, options });
    const script = args.at(-1);
    return script.includes("Unprotect")
      ? { status: 0, stdout: API_KEY, stderr: "" }
      : { status: 0, stdout: encrypted, stderr: "" };
  };

  try {
    await promptAndStoreApiKey({
      platform: "win32",
      filePath,
      readSecretFn: async () => API_KEY,
      spawnSyncFn,
    });
    assert.equal(keychainHasApiKey({ platform: "win32", filePath }), true);
    assert.equal(
      readKeychainApiKey({ platform: "win32", filePath, spawnSyncFn }),
      API_KEY,
    );
    assert.equal(
      calls.every(
        (call) =>
          call.command ===
          "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ),
      true,
    );
    assert.equal(
      calls.every((call) =>
        call.args.at(-1).includes("Add-Type -AssemblyName System.Security")),
      true,
    );
    assert.equal(calls.flatMap((call) => call.args).includes(API_KEY), false);
    assert.equal(removeKeychainApiKey({ platform: "win32", filePath }), true);
    assert.equal(keychainHasApiKey({ platform: "win32", filePath }), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows PowerShell can round-trip a key through DPAPI", {
  skip: process.platform !== "win32",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "cribble-windows-dpapi-"));
  const filePath = join(root, "agent-key.dpapi");

  try {
    await promptAndStoreApiKey({
      platform: "win32",
      filePath,
      readSecretFn: async () => API_KEY,
    });
    assert.equal(readKeychainApiKey({ platform: "win32", filePath }), API_KEY);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows credentials stay in machine-local application data", () => {
  assert.equal(
    windowsCredentialPath({
      homeDirectory: "C:\\Users\\alice",
      env: {
        APPDATA: "C:\\Users\\alice\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
      },
    }),
    "C:\\Users\\alice\\AppData\\Local\\Cribble\\agent-key.dpapi",
  );
});
