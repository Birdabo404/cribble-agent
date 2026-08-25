"use strict";

const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

function resolvePowerShellPath({
  powershellPath,
  env = process.env,
  existsSyncFn = existsSync,
} = {}) {
  if (powershellPath) return powershellPath;
  const root = env.SystemRoot || env.WINDIR;
  if (root) {
    const candidate = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (existsSyncFn(candidate)) return candidate;
  }
  return "powershell.exe";
}

function runPowerShellFile(
  scriptPath,
  args,
  {
    spawnSyncFn = spawnSync,
    powershellPath,
    env = process.env,
    existsSyncFn = existsSync,
    input,
    timeout = 15_000,
  } = {},
) {
  const result = spawnSyncFn(
    resolvePowerShellPath({ powershellPath, env, existsSyncFn }),
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      ...args,
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout,
      stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      ...(input === undefined ? {} : { input }),
    },
  );
  if (result.error) throw result.error;
  return result;
}

module.exports = {
  resolvePowerShellPath,
  runPowerShellFile,
};
