// S0b-2 — Internal private-storage Worker entrypoint (glue only). DORMANT.
//
// Not deployed, not routed, no bindings provisioned by this repository state. When provisioned it is
// reachable ONLY through a service binding; it defines no fetch handler, so there is no HTTP surface.
// All logic lives in ./private-worker-core.js (unit-tested in Node); this file only adapts it to the
// Workers runtime and is syntax-checked (`node --check`), not executed, in CI.
//
// `this.env` is the worker's own environment. It is never a parameter of the RPC method.

import { WorkerEntrypoint } from "cloudflare:workers";
import { handlePrivateCall } from "./private-worker-core.js";

export default class PrivateStorageEntrypoint extends WorkerEntrypoint {
  // Service-binding RPC: one method taking one signed envelope. Platform-attached caller identity
  // (ctx.props.caller, set in the binding configuration) is cross-checked against the envelope when present.
  async call(envelope) {
    const platformCaller = typeof this.ctx?.props?.caller === "string" ? this.ctx.props.caller : null;
    return handlePrivateCall({ env: this.env, envelope, platformCaller });
  }
}
