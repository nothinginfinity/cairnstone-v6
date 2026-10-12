// Issue #94: staging durable auth store. Real SQLite engine, real migration file. Every denial path is asserted.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SQLITE_AVAILABLE, createSqliteD1 } from "./helpers/sqlite-d1.js";
import { createD1StagingAuthStore, STAGING_AUTH_SCHEMA_VERSION } from "../src/staging-gateway/staging-auth-store.js";
import { createStagingOAuthVerifier } from "../src/staging-gateway/staging-oauth-verifier.js";
import { mintStagingToken } from "../src/staging-gateway/staging-token.js";

const skip = SQLITE_AVAILABLE ? false : "node:sqlite unavailable";
const MIGRATION = readFileSync(new URL("../migrations/staging-auth/0001_staging_auth.sql", import.meta.url), "utf8");
const T = 1_000_000;
function fixture() {
  const db = createSqliteD1({ sql: MIGRATION });
  const conn = (id, acct, status = "active") => db.exec(`INSERT INTO staging_connections VALUES ('${id}','${acct}','${status}',${T},${T})`);
  const fam = (id, acct, c, revoked = 0) => db.exec(`INSERT INTO staging_token_families (token_family_id, account_id, connection_id, revoked, created_at, revoked_at) VALUES ('${id}','${acct}','${c}',${revoked},${T},${revoked ? T : "NULL"})`);
  conn("conn_alpha_1", "acct_alpha"); conn("conn_bravo_1", "acct_bravo"); conn("conn_off_1", "acct_alpha", "inactive"); conn("conn_rev_1", "acct_alpha", "revoked");
  fam("tfam_ok_1", "acct_alpha", "conn_alpha_1"); fam("tfam_revoked", "acct_alpha", "conn_alpha_1", 1);
  fam("tfam_off_1", "acct_alpha", "conn_off_1"); fam("tfam_connrev", "acct_alpha", "conn_rev_1"); fam("tfam_bravo", "acct_bravo", "conn_bravo_1");
  return { db, store: createD1StagingAuthStore(db) };
}
const ok = { tokenFamilyId: "tfam_ok_1", connectionId: "conn_alpha_1", accountId: "acct_alpha" };

test("migration is versioned and creates exactly the auth schema", { skip }, () => {
  const { db } = fixture();
  assert.deepEqual(db.rows("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'staging_%' ORDER BY name").map((r) => r.name), ["staging_auth_schema", "staging_connections", "staging_token_families"]);
  assert.equal(db.rows("SELECT MAX(version) AS v FROM staging_auth_schema")[0].v, STAGING_AUTH_SCHEMA_VERSION);
  assert.doesNotMatch(MIGRATION, /priv_(homes|messages|inbox)|DROP TABLE/);
});

test("admits only an active family on an active connection of the same account", { skip }, async () => {
  const { store } = fixture();
  assert.equal(await store.checkAuth(ok), true);
  assert.equal(await store.isRevoked("tfam_ok_1"), false);
  assert.equal(await store.connectionActive("conn_alpha_1"), true);
  assert.equal(await store.schemaReady(), true);
});

test("DENIES: unknown, revoked, inactive, revoked-connection, wrong account, wrong connection, malformed", { skip }, async () => {
  const { store } = fixture();
  const deny = async (over) => assert.equal(await store.checkAuth({ ...ok, ...over }), false, JSON.stringify(over));
  await deny({ tokenFamilyId: "tfam_unknown" });
  await deny({ tokenFamilyId: "tfam_revoked" });
  await deny({ tokenFamilyId: "tfam_off_1", connectionId: "conn_off_1" });
  await deny({ tokenFamilyId: "tfam_connrev", connectionId: "conn_rev_1" });
  await deny({ accountId: "acct_bravo" });                               // token claims another account
  await deny({ tokenFamilyId: "tfam_bravo" });                           // family of another account/connection
  await deny({ connectionId: "conn_bravo_1" });                          // family not on that connection
  await deny({ connectionId: "conn_unknown_1" });
  for (const bad of [undefined, null, "", "x", "a b c d e", "tfam'; DROP TABLE staging_connections;--", 7, {}, "t".repeat(81)]) {
    await deny({ tokenFamilyId: bad }); await deny({ connectionId: bad }); await deny({ accountId: bad });
  }
  assert.equal(await store.checkAuth(), false);
  assert.equal(await store.checkAuth(null), false);
  assert.equal(await store.isRevoked("tfam_unknown"), true);   // unknown reads as revoked
  assert.equal(await store.isRevoked("tfam_revoked"), true);
  assert.equal(await store.isRevoked(undefined), true);
  assert.equal(await store.connectionActive("conn_off_1"), false);
  assert.equal(await store.connectionActive("conn_unknown_1"), false);
});

