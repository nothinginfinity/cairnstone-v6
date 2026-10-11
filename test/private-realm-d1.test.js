// S0b-2 contract tests for the D1-backed store.
// Interface and basic construction tests. Full concurrent SQLite/Miniflare
// integration tests for races, revocation, and cross-Home remain residual.

import { test } from "node:test";
import assert from "node:assert/strict";
import { STORE_METHODS } from "../src/private-realm/store.js";
import { createD1HomeStore } from "../src/private-realm/d1-store.js";
import { PrivateRealmError } from "../src/private-realm/scope.js";

test("STORE_METHODS matches D1 adapter interface", () => {
  const methods = [...STORE_METHODS];
  assert.equal(methods.length, 12);
  assert.ok(methods.includes("ensureDefaultHome"));
  assert.ok(methods.includes("setConnectionRole"));
  assert.ok(methods.includes("send"));
  assert.ok(methods.includes("ack"));
});

test("createD1HomeStore requires a D1-like db", () => {
  assert.throws(() => createD1HomeStore({}), /private_d1_required/);
});

test("D1 adapter exposes all 12 methods", () => {
  const fakeDb = {
    prepare() {
      return {
        bind() {
          return {
            first: async () => null,
            run: async () => ({}),
            all: async () => ({ results: [] })
          };
        }
      };
    },
    batch: async () => []
  };
  const store = createD1HomeStore({ db: fakeDb });
  for (const m of STORE_METHODS) {
    assert.equal(typeof store[m], "function");
  }
});

test("private worker skeleton exports handleStoreCall", async () => {
  const mod = await import("../src/private-realm/private-worker.js");
  assert.equal(typeof mod.default.handleStoreCall, "function");
});
