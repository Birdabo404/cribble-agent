"use strict";

const { randomUUID } = require("node:crypto");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { dirname, join } = require("node:path");

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function clientIdPath(homeDirectory = homedir()) {
  return join(homeDirectory, ".config", "cribble", "client-id");
}

function readClientId(filePath) {
  const clientId = readFileSync(filePath, "utf8").trim();
  if (!UUID_V4_PATTERN.test(clientId)) {
    throw new Error(
      `The Cribble client ID at ${filePath} is invalid. Remove that file and sync again.`,
    );
  }
  return clientId;
}

function getOrCreateClientId(filePath = clientIdPath()) {
  if (existsSync(filePath)) return readClientId(filePath);

  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const clientId = randomUUID();
  try {
    writeFileSync(filePath, `${clientId}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return clientId;
  } catch (error) {
    // Concurrent first syncs race safely: whichever process creates the file
    // first defines the permanent identity and every other process reuses it.
    if (error?.code === "EEXIST") return readClientId(filePath);
    throw error;
  }
}

module.exports = {
  clientIdPath,
  getOrCreateClientId,
};