test("DENIES on any read failure: missing tables, throwing D1, malformed rows, missing schema version", { skip }, async () => {
  const empty = createD1StagingAuthStore(createSqliteD1({ sql: "CREATE TABLE unrelated (x INTEGER);" }));
  assert.equal(await empty.checkAuth(ok), false); assert.equal(await empty.isRevoked("tfam_ok_1"), true);
  assert.equal(await empty.connectionActive("conn_alpha_1"), false); assert.equal(await empty.schemaReady(), false);
  const throwing = createD1StagingAuthStore({ prepare: () => { throw new Error("D1 down"); } });
  assert.equal(await throwing.checkAuth(ok), false);
  const rejecting = createD1StagingAuthStore({ prepare: () => ({ bind: () => ({ first: async () => { throw new Error("boom"); } }) }) });
  assert.equal(await rejecting.checkAuth(ok), false); assert.equal(await rejecting.isRevoked("tfam_ok_1"), true);
  const row = (r) => createD1StagingAuthStore({ prepare: () => ({ bind: () => ({ first: async () => r }) }) });
  const good = { revoked: 0, family_account: "acct_alpha", family_connection: "conn_alpha_1", connection_status: "active", connection_account: "acct_alpha" };
  assert.equal(await row(good).checkAuth(ok), true);                                   // control: the stub shape itself can admit
  for (const mut of [{ revoked: null }, { revoked: undefined }, { revoked: 1 }, { revoked: "1" }, { connection_status: "ACTIVE" }, { connection_status: undefined },
    { family_account: "acct_x" }, { connection_account: "acct_x" }, { family_connection: "conn_x_1" }]) {
    assert.equal(await row({ ...good, ...mut }).checkAuth(ok), false, JSON.stringify(mut));
  }
  assert.equal(await row(null).checkAuth(ok), false);
  assert.equal(await row(undefined).checkAuth(ok), false);
  for (const bad of [undefined, null, {}, { prepare: 1 }]) assert.throws(() => createD1StagingAuthStore(bad), { code: "trusted_gateway_dependencies_required" });
});

test("triggers: revocation is permanent, identity immutable, no deletes, same-account families only", { skip }, () => {
  const { db } = fixture();
  const aborts = (sql, re) => assert.throws(() => db.exec(sql), re, sql);
  aborts("UPDATE staging_token_families SET revoked = 0, revoked_at = NULL WHERE token_family_id = 'tfam_revoked'", /revocation is permanent/);
  aborts("UPDATE staging_token_families SET revoked_at = 5 WHERE token_family_id = 'tfam_revoked'", /revocation is permanent/);
  aborts("UPDATE staging_token_families SET account_id = 'acct_bravo' WHERE token_family_id = 'tfam_ok_1'", /immutable/);
  aborts("UPDATE staging_token_families SET connection_id = 'conn_bravo_1' WHERE token_family_id = 'tfam_ok_1'", /immutable/);
  aborts("DELETE FROM staging_token_families WHERE token_family_id = 'tfam_ok_1'", /append-only/);
  aborts("UPDATE staging_connections SET status = 'active' WHERE connection_id = 'conn_rev_1'", /cannot be revived/);
  aborts("UPDATE staging_connections SET account_id = 'acct_bravo' WHERE connection_id = 'conn_alpha_1'", /immutable/);
  aborts("DELETE FROM staging_connections WHERE connection_id = 'conn_alpha_1'", /append-only/);
  aborts(`INSERT INTO staging_token_families (token_family_id, account_id, connection_id, created_at) VALUES ('tfam_cross','acct_bravo','conn_alpha_1',${T})`, /does not match connection account/);
  // legitimate transitions still work
  db.exec("UPDATE staging_token_families SET revoked = 1, revoked_at = 9 WHERE token_family_id = 'tfam_ok_1'");
  db.exec("UPDATE staging_connections SET status = 'revoked', updated_at = 9 WHERE connection_id = 'conn_alpha_1'");
});

