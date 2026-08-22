"use strict";

const { spawnSync } = require("node:child_process");

const SECURITY_PATH = "/usr/bin/security";
const KEYCHAIN_SERVICE = "dev.cribble.agent.api-key";
const KEYCHAIN_ACCOUNT = "cribble-agent";
const API_KEY_PATTERN = /^crib_ag_[0-9a-f]{64}$/;

function requireMac(platform = process.platform) {
  if (platform !== "darwin") {
    throw new Error(
      "Cribble Keychain and background-service commands currently require macOS.",
    );
  }
}

function runSecurity(args, { spawnSyncFn = spawnSync, stdio, input } = {}) {
  const result = spawnSyncFn(SECURITY_PATH, args, {
    encoding: "utf8",
    stdio: stdio ?? ["ignore", "pipe", "pipe"],
    ...(input === undefined ? {} : { input }),
  });
  if (result.error) throw result.error;
  return result;
}

function validateApiKey(value) {
  const apiKey = String(value ?? "").trim();
  if (!API_KEY_PATTERN.test(apiKey)) {
    throw new Error("The Cribble Agent key must start with crib_ag_ and contain 64 hex characters.");
  }
  return apiKey;
}

function keychainHasApiKey(options = {}) {
  requireMac(options.platform);
  const result = runSecurity(
    ["find-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE],
    options,
  );
  if (result.status === 44) return false;
  if (result.status !== 0) {
    throw new Error("Could not check the Cribble Agent key in macOS Keychain.");
  }
  return true;
}

function readKeychainApiKey(options = {}) {
  requireMac(options.platform);
  const result = runSecurity(
    [
      "find-generic-password",
      "-a",
      KEYCHAIN_ACCOUNT,
      "-s",
      KEYCHAIN_SERVICE,
      "-w",
    ],
    options,
  );
  if (result.status === 44) return null;
  if (result.status !== 0) {
    throw new Error("Could not read the Cribble Agent key from macOS Keychain.");
  }
  return validateApiKey(result.stdout);
}

function readHiddenLine({ input = process.stdin, output = process.stdout } = {}) {
  if (!input?.isTTY || !output?.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Run `cribble connect` in an interactive terminal to enter your Agent key.");
  }

  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = input.isRaw === true;
    const wasPaused = input.isPaused?.() === true;

    const finish = (error) => {
      input.removeListener("data", onData);
      if (!wasRaw) input.setRawMode(false);
      if (wasPaused) input.pause();
      output.write("\n");
      if (error) reject(error);
      else resolve(value.trim());
    };

    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u0003" || character === "\u0004") {
          finish(new Error("Agent key entry cancelled."));
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") value += character;
      }
    };

    output.write("Paste your Cribble Agent key (input hidden): ");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function promptAndStoreApiKey(options = {}) {
  requireMac(options.platform);
  const readSecretFn = options.readSecretFn ?? readHiddenLine;
  const apiKey = validateApiKey(
    await readSecretFn({ input: options.input, output: options.output }),
  );
  const result = runSecurity(
    [
      "add-generic-password",
      "-a",
      KEYCHAIN_ACCOUNT,
      "-s",
      KEYCHAIN_SERVICE,
      "-l",
      "Cribble Agent Key",
      "-U",
      // Keep -w last and send the secret over stdin. It never appears in
      // shell history, logs, environment variables, or process arguments.
      "-w",
    ],
    // macOS asks for the value and a confirmation when -w has no argv value.
    { ...options, input: `${apiKey}\n${apiKey}\n`, stdio: ["pipe", "pipe", "pipe"] },
  );
  if (result.status !== 0) throw new Error("The Agent key was not saved to macOS Keychain.");
}

function removeKeychainApiKey(options = {}) {
  requireMac(options.platform);
  const result = runSecurity(
    ["delete-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE],
    options,
  );
  if (result.status === 44) return false;
  if (result.status !== 0) {
    throw new Error("Could not remove the Cribble Agent key from macOS Keychain.");
  }
  return true;
}

function resolveApiKey(
  env = process.env,
  { platform = process.platform, readKeychainApiKeyFn = readKeychainApiKey } = {},
) {
  if (env.CRIBBLE_API_KEY) return validateApiKey(env.CRIBBLE_API_KEY);
  if (platform !== "darwin") return null;
  return readKeychainApiKeyFn({ platform });
}

module.exports = {
  API_KEY_PATTERN,
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
  keychainHasApiKey,
  promptAndStoreApiKey,
  readHiddenLine,
  readKeychainApiKey,
  removeKeychainApiKey,
  resolveApiKey,
  validateApiKey,
};
