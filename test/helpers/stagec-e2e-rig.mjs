// In-process rig for issue #94: the REAL Stage C driver -> HTTP contract -> REAL harness Worker -> REAL HMAC-signed envelopes
// -> service-binding doubles -> REAL private staging core -> REAL staging migrations (triggers, nonce key) on SQLite,
// plus the REAL staging auth migration behind the REAL verifier. Nothing is stubbed on the harness side.
// What is simulated: the platform. A binding double passes `props.caller` the way a Cloudflare service binding would, and
// "RPC" delivery of errors can be set to drop class identity and custom properties (rpcErrors: "plain" | "opaque").
import { readFileSync } from "node:fs";
import { SQLITE_AVAILABLE, createSqliteD1, createFakeR2 } from "./sqlite-d1.js";
import { handleStagingPrivateCall } from "../../src/private-realm/private-staging-core.js";
import worker from "../../src/staging-gateway/stagec-harness-worker.js";
import { createHttpHarness } from "../../scripts/staging/s1-3-stagec-lib.mjs";

export { SQLITE_AVAILABLE };
const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
export const HMAC = "synthetic-stagec-hmac-key-32characters-plus-extra";
export const OAUTH_KEY = "synthetic-staging-oauth-signing-key-32characters-plus";
export const HARNESS_TOKEN = "synthetic-harness-bearer-token-with-40-or-more-chars";
export const CALLER = "cairnstone-stage-gateway";

export function createRig({ rpcErrors = "class", variant = {}, harnessEnv = {}, runId = "rig001" } = {}) {
  const privateDb = createSqliteD1({ sql: `${read("migrations/private-staging/0001_private_realm.sql")}\n${read("migrations/private-staging/0002_parity_role_and_authz_triggers.sql")}` });
  const authDb = createSqliteD1({ sql: read("migrations/staging-auth/0001_staging_auth.sql") });
  if (variant.dropSenderTrigger) privateDb.exec("DROP TRIGGER priv_messages_sender_authorized");
  const privateEnv = {
    PRIVATE_STAGE_ENABLED: "true", PRIVATE_STAGE_CALLER: CALLER, PRIVATE_ALLOWED_CALLERS: CALLER,
    PRIVATE_GATEWAY_HMAC_KEY: HMAC, CAIRNSTONE_PRIVATE_DB: privateDb, CAIRNSTONE_PRIVATE_R2: createFakeR2()
  };
  const deliverError = (e) => {
    if (rpcErrors === "class") return e;
    if (rpcErrors === "plain") return new Error(e.message);          // class and .code lost; message survives (name -> Error)
    return new Error("internal failure");                              // "opaque": nothing typed survives
  };
  const binding = (props) => ({
    async call(envelope) {
      try {
        const platformCaller = variant.ignorePlatform ? CALLER : (props?.caller ?? null);
        return JSON.parse(JSON.stringify(await handleStagingPrivateCall({ env: privateEnv, envelope, platformCaller }) ?? null));
      } catch (e) { throw deliverError(e); }
    }
  });
  // mutation: a DB layer that reports every family as not revoked (the comparison logic in the adapter is still real)
  const authDbForHarness = variant.authAlwaysAdmit
    ? { prepare: (sql) => { const st = authDb.prepare(sql); return { bind: (...a) => { const b = st.bind(...a); return { first: async () => { const row = await b.first(); return row && "revoked" in row ? { ...row, revoked: 0, connection_status: "active" } : row; } }; } }; } }
    : authDb;
  const env = {
    STAGE_C_HARNESS_ENABLED: "true", STAGE_C_HARNESS_TOKEN: HARNESS_TOKEN, PRIVATE_GATEWAY_HMAC_KEY: HMAC,
    CAIRNSTONE_PRIVATE_STAGE: binding({ caller: CALLER }), CAIRNSTONE_PRIVATE_STAGE_NOPROPS: binding(undefined),
    CAIRNSTONE_PRIVATE_STAGE_WRONGPROPS: binding({ caller: "not-the-stage-gateway" }),
    STAGING_AUTH_DB: authDbForHarness, STAGING_OAUTH_SIGNING_KEY: OAUTH_KEY,
    STAGING_OAUTH_RESOURCE: "https://stage.example.test/mcp/core-auth", STAGING_OAUTH_ISSUER: "https://stage.example.test",
    LEGACY_MCP_HEALTH_URL: "https://legacy.example.test/health", LEGACY_MCP_TOOLS_URL: "https://legacy.example.test/tools",
    ...harnessEnv
  };
  const legacyFetch = async (url) => (String(url).endsWith("/health")
    ? new Response("ok", { status: 200 }) : new Response(JSON.stringify({ tools: ["cairnstone_search", "cairnstone_get_stone"] }), { status: 200 }));
  const wire = [];
  const fetchImpl = async (url, init) => {
    const req = new Request(url, init);
    wire.push({ url: String(url), body: init?.body });
    const prev = globalThis.fetch;
    globalThis.fetch = legacyFetch;
    try { return await worker.fetch(req, env); } finally { globalThis.fetch = prev; }
  };
  const rows = (sql, ...a) => privateDb.rows(sql, ...a);
  const d1 = {
    kind: "sqlite",
    async query(q, params = []) { if (!/^\s*(SELECT|PRAGMA)\s/i.test(q)) throw new Error("not read-only"); return rows(q, ...params); },
    async seedNonce(caller, nonce, issuedAt) { await privateDb.prepare("INSERT INTO priv_service_nonces (caller, nonce, issued_at) VALUES (?1, ?2, ?3)").bind(caller, nonce, issuedAt).run(); },
    async expectAbort(q, params = []) {
      if (!/^\s*INSERT INTO (priv_messages|priv_deliveries)\s*\(/i.test(q)) throw new Error("not allowed");
      try { await privateDb.prepare(q).bind(...params).run(); return { aborted: false, message: "" }; } catch (e) { return { aborted: true, message: String(e.message).slice(0, 300) }; }
    }
  };
  const harness = createHttpHarness({ url: "https://stage-harness.example.test", token: HARNESS_TOKEN, runId, fetchImpl });
  return { harness, d1, privateDb, authDb, env, worker, wire, fetchImpl, runId };
}
