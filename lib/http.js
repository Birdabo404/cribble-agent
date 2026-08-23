"use strict";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const { version: packageVersion } = require("../package.json");
const { validateApiKey } = require("./keychain");
const { safeText } = require("./safety");

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
  if (endpoint.username || endpoint.password) {
    throw new Error("The sync endpoint must not contain a username or password.");
  }
  if (endpoint.search || endpoint.hash) {
    throw new Error("The sync endpoint must not contain query parameters or a fragment.");
  }
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  if (endpoint.protocol !== "https:" && !loopbackHosts.has(endpoint.hostname)) {
    throw new Error(
      "The sync endpoint must use HTTPS (plain HTTP is only allowed for localhost development).",
    );
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

function responseDetail(body, responseText) {
  if (body && typeof body === "object" && typeof body.error === "string") {
    return safeText(body.error, { maxLength: 300 });
  }
  return safeText(responseText, { maxLength: 300 });
}

async function readResponseText(response) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    try {
      await response.body?.cancel?.();
    } catch {
      // The size violation is the useful error; cancellation is best effort.
    }
    throw new SyncRequestError("Cribble returned an unexpectedly large response.", {
      status: response.status,
      retryable: response.status >= 500,
    });
  }

  const reader = response.body?.getReader?.();
  if (reader) {
    const decoder = new TextDecoder();
    let bytesRead = 0;
    let text = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value?.byteLength ?? 0;
      if (bytesRead > MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the bounded-response error if cancellation also fails.
        }
        throw new SyncRequestError("Cribble returned an unexpectedly large response.", {
          status: response.status,
          retryable: response.status >= 500,
        });
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  }

  // Test doubles and older fetch implementations may expose only text().
  // Real Node responses take the streaming path above and are bounded while
  // reading, rather than after an attacker-controlled body is buffered.
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new SyncRequestError("Cribble returned an unexpectedly large response.", {
      status: response.status,
      retryable: response.status >= 500,
    });
  }
  return text;
}

function validSuccessReceipt(body, snapshot) {
  if (!body || typeof body !== "object" || body.success !== true) return false;
  const counts = [body.inserted, body.replaced, body.stale];
  if (!counts.every((value) => Number.isInteger(value) && value >= 0)) return false;
  if (body.clientId !== snapshot.clientId) return false;
  return counts.reduce((sum, value) => sum + value, 0) === snapshot.daily.length;
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
  const validatedApiKey = validateApiKey(apiKey);
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
          Authorization: `Bearer ${validatedApiKey}`,
        },
        body: JSON.stringify(snapshot),
        redirect: "error",
        referrerPolicy: "no-referrer",
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
        `Could not reach the Cribble sync endpoint: ${safeText(error?.message, { fallback: "network error" })}`,
        { retryable: true, cause: error },
      );
    }

    let responseText;
    try {
      responseText = await readResponseText(response);
    } catch (error) {
      if (error instanceof SyncRequestError) throw error;
      throw new SyncRequestError(
        `Could not read the Cribble sync response: ${safeText(error?.message, { fallback: "network error" })}`,
        { retryable: true, cause: error },
      );
    }
    const body = responseBody(responseText);

    if (!response.ok) {
      const detail = responseDetail(body, responseText);
      const retryable =
        response.status === 408 ||
        response.status === 425 ||
        response.status === 429 ||
        (response.status >= 500 && response.status <= 599);
      const message =
        response.status === 401 || response.status === 403
          ? `Cribble rejected the Agent key (HTTP ${response.status}). Create a fresh key in Cribble Settings, then run \`cribble connect\` again.`
          : response.status === 413
            ? "Cribble rejected the sync because it was too large. Retry with fewer days, for example `cribble sync --days 30`."
            : `Sync failed with HTTP ${response.status}${detail ? `: ${detail}` : "."}`;
      throw new SyncRequestError(
        message,
        {
          status: response.status,
          retryable,
          retryAfterMs: retryAfterMs(response),
        },
      );
    }

    if (!validSuccessReceipt(body, snapshot)) {
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
  safeEndpointLabel,
};
