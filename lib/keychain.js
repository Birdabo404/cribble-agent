"use strict";

const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { homedir } = require("node:os");
const { dirname, isAbsolute, win32 } = require("node:path");
const { configDirectory } = require("./config-path");
const { requireMacOS: requireMac } = require("./platform");
const { safeText } = require("./safety");

const SECURITY_PATH = "/usr/bin/security";
const KEYCHAIN_SERVICE = "dev.cribble.agent.api-key";
const KEYCHAIN_ACCOUNT = "cribble-agent";
const API_KEY_PATTERN = /^crib_ag_[0-9a-f]{64}$/;
const MAX_HIDDEN_INPUT_LENGTH = 512;
const LINUX_SECRET_TOOL = "/usr/bin/secret-tool";
const LINUX_SECRET_TOOL_CANDIDATES = Object.freeze([
  LINUX_SECRET_TOOL,
  "/usr/local/bin/secret-tool",
  "/bin/secret-tool",
]);
const WINDOWS_LOAD_DPAPI = "Add-Type -AssemblyName System.Security";
const WINDOWS_PROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  WINDOWS_LOAD_DPAPI,
  "$plain=[Console]::In.ReadToEnd().TrimEnd([char[]]\"`r`n\")",
  "$bytes=[Text.Encoding]::UTF8.GetBytes($plain)",
  "$scope=[Security.Cryptography.DataProtectionScope]::CurrentUser",
  "$protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,$scope)",
  "[Console]::Out.Write([Convert]::ToBase64String($protected))",
].join(";");
const WINDOWS_UNPROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  WINDOWS_LOAD_DPAPI,
  "$encoded=[Console]::In.ReadToEnd().Trim()",
  "$protected=[Convert]::FromBase64String($encoded)",
  "$scope=[Security.Cryptography.DataProtectionScope]::CurrentUser",
  "$bytes=[Security.Cryptography.ProtectedData]::Unprotect($protected,$null,$scope)",
  "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))",
].join(";");

function currentPlatform(options) {
  return options.platform ?? process.platform;
}

function windowsCredentialPath({
  homeDirectory = homedir(),
  env = process.env,
} = {}) {
  return win32.join(
    configDirectory({ homeDirectory, env, platform: "win32" }),
    "agent-key.dpapi",
  );
}

function linuxSecretToolPath(options = {}) {
  const configured = options.secretToolPath;
  if (configured != null && !isAbsolute(configured)) {
    throw new Error("The Linux Secret Service executable path must be absolute.");
  }
  if (configured) return configured;
  const existsSyncFn = options.existsSyncFn ?? existsSync;
  return LINUX_SECRET_TOOL_CANDIDATES.find((candidate) => existsSyncFn(candidate)) ??
    LINUX_SECRET_TOOL;
}

