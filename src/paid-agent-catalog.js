// V7.5.0 (step 1 of the ROADMAP_V7.md engineering sequence) -- pure,
// deterministic helpers for the three provider-neutral identities/contracts
// this slice is scoped to:
//
//   - cairnstone-paid-agent-service-v1  (immutable service descriptor)
//   - cairnstone-paid-agent-request-v1  (caller + service + task + package_id,
//     service_request_id = sha256(canonical request))
//   - cairnstone-paid-agent-quote-v1    (binds service_request_id + package_id
//     to a price/asset/network/payee/expiry digest)
//
// `cairnstone-paid-agent-result-v1` (PAID_RESULT_SCHEMA_V1) is declared as a
// schema constant only in this slice; its builder is deferred to a later
// V7.5.0 step once execution/tool-receipt/payment-receipt composition exists.
//
// Hard constraints for this slice (see docs/ROADMAP_V7.md V7.5.0):
//   - zero settlement: nothing here calls x402-sub-agent-mcp, a facilitator,
//     or any wallet/signing primitive. `buildQuote` accepts an
//     already-computed price (obtained elsewhere, e.g. from that service's
//     `evaluate_request` policy primitive) and only binds it deterministically.
//   - zero model/tool calls: every export here is a pure, synchronous-except-
//     for-sha256 function. No network I/O, no CairnStone tool calls, no LLM
//     calls.
//   - price authority never comes from the model/profile -- callers must
//     supply `price` from the x402 policy plane; nothing here invents a price.
//   - a service descriptor, request, or quote can never grant execution or
//     mutation authority (mirrors the same invariant in src/profiles.js).
//   - `checkPaidAgentContextRace` and `checkReplayConsistency` are the pure
//     building blocks for the roadmap's `paid_agent_context_race` and
//     replay/no-double-charge rules; the stateful enforcement (persisting
//     settled results, re-snapshotting live authority) belongs to a later
//     engineering step once this slice's identities are accepted.
//
// Hardened per chatgpt:cairnstone-v7's AC1 review (stone
// 319be5a1da8e25e953966192a93d784b1254af7be9db4011f3268fb7535b3cdc) before any
// MCP-facing preview is exposed:
//   - `buildServiceRequest` now verifies the descriptor's own content hash
//     (`verifyServiceDescriptorIdentity`), not only its shape, so a
//     shape-valid but tampered descriptor is rejected.
//   - `buildQuote` now verifies the request's own content hash
//     (`verifyServiceRequestIdentity`) before quoting, so a syntactically
//     valid but stale/tampered `service_request_id` cannot be quoted.
//   - Quotes get the same recompute/verify treatment
//     (`recomputeQuoteId`/`verifyQuoteIdentity`), and `validateQuote` now
//     fails closed if `authorized`, `verified`, OR `settled` is ever true in
//     this zero-settlement slice (not just `settled`).
//   - `isQuoteExpired` now fails closed (treats as expired) on an invalid
//     `nowIso` instead of silently reporting "not expired".
//   - The quote's local terms digest is named `quote_terms_digest`, not
//     `payment_requirement_digest` -- it is a digest of locally normalized
//     quote terms, NOT yet the actual x402 challenge/payment requirement.
//     `checkQuotePriceMatchesAdvertisedRoute` treats a service descriptor's
//     `pricing_route` fields as advertised/non-authoritative metadata and
//     fails closed on a mismatch; x402 remains the only price authority.
//
// Second hardening round per chatgpt:cairnstone-v7 (stone
// e840964f53f0b7cd66d62b96cf5763a762e367e1eb0c2ef9059a4cb98a9779dc):
//   - `execution_authority`/`mutation_authority` on a descriptor, and each of
//     `authorized`/`verified`/`settled` on a quote's `x402_settlement`, must
//     now be an explicit `false` -- omission, `null`, or a non-boolean value
//     fails closed exactly like an explicit `true` would have.
//   - `checkQuotePriceMatchesAdvertisedRoute` now also compares `pay_to` and
//     fully validates the advertised `pricingRoute` itself (via
//     `validatePricingRoute`) first, so an unknown/malformed route can never
//     silently pass the check.
//
// V7.5.0 step 2 (`previewPaidAgentQuoteFromBody`, `computeAuthorityFingerprint`,
// `PAID_AGENT_QUOTE_PREVIEW_TOOL_DEFINITION`): a deterministic quote/preview
// MCP tool wrapper. Sources `package_id` and authority ONLY from a real
// `cairnstone_agent_bootstrap` call injected as `deps.agentBootstrapFromBody`;
// never accepts a caller-supplied package_id/fingerprint as authority. Still
// zero settlement -- the shown price is the caller-supplied `pricing_route`
// labeled advertised/non-authoritative with `x402_policy_evaluated:false`,
// not a real x402 challenge (Step 3 adds that adapter).

import { getAgentProfile } from "./profiles.js";
import { sha256Text, stableJson } from "./agent-bootstrap.js";

