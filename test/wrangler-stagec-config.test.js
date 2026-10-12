// Issue #94: static invariants for the staging Wrangler configs (no network, no Wrangler needed).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ACTIVATION } from "../scripts/staging/s1-3-activation-lib.mjs";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const code = (f) => read(f).replace(/^\s*#.*$/gm, "");
const FILES = ["wrangler.stagec-harness.toml", "wrangler.staging-gateway.toml"];
const ZERO = "00000000-0000-0000-0000-000000000000";

for (const f of FILES) {
  test(`${f}: no routes, domains, triggers, KV/R2, build hooks, public URLs or production ids`, () => {
    const c = code(f);
    assert.doesNotMatch(c, /^\s*\[?\[?(routes?|triggers|kv_namespaces|r2_buckets|build|env\.[a-z]+|site|assets|queues|durable_objects|vectorize|ai|browser)\b/im);
    assert.doesNotMatch(c, /^\s*(route|routes|pattern|zone_id|zone_name|custom_domain)\s*=/im);
    assert.match(c, /^workers_dev\s*=\s*false/m);
    assert.match(c, /^preview_urls\s*=\s*false/m);
    assert.match(c, /^send_metrics\s*=\s*false/m);
    for (const forbidden of ["9420f645", "26d4e786", "CAIRNSTONE_PRIVATE_DB", "CAIRNSTONE_PRIVATE_R2"]) assert.ok(!c.includes(forbidden), forbidden);
  });
  test(`${f}: only the placeholder staging auth D1 is bound, and no secret value is present`, () => {
    const c = code(f);
    const dbs = [...c.matchAll(/\[\[d1_databases\]\]([\s\S]*?)(?=\n\[|$)/g)].map((m) => m[1]);
    assert.equal(dbs.length, 1);
    assert.match(dbs[0], /binding\s*=\s*"STAGING_AUTH_DB"/);
    assert.match(dbs[0], /database_name\s*=\s*"cairnstone-staging-auth"/);
    // The gateway config always keeps the placeholder. The harness config keeps it until the owner's reviewed pin PR, after which it must
    // equal the id pinned in ACTIVATION (verified exactly by the activation verifiers); the all-zero placeholder is then rejected.
    const pinned = f === "wrangler.stagec-harness.toml" ? ACTIVATION.auth.dbId : null;
    if (pinned) { assert.ok(dbs[0].includes(pinned), "harness auth D1 id must equal the reviewed pin"); assert.ok(!dbs[0].includes(ZERO)); }
    else assert.ok(dbs[0].includes(ZERO), "placeholder id only; the owner supplies the real id");
    assert.doesNotMatch(c, /(HMAC_KEY|SIGNING_KEY|HARNESS_TOKEN)\s*=/);
    assert.doesNotMatch(c, /(token|secret|password)\s*=\s*"[^"]{12,}"/i);
  });
}

test("harness config: disabled by default, exactly the three private-Worker bindings with the intended props", () => {
  const c = code("wrangler.stagec-harness.toml");
  assert.match(c, /^name\s*=\s*"cairnstone-stage-harness"/m);
  assert.match(c, /STAGE_C_HARNESS_ENABLED\s*=\s*"false"/);
  const svc = [...c.matchAll(/\[\[services\]\]([\s\S]*?)(?=\n\[|$)/g)].map((m) => m[1]);
  assert.equal(svc.length, 3);
  for (const s of svc) assert.match(s, /service\s*=\s*"cairnstone-private-staging"/);
  assert.match(svc[0], /CAIRNSTONE_PRIVATE_STAGE"[\s\S]*caller\s*=\s*"cairnstone-stage-gateway"/);
  assert.doesNotMatch(svc[1], /props/);
  assert.match(svc[2], /caller\s*=\s*"not-the-stage-gateway"/);
});

test("gateway config: stays disabled with a single service binding to the private staging Worker", () => {
  const c = code("wrangler.staging-gateway.toml");
  assert.match(c, /PRIVATE_STAGE_GATEWAY_ENABLED\s*=\s*"false"/);
  const svc = [...c.matchAll(/\[\[services\]\]/g)];
  assert.equal(svc.length, 1);
  assert.match(c, /caller\s*=\s*"cairnstone-stage-gateway"/);
});
