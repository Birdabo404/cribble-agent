"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SyncRequestError,
  postSnapshotWithRetry,
} = require("../lib/http");

const CLIENT_ID = "123e4567-e89b-42d3-a456-426614174000";
const API_KEY = `crib_ag_${"d".repeat(64)}`;
const PAYLOAD = {
  schemaVersion: 1,
  clientId: CLIENT_ID,
  daily: [{ date: "2026-08-22" }],
};

test("postSnapshotWithRetry retries transient server failures with one payload", async () => {
  const requests = [];
  const delays = [];
  let attempt = 0;

  const result = await postSnapshotWithRetry(
    PAYLOAD,
    {
      endpoint: "https://cribble.test/api/agent/usage",
      apiKey: API_KEY,
      fetchFn: async (_url, options) => {
        requests.push(JSON.parse(options.body));
        attempt += 1;
        if (attempt < 3) {
          return {
            ok: false,
            status: 503,
            headers: { get: () => null },
            text: async () => "temporarily unavailable",
          };
        }
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () =>
            `{"success":true,"inserted":1,"replaced":0,"stale":0,"clientId":"${CLIENT_ID}"}`,
        };
      },
    },
    {
      randomFn: () => 0,
      sleepFn: async (delayMs) => delays.push(delayMs),
    },
  );

  assert.equal(attempt, 3);
  assert.deepEqual(requests, [PAYLOAD, PAYLOAD, PAYLOAD]);
  assert.deepEqual(delays, [500, 1000]);
  assert.deepEqual(result.body, {
    success: true,
    inserted: 1,
    replaced: 0,
    stale: 0,
    clientId: CLIENT_ID,
  });
});

test("postSnapshotWithRetry does not retry credentials or payload failures", async () => {
  let calls = 0;

  await assert.rejects(
    postSnapshotWithRetry(
      PAYLOAD,
      {
        endpoint: "https://cribble.test/api/agent/usage",
        apiKey: API_KEY,
        fetchFn: async () => {
          calls += 1;
          return {
            ok: false,
            status: 401,
            headers: { get: () => null },
            text: async () => "Unauthorized",
          };
        },
      },
      { sleepFn: async () => assert.fail("401 must not sleep or retry") },
    ),
    (error) =>
      error instanceof SyncRequestError && error.status === 401 && !error.retryable,
  );

  assert.equal(calls, 1);
});

test("postSnapshotWithRetry respects a bounded Retry-After response", async () => {
  const delays = [];
  let calls = 0;

  await postSnapshotWithRetry(
    PAYLOAD,
    {
      endpoint: "https://cribble.test/api/agent/usage",
      apiKey: API_KEY,
      fetchFn: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            ok: false,
            status: 429,
            headers: { get: () => "120" },
            text: async () => "slow down",
          };
        }
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () =>
            `{"success":true,"inserted":0,"replaced":0,"stale":1,"clientId":"${CLIENT_ID}"}`,
        };
      },
    },
    { sleepFn: async (delayMs) => delays.push(delayMs) },
  );

  assert.deepEqual(delays, [30_000]);
});

test("postSnapshotWithRetry does not mistake a 2xx proxy page for ingestion", async () => {
  let calls = 0;
  await assert.rejects(
    postSnapshotWithRetry(
      PAYLOAD,
      {
        endpoint: "https://cribble.test/api/agent/usage",
        apiKey: API_KEY,
        fetchFn: async () => {
          calls += 1;
          return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            text: async () => "<html>maintenance</html>",
          };
        },
      },
      { attempts: 2, sleepFn: async () => {} },
    ),
    /invalid success response/,
  );
  assert.equal(calls, 2);
});

test("postSnapshotWithRetry rejects a receipt for the wrong machine", async () => {
  await assert.rejects(
    postSnapshotWithRetry(
      PAYLOAD,
      {
        endpoint: "https://cribble.test/api/agent/usage",
        apiKey: API_KEY,
        fetchFn: async () => ({
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () =>
            '{"success":true,"inserted":1,"replaced":0,"stale":0,"clientId":"223e4567-e89b-42d3-a456-426614174000"}',
        }),
      },
      { attempts: 1 },
    ),
    /invalid success response/,
  );
});

test("postSnapshotWithRetry bounds response bodies", async () => {
  await assert.rejects(
    postSnapshotWithRetry(
      PAYLOAD,
      {
        endpoint: "https://cribble.test/api/agent/usage",
        apiKey: API_KEY,
        fetchFn: async () => ({
          ok: true,
          status: 200,
          headers: { get: (name) => (name === "content-length" ? "70000" : null) },
          text: async () => assert.fail("oversized response should not be read"),
        }),
      },
      { attempts: 1 },
    ),
    /unexpectedly large response/,
  );
});

test("postSnapshotWithRetry stops reading an oversized streamed response", async () => {
  let textCalled = false;
  await assert.rejects(
    postSnapshotWithRetry(
      PAYLOAD,
      {
        endpoint: "https://cribble.test/api/agent/usage",
        apiKey: API_KEY,
        fetchFn: async () => ({
          ok: true,
          status: 200,
          headers: { get: () => null },
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(40 * 1024));
              controller.enqueue(new Uint8Array(40 * 1024));
              controller.close();
            },
          }),
          text: async () => {
            textCalled = true;
            return "";
          },
        }),
      },
      { attempts: 1 },
    ),
    /unexpectedly large response/,
  );
  assert.equal(textCalled, false);
});
