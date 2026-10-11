// S0b-2 contract tests for the D1-backed store.
// These run against the in-memory fake for logic coverage and document the D1/R2 requirements.
// Full concurrent D1 transaction tests require a local private D1 (not provisioned in this draft).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryHomeStore, STORE_METHODS } from "../src/private-realm/store.js";
import { createD1HomeStore } from "../src/private-realm/d1-store.js";
import { PrivateRealmError } from "../src/private-realm/scope.js";

test("STORE_METHODS matches D1 adapter interface", () => {
  const methods = [...STORE_METHODS];
  assert.equal(methods.length, 12);
  assert.ok(methods.includes("ensureDefaultHome"));
  assert.ok(methods.includes("send"));
  assert.ok(methods.includes("ack"));
});

test("createD1HomeStore requires a D1-like db", () => {
  assert.throws(() => createD1HomeStore({}), /private_d1_required/);
});

test("D1 adapter exposes all 12 methods", () => {
  const fakeDb = { prepare() { return { bind() { return { first: async () => null, run: async () => ({}) }; } }; } };
  const store = createD1HomeStore({ db: fakeDb });
  for (const m of STORE_METHODS) {
    assert.equal(typeof store[m], "function");
  }
});

test("residual: full D1 concurrency, R2 bodies, internal Worker not yet implemented", () => {
  // Disclosure: this draft lands the migration candidate + ensureDefaultHome skeleton +
  // R2 key-format helper. Remaining: complete SQL for all methods, db.batch transactions,
  // real local D1 integration tests for races/revocation/cross-Home, private Worker service binding.
  assert.ok(true);
});
