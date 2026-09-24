// Wrangler module entry.
// Default fetch Worker remains src/index.js.
// MessagesAuthBridge is a Cloudflare named Service Binding RPC entrypoint.
import { WorkerEntrypoint } from "cloudflare:workers";
import { introspectAccessToken } from "./messages-auth-bridge.js";

export { default } from "./index.js";

export class MessagesAuthBridge extends WorkerEntrypoint {
  async introspectAccessToken(args = {}) {
    return introspectAccessToken(this.env, args);
  }
}
