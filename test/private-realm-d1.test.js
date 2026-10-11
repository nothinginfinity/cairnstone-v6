// S0b-2 interface and hygiene tests for the D1-backed store.
// Behaviour, races, isolation, R2 and the Worker boundary are proven against a real SQLite engine in:
//   private-realm-d1-sqlite.test.js, private-realm-d1-races.test.js,
//   private-realm-r2.test.js, private-realm-worker.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { STORE_METHODS } from "../src/private-realm/store.js";
import { createD1HomeStore } from "../src/private-realm/d1-store.js";

test("STORE_METHODS is the closed 13-method interface the D1 adapter implements", () => {
  assert.deepEqual([...STORE_METHODS].sort(), [
    "ack", "can", "createInbox", "ensureDefaultHome", "grantInbox", "listInbox", "listInboxes", "readInbox", "resolveHome", "revokeConnection", "revokeGrant", "send", "setConnectionRole"
  ]);
});

test("createD1HomeStore requires a D1-like db and implements every method", () => {
  assert.throws(() => createD1HomeStore({}), /private_d1_required/);
  assert.throws(() => createD1HomeStore({ db: {} }), /private_d1_required/);
  const store = createD1HomeStore({ db: { prepare() { throw new Error("unused"); }, batch: async () => [] } });
  assert.deepEqual(Object.keys(store).sort(), [...STORE_METHODS].sort());
  for (const m of STORE_METHODS) assert.equal(typeof store[m], "function", m);
});

test("no test in the private-realm suites is a placeholder assertion", () => {
  const dir = new URL("./", import.meta.url);
  for (const file of readdirSync(dir).filter(f => /^private-realm-.*\.test\.js$/.test(f))) {
    const text = readFileSync(new URL(file, dir), "utf8").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(text, /assert\.ok\(\s*true\b/, `${file} contains a vacuous always-true assertion`);
    assert.doesNotMatch(text, /assert\.(equal|strictEqual)\(\s*true\s*,\s*true\s*\)/, `${file} contains a vacuous equality`);
  }
});

test("the migration candidate stays out of the applied migration set and wrangler config", () => {
  const applied = readdirSync(new URL("../migrations/", import.meta.url), { withFileTypes: true });
  assert.ok(applied.filter(e => e.isFile()).every(e => !/private|priv_|home/i.test(e.name)), "no private migration in migrations/");
  const wrangler = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.doesNotMatch(wrangler, /CAIRNSTONE_PRIVATE|private_storage|priv_|migrations\/private/i);
});