test("revocation takes effect on the next read", { skip }, async () => {
  const { db, store } = fixture();
  assert.equal(await store.checkAuth(ok), true);
  db.exec("UPDATE staging_token_families SET revoked = 1, revoked_at = 9 WHERE token_family_id = 'tfam_ok_1'");
  assert.equal(await store.checkAuth(ok), false);
  const fresh = fixture();
  fresh.db.exec("UPDATE staging_connections SET status = 'inactive', updated_at = 9 WHERE connection_id = 'conn_alpha_1'");
  assert.equal(await fresh.store.checkAuth(ok), false);
});

// ---- verifier on top of the real adapter ----
const KEY = "staging-oauth-test-key-".repeat(3);
const env = { PRIVATE_STAGE_GATEWAY_ENABLED: "true", STAGING_OAUTH_SIGNING_KEY: KEY, STAGING_OAUTH_RESOURCE: "https://stage.example.test/mcp/core-auth", STAGING_OAUTH_ISSUER: "https://stage.example.test" };
const now = () => Math.floor(Date.now() / 1000);
const claims = (over = {}) => ({ iss: env.STAGING_OAUTH_ISSUER, aud: env.STAGING_OAUTH_RESOURCE, resource: env.STAGING_OAUTH_RESOURCE, exp: now() + 600, iat: now(),
  account_id: "acct_alpha", tenant_id: "ten_alpha", principal_id: "prin_alpha_1", connection_id: "conn_alpha_1", account_status: "active", connection_status: "active",
  token_family_status: "active", token_family_id: "tfam_ok_1", scopes: ["mcp:core"], ...over });

test("verifier + real adapter: admits good, denies each persisted-state failure and each malformed claim", { skip }, async () => {
  const { store } = fixture();
  const verify = await createStagingOAuthVerifier({ env, authStore: store });
  const tok = (over, key = KEY) => mintStagingToken(key, claims(over));
  assert.equal((await verify(await tok({}), env.STAGING_OAUTH_RESOURCE)).ok, true);
  const denied = async (over, key) => assert.rejects(verify(await tok(over, key), env.STAGING_OAUTH_RESOURCE), { code: "scope_not_authorized" }, JSON.stringify(over));
  await denied({ token_family_id: "tfam_revoked" });
  await denied({ token_family_id: "tfam_unknown" });
  await denied({ connection_id: "conn_off_1", token_family_id: "tfam_off_1" });
  await denied({ account_id: "acct_bravo" });
  await denied({ aud: "https://wrong.invalid/" });
  await denied({ resource: "https://wrong.invalid/" });
  await denied({ iss: "https://other.invalid" });
  await denied({ exp: now() - 1 });
  await denied({ exp: undefined });                 // regression: a missing exp used to read as "not expired"
  await denied({ exp: "9999999999" });
  await denied({ iat: undefined });
  await denied({ iat: now() + 3600 });
  await denied({ scopes: [] });
  await denied({ token_family_id: 7 }); await denied({ account_id: null }); await denied({ connection_id: undefined });
  await denied({ account_status: "revoked" }); await denied({ token_family_status: "revoked" });
  await denied({}, "a-different-staging-key-".repeat(3));
  for (const junk of ["", "csat_", "csat_a.b", "csat_a.b.c", "Bearer x", "csat_%%%.%%%", `csat_${btoa("[]")}.AAAA`]) {
    await assert.rejects(verify(junk, env.STAGING_OAUTH_RESOURCE), { code: "scope_not_authorized" }, junk);
  }
});

test("verifier fails closed when the store is missing, throws, or answers anything but strict true", { skip }, async () => {
  for (const bad of [undefined, null, {}, { isRevoked: async () => false, connectionActive: async () => true }]) {
    await assert.rejects(createStagingOAuthVerifier({ env, authStore: bad }), { code: "trusted_gateway_dependencies_required" });
  }
  const token = await mintStagingToken(KEY, claims());
  for (const answer of [() => { throw new Error("db"); }, async () => { throw new Error("db"); }, async () => "true", async () => 1, async () => ({}), async () => undefined, async () => false]) {
    const v = await createStagingOAuthVerifier({ env, authStore: { checkAuth: answer } });
    await assert.rejects(v(token, env.STAGING_OAUTH_RESOURCE), { code: "scope_not_authorized" });
  }
  await assert.rejects(createStagingOAuthVerifier({ env: { ...env, PRIVATE_STAGE_GATEWAY_ENABLED: "false" }, authStore: { checkAuth: async () => true } }), { code: "private_tools_disabled" });
  await assert.rejects(createStagingOAuthVerifier({ env: { ...env, STAGING_OAUTH_SIGNING_KEY: "short" }, authStore: { checkAuth: async () => true } }), { code: "trusted_gateway_dependencies_required" });
});
