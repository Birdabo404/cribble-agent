"use strict";

const { spawnSync } = require("node:child_process");
const {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { homedir } = require("node:os");
const { dirname, join, resolve } = require("node:path");

const LAUNCHCTL_PATH = "/bin/launchctl";
const PLUTIL_PATH = "/usr/bin/plutil";
const BACKGROUND_LABEL = "dev.cribble.agent.sync";
const SUPPORTED_INTERVALS = new Set([5, 10, 15, 20, 30, 60]);

function requireMac(platform = process.platform) {
  if (platform !== "darwin") {
    throw new Error("Cribble background sync currently requires macOS.");
  }
}

function launchAgentPath(homeDirectory = homedir()) {
  return join(homeDirectory, "Library", "LaunchAgents", `${BACKGROUND_LABEL}.plist`);
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function stringElement(value, indent = "    ") {
  return `${indent}<string>${escapeXml(value)}</string>`;
}

function validateSchedule({ intervalMinutes, days }) {
  if (!SUPPORTED_INTERVALS.has(intervalMinutes)) {
    throw new Error("--interval must be one of 5, 10, 15, 20, 30, or 60 minutes.");
  }
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error("--days must be a whole number between 1 and 365.");
  }
}

function launchAgentPlist({
  nodePath,
  entryPath,
  intervalMinutes = 15,
  days = 7,
  endpoint,
}) {
  validateSchedule({ intervalMinutes, days });
  const programArguments = [
    nodePath,
    entryPath,
    "sync",
    "--background",
    "--days",
    String(days),
    ...(endpoint ? ["--endpoint", endpoint] : []),
  ];
  const minutes = Array.from(
    { length: 60 / intervalMinutes },
    (_, index) => index * intervalMinutes,
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${BACKGROUND_LABEL}</string>
  <key>Program</key>
  <string>${escapeXml(nodePath)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments.map((argument) => stringElement(argument)).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(dirname(entryPath))}</string>
  <key>StartCalendarInterval</key>
  <array>
${minutes
  .map(
    (minute) => `    <dict>
      <key>Minute</key>
      <integer>${minute}</integer>
    </dict>`,
  )
  .join("\n")}
  </array>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
  <key>Umask</key>
  <integer>63</integer>
</dict>
</plist>
`;
}

function runCommand(command, args, { spawnSyncFn = spawnSync } = {}) {
  const result = spawnSyncFn(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  return result;
}

function commandFailure(label, result) {
  const detail = String(result.stderr ?? result.stdout ?? "").trim();
  return new Error(`${label} failed${detail ? `: ${detail}` : "."}`);
}

function writeLaunchAgent(
  contents,
  filePath,
  { spawnSyncFn = spawnSync } = {},
) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, contents, {
      encoding: "utf8",
      mode: 0o600,
      flag: "w",
    });
    const lint = runCommand(PLUTIL_PATH, ["-lint", temporaryPath], { spawnSyncFn });
    if (lint.status !== 0) throw commandFailure("LaunchAgent validation", lint);
    renameSync(temporaryPath, filePath);
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
}

function serviceTarget(uid) {
  return `gui/${uid}/${BACKGROUND_LABEL}`;
}

function domainTarget(uid) {
  return `gui/${uid}`;
}

function requireUid(uid) {
  if (!Number.isInteger(uid) || uid < 0) {
    throw new Error("Could not determine the current macOS user.");
  }
  return uid;
}

function installBackground({
  intervalMinutes = 15,
  days = 7,
  endpoint,
  homeDirectory = homedir(),
  entryPath = resolve(__dirname, "..", "index.js"),
  nodePath = process.execPath,
  platform = process.platform,
  uid = process.getuid?.(),
  spawnSyncFn = spawnSync,
} = {}) {
  requireMac(platform);
  requireUid(uid);
  if (!existsSync(nodePath)) throw new Error(`Node executable not found at ${nodePath}.`);
  if (!existsSync(entryPath)) throw new Error(`Cribble CLI not found at ${entryPath}.`);

  const filePath = launchAgentPath(homeDirectory);
  const previousContents = existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
  const contents = launchAgentPlist({
    nodePath,
    entryPath,
    intervalMinutes,
    days,
    endpoint,
  });
  writeLaunchAgent(contents, filePath, { spawnSyncFn });

  let serviceReplaced = false;
  try {
    // Clear a persistent disabled flag from an earlier pause/uninstall, then
    // replace any loaded copy with this validated definition.
    const enable = runCommand(LAUNCHCTL_PATH, ["enable", serviceTarget(uid)], {
      spawnSyncFn,
    });
    if (enable.status !== 0) throw commandFailure("Enabling background sync", enable);
    runCommand(LAUNCHCTL_PATH, ["bootout", serviceTarget(uid)], { spawnSyncFn });
    serviceReplaced = true;
    const bootstrap = runCommand(
      LAUNCHCTL_PATH,
      ["bootstrap", domainTarget(uid), filePath],
      { spawnSyncFn },
    );
    if (bootstrap.status !== 0) throw commandFailure("Installing background sync", bootstrap);

    const kickstart = runCommand(LAUNCHCTL_PATH, ["kickstart", serviceTarget(uid)], {
      spawnSyncFn,
    });
    if (kickstart.status !== 0) throw commandFailure("Starting background sync", kickstart);
  } catch (error) {
    // Do not strand a previously working schedule. Put its exact definition
    // back and make a best-effort attempt to reload it.
    if (serviceReplaced) {
      runCommand(LAUNCHCTL_PATH, ["bootout", serviceTarget(uid)], { spawnSyncFn });
    }
    if (previousContents === null) {
      rmSync(filePath, { force: true });
    } else {
      writeLaunchAgent(previousContents, filePath, { spawnSyncFn });
      if (serviceReplaced) {
        runCommand(
          LAUNCHCTL_PATH,
          ["bootstrap", domainTarget(uid), filePath],
          { spawnSyncFn },
        );
      }
    }
    throw error;
  }

  return { filePath, intervalMinutes, days, endpoint: endpoint ?? null };
}

function pauseBackground({
  platform = process.platform,
  uid = process.getuid?.(),
  spawnSyncFn = spawnSync,
} = {}) {
  requireMac(platform);
  requireUid(uid);
  const disable = runCommand(LAUNCHCTL_PATH, ["disable", serviceTarget(uid)], {
    spawnSyncFn,
  });
  if (disable.status !== 0) throw commandFailure("Pausing background sync", disable);
  runCommand(LAUNCHCTL_PATH, ["bootout", serviceTarget(uid)], { spawnSyncFn });
}

function resumeBackground({
  homeDirectory = homedir(),
  platform = process.platform,
  uid = process.getuid?.(),
  spawnSyncFn = spawnSync,
} = {}) {
  requireMac(platform);
  requireUid(uid);
  const filePath = launchAgentPath(homeDirectory);
  if (!existsSync(filePath)) {
    throw new Error("Background sync is not installed. Run `cribble background install` first.");
  }

  const enable = runCommand(LAUNCHCTL_PATH, ["enable", serviceTarget(uid)], {
    spawnSyncFn,
  });
  if (enable.status !== 0) throw commandFailure("Resuming background sync", enable);
  runCommand(LAUNCHCTL_PATH, ["bootout", serviceTarget(uid)], { spawnSyncFn });
  const bootstrap = runCommand(
    LAUNCHCTL_PATH,
    ["bootstrap", domainTarget(uid), filePath],
    { spawnSyncFn },
  );
  if (bootstrap.status !== 0) throw commandFailure("Loading background sync", bootstrap);
  const kickstart = runCommand(LAUNCHCTL_PATH, ["kickstart", serviceTarget(uid)], {
    spawnSyncFn,
  });
  if (kickstart.status !== 0) throw commandFailure("Starting background sync", kickstart);
}

function uninstallBackground({
  homeDirectory = homedir(),
  platform = process.platform,
  uid = process.getuid?.(),
  spawnSyncFn = spawnSync,
} = {}) {
  requireMac(platform);
  requireUid(uid);
  runCommand(LAUNCHCTL_PATH, ["bootout", serviceTarget(uid)], { spawnSyncFn });
  // Clear the persistent disabled bit so a future install starts from a
  // predictable state.
  runCommand(LAUNCHCTL_PATH, ["enable", serviceTarget(uid)], { spawnSyncFn });
  const filePath = launchAgentPath(homeDirectory);
  const removed = existsSync(filePath);
  if (removed) rmSync(filePath, { force: true });
  return { removed, filePath };
}

function backgroundStatus({
  homeDirectory = homedir(),
  platform = process.platform,
  uid = process.getuid?.(),
  spawnSyncFn = spawnSync,
} = {}) {
  requireMac(platform);
  requireUid(uid);
  const filePath = launchAgentPath(homeDirectory);
  const installed = existsSync(filePath);
  const loaded =
    runCommand(LAUNCHCTL_PATH, ["print", serviceTarget(uid)], { spawnSyncFn }).status === 0;
  const disabledOutput = runCommand(LAUNCHCTL_PATH, ["print-disabled", domainTarget(uid)], {
    spawnSyncFn,
  });
  const disabled = new RegExp(`"?${BACKGROUND_LABEL.replaceAll(".", "\\.")}"?\\s*=>\\s*true`).test(
    String(disabledOutput.stdout ?? ""),
  );

  return { installed, loaded, disabled, filePath };
}

module.exports = {
  BACKGROUND_LABEL,
  backgroundStatus,
  installBackground,
  launchAgentPath,
  launchAgentPlist,
  pauseBackground,
  resumeBackground,
  uninstallBackground,
};
