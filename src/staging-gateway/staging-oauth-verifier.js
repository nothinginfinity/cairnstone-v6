// Staging-only OAuth/token verifier. DORMANT until PRIVATE_STAGE_GATEWAY_ENABLED=true and secrets present.
// Checks issuer, audience/resource, expiry, revocation status, account/connection status.
// Never accepts client-supplied identity, role, or HomeScope. Uses staging-specific signing key.
// Revocation and connection status come from a trusted durable store interface (not static env, not production OAuth).
import { PrivateRealmError } from "../private-realm/scope.js";

const err = code => new PrivateRealmError(code);

function base64UrlDecode(str) {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  return atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

async function verifyHmac(key, data, sig) {
  const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const sigBytes = Uint8Array.from(base64UrlDecode(sig), c => c.charCodeAt(0));
  return crypto.subtle.verify("HMAC", cryptoKey, sigBytes, new TextEncoder().encode(data));
}

export async function createStagingOAuthVerifier({ env, revocationStore } = {}) {
  if (env?.PRIVATE_STAGE_GATEWAY_ENABLED !== "true") throw err("private_tools_disabled");
  const signingKey = env.STAGING_OAUTH_SIGNING_KEY;
  const expectedResource = env.STAGING_OAUTH_RESOURCE;
  const expectedIssuer = env.STAGING_OAUTH_ISSUER;
  if (typeof signingKey !== "string" || signingKey.length < 32 ||
      typeof expectedResource !== "string" || typeof expectedIssuer !== "string") {
    throw err("trusted_gateway_dependencies_required");
  }

  // Durable store interface: async isRevoked(tokenFamilyId) and async connectionActive(connectionId)
  // In live staging this binds to a staging-only D1 or external authority. Tests inject a mock.
  const store = revocationStore || {
    isRevoked: async () => false,
    connectionActive: async () => true
  };

  return async function validateStagingToken(accessToken, resource) {
    if (typeof accessToken !== "string" || !accessToken.startsWith("csat_")) throw err("scope_not_authorized");
    const parts = accessToken.slice(5).split(".");
    if (parts.length !== 2) throw err("scope_not_authorized");
    const [payloadB64, sig] = parts;
    let payload;
    try { payload = JSON.parse(base64UrlDecode(payloadB64)); } catch { throw err("scope_not_authorized"); }

    const now = Math.floor(Date.now() / 1000);
    if (payload.iss !== expectedIssuer || payload.aud !== expectedResource || payload.resource !== resource ||
        payload.exp <= now || payload.iat > now + 60 ||
        payload.account_status !== "active" || payload.connection_status !== "active" ||
        payload.token_family_status !== "active") {
      throw err("scope_not_authorized");
    }
    if (!Array.isArray(payload.scopes) || !payload.scopes.includes("mcp:core")) {
      throw err("scope_not_authorized");
    }
    if (await store.isRevoked(payload.token_family_id)) throw err("scope_not_authorized");
    if (!(await store.connectionActive(payload.connection_id))) throw err("scope_not_authorized");
    if (!(await verifyHmac(signingKey, payloadB64, sig))) throw err("scope_not_authorized");

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
