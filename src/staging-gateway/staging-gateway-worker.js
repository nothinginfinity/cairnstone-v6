// S1-3 isolated staging gateway Worker. HTTP surface for authorized private inbox tools only.
// DORMANT by default. No production imports, no public private Worker routes, no onboard/inspect exposed.
// Service binding must set props.caller = "cairnstone-stage-gateway" (enforced in private Worker).
import { createStagingGatewayCore } from "./private-staging-gateway-client.js";
import { createStagingOAuthVerifier } from "./staging-oauth-verifier.js";
import { PrivateRealmError } from "../private-realm/scope.js";

const ALLOWED_TOOLS = new Set(["private_inbox_get", "private_inbox_list", "private_inbox_read", "private_inbox_send", "private_inbox_ack"]);

export default {
  async fetch(request, env) {
    if (env.PRIVATE_STAGE_GATEWAY_ENABLED !== "true") {
      return new Response(null, { status: 404 });
    }
    const url = new URL(request.url);
    if (request.method !== "POST" || !url.pathname.startsWith("/v1/private-inbox/")) {
      return new Response(null, { status: 404 });
    }
    const tool = url.pathname.slice("/v1/private-inbox/".length);
    if (!ALLOWED_TOOLS.has(tool)) return new Response(null, { status: 404 });

    const auth = request.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    const token = auth.slice(7);

    let body;
    try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: "invalid_arguments" }), { status: 400 }); }

    try {
      const validateStagingToken = await createStagingOAuthVerifier({ env });
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
