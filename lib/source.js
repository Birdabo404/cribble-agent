"use strict";

const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

function loadUsage(
  env = process.env,
  {
    baseDirectory = join(__dirname, ".."),
    execFileSyncFn = execFileSync,
    existsSyncFn = existsSync,
  } = {},
) {
  const localBinary = join(baseDirectory, "node_modules", ".bin", "ccusage");
  const configuredBinary = env.CCUSAGE_BIN;
  const command = configuredBinary || (existsSyncFn(localBinary) ? localBinary : "npx");
  const args =
    configuredBinary || existsSyncFn(localBinary)
      ? ["daily", "--json"]
      : ["--yes", "ccusage@latest", "daily", "--json"];

  try {
    const raw = execFileSyncFn(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      maxBuffer: 50 * 1024 * 1024,
    });
    return JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("ccusage returned output that was not valid JSON.");
    }
    const detail = String(error.stderr ?? error.message ?? "").trim();
    throw new Error(`Could not read ccusage data${detail ? `: ${detail}` : "."}`);
  }
}

module.exports = { loadUsage };
