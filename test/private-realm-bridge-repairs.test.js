// S1-1 repair queue (from the converged PR #77 review): resolveHome, admission on an unchanged fresh context,
// atomic first grant, normalized verifier/policy failures. Runs on BOTH the in-memory store and real-SQLite D1.

import test from "node:test";
import assert from "node:assert/strict";
import { createIdentityHomeBridge } from "../src/private-realm/identity-home-bridge.js";
import { PrivateRealmError, createInMemoryHomeStore } from "../src/private-realm/index.js";
import { createD1HomeStore } from "../src/private-realm/d1-store.js";
import { SQLITE_AVAILABLE, createClock, createMint, createSqliteD1 } from "./helpers/sqlite-d1.js";
import { sc } from "./helpers/private-scopes.js";

const skip = SQLITE_AVAILABLE ? false : "node:sqlite unavailable";
const RESOURCE = "https://cairnstone.example/mcp/core-auth";
const KEY = "test-only-inbox-derivation-secret-32-chars-min";
const one = sc("alice", "one");
const two = sc("alice", "two");

const ctx = (scope, o = {}) => ({
  schema: "cairnstone-core-auth-context-v1", realm: "core-auth",
  account_id: scope.account_id, tenant_id: scope.tenant_id, principal_id: scope.principal_id, connection_id: scope.connection_id,
  client_family: scope.provider_label, resource: RESOURCE, authenticator_assurance: "passkey",
  account_status: "active", connection_status: "active", token_family_status: "active",
  token_family_id: "tfam_test1234", authz_version: 1, scopes: ["mcp:core"], ...o
});
const codeOf = p => p.then(() => null, e => (e instanceof PrivateRealmError ? e.code : `RAW:${e && e.message}`));

function make(kind, hooks = {}) {
  const db = kind === "sqlite" ? createSqliteD1() : null;
  const store = db
    ? createD1HomeStore({ db, now: createClock(), mintId: createMint() })
    : createInMemoryHomeStore({ testHooks: true, now: createClock(), mintId: createMint() });
  const contexts = { csat_one: ctx(one), csat_two: ctx(two) };
  const state = { validate: async token => ({ ok: token in contexts, context: structuredClone(contexts[token]) }) };
  const bridge = createIdentityHomeBridge({
    store, expectedResource: RESOURCE, inboxDerivationKey: KEY,
    validateToken: (t, r) => state.validate(t, r),
    admitOnboarding: hooks.admitOnboarding || (async () => true),
    admitAdminRecovery: hooks.admitAdminRecovery || (async () => false)
  });
  return { db, store, bridge, contexts, state };
}
const kinds = SQLITE_AVAILABLE ? ["memory", "sqlite"] : ["memory"];

