"use strict";

const { execFileSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { dirname, isAbsolute, join, resolve } = require("node:path");
const { safeText } = require("./safety");

const COLLECTOR_ENV_KEYS = Object.freeze([
  "APPDATA",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  "PATH",
  "PROGRAMDATA",
  "SHELL",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "USERPROFILE",
  "WINDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]);

function collectorEnvironment(env) {
  const safeEnv = {};
  for (const key of COLLECTOR_ENV_KEYS) {
    if (typeof env?.[key] === "string" && env[key]) safeEnv[key] = env[key];
  }
  // JSON collection must not emit ANSI formatting. More importantly, the
  // child never inherits API keys, cloud credentials, NODE_OPTIONS, or other
  // unrelated secrets from the parent Cribble process.
  safeEnv.NO_COLOR = "1";
  return safeEnv;
}

function resolveBundledBinary(
  baseDirectory,
  {
    existsSyncFn = existsSync,
    readFileSyncFn = readFileSync,
    requireResolveFn = require.resolve,
    platform = process.platform,
  } = {},
) {
  const directBinary = join(baseDirectory, "node_modules", ".bin", "ccusage");
  // npm's Windows .bin entries are cmd/sh wrappers. This CLI always invokes
  // the collector through `node`, so those shims cannot be used as a script.
  if (platform !== "win32" && existsSyncFn(directBinary)) return directBinary;

  try {
    // npm may hoist the dependency beside cribble-agent instead of nesting it
    // inside the package. Resolve from the installed package location rather
    // than assuming a particular node_modules layout.
    const packagePath = requireResolveFn("ccusage/package.json", {
      paths: [baseDirectory],
    });
    const packageJson = JSON.parse(readFileSyncFn(packagePath, "utf8"));
    const relativeBinary =
      typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.ccusage;
    const resolvedBinary = relativeBinary
      ? resolve(dirname(packagePath), relativeBinary)
      : null;
    if (resolvedBinary && existsSyncFn(resolvedBinary)) return resolvedBinary;
  } catch {
    // Fall through to the single actionable installation error below.
  }

  throw new Error(
    "The bundled ccusage executable is missing. Run `npm install` in the cribble-agent directory, then try again.",
  );
}

function loadUsage(
  env = process.env,
  {
    baseDirectory = join(__dirname, ".."),
    execFileSyncFn = execFileSync,
    existsSyncFn = existsSync,
    readFileSyncFn = readFileSync,
    requireResolveFn = require.resolve,
    nodePath = process.execPath,
    platform = process.platform,
  } = {},
) {
  const configuredBinary = env.CCUSAGE_BIN;
  if (configuredBinary && !isAbsolute(configuredBinary)) {
    throw new Error("CCUSAGE_BIN must be an absolute executable path.");
  }
  const bundledBinary = configuredBinary
    ? null
    : resolveBundledBinary(baseDirectory, {
        existsSyncFn,
        readFileSyncFn,
        requireResolveFn,
        platform,
      });
  const command = configuredBinary || nodePath;
  const args = configuredBinary
    ? ["daily", "--json"]
    : [bundledBinary, "daily", "--json"];

  try {
    // launchd starts with a minimal PATH. Invoke the bundled JavaScript entry
    // through this process's absolute Node path instead of its /usr/bin/env
    // shebang so scheduled collection works outside an interactive shell.
    const raw = execFileSyncFn(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      maxBuffer: 50 * 1024 * 1024,
      env: collectorEnvironment(env),
    });
    return JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("ccusage returned output that was not valid JSON.");
    }
    const detail = safeText(error.stderr ?? error.message, { maxLength: 300 });
    throw new Error(`Could not read ccusage data${detail ? `: ${detail}` : "."}`);
  }
}

module.exports = { collectorEnvironment, loadUsage, resolveBundledBinary };
