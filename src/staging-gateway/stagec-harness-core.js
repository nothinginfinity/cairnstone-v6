// S1-3 Stage C harness core (issue #94). STAGING ONLY, DORMANT by default (see stagec-harness-worker.js).
// Replaces the former stub: every call is a REAL HMAC-signed envelope sent through a REAL service binding to the
// private staging Worker, which runs its real D1 store. Anything this deployment cannot genuinely do returns an explicit
// fail-closed `{ok:false, code}`; nothing is fabricated and nothing carries `stub: true`.
//
// The harness holds the HMAC key; the Stage C driver never sees it. Scope is derived HERE from a fixed synthetic
// identity; the request can never supply a scope, home, role, caller, method outside STORE_METHODS, or key.
import { PrivateRealmError } from "../private-realm/scope.js";
import { STORE_METHODS } from "../private-realm/store.js";
import { signEnvelope } from "../private-realm/private-worker-core.js";
import { createStagingOAuthVerifier } from "./staging-oauth-verifier.js";
import { createD1StagingAuthStore } from "./staging-auth-store.js";
import { mintStagingToken } from "./staging-token.js";
import { privateErrorCode } from "./private-error-code.js";

export const STAGEC_CALLER = "cairnstone-stage-gateway";
export const SYNTHETIC_ACCOUNTS = Object.freeze(["alpha", "bravo"]);
export const SYNTHETIC_PROVIDERS = Object.freeze(["chatgpt", "grok"]);
export const HARNESS_PROBES = Object.freeze([
  "bad_sig", "stale_iat", "future_iat", "mutated_method", "mutated_args", "wrong_caller_name",
  "missing_platform_caller", "wrong_platform_caller", "replay_same_nonce", "replay_preseeded_nonce",
  "caller_selector_injection", "wrong_audience_token", "revoked_oauth", "wrong_account_association", "legacy_regression"
]);
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const bad = (code = "invalid_arguments") => new PrivateRealmError(code);

export function deriveSyntheticScope(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity) ||
      Object.keys(identity).sort().join(",") !== "account,provider" ||
      !SYNTHETIC_ACCOUNTS.includes(identity.account) || !SYNTHETIC_PROVIDERS.includes(identity.provider)) throw bad();
  return {
    account_id: `acct_stagec_${identity.account}`,
    tenant_id: `ten_stagec_${identity.account}`,
    principal_id: `prin_stagec_${identity.account}_${identity.provider}`,
    connection_id: `conn_stagec_${identity.account}_${identity.provider}`,
    provider_label: identity.provider,
    home_role: identity.provider === "chatgpt" ? "admin" : "member"
  };
}

const hasCall = (b) => b && typeof b.call === "function";

