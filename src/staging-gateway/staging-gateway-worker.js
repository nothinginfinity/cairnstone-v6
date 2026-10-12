// S1-3 isolated staging gateway Worker. HTTP surface for authorized private inbox tools + Stage C harness.
// DORMANT by default. No production imports, no public private Worker routes, no onboard/inspect exposed.
// Service binding must set props.caller = "cairnstone-stage-gateway" (enforced in private Worker).
// Stage C harness is separately bearer-protected and uses server-derived synthetic identities only.
import { createStagingGatewayCore } from "./private-staging-gateway-client.js";
import { createStagingOAuthVerifier } from "./staging-oauth-verifier.js";
import { PrivateRealmError } from "../private-realm/scope.js";

const PATH_TO_TOOL = Object.freeze({
  get: "private_inbox_get",
  list: "private_inbox_list",
  read: "private_inbox_read",
  send: "private_inbox_send",
  ack: "private_inbox_ack"
});

function deriveSyntheticScope(identity) {
  if (!identity || typeof identity.account !== "string" || typeof identity.provider !== "string") {
    throw new PrivateRealmError("invalid_arguments");
  }
  if (!["alpha", "bravo"].includes(identity.account) || !["chatgpt", "grok"].includes(identity.provider)) {
    throw new PrivateRealmError("invalid_arguments");
  }
  return {
    account_id: `acct_stagec_${identity.account}`,
    tenant_id: `ten_stagec_${identity.account}`,
    principal_id: `prin_stagec_${identity.account}_${identity.provider}`,
    connection_id: `conn_stagec_${identity.account}_${identity.provider}`,
    home_role: identity.account === "alpha" && identity.provider === "chatgpt" ? "admin" : "member"
  };
}

export default {
  async fetch(request, env) {
    if (env.PRIVATE_STAGE_GATEWAY_ENABLED !== "true") {
      return new Response(null, { status: 404 });
    }
    const url = new URL(request.url);
    if (request.method !== "POST") return new Response(null, { status: 404 });

    // Stage C harness (separately protected)
    if (url.pathname === "/stagec/v1/call" || url.pathname === "/stagec/v1/probe") {
      const harnessAuth = request.headers.get("Authorization") || "";
      if (harnessAuth !== `Bearer ${env.STAGE_C_HARNESS_TOKEN}`) {
        return new Response(JSON.stringify({ ok: false, code: "unauthorized" }), { status: 401 });
      }
      let body;
      try { body = await request.json(); } catch { return new Response(JSON.stringify({ ok: false, code: "invalid_arguments" }), { status: 400 }); }

      try {
        if (url.pathname === "/stagec/v1/call") {
          const scope = deriveSyntheticScope(body.identity);
          // In live, this would call the private binding with signed envelope using server-derived scope.
          // Source returns typed success for synthetic fixtures; live requires real binding + store.
          return new Response(JSON.stringify({ ok: true, result: { scope, method: body.method, isolate: "stagec-source" } }), { status: 200 });
        }
        if (url.pathname === "/stagec/v1/probe") {
          return new Response(JSON.stringify({ ok: true, result: { name: body.name, isolate: "stagec-source" } }), { status: 200 });
        }
      } catch (error) {
        const code = error instanceof PrivateRealmError ? error.code : "private_tool_failed";
        return new Response(JSON.stringify({ ok: false, code }), { status: 403 });
      }
    }

    // User private inbox routes
    if (!url.pathname.startsWith("/v1/private-inbox/")) return new Response(null, { status: 404 });
    const short = url.pathname.slice("/v1/private-inbox/".length);
    const tool = PATH_TO_TOOL[short];
    if (!tool) return new Response(null, { status: 404 });

    const auth = request.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    const token = auth.slice(7);

    let body;
    try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: "invalid_arguments" }), { status: 400 }); }

    try {
      // Require explicit durable store; Worker must supply one (e.g. from env.STAGING_AUTH_STORE binding)
      const revocationStore = env.STAGING_AUTH_STORE;
      if (!revocationStore) throw new PrivateRealmError("trusted_gateway_dependencies_required");
      const validateStagingToken = await createStagingOAuthVerifier({ env, revocationStore });
      const core = createStagingGatewayCore({
        env,
        validateStagingToken,
        expectedResource: env.STAGING_OAUTH_RESOURCE,
        inboxDerivationKey: env.INBOX_DERIVATION_KEY || env.PRIVATE_GATEWAY_HMAC_KEY
      });
      const result = await core.call(token, tool, body);
      return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
    } catch (error) {
      const code = error instanceof PrivateRealmError ? error.code : "private_tool_failed";
      return new Response(JSON.stringify({ error: code }), { status: 403 });
    }
  }
};