function windowsPowerShellPath(options = {}) {
  if (options.powershellPath != null) {
    if (!win32.isAbsolute(options.powershellPath)) {
      throw new Error("The Windows PowerShell executable path must be absolute.");
    }
    return options.powershellPath;
  }
  const systemRoot =
    typeof options.env?.SystemRoot === "string" &&
    win32.isAbsolute(options.env.SystemRoot.trim())
      ? options.env.SystemRoot.trim()
      : "C:\\Windows";
  return win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function runPortableCommand(command, args, {
  spawnSyncFn = spawnSync,
  input,
} = {}) {
  const result = spawnSyncFn(command, args, {
    encoding: "utf8",
    input,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 15_000,
  });
  if (result.error) throw result.error;
  return result;
}

function linuxCredentialError(error) {
  if (error?.code === "ENOENT") {
    return new Error(
      "Linux credential storage requires `secret-tool` (usually provided by libsecret-tools).",
    );
  }
  return error;
}

// secret-tool can be installed yet unusable (no D-Bus session or keyring
// daemon on headless systems). Surface its stderr so the real cause is
// visible instead of a dead-end fixed string.
function linuxSecretServiceFailure(action, result) {
  const detail = safeText(result?.stderr, { maxLength: 200 });
  const hint = /d-?bus|display|keyring|secret service/i.test(detail)
    ? " A running Secret Service (for example gnome-keyring over D-Bus) is required; on headless systems set CRIBBLE_API_KEY instead."
    : "";
  return new Error(`${action}${detail ? ` (${detail})` : ""}.${hint}`);
}

function readLinuxApiKey(options = {}) {
  let result;
  try {
    result = runPortableCommand(
      linuxSecretToolPath(options),
      ["lookup", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT],
      options,
    );
  } catch (error) {
    throw linuxCredentialError(error);
  }
  if (result.status === 1 && !String(result.stderr ?? "").trim()) return null;
  if (result.status !== 0) {
    throw linuxSecretServiceFailure(
      "Could not read the Cribble Agent key from Linux Secret Service",
      result,
    );
  }
  return result.stdout?.trim() ? validateApiKey(result.stdout) : null;
}

function storeLinuxApiKey(apiKey, options = {}) {
  let result;
  try {
    result = runPortableCommand(
      linuxSecretToolPath(options),
      [
        "store",
        "--label=Cribble Agent Key",
        "service",
        KEYCHAIN_SERVICE,
        "account",
        KEYCHAIN_ACCOUNT,
      ],
      // secret-tool reads until EOF, so avoid storing a trailing newline.
      { ...options, input: apiKey },
    );
  } catch (error) {
    throw linuxCredentialError(error);
  }
  if (result.status !== 0) {
    throw linuxSecretServiceFailure(
      "The Agent key was not saved to Linux Secret Service",
      result,
    );
  }
}

function removeLinuxApiKey(options = {}) {
  let result;
  try {
    result = runPortableCommand(
      linuxSecretToolPath(options),
      ["clear", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT],
      options,
    );
  } catch (error) {
    throw linuxCredentialError(error);
  }
  if (result.status === 1 && !String(result.stderr ?? "").trim()) return false;
  if (result.status !== 0) {
    throw linuxSecretServiceFailure(
      "Could not remove the Cribble Agent key from Linux Secret Service",
      result,
    );
  }
  return true;
}

function runPowerShell(script, input, options = {}) {
  let result;
  try {
    result = runPortableCommand(
      windowsPowerShellPath(options),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { ...options, input },
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Windows credential storage requires Windows PowerShell.");
    }
    throw error;
  }
  if (result.status !== 0) {
    throw new Error(
      script === WINDOWS_UNPROTECT_SCRIPT
        ? "Windows could not read the stored Cribble Agent key for this user. Run `cribble connect` to save it again."
        : "Windows could not protect the Cribble Agent key for this user.",
    );
  }
  return String(result.stdout ?? "").trim();
}

function readWindowsApiKey(options = {}) {
  const filePath = options.filePath ?? windowsCredentialPath(options);
  const existsSyncFn = options.existsSyncFn ?? existsSync;
  const readFileSyncFn = options.readFileSyncFn ?? readFileSync;
  if (!existsSyncFn(filePath)) return null;
  const encrypted = String(readFileSyncFn(filePath, "utf8")).trim();
  if (!/^[A-Za-z0-9+/=]{16,8192}$/.test(encrypted)) {
    throw new Error("The stored Windows Cribble Agent key is unreadable.");
  }
  return validateApiKey(runPowerShell(WINDOWS_UNPROTECT_SCRIPT, encrypted, options));
}

function storeWindowsApiKey(apiKey, options = {}) {
  const encrypted = runPowerShell(WINDOWS_PROTECT_SCRIPT, apiKey, options);
  if (!/^[A-Za-z0-9+/=]{16,8192}$/.test(encrypted)) {
    throw new Error("Windows returned an invalid protected Agent key.");
  }
  const filePath = options.filePath ?? windowsCredentialPath(options);
  const mkdirSyncFn = options.mkdirSyncFn ?? mkdirSync;
  const renameSyncFn = options.renameSyncFn ?? renameSync;
  const rmSyncFn = options.rmSyncFn ?? rmSync;
  const writeFileSyncFn = options.writeFileSyncFn ?? writeFileSync;
  mkdirSyncFn(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSyncFn(temporaryPath, `${encrypted}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSyncFn(temporaryPath, filePath);
  } finally {
    rmSyncFn(temporaryPath, { force: true });
  }
}

function removeWindowsApiKey(options = {}) {
  const filePath = options.filePath ?? windowsCredentialPath(options);
  const existsSyncFn = options.existsSyncFn ?? existsSync;
  if (!existsSyncFn(filePath)) return false;
  (options.rmSyncFn ?? rmSync)(filePath, { force: true });
  return true;
}

function runSecurity(args, { spawnSyncFn = spawnSync, stdio, input } = {}) {
  const result = spawnSyncFn(SECURITY_PATH, args, {
    encoding: "utf8",
    stdio: stdio ?? ["ignore", "pipe", "pipe"],
    // A locked keychain can make `security` block on a SecurityAgent dialog.
    // In a launchd context that dialog never appears, so an unbounded wait
    // would hang background sync while it holds the sync lock. Give a person
    // at a terminal a full minute, then fail with a normal error instead.
    timeout: 60_000,
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
  const platform = currentPlatform(options);
  if (platform === "linux") return readLinuxApiKey(options) !== null;
  if (platform === "win32") {
    return (options.existsSyncFn ?? existsSync)(
      options.filePath ?? windowsCredentialPath(options),
    );
  }
  requireMac(platform);
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
  const platform = currentPlatform(options);
  if (platform === "linux") return readLinuxApiKey(options);
  if (platform === "win32") return readWindowsApiKey(options);
  requireMac(platform);
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
    let escapeSequence = false;
    let escapeLength = 0;
    let settled = false;
    const wasRaw = input.isRaw === true;
    const wasFlowing = input.readableFlowing === true;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("close", onEnd);
      input.removeListener("error", onError);
      if (!wasRaw) {
        try {
          input.setRawMode(false);
        } catch {
          // Preserve the original input result if terminal cleanup fails.
        }
      }
      // A fresh stdin reports isPaused() === false, yet it still must be
      // paused after our resume(): a flowing TTY handle keeps the event loop
      // alive, which made the CLI hang after printing its final message.
      if (!wasFlowing) input.pause();
      try {
        output.write("\n");
      } catch {
        // Do not replace a useful validation/cancellation error.
      }
      if (error) reject(error);
      else resolve(value.trim());
    };

    const onEnd = () => finish(new Error("Agent key entry ended before a key was received."));
    const onError = () => finish(new Error("Could not read the Agent key from this terminal."));

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
        if (escapeSequence) {
          escapeLength += 1;
          if (/[A-Za-z~]/.test(character) || escapeLength >= 32) {
            escapeSequence = false;
            escapeLength = 0;
          }
          continue;
        }
        if (character === "\u001b") {
          escapeSequence = true;
          escapeLength = 0;
          continue;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") {
          value += character;
          if (value.length > MAX_HIDDEN_INPUT_LENGTH) {
            finish(new Error("Agent key entry was unexpectedly long."));
            return;
          }
        }
      }
    };

    output.write("Paste your Cribble Agent key (input hidden): ");
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("close", onEnd);
    input.once("error", onError);
    try {
      input.setRawMode(true);
      input.resume();
    } catch {
      finish(new Error("Could not enable hidden Agent key entry in this terminal."));
    }
  });
}

async function promptAndStoreApiKey(options = {}) {
  const platform = currentPlatform(options);
  if (!["darwin", "linux", "win32"].includes(platform)) {
    throw new Error("Cribble Agent credentials are not supported on this platform.");
  }
  const readSecretFn = options.readSecretFn ?? readHiddenLine;
  const apiKey = validateApiKey(
    await readSecretFn({ input: options.input, output: options.output }),
  );
  if (platform === "linux") {
    storeLinuxApiKey(apiKey, options);
    return;
  }
  if (platform === "win32") {
    storeWindowsApiKey(apiKey, options);
    return;
  }
  requireMac(platform);
  // `add-generic-password -w` without a value prompts on /dev/tty in a real
  // terminal and ignores piped stdin, so `cribble connect` asked for the key
  // three times (our prompt plus security's "password data" and "retype"
  // prompts). Interactive mode (-i) reads the whole command from stdin
  // instead: nothing can prompt, and the validated key (strictly
  // crib_ag_ + 64 hex, so safe to embed unquoted) never appears in argv,
  // shell history, logs, or environment variables.
  const addCommand = [
    "add-generic-password",
    "-a",
    KEYCHAIN_ACCOUNT,
    "-s",
    KEYCHAIN_SERVICE,
    "-l",
    '"Cribble Agent Key"',
    "-U",
    "-w",
    apiKey,
  ].join(" ");
  const result = runSecurity(["-i"], {
    ...options,
    input: `${addCommand}\n`,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error("The Agent key was not saved to macOS Keychain.");
}

function removeKeychainApiKey(options = {}) {
  const platform = currentPlatform(options);
  if (platform === "linux") return removeLinuxApiKey(options);
  if (platform === "win32") return removeWindowsApiKey(options);
  requireMac(platform);
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
  windowsCredentialPath,
};
