"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { hermesRoots, loadHermesProviderRoutes, providerFromRow } = require("../lib/hermes-provider-routes");

test("Hermes roots honor explicit comma-separated configuration", () => {
  assert.deepEqual(hermesRoots({ HERMES_HOME: " /one , /two,/one " }, "/home/test"), ["/one", "/two"]);
  assert.deepEqual(hermesRoots({}, "/home/test"), ["/home/test/.hermes"]);
});

test("provider identity prefers the ledger and safely recognizes known endpoints", () => {
  assert.equal(providerFromRow({ provider: "Nous", baseUrl: "" }), "nous");
  assert.equal(providerFromRow({ provider: "", baseUrl: "https://openrouter.ai/api/v1" }), "openrouter");
  assert.equal(providerFromRow({ provider: "", baseUrl: "https://example.com" }), null);
});

test("Hermes route aggregation uses provider ledger token weights", () => {
  const calls = [];
  const routes = loadHermesProviderRoutes({ HERMES_HOME: "/one,/two" }, {
    readSqliteJsonRowsFn: (path, sql) => {
      calls.push({ path, sql });
      return path.startsWith("/one")
        ? [
            { model: "shared", provider: "nous", baseUrl: "", totalTokens: 30 },
            { model: "shared", provider: "openrouter", baseUrl: "", totalTokens: 10 },
          ]
        : [{ model: "shared", provider: "nous", baseUrl: "", totalTokens: 20 }];
    },
  });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.path.endsWith("/state.db")));
  assert.ok(calls.every((call) => call.sql.includes("session_model_usage")));
  assert.deepEqual(routes, [
    { model: "shared", provider: "nous", totalTokens: 50 },
    { model: "shared", provider: "openrouter", totalTokens: 10 },
  ]);
});