for (const kind of kinds) {
  test(`[${kind}] inspect returns the real home_id and role, resolved by the store from the verified connection`, async () => {
    const { bridge } = make(kind);
    const onboarded = await bridge.onboard("csat_one");
    const seen = await bridge.inspect("csat_one");
    assert.equal(seen.home_id, onboarded.home_id);
    assert.equal(seen.role, "admin");
    assert.equal(seen.inbox_ids.length, 4);
    const joined = await bridge.onboard("csat_two");
    assert.equal((await bridge.inspect("csat_two")).home_id, joined.home_id);
    assert.equal((await bridge.inspect("csat_two")).role, "member");
  });

  test(`[${kind}] inspect never provisions: an unknown or revoked connection is denied and nothing is created`, async () => {
    const { bridge, store, db } = make(kind);
    assert.equal(await codeOf(bridge.inspect("csat_one")), "scope_not_authorized");
    if (db) assert.equal(db.count("priv_homes"), 0); else assert.equal(store.__inspect().homes.length, 0);
    await bridge.onboard("csat_one");
    await bridge.onboard("csat_two");
    await store.revokeConnection(one, two.connection_id);
    assert.equal(await codeOf(bridge.inspect("csat_two")), "scope_not_authorized");
    assert.equal(await codeOf(bridge.inspect("csat_one", {})), "caller_selectors_forbidden");
  });

  test(`[${kind}] admission is bound to the FRESH context: any drift between verifications denies and writes nothing`, async () => {
    for (const drift of [
      { authenticator_assurance: null },
      { scopes: ["mcp:core", "extra:scope"] },
      { client_family: "someone-else" },
      { token_family_id: "tfam_other9999" },
      { authz_version: 2 }
    ]) {
      const { bridge, store, state, db } = make(kind, { admitOnboarding: async c => c.authenticator_assurance === "passkey" });
      let calls = 0;
      state.validate = async () => ({ ok: true, context: ctx(one, calls++ === 0 ? {} : drift) });
      assert.equal(await codeOf(bridge.onboard("csat_one")), "scope_not_authorized", JSON.stringify(drift));
      if (db) assert.equal(db.count("priv_homes"), 0); else assert.equal(store.__inspect().homes.length, 0);
    }
  });

  test(`[${kind}] an unchanged context is admitted exactly as before`, async () => {
    const { bridge } = make(kind, { admitOnboarding: async c => c.authenticator_assurance === "passkey" });
    assert.equal((await bridge.onboard("csat_one")).created, true);
  });

  test(`[${kind}] hooks receive copies: a hook cannot alter the context the bridge later compares`, async () => {
    const { bridge } = make(kind, { admitOnboarding: async c => { c.scopes.push("mutated"); c.authenticator_assurance = "forged"; return true; } });
    assert.equal((await bridge.onboard("csat_one")).created, true);
  });

  test(`[${kind}] verifier and policy failures are normalized: no raw error, no storage text`, async () => {
    const thrower = make(kind);
    thrower.state.validate = async () => { throw new Error("D1_ERROR secret-row"); };
    assert.equal(await codeOf(thrower.bridge.inspect("csat_one")), "scope_not_authorized");
    assert.equal(await codeOf(thrower.bridge.onboard("csat_one")), "scope_not_authorized");

    const badAdmit = make(kind, { admitOnboarding: async () => { throw new Error("policy db down"); } });
    assert.equal(await codeOf(badAdmit.bridge.onboard("csat_one")), "onboarding_not_admitted");
    const home = kind === "sqlite" ? badAdmit.db.count("priv_homes") : badAdmit.store.__inspect().homes.length;
    assert.equal(home, 0);

    // A failing RECOVERY hook means "no recovery" (less privilege), not an error and not an admin.
    const badRecovery = make(kind, { admitAdminRecovery: async () => { throw new Error("recovery policy down"); } });
    const joined = await badRecovery.bridge.onboard("csat_one");
    assert.equal(joined.role, "admin", "first connection of a new Home is admin regardless of recovery consent");
    const second = await badRecovery.bridge.onboard("csat_two");
    assert.equal(second.role, "member");
  });

  test(`[${kind}] the first admin ends up with the grant on every Home inbox, and re-onboarding never re-grants after revocation`, async () => {
    const { bridge, store } = make(kind);
    const first = await bridge.onboard("csat_one");
    for (const plane of ["chat", "work"]) assert.deepEqual({ ...first.inboxes[plane].home.capabilities }, { read: true, send: true, ack: true });
    const homeInbox = first.inboxes.chat.home.inbox_id;
    await store.revokeGrant(one, { inboxId: homeInbox, targetConnectionId: one.connection_id });
    const again = await bridge.onboard("csat_one");
    assert.deepEqual({ ...again.inboxes.chat.home.capabilities }, { read: false, send: false, ack: false }, "revoked grant is not resurrected");
    assert.deepEqual({ ...again.inboxes.work.home.capabilities }, { read: true, send: true, ack: true });
  });
}

test("[sqlite] a failure inside the create+grant step leaves NO inbox without its grant; retry completes exactly once", { skip }, async () => {
  const { bridge, db } = make("sqlite");
  db.exec("CREATE TRIGGER fail_first_grants BEFORE INSERT ON priv_inbox_grants BEGIN SELECT RAISE(ABORT, 'injected'); END");
  assert.ok(await codeOf(bridge.onboard("csat_one")), "the injected failure surfaces as an error");
  assert.equal(db.count("priv_inboxes", "scope = 'home'"), 0, "the Home inbox rolled back together with its grant");
  assert.equal(db.count("priv_inbox_grants"), 0);
  db.exec("DROP TRIGGER fail_first_grants");
  const done = await bridge.onboard("csat_one");
  assert.deepEqual({ ...done.inboxes.chat.home.capabilities }, { read: true, send: true, ack: true });
  assert.equal(db.count("priv_inbox_grants", "inbox_id = ?", done.inboxes.chat.home.inbox_id), 1);
  assert.equal(db.count("priv_inboxes", "scope = 'home'"), 2);
});

