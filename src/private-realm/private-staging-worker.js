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
    // ctx.props is set by the gateway's service-binding `props` config and is unforgeable by the caller.
    // The core fails closed when it is absent or does not equal PRIVATE_STAGE_CALLER.
    const platformCaller = typeof this.ctx?.props?.caller === "string" ? this.ctx.props.caller : null;
    return handleStagingPrivateCall({ env: this.env, envelope, platformCaller });
  }
}
