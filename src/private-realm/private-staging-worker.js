// S1-3 staging-only internal Worker. HTTP handler always denies; no public route.
import { WorkerEntrypoint } from "cloudflare:workers";
import { handleStagingPrivateCall } from "./private-staging-core.js";

export default class PrivateStagingEntrypoint extends WorkerEntrypoint {
  // Cloudflare requires a registered event handler for deployment (API 10068).
  // Never expose HTTP functionality even if a route is accidentally attached.
  async fetch() {
    return new Response(null, { status: 404 });
  }

  async call(envelope) {
    // For separate-Worker service bindings, Cloudflare provides no ctx.props.
    // HMAC authenticates exact caller + method + arguments; service binding
    // limits who can reach this RPC in the first place.
    return handleStagingPrivateCall({ env: this.env, envelope });
  }
}
