// S1-3 staging-only internal Worker. No fetch handler, no public route.
import { WorkerEntrypoint } from "cloudflare:workers";
import { handleStagingPrivateCall } from "./private-staging-core.js";

export default class PrivateStagingEntrypoint extends WorkerEntrypoint {
  async call(envelope) {
    // For separate-Worker service bindings, Cloudflare provides no ctx.props.
    // HMAC authenticates exact caller + method + arguments; service binding
    // limits who can reach this RPC in the first place.
    return handleStagingPrivateCall({ env: this.env, envelope });
  }
}
