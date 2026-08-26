"use strict";

const SUPPORTED_PLATFORMS = new Set(["darwin", "linux", "win32"]);
const SUPPORTED_ARCHITECTURES = new Set(["arm64", "x64"]);
const UNSUPPORTED_PLATFORM_MESSAGE =
  "Cribble Agent currently supports macOS, Linux, and Windows on arm64 or x64.";

function requireMacOS(platform = process.platform) {
  if (platform !== "darwin") {
    throw new Error("This Cribble operation requires macOS.");
  }
}

function requireSupportedPlatform(
  platform = process.platform,
  architecture = process.arch,
) {
  if (
    !SUPPORTED_PLATFORMS.has(platform) ||
    !SUPPORTED_ARCHITECTURES.has(architecture)
  ) {
    throw new Error(UNSUPPORTED_PLATFORM_MESSAGE);
  }
}

module.exports = {
  requireMacOS,
  requireSupportedPlatform,
  SUPPORTED_ARCHITECTURES,
  SUPPORTED_PLATFORMS,
  UNSUPPORTED_PLATFORM_MESSAGE,
};
