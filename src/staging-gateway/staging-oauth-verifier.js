// Staging-only OAuth/token verifier. DORMANT until PRIVATE_STAGE_GATEWAY_ENABLED=true and secrets present.
// Checks issuer, audience/resource, expiry, revocation status, account/connection status.
// Never accepts client-supplied identity, role, or HomeScope. Uses staging-specific signing key.
// Revocation and connection status MUST come from a required durable store (createD1StagingAuthStore, issue #94).
// The store is asked ONE question, checkAuth({tokenFamilyId, connectionId, accountId}); only a strict `true` admits.
// Absent store, failed store, unknown/revoked/inactive/mismatched records all deny. Verify signature before any
// privileged lookup. Never use production auth.
import { PrivateRealmError } from "../private-realm/scope.js";

const err = code => new PrivateRealmError(code);

function base64UrlDecode(str) {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  return atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

async function verifyHmac(key, data, sig) {
  let sigBytes;
  try { sigBytes = Uint8Array.from(base64UrlDecode(sig), c => c.charCodeAt(0)); } catch { return false; }
  const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", cryptoKey, sigBytes, new TextEncoder().encode(data));
}

export async function createStagingOAuthVerifier({ env, authStore } = {}) {
  if (env?.PRIVATE_STAGE_GATEWAY_ENABLED !== "true") throw err("private_tools_disabled");
  const signingKey = env.STAGING_OAUTH_SIGNING_KEY;
  const expectedResource = env.STAGING_OAUTH_RESOURCE;
  const expectedIssuer = env.STAGING_OAUTH_ISSUER;
  if (typeof signingKey !== "string" || signingKey.length < 32 ||
      typeof expectedResource !== "string" || typeof expectedIssuer !== "string") {
    throw err("trusted_gateway_dependencies_required");
  }
  if (!authStore || typeof authStore.checkAuth !== "function") {
    throw err("trusted_gateway_dependencies_required"); // fail closed; no permissive default
  }

  return async function validateStagingToken(accessToken, resource) {
    if (typeof accessToken !== "string" || !accessToken.startsWith("csat_")) throw err("scope_not_authorized");
    const parts = accessToken.slice(5).split(".");
    if (parts.length !== 2) throw err("scope_not_authorized");
    const [payloadB64, sig] = parts;

    // Verify signature FIRST before any claim use or DB lookup
    if (!(await verifyHmac(signingKey, payloadB64, sig))) throw err("scope_not_authorized");

    let payload;
    try { payload = JSON.parse(base64UrlDecode(payloadB64)); } catch { throw err("scope_not_authorized"); }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw err("scope_not_authorized");
    const now = Math.floor(Date.now() / 1000);
    // exp/iat must be real integers: a missing exp must never read as "not expired".
    if (!Number.isInteger(payload.exp) || !Number.isInteger(payload.iat)) throw err("scope_not_authorized");
    for (const k of ["account_id", "connection_id", "token_family_id"]) {
      if (typeof payload[k] !== "string") throw err("scope_not_authorized");
    }
    if (payload.iss !== expectedIssuer || payload.aud !== expectedResource || payload.resource !== resource ||
        payload.exp <= now || payload.iat > now + 60 ||
        payload.account_status !== "active" || payload.connection_status !== "active" ||
        payload.token_family_status !== "active") {
      throw err("scope_not_authorized");
    }
    if (!Array.isArray(payload.scopes) || !payload.scopes.includes("mcp:core")) {
      throw err("scope_not_authorized");
    }

    let admitted;
    try {
      admitted = await authStore.checkAuth({
        tokenFamilyId: payload.token_family_id, connectionId: payload.connection_id, accountId: payload.account_id
      });
    } catch {
      throw err("scope_not_authorized"); // store error denies
    }
    if (admitted !== true) throw err("scope_not_authorized");

    return {
      ok: true,
      context: {
        schema: "cairnstone-core-auth-context-v1",
        realm: "core-auth",
        resource: payload.resource,
        account_id: payload.account_id,
        tenant_id: payload.tenant_id,
        principal_id: payload.principal_id,
        connection_id: payload.connection_id,
        account_status: payload.account_status,
        connection_status: payload.connection_status,
        token_family_status: payload.token_family_status,
        token_family_id: payload.token_family_id,
        scopes: payload.scopes,
        client_family: payload.client_family || "unspecified"
      }
    };
  };
}