export const PAID_SERVICE_SCHEMA_V1 = "cairnstone-paid-agent-service-v1";
export const PAID_REQUEST_SCHEMA_V1 = "cairnstone-paid-agent-request-v1";
export const PAID_QUOTE_SCHEMA_V1 = "cairnstone-paid-agent-quote-v1";
export const PAID_RESULT_SCHEMA_V1 = "cairnstone-paid-agent-result-v1"; // reserved; no builder yet

export const PRICING_ROUTE_SCHEMA_V1 = "cairnstone-paid-agent-pricing-route-v1";

const ACTOR_ID_RE = /^[A-Za-z][A-Za-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const PACKAGE_ID_RE = /^sha256:[0-9a-f]{64}$/i;
const CONTENT_ID_RE = /^sha256:[0-9a-f]{64}$/i;
const ASSET_RE = /^[A-Za-z0-9_.:/-]{1,64}$/;
const NETWORK_RE = /^[a-z0-9-]{1,64}$/;
const TASK_MAX_LENGTH = 4000;
const PRICING_MODES = Object.freeze(["exact", "upto"]);
const DEFAULT_REQUIRED_RESULT_FIELDS = Object.freeze([
  "answer",
  "citations",
  "package_id",
  "profile_id",
  "provider",
  "model"
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function pushError(errors, path, message) {
  errors.push(`${path}: ${message}`);
}

function isPositiveIntegerAtomicString(value) {
  return typeof value === "string" && /^[0-9]+$/.test(value) && value !== "0";
}

function isValidIsoTimestamp(value) {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

// ---------------------------------------------------------------------------
// Pricing route (metadata only -- no x402 call happens here)
// ---------------------------------------------------------------------------

export function validatePricingRoute(route) {
  const errors = [];
  if (!isObject(route)) return { ok: false, errors: ["pricing_route must be an object"] };
  if (route.schema !== PRICING_ROUTE_SCHEMA_V1) {
    pushError(errors, "schema", `must equal '${PRICING_ROUTE_SCHEMA_V1}'`);
  }
  if (!isNonEmptyString(route.pattern)) pushError(errors, "pattern", "must be a non-empty string (x402 route pattern)");
  if (!isNonEmptyString(route.pay_to)) pushError(errors, "pay_to", "must be a non-empty string (payee address/identifier)");
  if (!isPositiveIntegerAtomicString(route.price_atomic)) {
    pushError(errors, "price_atomic", "must be a positive integer string in atomic units");
  }
  if (!isNonEmptyString(route.asset) || !ASSET_RE.test(route.asset)) {
    pushError(errors, "asset", "must be a short asset identifier string");
  }
  if (!isNonEmptyString(route.network) || !NETWORK_RE.test(route.network)) {
    pushError(errors, "network", "must be a short lowercase network identifier string");
  }
  if (route.mode !== undefined && !PRICING_MODES.includes(route.mode)) {
    pushError(errors, "mode", `when present, must be one of ${PRICING_MODES.join(", ")}`);
  }
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

// ---------------------------------------------------------------------------
// cairnstone-paid-agent-service-v1
// ---------------------------------------------------------------------------

/**
 * Build an immutable paid-service descriptor binding a service identity to
 * an already-accepted V7.4 agent profile and a pricing route. Pure except
 * for the final content-identity hash. Never calls x402 or any tool.
 */
export async function buildServiceDescriptor({
  service_id,
  profile_id,
  pricing_route,
  compact_result_contract
} = {}) {
  const errors = [];
  if (!isNonEmptyString(service_id)) pushError(errors, "service_id", "must be a non-empty string");

  const profileResolved = getAgentProfile(profile_id);
  if (!profileResolved.ok) {
    return { ok: false, error: "agent_profile_not_found", profile_id: profile_id || null };
  }
  const profile = profileResolved.profile;

  const routeValidation = validatePricingRoute(pricing_route);
  if (!routeValidation.ok) {
    for (const e of routeValidation.errors) pushError(errors, "pricing_route", e);
  }

  const contract = isObject(compact_result_contract) ? compact_result_contract : {};
  const maxOutputTokens = Number.isInteger(contract.max_output_tokens) && contract.max_output_tokens > 0
    ? contract.max_output_tokens
    : profile.budgets?.max_output_tokens;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1) {
    pushError(errors, "compact_result_contract.max_output_tokens", "must resolve to a positive integer");
  }
  const requiredFields = Array.isArray(contract.required_fields) && contract.required_fields.length > 0
    && contract.required_fields.every(isNonEmptyString)
    ? [...contract.required_fields]
    : [...DEFAULT_REQUIRED_RESULT_FIELDS];

  if (errors.length > 0) return { ok: false, errors };

  const descriptorBody = {
    schema: PAID_SERVICE_SCHEMA_V1,
    service_id,
    profile_id: profile.profile_id,
    profile_version: profile.version,
    chain_scope: {
      chain: profile.scope.chain,
      allowed_chains: Array.isArray(profile.scope.allowed_chains) ? [...profile.scope.allowed_chains] : []
    },
    compact_result_contract: {
      max_output_tokens: maxOutputTokens,
      required_fields: requiredFields
    },
    tool_allowlist: [...(profile.tool_allowlist || [])],
    confirmation_policy: { human_confirmation_required_for_mutation: true },
    budgets: { ...(profile.budgets || {}) },
    pricing_route: {
      schema: PRICING_ROUTE_SCHEMA_V1,
      pattern: pricing_route.pattern,
      pay_to: pricing_route.pay_to,
      price_atomic: pricing_route.price_atomic,
      asset: pricing_route.asset,
      network: pricing_route.network,
      mode: pricing_route.mode || "exact"
    },
    execution_authority: false,
    mutation_authority: false
  };

  const descriptorId = "sha256:" + await sha256Text(stableJson(descriptorBody));
  return { ok: true, descriptor: { descriptor_id: descriptorId, ...descriptorBody } };
}

/**
 * Deterministically validate a candidate service descriptor object. Pure,
 * synchronous, never throws.
 */
export function validateServiceDescriptor(descriptor) {
  const errors = [];
  if (!isObject(descriptor)) return { ok: false, errors: ["descriptor must be an object"] };

  if (descriptor.schema !== PAID_SERVICE_SCHEMA_V1) {
    pushError(errors, "schema", `must equal '${PAID_SERVICE_SCHEMA_V1}'`);
  }
  if (!isNonEmptyString(descriptor.descriptor_id) || !CONTENT_ID_RE.test(descriptor.descriptor_id)) {
    pushError(errors, "descriptor_id", "must be a 'sha256:<64 hex>' content identity string");
  }
  if (!isNonEmptyString(descriptor.service_id)) pushError(errors, "service_id", "must be a non-empty string");
  if (!isNonEmptyString(descriptor.profile_id)) pushError(errors, "profile_id", "must be a non-empty string");
  if (!isNonEmptyString(descriptor.profile_version)) pushError(errors, "profile_version", "must be a non-empty string");
  if (!isObject(descriptor.chain_scope) || !isNonEmptyString(descriptor.chain_scope.chain)) {
    pushError(errors, "chain_scope.chain", "must be a non-empty string");
  }
  if (
    descriptor.chain_scope !== undefined && isObject(descriptor.chain_scope) &&
    descriptor.chain_scope.allowed_chains !== undefined &&
    (!Array.isArray(descriptor.chain_scope.allowed_chains) || descriptor.chain_scope.allowed_chains.some(c => !isNonEmptyString(c)))
  ) {
    pushError(errors, "chain_scope.allowed_chains", "when present, must be an array of non-empty strings");
  }
  if (!isObject(descriptor.compact_result_contract) || !Number.isInteger(descriptor.compact_result_contract.max_output_tokens) ||
      descriptor.compact_result_contract.max_output_tokens < 1) {
    pushError(errors, "compact_result_contract.max_output_tokens", "must be a positive integer");
  }
  const routeValidation = validatePricingRoute(descriptor.pricing_route);
  if (!routeValidation.ok) for (const e of routeValidation.errors) pushError(errors, "pricing_route", e);

  if (descriptor.execution_authority !== false) {
    pushError(errors, "execution_authority", "must be explicitly false -- a service descriptor must never grant execution authority");
  }
  if (descriptor.mutation_authority !== false) {
    pushError(errors, "mutation_authority", "must be explicitly false -- a service descriptor must never grant mutation authority");
  }

  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

/** Recompute the content-identity hash a descriptor's fields imply. */
export async function recomputeServiceDescriptorId(descriptor) {
  if (!isObject(descriptor)) return null;
  const { descriptor_id, ...rest } = descriptor;
  return "sha256:" + await sha256Text(stableJson(rest));
}

/**
 * Fail closed if a descriptor's declared id doesn't match its own content,
 * on top of ordinary shape validation. Callers that accept a descriptor from
 * outside their own process (e.g. a stored/replayed descriptor) must use
 * this instead of `validateServiceDescriptor` alone.
 */
export async function verifyServiceDescriptorIdentity(descriptor) {
  const validation = validateServiceDescriptor(descriptor);
  if (!validation.ok) return { ok: false, error: "invalid_service_descriptor", errors: validation.errors };
  const recomputed = await recomputeServiceDescriptorId(descriptor);
  if (recomputed !== descriptor.descriptor_id) {
    return { ok: false, error: "descriptor_id_mismatch", expected: recomputed, actual: descriptor.descriptor_id };
  }
  return { ok: true };
}

/** True if `chain` is within the service descriptor's chain scope. */
export function serviceDescriptorAllowsChain(descriptor, chain) {
  if (!isObject(descriptor) || !isObject(descriptor.chain_scope) || !isNonEmptyString(chain)) return false;
  if (descriptor.chain_scope.chain === chain) return true;
  return Array.isArray(descriptor.chain_scope.allowed_chains) && descriptor.chain_scope.allowed_chains.includes(chain);
}

// ---------------------------------------------------------------------------
// cairnstone-paid-agent-request-v1
// ---------------------------------------------------------------------------

/**
 * Build a caller service request bound to an already-validated service
 * descriptor and an exact V7.0 `package_id`. `service_request_id =
 * sha256(canonical request)` -- deterministic, so an exact retry produces
 * the identical id (the replay/idempotency key for later steps).
 */
export async function buildServiceRequest({
  caller_actor_id,
  service_descriptor,
  chain,
  task,
  generation,
  package_id
} = {}) {
  const errors = [];

  if (!isNonEmptyString(caller_actor_id) || !ACTOR_ID_RE.test(caller_actor_id)) {
    pushError(errors, "caller_actor_id", "must be a non-empty 'namespace:identifier' string");
  }

  const descriptorVerification = await verifyServiceDescriptorIdentity(service_descriptor);
  if (!descriptorVerification.ok) return descriptorVerification;

  if (!isNonEmptyString(chain)) {
    pushError(errors, "chain", "must be a non-empty string");
  } else if (!serviceDescriptorAllowsChain(service_descriptor, chain)) {
    pushError(errors, "chain", `service '${service_descriptor.service_id}' is not scoped to chain '${chain}'`);
  }

  if (!isNonEmptyString(task) || task.trim().length > TASK_MAX_LENGTH) {
    pushError(errors, "task", `must be a non-empty string up to ${TASK_MAX_LENGTH} chars`);
  }

  if (!isNonEmptyString(package_id) || !PACKAGE_ID_RE.test(package_id)) {
    pushError(errors, "package_id", "must be a 'sha256:<64 hex>' V7.0 package identity string");
  }

  const gen = isObject(generation) ? generation : {};
  const ceiling = service_descriptor?.compact_result_contract?.max_output_tokens;
  const maxOutputTokens = Number.isInteger(gen.max_output_tokens) ? gen.max_output_tokens : ceiling;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || (Number.isInteger(ceiling) && maxOutputTokens > ceiling)) {
    pushError(
      errors,
      "generation.max_output_tokens",
      `must be a positive integer not exceeding the service's compact_result_contract.max_output_tokens (${ceiling})`
    );
  }

  if (errors.length > 0) return { ok: false, errors };

  const canonicalRequest = {
    schema: PAID_REQUEST_SCHEMA_V1,
    caller_actor_id,
    service_id: service_descriptor.service_id,
    service_descriptor_id: service_descriptor.descriptor_id,
    profile_id: service_descriptor.profile_id,
    profile_version: service_descriptor.profile_version,
    chain,
    task: task.trim(),
    generation: { max_output_tokens: maxOutputTokens },
    package_id
  };

  const serviceRequestId = "sha256:" + await sha256Text(stableJson(canonicalRequest));

  return { ok: true, request: { service_request_id: serviceRequestId, ...canonicalRequest } };
}

/** Deterministically validate a candidate service request object. */
export function validateServiceRequest(request) {
  const errors = [];
  if (!isObject(request)) return { ok: false, errors: ["request must be an object"] };

  if (request.schema !== PAID_REQUEST_SCHEMA_V1) pushError(errors, "schema", `must equal '${PAID_REQUEST_SCHEMA_V1}'`);
  if (!isNonEmptyString(request.service_request_id) || !CONTENT_ID_RE.test(request.service_request_id)) {
    pushError(errors, "service_request_id", "must be a 'sha256:<64 hex>' content identity string");
  }
  if (!isNonEmptyString(request.caller_actor_id) || !ACTOR_ID_RE.test(request.caller_actor_id)) {
    pushError(errors, "caller_actor_id", "must be a namespaced actor id");
  }
  if (!isNonEmptyString(request.service_id)) pushError(errors, "service_id", "must be a non-empty string");
  if (!isNonEmptyString(request.service_descriptor_id) || !CONTENT_ID_RE.test(request.service_descriptor_id)) {
    pushError(errors, "service_descriptor_id", "must be a 'sha256:<64 hex>' content identity string");
  }
  if (!isNonEmptyString(request.chain)) pushError(errors, "chain", "must be a non-empty string");
  if (!isNonEmptyString(request.task)) pushError(errors, "task", "must be a non-empty string");
  if (!isNonEmptyString(request.package_id) || !PACKAGE_ID_RE.test(request.package_id)) {
    pushError(errors, "package_id", "must be a 'sha256:<64 hex>' package identity string");
  }
  if (!isObject(request.generation) || !Number.isInteger(request.generation.max_output_tokens) || request.generation.max_output_tokens < 1) {
    pushError(errors, "generation.max_output_tokens", "must be a positive integer");
  }

  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

/** Recompute the content-identity hash a request's fields imply. */
export async function recomputeServiceRequestId(request) {
  if (!isObject(request)) return null;
  const { service_request_id, ...rest } = request;
  return "sha256:" + await sha256Text(stableJson(rest));
}

/** Fail closed if a request's declared id doesn't match its own content. */
export async function verifyServiceRequestIdentity(request) {
  const validation = validateServiceRequest(request);
  if (!validation.ok) return { ok: false, error: "invalid_service_request", errors: validation.errors };
  const recomputed = await recomputeServiceRequestId(request);
  if (recomputed !== request.service_request_id) {
    return { ok: false, error: "service_request_id_mismatch", expected: recomputed, actual: request.service_request_id };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// cairnstone-paid-agent-quote-v1
// ---------------------------------------------------------------------------

/**
 * Bind a validated service request to an already-computed price into a
 * deterministic quote. This function performs NO x402 call, NO settlement,
 * and NO payment authorization -- `price` must be supplied by the caller
 * from the x402 policy plane (e.g. `evaluate_request`). Price authority
 * never originates here or from the model/profile.
 */
export async function buildQuote({ service_request, price, expires_at } = {}) {
  const requestVerification = await verifyServiceRequestIdentity(service_request);
  if (!requestVerification.ok) return requestVerification;

  const priceInfo = isObject(price) ? price : {};
  const errors = [];
  if (!isPositiveIntegerAtomicString(priceInfo.price_atomic)) {
    pushError(errors, "price.price_atomic", "must be a positive integer string in atomic units");
  }
  if (!isNonEmptyString(priceInfo.asset) || !ASSET_RE.test(priceInfo.asset)) {
    pushError(errors, "price.asset", "must be a short asset identifier string");
  }
  if (!isNonEmptyString(priceInfo.network) || !NETWORK_RE.test(priceInfo.network)) {
    pushError(errors, "price.network", "must be a short lowercase network identifier string");
  }
  if (!isNonEmptyString(priceInfo.pay_to)) pushError(errors, "price.pay_to", "must be a non-empty payee identifier string");
  if (!isValidIsoTimestamp(expires_at)) pushError(errors, "expires_at", "must be a valid ISO-8601 timestamp");
  if (errors.length > 0) return { ok: false, errors };

  const canonicalQuote = {
    schema: PAID_QUOTE_SCHEMA_V1,
    service_request_id: service_request.service_request_id,
    package_id: service_request.package_id,
    price_atomic: priceInfo.price_atomic,
    asset: priceInfo.asset,
    network: priceInfo.network,
    pay_to: priceInfo.pay_to,
    expires_at
  };

  // NOTE: this is a digest of LOCALLY NORMALIZED quote terms, not the actual
  // x402 challenge/payment-requirement digest. A later step must accept an
  // externally supplied x402 requirement digest from the policy plane before
  // this can be treated as anything more than a local integrity check.
  const quoteTermsDigest = "sha256:" + await sha256Text(stableJson(canonicalQuote));
  const quoteId = "sha256:" + await sha256Text(
    stableJson({ ...canonicalQuote, quote_terms_digest: quoteTermsDigest })
  );

  return {
    ok: true,
    quote: {
      quote_id: quoteId,
      quote_terms_digest: quoteTermsDigest,
      ...canonicalQuote,
      x402_settlement: {
        authorized: false,
        verified: false,
        settled: false,
        note: "V7.5.0 step 1/2: zero settlement -- x402 verify/settle is a later gated engineering step"
      }
    }
  };
}

/**
 * Recompute the terms digest and quote id a quote's own canonical terms
 * imply (i.e. everything except `quote_id`, `x402_settlement`, and the
 * stored `quote_terms_digest` field itself).
 */
export async function recomputeQuoteId(quote) {
  if (!isObject(quote)) return null;
  const { quote_id, x402_settlement, quote_terms_digest, ...termsOnly } = quote;
  const expectedTermsDigest = "sha256:" + await sha256Text(stableJson(termsOnly));
  const expectedQuoteId = "sha256:" + await sha256Text(
    stableJson({ ...termsOnly, quote_terms_digest: expectedTermsDigest })
  );
  return { expectedTermsDigest, expectedQuoteId };
}

/**
 * Fail closed if a quote's declared `quote_id` or `quote_terms_digest`
 * doesn't match its own content, on top of ordinary shape validation.
 */
export async function verifyQuoteIdentity(quote) {
  const validation = validateQuote(quote);
  if (!validation.ok) return { ok: false, error: "invalid_quote", errors: validation.errors };
  const { expectedTermsDigest, expectedQuoteId } = await recomputeQuoteId(quote);
  if (quote.quote_terms_digest !== expectedTermsDigest) {
    return { ok: false, error: "quote_terms_digest_mismatch", expected: expectedTermsDigest, actual: quote.quote_terms_digest };
  }
  if (quote.quote_id !== expectedQuoteId) {
    return { ok: false, error: "quote_id_mismatch", expected: expectedQuoteId, actual: quote.quote_id };
  }
  return { ok: true };
}

/** Deterministically validate a candidate quote object. */
export function validateQuote(quote) {
  const errors = [];
  if (!isObject(quote)) return { ok: false, errors: ["quote must be an object"] };

  if (quote.schema !== PAID_QUOTE_SCHEMA_V1) pushError(errors, "schema", `must equal '${PAID_QUOTE_SCHEMA_V1}'`);
  if (!isNonEmptyString(quote.quote_id) || !CONTENT_ID_RE.test(quote.quote_id)) {
    pushError(errors, "quote_id", "must be a 'sha256:<64 hex>' content identity string");
  }
  if (!isNonEmptyString(quote.quote_terms_digest) || !CONTENT_ID_RE.test(quote.quote_terms_digest)) {
    pushError(errors, "quote_terms_digest", "must be a 'sha256:<64 hex>' content identity string");
  }
  if (!isNonEmptyString(quote.service_request_id) || !CONTENT_ID_RE.test(quote.service_request_id)) {
    pushError(errors, "service_request_id", "must be a 'sha256:<64 hex>' content identity string");
  }
  if (!isNonEmptyString(quote.package_id) || !PACKAGE_ID_RE.test(quote.package_id)) {
    pushError(errors, "package_id", "must be a 'sha256:<64 hex>' package identity string");
  }
  if (!isPositiveIntegerAtomicString(quote.price_atomic)) pushError(errors, "price_atomic", "must be a positive integer string");
  if (!isValidIsoTimestamp(quote.expires_at)) pushError(errors, "expires_at", "must be a valid ISO-8601 timestamp");

  if (isObject(quote.x402_settlement)) {
    for (const field of ["authorized", "verified", "settled"]) {
      if (quote.x402_settlement[field] !== false) {
        pushError(
          errors,
          `x402_settlement.${field}`,
          "must be explicitly false in this zero-settlement slice -- omission, a non-boolean, or true all fail closed"
        );
      }
    }
  } else {
    pushError(errors, "x402_settlement", "must be an object with authorized/verified/settled booleans");
  }

  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

/**
 * True if `quote` has expired as of `nowIso` (defaults to current time).
 * Fails closed (treats as expired) on a missing/malformed quote or an
 * invalid `nowIso` rather than silently reporting "not expired".
 */
export function isQuoteExpired(quote, nowIso = new Date().toISOString()) {
  if (!isObject(quote) || !isValidIsoTimestamp(quote.expires_at) || !isValidIsoTimestamp(nowIso)) return true;
  return Date.parse(nowIso) >= Date.parse(quote.expires_at);
}

/**
 * Pure policy-mismatch guard: a service descriptor's `pricing_route` fields
 * are advertised/non-authoritative metadata, never settlement authority --
 * x402 (via the policy plane's `evaluate_request`) remains the only price
 * authority. This fails closed if a quote's asset/network/price diverges
 * from what the service advertised, without itself granting or asserting
 * that the quote's price is correct.
 */
export function checkQuotePriceMatchesAdvertisedRoute(quote, pricingRoute) {
  if (!isObject(quote) || !isObject(pricingRoute)) return { ok: false, error: "invalid_input" };
  const routeValidation = validatePricingRoute(pricingRoute);
  if (!routeValidation.ok) return { ok: false, error: "invalid_pricing_route", errors: routeValidation.errors };
  if (quote.asset !== pricingRoute.asset) return { ok: false, error: "advertised_price_mismatch", field: "asset" };
  if (quote.network !== pricingRoute.network) return { ok: false, error: "advertised_price_mismatch", field: "network" };
  if (quote.pay_to !== pricingRoute.pay_to) return { ok: false, error: "advertised_price_mismatch", field: "pay_to" };
  if (!isPositiveIntegerAtomicString(quote.price_atomic) || !isPositiveIntegerAtomicString(pricingRoute.price_atomic)) {
    return { ok: false, error: "invalid_input" };
  }
  const quotedAtomic = BigInt(quote.price_atomic);
  const routeAtomic = BigInt(pricingRoute.price_atomic);
  const mode = pricingRoute.mode || "exact";
  if (mode === "exact" && quotedAtomic !== routeAtomic) {
    return { ok: false, error: "advertised_price_mismatch", field: "price_atomic" };
  }
  if (mode === "upto" && quotedAtomic > routeAtomic) {
    return { ok: false, error: "advertised_price_mismatch", field: "price_atomic" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// paid_agent_context_race / replay-idempotency helpers
// ---------------------------------------------------------------------------

/**
 * Pure building block for the roadmap's `paid_agent_context_race` rule: fails
 * closed if the accepted-authority fingerprint captured at quote time no
 * longer matches the fingerprint read immediately before settlement. Callers
 * are responsible for actually capturing both fingerprints (e.g. via
 * `cairnstone_resume_chain`'s path/chain-head fingerprint) -- this function
 * only compares them.
 */
export function checkPaidAgentContextRace({ quote, authority_fingerprint_at_quote, current_authority_fingerprint } = {}) {
  if (!isObject(quote)) return { ok: false, error: "invalid_quote" };
  if (!isNonEmptyString(authority_fingerprint_at_quote) || !isNonEmptyString(current_authority_fingerprint)) {
    return { ok: false, error: "authority_fingerprint_missing" };
  }
  if (authority_fingerprint_at_quote !== current_authority_fingerprint) {
    return { ok: false, error: "paid_agent_context_race", quote_id: quote.quote_id || null };
  }
  return { ok: true };
}

/**
 * Pure building block for the roadmap's replay/no-double-charge rule: an
 * exact replay (same `service_request_id`, and the request's own content
 * still hashes to that id) is a safe replay; a `service_request_id` collision
 * where the underlying content differs is `idempotency_conflict` and must
 * fail closed rather than silently re-executing or re-charging.
 */
export async function checkReplayConsistency(newRequest, priorRequest) {
  if (!isObject(priorRequest)) return { ok: true, replay: false };
  if (!isObject(newRequest) || newRequest.service_request_id !== priorRequest.service_request_id) {
    return { ok: true, replay: false };
  }
  const [newId, priorId] = await Promise.all([
    recomputeServiceRequestId(newRequest),
    recomputeServiceRequestId(priorRequest)
  ]);
  if (newId !== priorId || newId !== newRequest.service_request_id) {
    return { ok: false, error: "idempotency_conflict", service_request_id: newRequest.service_request_id };
  }
  return { ok: true, replay: true };
}

// ---------------------------------------------------------------------------
// V7.5.0 step 2 -- deterministic quote/preview MCP tool wrapper.
//
// Sources `package_id` and authority ONLY from a real `cairnstone_agent_bootstrap`
// call (via injected `deps.agentBootstrapFromBody`, mirroring the exact same
// dependency-injection pattern already used for cairnstone_delegate and
// cairnstone_tool_authorization_prepare in src/index.js). A caller-supplied
// package_id or authority fingerprint is never accepted as authority.
//
// This wrapper is a PREVIEW ONLY:
//   - zero settlement, zero wallet signing, zero x402 verify/settle;
//   - the price shown comes directly from the caller-supplied service
//     pricing_route, NOT from any x402 policy evaluation (that adapter does
//     not exist until Step 3) -- the response explicitly sets
//     `x402_policy_evaluated:false` and labels the price
//     advertised/non-authoritative rather than presenting it as a real
//     payment quote/challenge;
//   - `authority_fingerprint` is derived from the same bootstrap call's
//     accepted chain_head/path_heads, using the identical construction the
//     context compiler itself uses for race detection, so a later settlement
//     step can re-bootstrap immediately before payment and compare
//     fingerprints via `checkPaidAgentContextRace` -- this preview does not
//     itself enforce that race check, since no settlement happens here.
// ---------------------------------------------------------------------------

export const PAID_AGENT_QUOTE_PREVIEW_SCHEMA_V1 = "cairnstone-paid-agent-quote-preview-v1";
const DEFAULT_QUOTE_EXPIRES_IN_SECONDS = 300;
const MIN_QUOTE_EXPIRES_IN_SECONDS = 30;
const MAX_QUOTE_EXPIRES_IN_SECONDS = 3600;

export const PAID_AGENT_QUOTE_PREVIEW_TOOL_DEFINITION = {
  name: "cairnstone_paid_agent_quote_preview",
  description:
    "V7.5.0 step 2: deterministic, zero-settlement preview of a paid-agent service/request/quote for an accepted V7.4 profile (e.g. repo-debugger). Sources package_id and authority ONLY from a real cairnstone_agent_bootstrap call -- a caller-supplied package_id/fingerprint is never accepted as authority. The returned price comes directly from the caller-supplied pricing_route and is explicitly labeled advertised/non-authoritative with x402_policy_evaluated:false; this is NOT a real x402 payment quote/challenge (that requires the Step 3 x402 adapter). Performs zero wallet signing and zero x402 verify/settle.",
  inputSchema: {
    type: "object",
    required: ["actor_id", "profile_id", "chain", "task", "pricing_route"],
    properties: {
      actor_id: { type: "string", description: "namespace:identifier caller/actor id, e.g. claude:cairnstone-v6" },
      profile_id: { type: "string", description: "An accepted V7.4 profile id, e.g. repo-debugger" },
      service_id: { type: "string", description: "Defaults to 'cairnstone-paid-agent-service:<profile_id>' if omitted" },
      chain: { type: "string", description: "Must be within the profile's chain scope" },
      task: { type: "string", maxLength: 4000 },
      generation: {
        type: "object",
        properties: { max_output_tokens: { type: "number", minimum: 1 } },
        additionalProperties: false
      },
      pricing_route: {
        type: "object",
        description: "Advertised/non-authoritative pricing metadata. NOT an x402 policy evaluation.",
        required: ["pattern", "pay_to", "price_atomic", "asset", "network"],
        properties: {
          pattern: { type: "string" },
          pay_to: { type: "string" },
          price_atomic: { type: "string" },
          asset: { type: "string" },
          network: { type: "string" },
          mode: { type: "string", enum: ["exact", "upto"] }
        }
      },
      expires_in_seconds: {
        type: "number",
        minimum: MIN_QUOTE_EXPIRES_IN_SECONDS,
        maximum: MAX_QUOTE_EXPIRES_IN_SECONDS,
        description: `Quote validity window. Defaults to ${DEFAULT_QUOTE_EXPIRES_IN_SECONDS}.`
      }
    },
    additionalProperties: false
  }
};

/**
 * Compute the same authority fingerprint the V7.0 context compiler uses
 * internally for race detection, from a bootstrap result's `authority`
 * section (`{ chain_head: { stone_hash }, path_heads: [{ path, stone_hash }] }`).
 * Pure and synchronous.
 */
export function computeAuthorityFingerprint(authority) {
  if (!isObject(authority) || !isObject(authority.chain_head) || !Array.isArray(authority.path_heads)) return null;
  return stableJson({
    chain_head: authority.chain_head.stone_hash,
    path_heads: authority.path_heads.map(item => `${item.path}:${item.stone_hash}`).sort()
  });
}

/**
 * Build a zero-settlement paid-agent quote preview. `deps.agentBootstrapFromBody`
 * must be the real V7.0 context compiler (pre-bound with its own internal
 * dependencies exactly as wired in src/index.js) -- this is the ONLY source
 * of `package_id` and accepted authority. No other input can substitute for it.
 */
export async function previewPaidAgentQuoteFromBody(body, env, deps) {
  if (!deps || typeof deps.agentBootstrapFromBody !== "function") {
    return { ok: false, error: "preview_dependencies_missing" };
  }
  if (!isObject(body)) return { ok: false, error: "invalid_request_body" };

  const actorId = body.actor_id;
  const profileId = body.profile_id;
  const chain = body.chain;
  const task = body.task;
  if (!isNonEmptyString(actorId) || !ACTOR_ID_RE.test(actorId)) return { ok: false, error: "invalid_actor_id" };
  if (!isNonEmptyString(profileId)) return { ok: false, error: "invalid_profile_id" };
  if (!isNonEmptyString(chain)) return { ok: false, error: "invalid_chain" };
  if (!isNonEmptyString(task)) return { ok: false, error: "invalid_task" };

  // package_id and authority come ONLY from this real bootstrap call.
  // Any package_id/fingerprint the caller might have supplied is ignored.
  const bootstrap = await deps.agentBootstrapFromBody({ actor_id: actorId, task, chain, include_inbox: false }, env);
  if (!bootstrap || bootstrap.ok === false) {
    return { ok: false, error: "bootstrap_failed", detail: bootstrap };
  }
  const packageId = bootstrap.package_id;
  const authorityFingerprint = computeAuthorityFingerprint(bootstrap.authority);
  if (!isNonEmptyString(packageId) || !PACKAGE_ID_RE.test(packageId) || !authorityFingerprint) {
    return { ok: false, error: "bootstrap_result_malformed" };
  }

  const serviceId = isNonEmptyString(body.service_id) ? body.service_id : `cairnstone-paid-agent-service:${profileId}`;
  const descriptorResult = await buildServiceDescriptor({
    service_id: serviceId,
    profile_id: profileId,
    pricing_route: body.pricing_route
  });
  if (!descriptorResult.ok) return descriptorResult;

  const requestResult = await buildServiceRequest({
    caller_actor_id: actorId,
    service_descriptor: descriptorResult.descriptor,
    chain,
    task,
    generation: body.generation,
    package_id: packageId
  });
  if (!requestResult.ok) return requestResult;

  const expiresInSeconds = Number.isFinite(Number(body.expires_in_seconds))
    ? Math.max(MIN_QUOTE_EXPIRES_IN_SECONDS, Math.min(MAX_QUOTE_EXPIRES_IN_SECONDS, Math.floor(Number(body.expires_in_seconds))))
    : DEFAULT_QUOTE_EXPIRES_IN_SECONDS;
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

  // Advertised price comes directly from the caller-supplied pricing_route --
  // NOT from any x402 policy evaluation. Step 3 is required before this can
  // become a real payment requirement.
  const route = descriptorResult.descriptor.pricing_route;
  const quoteResult = await buildQuote({
    service_request: requestResult.request,
    price: { price_atomic: route.price_atomic, asset: route.asset, network: route.network, pay_to: route.pay_to },
    expires_at: expiresAt
  });
  if (!quoteResult.ok) return quoteResult;

  const priceMatchCheck = checkQuotePriceMatchesAdvertisedRoute(quoteResult.quote, route);
  if (!priceMatchCheck.ok) return { ok: false, error: "quote_route_binding_failed", detail: priceMatchCheck };

  return {
    ok: true,
    schema: PAID_AGENT_QUOTE_PREVIEW_SCHEMA_V1,
    package_id: packageId,
    authority_fingerprint: authorityFingerprint,
    service_descriptor: descriptorResult.descriptor,
    service_request: requestResult.request,
    quote: quoteResult.quote,
    pricing_metadata: {
      advertised: true,
      authoritative: false,
      x402_policy_evaluated: false,
      note: "Price sourced directly from the service's pricing_route, not from x402 policy evaluation. This is a preview, not a real payment quote/challenge. Step 3 adds the x402 adapter that will make pricing authoritative."
    },
    settlement: {
      authorized: false,
      verified: false,
      settled: false,
      note: "V7.5.0 step 2: zero settlement. Real settlement (step 4) must re-bootstrap and revalidate accepted authority immediately before payment and fail paid_agent_context_race before any settlement if authority_fingerprint has changed."
    }
  };
}
