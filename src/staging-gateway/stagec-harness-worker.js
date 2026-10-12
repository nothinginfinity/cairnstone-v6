// S1-3 Stage C harness Worker (issue #94). STAGING ONLY. A separate Worker from the product gateway on purpose:
// it needs three service bindings (valid / no / wrong props.caller) to prove caller attestation, and the product gateway
// must keep exactly one. DISABLED unless STAGE_C_HARNESS_ENABLED === "true" AND a strong STAGE_C_HARNESS_TOKEN exists.
// No routes, no workers.dev, no previews are declared in wrangler.stagec-harness.toml; reaching it needs an owner-provisioned,
// access-restricted hostname (issue #90). Never deployed by this change.
import { createStageCHarness } from "./stagec-harness-core.js";
import { PrivateRealmError } from "../private-realm/scope.js";

const MAX_BODY = 32768;
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// Constant-time-ish comparison without early exit on content (length is not secret: the token is fixed-format).
function sameToken(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    // Disabled by default: indistinguishable from "no such Worker route".
    if (env?.STAGE_C_HARNESS_ENABLED !== "true") return new Response(null, { status: 404 });
    const url = new URL(request.url);
    if (request.method !== "POST" || (url.pathname !== "/stagec/v1/call" && url.pathname !== "/stagec/v1/probe")) return new Response(null, { status: 404 });
    const token = env.STAGE_C_HARNESS_TOKEN;
    if (typeof token !== "string" || token.length < 32) return json({ ok: false, code: "harness_unconfigured" }, 403);
    if (!sameToken(request.headers.get("Authorization") || "", `Bearer ${token}`)) return json({ ok: false, code: "unauthorized" }, 401);

    let body;
    try {
      const text = await request.text();
      if (text.length > MAX_BODY) return json({ ok: false, code: "invalid_arguments" }, 413);
      body = JSON.parse(text);
    } catch { return json({ ok: false, code: "invalid_arguments" }, 400); }

    try {
      const harness = createStageCHarness({ env });
      const result = url.pathname === "/stagec/v1/call" ? await harness.call(body) : await harness.probe(body);
      return json(result, 200);
    } catch (error) {
      // Protocol/config errors only; private-store denials are RESULTS (200) produced inside the core.
      const code = error instanceof PrivateRealmError ? error.code : "harness_error";
      return json({ ok: false, code }, code === "invalid_arguments" || code === "unknown_store_method" ? 400 : 503);
    }
  }
};
