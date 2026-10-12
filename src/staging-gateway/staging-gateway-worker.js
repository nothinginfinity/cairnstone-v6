// S1-3 isolated staging gateway Worker. HTTP surface for authorized private inbox tools.
// DORMANT by default. No production imports, no public private Worker routes, no onboard/inspect exposed.
// Service binding must set props.caller = "cairnstone-stage-gateway" (enforced in private Worker).
// The Stage C harness is NOT served here: it is a separate, separately-disabled Worker (stagec-harness-worker.js)
// so this gateway keeps exactly ONE service binding to the private Worker. /stagec/* is a plain 404 here.
import { createStagingGatewayCore } from "./private-staging-gateway-client.js";
import { createStagingOAuthVerifier } from "./staging-oauth-verifier.js";
import { createD1StagingAuthStore } from "./staging-auth-store.js";
import { PrivateRealmError } from "../private-realm/scope.js";

const PATH_TO_TOOL = Object.freeze({
  get: "private_inbox_get",
  list: "private_inbox_list",
  read: "private_inbox_read",
  send: "private_inbox_send",
  ack: "private_inbox_ack"
});

export default {
  async fetch(request, env) {
    if (env.PRIVATE_STAGE_GATEWAY_ENABLED !== "true") {
      return new Response(null, { status: 404 });
    }
    const url = new URL(request.url);
    if (request.method !== "POST") return new Response(null, { status: 404 });

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
      // Durable auth: a real D1 binding (STAGING_AUTH_DB) behind the fail-closed adapter. Absent binding denies.
      const authStore = createD1StagingAuthStore(env.STAGING_AUTH_DB);
      const validateStagingToken = await createStagingOAuthVerifier({ env, authStore });
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