for (const kind of kinds) {
  test(`[${kind}] store: createInbox grantToCreator is admin-only, Home-scope-only, boolean-only and never touches an existing inbox`, async () => {
    const { store } = make(kind);
    await store.ensureDefaultHome(one);
    await store.ensureDefaultHome(two);
    const reject = (fn, code) => assert.rejects(fn, e => e instanceof PrivateRealmError && e.code === code);
    await reject(() => store.createInbox(two, { scope: "home", inboxId: "ibx_member001", grantToCreator: true }), "capability_denied");
    await reject(() => store.createInbox(one, { scope: "connection", inboxId: "ibx_conn00001", grantToCreator: true }), "invalid_options");
    await reject(() => store.createInbox(one, { scope: "home", inboxId: "ibx_home000001", grantToCreator: "yes" }), "invalid_options");
    assert.equal((await store.createInbox(one, { scope: "home", inboxId: "ibx_home000001", grantToCreator: true })).created, true);
    assert.equal(await store.can(one, "ibx_home000001", "send"), true);
    await store.revokeGrant(one, { inboxId: "ibx_home000001", targetConnectionId: one.connection_id });
    assert.equal((await store.createInbox(one, { scope: "home", inboxId: "ibx_home000001", grantToCreator: true })).created, false);
    assert.equal(await store.can(one, "ibx_home000001", "read"), false, "an existing inbox is never re-granted");
  });

  test(`[${kind}] store: resolveHome is authorized, audited and non-provisioning`, async () => {
    const { store, db } = make(kind);
    await assert.rejects(() => store.resolveHome(one), e => e.code === "scope_not_authorized");
    const home = await store.ensureDefaultHome(one);
    assert.deepEqual({ ...(await store.resolveHome(one)) }, { home_id: home.home_id, role: "admin" });
    await assert.rejects(() => store.resolveHome({ ...one, tenant_id: "ten_other" }), e => e.code === "scope_not_authorized");
    await assert.rejects(() => store.resolveHome(one, { homeId: "home_otherhome001" }), e => e.code === "scope_not_authorized");
    if (db) {
      assert.equal(db.count("priv_homes"), 1);
      assert.ok(db.count("priv_audit", "action = 'resolve_home' AND outcome = 'allow'") >= 1);
      assert.ok(db.count("priv_audit", "action = 'resolve_home' AND outcome = 'deny'") >= 3);
    }
  });
}

test("[sqlite] SWEEP createInbox(grantToCreator) by an admin demoted at every statement boundary commits no inbox or grant afterwards", { skip }, async () => {
  const one2 = sc("alice", "adm2");
  const build = async () => {
    const fx = make("sqlite");
    await fx.store.ensureDefaultHome(one);
    await fx.store.ensureDefaultHome(one2);
    await fx.store.setConnectionRole(one, one2.connection_id, "admin");
    return fx;
  };
  const probe = await build();
  const start = probe.db.log.length;
  await probe.store.createInbox(one2, { scope: "home", inboxId: "ibx_sweepgrant", grantToCreator: true });
  const positions = probe.db.log.length - start;
  assert.ok(positions >= 3);
  let blocked = 0;
  for (let k = 0; k < positions; k += 1) {
    const fx = await build();
    let n = 0;
    let revokeSeq = null;
    fx.db.before(() => n++ === k, async () => { await fx.store.setConnectionRole(one, one2.connection_id, "member"); revokeSeq = fx.db.seq; });
    const failure = await fx.store.createInbox(one2, { scope: "home", inboxId: "ibx_sweepgrant", grantToCreator: true }).then(() => null, e => e);
    if (failure) { assert.ok(failure instanceof PrivateRealmError && ["scope_not_authorized", "capability_denied"].includes(failure.code), `position ${k}: ${failure.message}`); blocked += 1; }
    const late = fx.db.writes.filter(w => w.seq > revokeSeq && w.changes > 0 && /INSERT INTO priv_(inboxes|inbox_grants)\b/i.test(w.sql));
    assert.deepEqual(late, [], `position ${k}`);
  }
  assert.ok(blocked > 0);
});
