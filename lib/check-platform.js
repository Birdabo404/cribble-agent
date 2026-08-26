"use strict";

const { requireSupportedPlatform } = require("./platform");

try {
  requireSupportedPlatform();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
