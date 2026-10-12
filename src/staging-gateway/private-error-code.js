// Typed error codes across a Workers RPC boundary (issue #94; resolves the open `instanceof` review item).
// An error thrown by the private Worker reaches the gateway through a service binding. `instanceof PrivateRealmError`
// is unreliable there: the class is not shared, and custom own properties such as `.code` may be dropped. So the code is
// recovered from, in order: an own string `.code`, then the `.message` (PrivateRealmError sets message === code).
// A message is accepted ONLY if it is a known private-realm code or `invalid_<field>`; anything else (SQL text, stack
// text, platform errors) becomes `private_store_error`. Raw exception text never crosses.
export const KNOWN_PRIVATE_CODES = Object.freeze(new Set([
  "caller_not_authorized", "scope_not_authorized", "capability_denied", "invalid_arguments", "unknown_store_method",
  "private_store_error", "private_worker_unconfigured", "scope_must_not_carry_selectors", "home_scope_required",
  "private_tools_disabled", "trusted_gateway_dependencies_required", "onboarding_not_admitted", "private_r2_required",
  "secure_random_unavailable", "inbox_derivation_key_required"
]));
const CODE = /^[a-z][a-z0-9_]{2,60}$/;

export function privateErrorCode(error) {
  const own = error && typeof error === "object" && typeof error.code === "string" ? error.code : null;
  if (own && CODE.test(own) && (KNOWN_PRIVATE_CODES.has(own) || /^invalid_[a-z_]+$/.test(own))) return { code: own, source: "code" };
  const msg = error && typeof error === "object" && typeof error.message === "string" ? error.message : null;
  if (msg && CODE.test(msg) && (KNOWN_PRIVATE_CODES.has(msg) || /^invalid_[a-z_]+$/.test(msg))) return { code: msg, source: "message" };
  return { code: "private_store_error", source: "fallback" };
}
