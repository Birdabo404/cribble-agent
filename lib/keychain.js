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

function runSecurity(args, { spawnSyncFn = spawnSync, stdio } = {}) {
  const result = spawnSyncFn(SECURITY_PATH, args, {
    encoding: "utf8",
    stdio: stdio ?? ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  return result;
}

function validateApiKey(value) {
  const apiKey = String(value ?? "").trim();
  if (!API_KEY_PATTERN.test(apiKey)) {
    throw new Error("The Cribble API key must start with crib_ag_ and contain 64 hex characters.");
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
    throw new Error("Could not check the Cribble API key in macOS Keychain.");
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
    throw new Error("Could not read the Cribble API key from macOS Keychain.");
  }
  return validateApiKey(result.stdout);
}

function promptAndStoreApiKey(options = {}) {
  requireMac(options.platform);
  const result = runSecurity(
    [
      "add-generic-password",
      "-a",
      KEYCHAIN_ACCOUNT,
      "-s",
      KEYCHAIN_SERVICE,
      "-l",
      "Cribble Agent API Key",
      "-U",
      // Keep -w last so the macOS security tool prompts for the secret
      // instead of exposing it in this process's command-line arguments.
      "-w",
    ],
    { ...options, stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error("The API key was not saved to macOS Keychain.");
}

function removeKeychainApiKey(options = {}) {
  requireMac(options.platform);
  const result = runSecurity(
    ["delete-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE],
    options,
  );
  if (result.status === 44) return false;
  if (result.status !== 0) {
    throw new Error("Could not remove the Cribble API key from macOS Keychain.");
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
  readKeychainApiKey,
  removeKeychainApiKey,
  resolveApiKey,
  validateApiKey,
};
