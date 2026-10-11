// S0b-1 storage boundary plan.
// This module is dormant. No bindings are created or referenced.

export const HOME_STORE_BOUNDARY = Object.freeze({
  status: "plan-only",
  slice: "S0b-1",
  isolation: "two-service-roles",
  public_gateway: {
    role: "legacy + authenticated public MCP",
    private_bindings: "none",
    private_db: "absent",
    private_r2: "absent",
  },
  private_storage_worker: {
    role: "shared multitenant internal private-storage Worker",
    public_url: false,
    bindings: ["CAIRNSTONE_PRIVATE_DB", "CAIRNSTONE_PRIVATE_R2"],
    interface: "narrow service/RPC: resolveHome, createHome, grant, send, list, read, ack, revoke",
    audience: "only the public gateway may call it; callers never hold the private binding",
  },
  notes: [
    "Dedicated D1/R2 on the same Worker are not route-scoped.",
    "Private data must never land in shared stones, refs, FTS, or public R2.",
    "This plan is not a binding, migration, or deploy.",
  ],
});
