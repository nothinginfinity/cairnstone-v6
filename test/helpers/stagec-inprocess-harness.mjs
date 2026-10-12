// CI-only in-process stand-in for the staging gateway harness. It drives the REAL pinned private-staging core and the
// REAL staging migrations on a real SQLite engine, so the D1 triggers and nonce primary key genuinely execute.
// What it cannot be: a real Cloudflare service binding, a real isolate, or a real OAuth verifier. Those probes carry
// `stub: true`, and the driver refuses stubs unless allowStubs is set (it never is for a live run).
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { STAGEC, connectionIdOf, assertReadOnlySql, assertAbortProbeSql } from "../../scripts/staging/s1-3-stagec-lib.mjs";

const KEY = "synthetic-stagec-hmac-key-32characters-plus-extra";

export async function createInProcessHarness({ sourceDir, variant = {} } = {}) {
  const imp = (p) => import(pathToFileURL(join(sourceDir, p)).href);
  const { signEnvelope, __resetNonceCacheForTests } = await imp("src/private-realm/private-worker-core.js");
  const { handleStagingPrivateCall } = await imp("src/private-realm/private-staging-core.js");
  const { createSqliteD1, createFakeR2 } = await imp("test/helpers/sqlite-d1.js");
  const sql = ["0001_private_realm.sql", "0002_parity_role_and_authz_triggers.sql"]
    .map((f) => readFileSync(join(sourceDir, "migrations/private-staging", f), "utf8")).join("\n");
  const db = createSqliteD1({ sql });
  if (variant.dropSenderTrigger) db.exec("DROP TRIGGER priv_messages_sender_authorized");
  if (variant.dropDeliveryTrigger) db.exec("DROP TRIGGER priv_deliveries_target_authorized");
  if (variant.noNonceKey) {
    // Mutation: the durable replay barrier is gone (no composite key, and the insert no longer de-duplicates).
    db.exec("DROP TABLE priv_service_nonces; CREATE TABLE priv_service_nonces (caller TEXT NOT NULL, nonce TEXT NOT NULL, issued_at INTEGER NOT NULL);");
    const inner = db.prepare;
    db.prepare = (q) => inner(q.replace(/ ON CONFLICT\(caller,nonce\) DO NOTHING/, ""));
  }
  const env = {
    PRIVATE_STAGE_ENABLED: "true", PRIVATE_STAGE_CALLER: STAGEC.caller, PRIVATE_ALLOWED_CALLERS: STAGEC.caller,
    PRIVATE_GATEWAY_HMAC_KEY: KEY, CAIRNSTONE_PRIVATE_DB: db, CAIRNSTONE_PRIVATE_R2: createFakeR2()
  };
  const scopeOf = ({ account, provider }) => ({
    account_id: `acct_stagec_${account}`, tenant_id: `ten_stagec_${account}`, principal_id: `prin_stagec_${account}_${provider}`,
    connection_id: connectionIdOf({ account, provider }), provider_label: provider
  });
  const collapse = (code) => (variant.collapseCodes && !["caller_not_authorized", "scope_not_authorized", "invalid_arguments"].includes(code) ? "private_store_error" : code);
  let isolateSeq = 0;
  const invoke = async (envelope, platformCaller = STAGEC.caller) => {
    try {
      const result = await handleStagingPrivateCall({ env, envelope, platformCaller: variant.ignorePlatform ? STAGEC.caller : platformCaller });
      return { ok: true, result: JSON.parse(JSON.stringify(result ?? null)) };
    } catch (e) {
      return { ok: false, code: collapse(typeof e?.code === "string" ? e.code : "private_store_error") };
    }
  };
  const sign = (identity, method, args, extra = {}) => signEnvelope({ key: KEY, caller: STAGEC.caller, method, args: [scopeOf(identity), ...args], ...extra });

  const harness = {
    kind: "in-process-sqlite",
    async call(identity, method, args = []) { return invoke(await sign(identity, method, args)); },
    async probe(name, params = {}) {
      const { identity, method = "listInboxes" } = params;
      const now = Math.floor(Date.now() / 1000);
      switch (name) {
        case "bad_sig": { const e = await sign(identity, method, []); return invoke({ ...e, sig: (e.sig[0] === "0" ? "1" : "0") + e.sig.slice(1) }); }
        case "stale_iat": return invoke(await sign(identity, method, [], { iat: now - 3600 }));
        case "future_iat": return invoke(await sign(identity, method, [], { iat: now + 3600 }));
        case "mutated_method": { const e = await sign(identity, method, []); return invoke({ ...e, method: "resolveHome" }); }
        case "mutated_args": { const e = await sign(identity, method, []); return invoke({ ...e, args: [scopeOf({ account: "bravo", provider: "chatgpt" })] }); }
        case "wrong_caller_name": return invoke(await signEnvelope({ key: KEY, caller: "someone-else", method, args: [scopeOf(identity)] }));
        case "missing_platform_caller": return { ...(await invoke(await sign(identity, method, []), null)), stub: true };
        case "wrong_platform_caller": return { ...(await invoke(await sign(identity, method, []), "not-the-gateway")), stub: true };
        case "replay_same_nonce": {
          const e = await sign(identity, method, []);
          __resetNonceCacheForTests();
          const first = await invoke(e);
          __resetNonceCacheForTests(); // a different isolate has an empty per-isolate cache: only D1 can stop the replay
          const second = await invoke(e);
          isolateSeq += 2;
          return { ok: true, first, second, isolates: [`sim-${isolateSeq - 1}`, `sim-${isolateSeq}`], nonce: e.nonce, stub: true };
        }
        case "replay_preseeded_nonce": return invoke(await sign(identity, method, [], { nonce: params.nonce }));
        case "caller_selector_injection": {
          const bad = { ...scopeOf(identity), home_id: "home_someone_else_0001", home_role: "admin" };
          return invoke(await signEnvelope({ key: KEY, caller: STAGEC.caller, method, args: [bad] }));
        }
        case "wrong_audience_token": case "revoked_oauth": case "wrong_account_association": return { ok: false, code: "scope_not_authorized", stub: true };
        case "legacy_regression": return { ok: true, health: 200, private_tools_visible: false, stub: true };
        default: return { ok: false, code: "unknown_probe" };
      }
    }
  };
  const d1 = {
    kind: "sqlite",
    async query(q, params = []) { assertReadOnlySql(q); return db.rows(q, ...params); },
    async seedNonce(caller, nonce, issuedAt) {
      await db.prepare("INSERT INTO priv_service_nonces (caller, nonce, issued_at) VALUES (?1, ?2, ?3)").bind(caller, nonce, issuedAt).run();
    },
    async expectAbort(q, params = []) {
      assertAbortProbeSql(q);
      try { await db.prepare(q).bind(...params).run(); return { aborted: false, message: "" }; }
      catch (e) { return { aborted: true, message: String(e.message).slice(0, 300) }; }
    }
  };
  return { harness, d1, db, env };
}
