"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CURSOR_CSV_URL,
  fetchCursorCsv,
  resolveCursorRedirect,
} = require("../lib/cursor-fetch-worker");

test("Cursor redirects stay on cursor.com", () => {
  assert.equal(
    resolveCursorRedirect("/api/dashboard/export-usage-events-csv?strategy=tokens", CURSOR_CSV_URL),
    "https://cursor.com/api/dashboard/export-usage-events-csv?strategy=tokens",
  );
  assert.equal(
    resolveCursorRedirect(
      "https://www.cursor.com/api/dashboard/export-usage-events-csv?strategy=tokens",
      CURSOR_CSV_URL,
    ),
    "https://www.cursor.com/api/dashboard/export-usage-events-csv?strategy=tokens",
  );
  assert.throws(
    () => resolveCursorRedirect("https://evil.example/steal", CURSOR_CSV_URL),
    /untrusted origin/,
  );
  assert.throws(
    () => resolveCursorRedirect("http://cursor.com/api", CURSOR_CSV_URL),
    /untrusted origin/,
  );
});

test("Cursor usage fetch follows one trusted redirect and bounds the body", async () => {
  const csv = "Date,Model\n2026-08-25,gpt-5\n";
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, redirect: options.redirect, cookie: options.headers.Cookie });
    if (url === CURSOR_CSV_URL) {
      return {
        status: 302,
        headers: {
          get: (name) => name === "location"
            ? "https://www.cursor.com/api/dashboard/export-usage-events-csv?strategy=tokens"
            : null,
        },
      };
    }
    return {
      status: 200,
      headers: { get: () => null },
      text: async () => csv,
    };
  };

  const body = await fetchCursorCsv({
    cookie: "WorkosCursorSessionToken=user_test%3A%3Afake",
    timeoutMs: 1000,
    fetchImpl,
  });
  assert.equal(body, csv);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].redirect, "manual");
  assert.equal(calls[1].url.startsWith("https://www.cursor.com/"), true);
});

test("Cursor usage fetch maps auth failures and oversize exports", async () => {
  await assert.rejects(
    () =>
      fetchCursorCsv({
        cookie: "WorkosCursorSessionToken=user_test%3A%3Afake",
        timeoutMs: 1000,
        fetchImpl: async () => ({ status: 401, headers: { get: () => null } }),
      }),
    /session expired/,
  );

  await assert.rejects(
    () =>
      fetchCursorCsv({
        cookie: "WorkosCursorSessionToken=user_test%3A%3Afake",
        timeoutMs: 1000,
        fetchImpl: async () => ({
          status: 200,
          headers: { get: (name) => name === "content-length" ? "99999999" : null },
          body: { cancel: async () => {} },
        }),
      }),
    /safe response limit/,
  );
});
