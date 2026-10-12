import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
function shape(sql) {
  const db = new DatabaseSync(":memory:");
  for (const s of sql) db.exec(s);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'priv_%' ORDER BY name").all().map((r) => r.name);
  const out = {};
  for (const t of tables) {
    out[t] = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value}:${c.pk}`).sort();
  }
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all().map((r) => r.name);
  return { out, triggers };
}
test("staging migrations reach schema parity with canonical S0b-2 (plus staging-only nonce table)", () => {
  const canonical = shape([read("migrations/private/0001_s0b2_private_realm.sql")]);
  const files = readdirSync(new URL("../migrations/private-staging/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort();
  assert.ok(files.length >= 2);
  const staging = shape(files.map((f) => read("migrations/private-staging/" + f)));
  const { priv_service_nonces, ...rest } = staging.out;
  assert.ok(priv_service_nonces, "staging-only replay ledger present");
  assert.deepEqual(rest, Object.fromEntries(Object.entries(canonical.out).filter(([k]) => k !== "priv_service_nonces")));
  assert.deepEqual(staging.triggers, canonical.triggers);
});
