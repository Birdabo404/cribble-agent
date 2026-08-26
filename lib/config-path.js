"use strict";

const { homedir } = require("node:os");
const { posix, win32 } = require("node:path");

function configDirectory({
  homeDirectory = homedir(),
  env = process.env,
  platform = process.platform,
} = {}) {
  const pathApi = platform === "win32" ? win32 : posix;
  if (platform === "win32") {
    const localAppData =
      typeof env.LOCALAPPDATA === "string" &&
      pathApi.isAbsolute(env.LOCALAPPDATA.trim())
        ? env.LOCALAPPDATA.trim()
        : pathApi.join(homeDirectory, "AppData", "Local");
    return pathApi.join(localAppData, "Cribble");
  }
  // Existing macOS installations have always persisted identity and state
  // below ~/.config/cribble. Preserve that location even when an interactive
  // shell exports XDG_CONFIG_HOME: launchd does not inherit shell-only
  // variables, and allowing the paths to diverge would create two machine IDs
  // and two independent sync locks on one Mac.
  if (platform !== "linux") {
    return pathApi.join(homeDirectory, ".config", "cribble");
  }
  const configuredHome =
    typeof env.XDG_CONFIG_HOME === "string" ? env.XDG_CONFIG_HOME.trim() : "";
  const configHome = pathApi.isAbsolute(configuredHome)
    ? configuredHome
    : pathApi.join(homeDirectory, ".config");
  return pathApi.join(configHome, "cribble");
}

module.exports = { configDirectory };
