// S0b-2 — Internal private-storage Worker skeleton.
//
// DORMANT. No public URL, no workers.dev, no custom domain, no routes.
// Holds CAIRNSTONE_PRIVATE_DB and CAIRNSTONE_PRIVATE_R2 only.
// Called solely via service binding from the public gateway.
// Gateway never holds the private bindings.

import { createD1HomeStore } from "./d1-store.js";
import { STORE_METHODS } from "./store.js";

export default {
  async fetch(request, env) {
    // No public routes. Any direct HTTP is denied.
    return new Response("private storage worker: service binding only", { status: 404 });
  },

  // Service-binding RPC entrypoint (Cloudflare service binding call).
  async handleStoreCall(method, args, env) {
    if (!STORE_METHODS.includes(method)) {
      throw new Error("unknown_store_method");
    }
    const store = createD1HomeStore({
      db: env.CAIRNSTONE_PRIVATE_DB,
      r2: env.CAIRNSTONE_PRIVATE_R2
    });
    return store[method](...args);
  }
};
