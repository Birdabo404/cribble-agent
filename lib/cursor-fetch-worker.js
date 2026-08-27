"use strict";

// Isolated Cursor usage fetch. The parent passes the session cookie on stdin
// so it never appears in process arguments. This file writes CSV to stdout and
// never logs the cookie.

const CURSOR_CSV_URL =
  "https://cursor.com/api/dashboard/export-usage-events-csv?strategy=tokens";
const CURSOR_REDIRECT_HOSTS = new Set(["cursor.com", "www.cursor.com"]);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CSV_BYTES = 8 * 1024 * 1024;

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function resolveCursorRedirect(location, baseUrl) {
  let url;
  try {
    url = new URL(location, baseUrl);
  } catch {
    throw new Error("Cursor API redirected to an untrusted origin.");
  }
  if (url.protocol !== "https:" || !CURSOR_REDIRECT_HOSTS.has(url.hostname)) {
    throw new Error("Cursor API redirected to an untrusted origin.");
  }
  return url.toString();
}

async function readBoundedText(response) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_CSV_BYTES) {
    try {
      await response.body?.cancel?.();
    } catch {
      // Size is the useful error; cancellation is best effort.
    }
    throw new Error("Cursor usage export exceeded the safe response limit.");
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_CSV_BYTES) {
      throw new Error("Cursor usage export exceeded the safe response limit.");
    }
    return text;
  }

  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value?.byteLength ?? 0;
    if (bytesRead > MAX_CSV_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the bounded-response error if cancellation also fails.
      }
      throw new Error("Cursor usage export exceeded the safe response limit.");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function requestHeaders(cookie) {
  return {
    Accept: "*/*",
    Cookie: cookie,
    Referer: "https://www.cursor.com/settings",
    "User-Agent": "Mozilla/5.0 (compatible; Cribble-Agent)",
  };
}

async function fetchUrl(url, cookie, timeoutMs, fetchImpl, redirect) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: requestHeaders(cookie),
    redirect,
    referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error("Cursor session expired. Sign in to Cursor again, then retry.");
  }
  return response;
}

async function fetchCursorCsv({ cookie, timeoutMs, fetchImpl }) {
  const first = await fetchUrl(
    CURSOR_CSV_URL,
    cookie,
    timeoutMs,
    fetchImpl,
    "manual",
  );
  if ([301, 302, 307, 308].includes(first.status)) {
    const location = first.headers.get("location");
    if (!location) throw new Error("Cursor API redirected without a Location header.");
    const target = resolveCursorRedirect(location, CURSOR_CSV_URL);
    const second = await fetchUrl(target, cookie, timeoutMs, fetchImpl, "manual");
    if (second.status !== 200) {
      throw new Error(`Cursor API returned ${second.status}.`);
    }
    return readBoundedText(second);
  }
  if (first.status !== 200) {
    throw new Error(`Cursor API returned ${first.status}.`);
  }
  return readBoundedText(first);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

async function main() {
  if (typeof fetch !== "function") {
    fail("Cursor collection requires Node.js 18 or newer.");
  }
  let request;
  try {
    request = JSON.parse(await readStdin());
  } catch {
    fail("Cursor usage fetch received invalid input.");
  }
  const cookie = request?.cookie;
  const timeoutMs = Number.isInteger(request?.timeoutMs)
    ? request.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  if (typeof cookie !== "string" || cookie.length < 20) {
    fail("Cursor usage fetch is missing a session.");
  }
  try {
    const csv = await fetchCursorCsv({
      cookie,
      timeoutMs,
      fetchImpl: fetch,
    });
    process.stdout.write(csv);
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      fail("Cursor API request timed out.");
    }
    fail(error?.message || "Could not read Cursor usage.");
  }
}

if (require.main === module) {
  main().catch(() => fail("Could not read Cursor usage."));
}

module.exports = {
  CURSOR_CSV_URL,
  CURSOR_REDIRECT_HOSTS,
  MAX_CSV_BYTES,
  fetchCursorCsv,
  resolveCursorRedirect,
};
