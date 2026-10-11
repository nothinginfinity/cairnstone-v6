// S1-3 staging-only internal Worker. No fetch handler, no public route.
import { WorkerEntrypoint } from "cloudflare:workers";
import { handleStagingPrivateCall } from "./private-staging-core.js";

export default class PrivateStagingEntrypoint extends WorkerEntrypoint {
  async call(envelope) {
    // Fail closed if service-binding props are missing. Gateway must attest caller.
    const caller = typeof this.ctx?.props?.caller === "string" ? this.ctx.props.caller : null;
    return handleStagingPrivateCall({
      env: this.env,
      envelope,
      platformCaller: caller
    });
  }
}
