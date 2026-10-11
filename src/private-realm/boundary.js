// S0b-1 — Storage boundary plan for the private realm.
//
// PLAN ONLY. This module creates no binding, references no binding, and is not imported by
// any production entrypoint. Approving or applying any part of it is a separate, explicit
// owner decision (see docs/private-realm/S0B1_STORE.md).
//
// Why two service roles: a second D1 or R2 binding inside the SAME Worker is not reachable
// "by route" only by convention. Any code path in that Worker (a legacy tool, a REST route,
// a future bug) can still call env.<BINDING>. Real isolation means the Worker that serves
// public/legacy traffic never holds the private binding at all.

import { STORE_METHODS } from "./store.js";

export const HOME_STORE_BOUNDARY = deepFreeze({
  status: "plan-only",
  slice: "S0b-1",
  isolation: "two-service-roles",
  decision_state: {
    binding_creation: "not-approved",
    migration_apply: "not-approved",
    deploy: "not-approved",
    guard_enforcement: "not-approved",
    accepted_head_movement: "not-authorized"
  },
  public_gateway: {
    role: "legacy + authenticated public MCP (existing cairnstone-v6 Worker)",
    private_bindings: "none",
    private_db: "absent",
    private_r2: "absent",
    responsibilities: [
      "verify the OAuth token and derive HomeScope from the verified authContext",
      "forward the HomeScope plus the operation to the private-storage Worker over a service binding",
      "collapse scope_not_authorized and capability_denied into one external 403"
    ],
    forbidden: [
      "holding CAIRNSTONE_PRIVATE_DB or CAIRNSTONE_PRIVATE_R2",
      "reading private bodies into stones, refs, FTS, manifests or shared R2",
      "accepting a caller-supplied home id as authority"
    ]
  },
  private_storage_worker: {
    role: "shared multitenant internal Worker; first home of many isolated Homes",
    public_url: false,
    workers_dev: false,
    custom_domain: false,
    routes: "none",
    bindings: ["CAIRNSTONE_PRIVATE_DB", "CAIRNSTONE_PRIVATE_R2"],
    interface: "narrow service-binding RPC; one method per STORE_METHODS entry",
    methods: [...STORE_METHODS],
    audience: "only the public gateway, via service binding; no external caller ever holds the binding",
    trust_rules: [
      "re-validate the forwarded HomeScope shape; never trust a forwarded home id",
      "resolve the Home from the connection recorded in private D1, not from the request",
      "deny by default; every method audits allow and deny with reason codes, never bodies"
    ]
  },
  per_home_resolver: {
    note: "resolveHomeStore(env) is the single seam. Early Homes share one private D1; a later approved slice can map a Home to a dedicated Worker/D1/R2/domain with no change to callers or to Home identity.",
    s0b1_behaviour: "closed: throws private_home_store_not_bound unless a test store is injected"
  },
  data_rules: [
    "private bodies exist only in the private store",
    "never in shared stones, refs, FTS, search, manifests, REST responses or shared R2",
    "audit rows hold ids and reason codes only"
  ],
  legacy_compatibility: [
    "legacy actors (chatgpt:chat, claude:cairnstone-v6, grok:*) are untouched and cannot satisfy HomeScope patterns",
    "S0a realm guard remains default off; this slice does not change its mode",
    "legacy mailbox tables, tools and REST routes are not read, written or migrated by this slice"
  ]
});

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}
