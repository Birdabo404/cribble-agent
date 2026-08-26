"use strict";

// WSL discovery is adapted from TokenTracker's MIT-licensed wsl-probe module.
// Cribble keeps only path discovery; it never reads prompt or response content.

const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { homedir } = require("node:os");

const WSL_MODES = new Set([
  "wsl-first",
  "native-first",
  "both",
  "native-only",
  "wsl-only",
]);

function decodeWslOutput(value) {
  if (Buffer.isBuffer(value)) {
    const utf8 = value.toString("utf8");
    return utf8.includes("\0") ? value.toString("utf16le") : utf8;
  }
  return String(value ?? "");
}

function parseWslDistributions(value) {
  return [...new Set(
    decodeWslOutput(value)
      .split(/\r?\n/)
      .map((line) => line.replaceAll("\0", "").replace(/^\s*\*\s*/, "").trim())
      .filter((line) => line && !/[\\/\0]/.test(line)),
  )];
}

function wslMode(env = process.env) {
  const configured = String(env.CRIBBLE_WSL_MODE ?? "").trim().toLowerCase();
  return WSL_MODES.has(configured) ? configured : "wsl-first";
}

function runWsl(args, { execFileSyncFn = execFileSync } = {}) {
  return execFileSyncFn("wsl.exe", args, {
    encoding: null,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
}

function discoverWslHomes({
  platform = process.platform,
  env = process.env,
  execFileSyncFn = execFileSync,
  existsSyncFn = existsSync,
} = {}) {
  if (platform !== "win32" || wslMode(env) === "native-only") return [];
  let distributions;
  try {
    distributions = parseWslDistributions(
      runWsl(["-l", "-q"], { execFileSyncFn }),
    );
  } catch {
    return [];
  }
  const homes = [];
  for (const distribution of distributions) {
    let linuxHome;
    try {
      linuxHome = decodeWslOutput(
        runWsl(
          ["-d", distribution, "--exec", "printenv", "HOME"],
          { execFileSyncFn },
        ),
      ).replaceAll("\0", "").trim();
    } catch {
      continue;
    }
    if (!linuxHome.startsWith("/") || /[\0\r\n]/.test(linuxHome)) continue;
    const relativeHome = linuxHome.slice(1).replaceAll("/", "\\");
    const candidates = [
      `\\\\wsl.localhost\\${distribution}\\${relativeHome}`,
      `\\\\wsl$\\${distribution}\\${relativeHome}`,
    ];
    const available = candidates.find((candidate) => {
      try {
        return existsSyncFn(candidate);
      } catch {
        return false;
      }
    });
    if (available) homes.push({ distribution, home: available });
  }
  return homes;
}

function nativeHome(env = process.env, fallback = homedir(), platform = process.platform) {
  const keys = platform === "win32" ? ["USERPROFILE", "HOME"] : ["HOME", "USERPROFILE"];
  for (const key of keys) {
    if (typeof env[key] === "string" && env[key].trim()) return env[key];
  }
  return fallback;
}

function usageHomes(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform !== "win32") {
    return [{ scope: "native", home: nativeHome(env, options.homeDirectory, platform) }];
  }
  const mode = wslMode(env);
  const native = {
    scope: "native",
    home: nativeHome(env, options.homeDirectory, platform),
  };
  if (mode === "native-only") return [native];
  const wslHomes = discoverWslHomes({ ...options, platform, env }).map((entry) => ({
      scope: `wsl:${entry.distribution}`,
      home: entry.home,
  }));
  if (mode === "wsl-only") return wslHomes;
  if (mode === "both") return [native, ...wslHomes];
  if (mode === "native-first") return [native, ...wslHomes];
  return wslHomes.length ? [...wslHomes, native] : [native];
}

module.exports = {
  decodeWslOutput,
  discoverWslHomes,
  parseWslDistributions,
  usageHomes,
  wslMode,
};
