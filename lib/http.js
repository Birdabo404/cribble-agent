"use strict";

const DEFAULT_TIMEOUT_MS = 15_000;
const { version: packageVersion } = require("../package.json");

class SyncRequestError extends Error {
  constructor(message, { status, retryable = false, retryAfterMs, cause } = {}) {
    super(message, { cause });
    this.name = "SyncRequestError";
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

function parseEndpoint(value) {
  if (!value) {
    throw new Error(
      "No sync endpoint configured. Set CRIBBLE_SYNC_URL or pass --endpoint URL.",
    );
  }

  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("The sync endpoint must be a valid http(s) URL.");
  }

  if (!["http:", "https:"].includes(endpoint.protocol)) {
    throw new Error("The sync endpoint must use http or https.");
  }
  return endpoint;
}

function safeEndpointLabel(endpoint) {
  return `${endpoint.origin}${endpoint.pathname}`;
}

function retryAfterMs(response) {
  const value = response.headers?.get?.("retry-after");
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function responseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function postSnapshot(
  snapshot,
  {
    endpoint: endpointValue,
    apiKey,
    fetchFn = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  },
) {
  const endpoint = parseEndpoint(endpointValue);
  if (typeof fetchFn !== "function") {
    throw new Error("sync requires Node.js 18 or newer (global fetch is unavailable).");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response;
    try {
      response = await fetchFn(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": `cribble-agent/${packageVersion}`,
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(snapshot),
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new SyncRequestError(`Sync timed out after ${timeoutMs / 1000} seconds.`, {
          retryable: true,
          cause: error,
        });
      }
      throw new SyncRequestError(
        `Could not reach the Cribble sync endpoint: ${error?.message || "network error"}`,
        { retryable: true, cause: error },
      );
    }

    let responseText;
    try {
      responseText = await response.text();
    } catch (error) {
      throw new SyncRequestError(
        `Could not read the Cribble sync response: ${error?.message || "network error"}`,
        { retryable: true, cause: error },
      );
    }
    const body = responseBody(responseText);

    if (!response.ok) {
      const detail = responseText.trim().slice(0, 300);
      const retryable =
        response.status === 408 ||
        response.status === 425 ||
        response.status === 429 ||
        (response.status >= 500 && response.status <= 599);
      throw new SyncRequestError(
        `Sync failed with HTTP ${response.status}${detail ? `: ${detail}` : "."}`,
        {
          status: response.status,
          retryable,
          retryAfterMs: retryAfterMs(response),
        },
      );
    }

    if (!body || typeof body !== "object" || body.success !== true) {
      // A 2xx HTML/error page is not proof that usage was accepted. Retrying
      // the identical generatedAt is safe because the server is idempotent.
      throw new SyncRequestError(
        "Cribble returned an invalid success response.",
        { status: response.status, retryable: true },
      );
    }

    return {
      status: response.status,
      endpoint: safeEndpointLabel(endpoint),
      body,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function postSnapshotWithRetry(
  snapshot,
  options,
  {
    attempts = 3,
    baseDelayMs = 500,
    maxDelayMs = 30_000,
    randomFn = Math.random,
    sleepFn = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  } = {},
) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("Retry attempts must be a positive whole number.");
  }
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await postSnapshot(snapshot, options);
    } catch (error) {
      lastError = error;
      if (!(error instanceof SyncRequestError) || !error.retryable || attempt === attempts) {
        throw error;
      }

      const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jitter = Math.floor(randomFn() * Math.min(250, exponential));
      const delayMs = Math.min(maxDelayMs, error.retryAfterMs ?? exponential + jitter);
      await sleepFn(delayMs);
    }
  }

  throw lastError;
}

module.exports = {
  SyncRequestError,
  parseEndpoint,
  postSnapshot,
  postSnapshotWithRetry,
};