export function createStageCHarness({ env, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const key = env?.PRIVATE_GATEWAY_HMAC_KEY;
  if (typeof key !== "string" || key.length < 32 || !hasCall(env?.CAIRNSTONE_PRIVATE_STAGE) ||
      !hasCall(env?.CAIRNSTONE_PRIVATE_STAGE_NOPROPS) || !hasCall(env?.CAIRNSTONE_PRIVATE_STAGE_WRONGPROPS)) {
    throw new PrivateRealmError("private_worker_unconfigured");
  }
  const valid = env.CAIRNSTONE_PRIVATE_STAGE;

  const sign = (identity, method, args, extra = {}) =>
    signEnvelope({ key, caller: STAGEC_CALLER, method, args: [deriveSyntheticScope(identity), ...args], ...extra });

  // Sends one envelope over one binding. Success carries the store result; failure carries a typed code recovered by value.
  async function send(binding, envelope) {
    try {
      const result = await binding.call(envelope);
      return { ok: true, result };
    } catch (error) {
      const { code, source } = privateErrorCode(error);
      return { ok: false, code, code_source: source };
    }
  }
  const outcome = (r) => (r.ok ? { ok: true } : { ok: false, code: r.code });

  async function call(body) {
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join(",") !== "args,identity,method") throw bad();
    if (typeof body.method !== "string" || !STORE_METHODS.includes(body.method)) throw bad("unknown_store_method");
    if (!Array.isArray(body.args) || body.args.length > 2) throw bad();
    const r = await send(valid, await sign(body.identity, body.method, body.args));
    return r.ok ? { ok: true, result: r.result } : { ok: false, code: r.code, code_source: r.code_source };
  }

  // ---- OAuth-layer probes: the REAL staging verifier + REAL durable auth store, with a positive control ----
  async function ensureAuthFixtures(db) {
    const t = Math.floor(now() / 1000);
    const conn = (id, acct) => db.prepare(
      "INSERT INTO staging_connections (connection_id, account_id, status, created_at, updated_at) VALUES (?1,?2,'active',?3,?3) ON CONFLICT(connection_id) DO NOTHING"
    ).bind(id, acct, t).run();
    const fam = (id, acct, c, revoked) => db.prepare(
      revoked
        ? "INSERT INTO staging_token_families (token_family_id, account_id, connection_id, revoked, created_at, revoked_at) VALUES (?1,?2,?3,1,?4,?4) ON CONFLICT(token_family_id) DO UPDATE SET revoked = 1, revoked_at = COALESCE(staging_token_families.revoked_at, excluded.revoked_at)"
        : "INSERT INTO staging_token_families (token_family_id, account_id, connection_id, revoked, created_at) VALUES (?1,?2,?3,0,?4) ON CONFLICT(token_family_id) DO NOTHING"
    ).bind(id, acct, c, t).run();
    await conn("conn_stagec_alpha_chatgpt", "acct_stagec_alpha");
    await conn("conn_stagec_bravo_chatgpt", "acct_stagec_bravo");
    await fam("tfam_stagec_active", "acct_stagec_alpha", "conn_stagec_alpha_chatgpt", false);
    await fam("tfam_stagec_revoked", "acct_stagec_alpha", "conn_stagec_alpha_chatgpt", true);
  }
  const claims = (over = {}) => {
    const t = Math.floor(now() / 1000);
    return {
      iss: env.STAGING_OAUTH_ISSUER, aud: env.STAGING_OAUTH_RESOURCE, resource: env.STAGING_OAUTH_RESOURCE,
      exp: t + 600, iat: t, account_id: "acct_stagec_alpha", tenant_id: "ten_stagec_alpha", principal_id: "prin_stagec_alpha_chatgpt",
      connection_id: "conn_stagec_alpha_chatgpt", account_status: "active", connection_status: "active", token_family_status: "active",
      token_family_id: "tfam_stagec_active", scopes: ["mcp:core"], ...over
    };
  };
  async function oauthProbe(name) {
    const db = env.STAGING_AUTH_DB;
    const sk = env.STAGING_OAUTH_SIGNING_KEY;
    if (!db || typeof db.prepare !== "function" || typeof sk !== "string" || sk.length < 32 ||
        typeof env.STAGING_OAUTH_RESOURCE !== "string" || typeof env.STAGING_OAUTH_ISSUER !== "string") {
      return { ok: false, code: "harness_oauth_unconfigured" };
    }
    try {
      await ensureAuthFixtures(db);
      const verify = await createStagingOAuthVerifier({ env: { ...env, PRIVATE_STAGE_GATEWAY_ENABLED: "true" }, authStore: createD1StagingAuthStore(db) });
      // Positive control: the same machinery must ADMIT a valid token, or a denial below proves nothing.
      const control = await verify(await mintStagingToken(sk, claims()), env.STAGING_OAUTH_RESOURCE).then((r) => r?.ok === true, () => false);
      if (!control) return { ok: false, code: "harness_control_failed" };
      const variant = {
        wrong_audience_token: claims({ aud: "https://wrong-audience.invalid/mcp", resource: "https://wrong-audience.invalid/mcp" }),
        revoked_oauth: claims({ token_family_id: "tfam_stagec_revoked" }),
        wrong_account_association: claims({ account_id: "acct_stagec_bravo", tenant_id: "ten_stagec_bravo" })
      }[name];
      try {
        await verify(await mintStagingToken(sk, variant), env.STAGING_OAUTH_RESOURCE);
        return { ok: true }; // admitted: a failure the driver will flag
      } catch (error) {
        return { ok: false, code: privateErrorCode(error).code, control: "passed" };
      }
    } catch {
      return { ok: false, code: "harness_oauth_error" };
    }
  }

  async function legacyProbe() {
    const httpsUrl = (u) => { try { const x = new URL(u); return x.protocol === "https:" && !x.username && !x.password ? x.toString() : null; } catch { return null; } };
    const health = httpsUrl(env.LEGACY_MCP_HEALTH_URL), tools = httpsUrl(env.LEGACY_MCP_TOOLS_URL);
    if (!health || !tools) return { ok: false, code: "legacy_not_configured" };
    try {
      const h = await fetchImpl(health, { redirect: "error" });
      const t = await fetchImpl(tools, { redirect: "error" });
      const text = t.ok ? await t.text() : null;
      return { ok: true, health: h.status, private_tools_visible: text === null ? null : /private_inbox_/.test(text) };
    } catch {
      return { ok: false, code: "legacy_unreachable" };
    }
  }

  async function probe(body) {
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.name !== "string" ||
        Object.keys(body).some((k) => k !== "name" && k !== "params")) throw bad();
    const name = body.name;
    if (!HARNESS_PROBES.includes(name)) return { ok: false, code: "unknown_probe" };
    const params = body.params && typeof body.params === "object" && !Array.isArray(body.params) ? body.params : {};
    if (name === "legacy_regression") return legacyProbe();
    if (["wrong_audience_token", "revoked_oauth", "wrong_account_association"].includes(name)) return oauthProbe(name);

    const identity = params.identity;
    deriveSyntheticScope(identity); // validates; throws invalid_arguments
    const method = typeof params.method === "string" && STORE_METHODS.includes(params.method) ? params.method : "listInboxes";
    const t = Math.floor(now() / 1000);
    switch (name) {
      case "bad_sig": { const e = await sign(identity, method, []); return outcome(await send(valid, { ...e, sig: (e.sig[0] === "0" ? "1" : "0") + e.sig.slice(1) })); }
      case "stale_iat": return outcome(await send(valid, await sign(identity, method, [], { iat: t - 3600 })));
      case "future_iat": return outcome(await send(valid, await sign(identity, method, [], { iat: t + 3600 })));
      case "mutated_method": { const e = await sign(identity, method, []); return outcome(await send(valid, { ...e, method: method === "resolveHome" ? "listInboxes" : "resolveHome" })); }
      case "mutated_args": { const e = await sign(identity, method, []); return outcome(await send(valid, { ...e, args: [deriveSyntheticScope({ account: identity.account === "alpha" ? "bravo" : "alpha", provider: "chatgpt" })] })); }
      case "wrong_caller_name": return outcome(await send(valid, await signEnvelope({ key, caller: "someone-else", method, args: [deriveSyntheticScope(identity)] })));
      case "missing_platform_caller": return outcome(await send(env.CAIRNSTONE_PRIVATE_STAGE_NOPROPS, await sign(identity, method, [])));
      case "wrong_platform_caller": return outcome(await send(env.CAIRNSTONE_PRIVATE_STAGE_WRONGPROPS, await sign(identity, method, [])));
      case "caller_selector_injection": {
        const injected = { ...deriveSyntheticScope(identity), home_id: "home_someone_else_0001", home_role: "admin" };
        return outcome(await send(valid, await signEnvelope({ key, caller: STAGEC_CALLER, method, args: [injected] })));
      }
      case "replay_same_nonce": {
        const e = await sign(identity, method, []);
        const first = await send(valid, e);
        const second = await send(valid, e);
        // The harness cannot attest WHICH isolates served the two calls, so it does not claim to (isolates: []).
        // Durable-barrier proof is replay_preseeded_nonce.
        return { ok: true, first: outcome(first), second: outcome(second), isolates: [], isolates_unattested: true, nonce: e.nonce };
      }
      case "replay_preseeded_nonce": {
        if (typeof params.nonce !== "string" || !NONCE.test(params.nonce)) throw bad();
        return outcome(await send(valid, await sign(identity, method, [], { nonce: params.nonce })));
      }
      default: return { ok: false, code: "unknown_probe" };
    }
  }

  return Object.freeze({ call, probe });
}
