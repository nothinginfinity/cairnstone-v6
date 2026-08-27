import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PAID_QUOTE_SCHEMA_V1,
  PAID_REQUEST_SCHEMA_V1,
  PAID_SERVICE_SCHEMA_V1,
  PAID_AGENT_QUOTE_PREVIEW_SCHEMA_V1,
  PRICING_ROUTE_SCHEMA_V1,
  buildQuote,
  buildServiceDescriptor,
  buildServiceRequest,
  checkPaidAgentContextRace,
  checkQuotePriceMatchesAdvertisedRoute,
  checkReplayConsistency,
  computeAuthorityFingerprint,
  isQuoteExpired,
  previewPaidAgentQuoteFromBody,
  recomputeQuoteId,
  recomputeServiceDescriptorId,
  recomputeServiceRequestId,
  serviceDescriptorAllowsChain,
  validatePricingRoute,
  validateQuote,
  validateServiceDescriptor,
  validateServiceRequest,
  verifyQuoteIdentity,
  verifyServiceDescriptorIdentity,
  verifyServiceRequestIdentity
} from "../src/paid-agent-catalog.js";

const VALID_PACKAGE_ID = "sha256:" + "a".repeat(64);
const VALID_PRICING_ROUTE = {
  schema: PRICING_ROUTE_SCHEMA_V1,
  pattern: "/paid/repo-debugger/*",
  pay_to: "0xabc0000000000000000000000000000000000000",
  price_atomic: "1000",
  asset: "USDC",
  network: "base-sepolia"
};

async function validDescriptor(overrides = {}) {
  const result = await buildServiceDescriptor({
    service_id: "cairnstone-paid-repo-debugger-v1",
    profile_id: "repo-debugger",
    pricing_route: VALID_PRICING_ROUTE,
    ...overrides
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.descriptor;
}

async function validRequest(descriptorOverrides = {}, requestOverrides = {}) {
  const descriptor = await validDescriptor(descriptorOverrides);
  const result = await buildServiceRequest({
    caller_actor_id: "chatgpt:cairnstone-v7",
    service_descriptor: descriptor,
    chain: "cairnstone-v6-project-memory",
    task: "Inspect this accepted repo state and return a cited diagnosis",
    package_id: VALID_PACKAGE_ID,
    ...requestOverrides
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return { descriptor, request: result.request };
}

// ---------------------------------------------------------------------------
// Pricing route
// ---------------------------------------------------------------------------

test("V7.5.0 a well-formed pricing route validates cleanly", () => {
  assert.deepEqual(validatePricingRoute(VALID_PRICING_ROUTE), { ok: true, errors: [] });
});

test("V7.5.0 pricing route rejects a non-positive-integer price_atomic", () => {
  const result = validatePricingRoute({ ...VALID_PRICING_ROUTE, price_atomic: "0" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.startsWith("price_atomic:")));
});

test("V7.5.0 pricing route rejects an unknown mode", () => {
  const result = validatePricingRoute({ ...VALID_PRICING_ROUTE, mode: "whatever" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.startsWith("mode:")));
});

// ---------------------------------------------------------------------------
// Service descriptor
// ---------------------------------------------------------------------------

test("V7.5.0 buildServiceDescriptor resolves the repo-debugger profile and pins its version/budgets", async () => {
  const descriptor = await validDescriptor();
  assert.equal(descriptor.schema, PAID_SERVICE_SCHEMA_V1);
  assert.equal(descriptor.profile_id, "repo-debugger");
  assert.equal(descriptor.profile_version, "0.1.1");
  assert.equal(descriptor.chain_scope.chain, "cairnstone-v6-project-memory");
  assert.deepEqual(descriptor.chain_scope.allowed_chains, ["praxiq-call"]);
  assert.equal(descriptor.compact_result_contract.max_output_tokens, 1200);
  assert.equal(descriptor.execution_authority, false);
  assert.equal(descriptor.mutation_authority, false);
  assert.match(descriptor.descriptor_id, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(validateServiceDescriptor(descriptor), { ok: true, errors: [] });
});

test("V7.5.0 buildServiceDescriptor is deterministic: identical inputs produce the identical descriptor_id", async () => {
  const a = await validDescriptor();
  const b = await validDescriptor();
  assert.equal(a.descriptor_id, b.descriptor_id);
  assert.deepEqual(a, b);
});

test("V7.5.0 buildServiceDescriptor fails closed for an unknown profile_id", async () => {
  const result = await buildServiceDescriptor({
    service_id: "x",
    profile_id: "not-a-real-profile",
    pricing_route: VALID_PRICING_ROUTE
  });
  assert.deepEqual(result, { ok: false, error: "agent_profile_not_found", profile_id: "not-a-real-profile" });
});

test("V7.5.0 buildServiceDescriptor rejects an invalid pricing route", async () => {
  const result = await buildServiceDescriptor({
    service_id: "x",
    profile_id: "repo-debugger",
    pricing_route: { ...VALID_PRICING_ROUTE, price_atomic: "not-a-number" }
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.startsWith("pricing_route:")));
});

test("V7.5.0 validateServiceDescriptor rejects a descriptor claiming execution or mutation authority", () => {
  const badExec = { schema: PAID_SERVICE_SCHEMA_V1, descriptor_id: VALID_PACKAGE_ID, service_id: "x", profile_id: "repo-debugger", profile_version: "0.1.1", chain_scope: { chain: "c" }, compact_result_contract: { max_output_tokens: 100 }, pricing_route: VALID_PRICING_ROUTE, execution_authority: true };
  const result = validateServiceDescriptor(badExec);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.startsWith("execution_authority:")));
});

test("V7.5.0 serviceDescriptorAllowsChain permits the primary scope chain and allowed_chains, nothing else", async () => {
  const descriptor = await validDescriptor();
  assert.equal(serviceDescriptorAllowsChain(descriptor, "cairnstone-v6-project-memory"), true);
  assert.equal(serviceDescriptorAllowsChain(descriptor, "praxiq-call"), true);
  assert.equal(serviceDescriptorAllowsChain(descriptor, "unlisted-chain"), false);
});

// ---------------------------------------------------------------------------
// Service request
// ---------------------------------------------------------------------------

test("V7.5.0 buildServiceRequest produces a deterministic service_request_id for identical canonical input", async () => {
  const { request: a } = await validRequest();
  const { request: b } = await validRequest();
  assert.equal(a.service_request_id, b.service_request_id);
  assert.deepEqual(validateServiceRequest(a), { ok: true, errors: [] });
});

test("V7.5.0 buildServiceRequest produces a different service_request_id when the task differs", async () => {
  const { descriptor } = await validRequest();
  const other = await buildServiceRequest({
    caller_actor_id: "chatgpt:cairnstone-v7",
    service_descriptor: descriptor,
    chain: "cairnstone-v6-project-memory",
    task: "A completely different task string",
    package_id: VALID_PACKAGE_ID
  });
  const { request: original } = await validRequest();
  assert.notEqual(original.service_request_id, other.request.service_request_id);
});

test("V7.5.0 buildServiceRequest fails closed on a malformed package_id", async () => {
  const descriptor = await validDescriptor();
  const result = await buildServiceRequest({
    caller_actor_id: "chatgpt:cairnstone-v7",
    service_descriptor: descriptor,
    chain: "cairnstone-v6-project-memory",
    task: "some task",
    package_id: "not-a-package-id"
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.startsWith("package_id:")));
});

test("V7.5.0 buildServiceRequest fails closed when chain is outside the service's chain scope", async () => {
  const descriptor = await validDescriptor();
  const result = await buildServiceRequest({
    caller_actor_id: "chatgpt:cairnstone-v7",
    service_descriptor: descriptor,
    chain: "some-unrelated-chain",
    task: "some task",
    package_id: VALID_PACKAGE_ID
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.startsWith("chain:")));
});

test("V7.5.0 buildServiceRequest fails closed when generation.max_output_tokens exceeds the service ceiling", async () => {
  const descriptor = await validDescriptor();
  const result = await buildServiceRequest({
    caller_actor_id: "chatgpt:cairnstone-v7",
    service_descriptor: descriptor,
    chain: "cairnstone-v6-project-memory",
    task: "some task",
    package_id: VALID_PACKAGE_ID,
    generation: { max_output_tokens: descriptor.compact_result_contract.max_output_tokens + 1 }
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.startsWith("generation.max_output_tokens:")));
});

test("V7.5.0 buildServiceRequest rejects a malformed caller_actor_id", async () => {
  const descriptor = await validDescriptor();
  const result = await buildServiceRequest({
    caller_actor_id: "not-namespaced",
    service_descriptor: descriptor,
    chain: "cairnstone-v6-project-memory",
    task: "some task",
    package_id: VALID_PACKAGE_ID
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.startsWith("caller_actor_id:")));
});

test("V7.5.0 verifyServiceRequestIdentity accepts an untampered request and rejects a tampered one", async () => {
  const { request } = await validRequest();
  const ok = await verifyServiceRequestIdentity(request);
  assert.deepEqual(ok, { ok: true });

  const tampered = { ...request, task: "a different task entirely" };
  const bad = await verifyServiceRequestIdentity(tampered);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "service_request_id_mismatch");
});

test("V7.5.0 recomputeServiceRequestId ignores the service_request_id field itself", async () => {
  const { request } = await validRequest();
  const recomputed = await recomputeServiceRequestId(request);
  assert.equal(recomputed, request.service_request_id);
});

// ---------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------

const VALID_PRICE = { price_atomic: "1000", asset: "USDC", network: "base-sepolia", pay_to: "0xabc0000000000000000000000000000000000000" };

test("V7.5.0 buildQuote binds a service_request + already-computed price with zero settlement", async () => {
  const { request } = await validRequest();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const result = await buildQuote({ service_request: request, price: VALID_PRICE, expires_at: expiresAt });
  assert.equal(result.ok, true, JSON.stringify(result));
  const quote = result.quote;
  assert.equal(quote.schema, PAID_QUOTE_SCHEMA_V1);
  assert.equal(quote.service_request_id, request.service_request_id);
  assert.equal(quote.package_id, request.package_id);
  assert.equal(quote.price_atomic, "1000");
  assert.equal(quote.x402_settlement.settled, false);
  assert.equal(quote.x402_settlement.authorized, false);
  assert.equal(quote.x402_settlement.verified, false);
  assert.deepEqual(validateQuote(quote), { ok: true, errors: [] });
});

test("V7.5.0 buildQuote is deterministic for identical request + price + expiry", async () => {
  const { request } = await validRequest();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const a = await buildQuote({ service_request: request, price: VALID_PRICE, expires_at: expiresAt });
  const b = await buildQuote({ service_request: request, price: VALID_PRICE, expires_at: expiresAt });
  assert.equal(a.quote.quote_id, b.quote.quote_id);
  assert.equal(a.quote.quote_terms_digest, b.quote.quote_terms_digest);
});

test("V7.5.0 buildQuote fails closed on an invalid service_request", async () => {
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const result = await buildQuote({ service_request: { not: "a request" }, price: VALID_PRICE, expires_at: expiresAt });
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_service_request");
});

test("V7.5.0 buildQuote fails closed on a missing/invalid price", async () => {
  const { request } = await validRequest();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const result = await buildQuote({ service_request: request, price: { price_atomic: "0" }, expires_at: expiresAt });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.startsWith("price.")));
});

test("V7.5.0 validateQuote rejects a quote that claims settlement", async () => {
  const { request } = await validRequest();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const { quote } = await buildQuote({ service_request: request, price: VALID_PRICE, expires_at: expiresAt });
  const settledClaim = { ...quote, x402_settlement: { ...quote.x402_settlement, settled: true } };
  const result = validateQuote(settledClaim);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.startsWith("x402_settlement.settled:")));
});

test("V7.5.0 isQuoteExpired reports expiry correctly", async () => {
  const { request } = await validRequest();
  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const expired = await buildQuote({ service_request: request, price: VALID_PRICE, expires_at: past });
  const fresh = await buildQuote({ service_request: request, price: VALID_PRICE, expires_at: future });
  assert.equal(isQuoteExpired(expired.quote), true);
  assert.equal(isQuoteExpired(fresh.quote), false);
  assert.equal(isQuoteExpired(null), true);
});

// ---------------------------------------------------------------------------
// paid_agent_context_race + replay/idempotency
// ---------------------------------------------------------------------------

test("V7.5.0 checkPaidAgentContextRace passes when authority fingerprint is unchanged", async () => {
  const { request } = await validRequest();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const { quote } = await buildQuote({ service_request: request, price: VALID_PRICE, expires_at: expiresAt });
  const result = checkPaidAgentContextRace({
    quote,
    authority_fingerprint_at_quote: "fp-1",
    current_authority_fingerprint: "fp-1"
  });
  assert.deepEqual(result, { ok: true });
});

test("V7.5.0 checkPaidAgentContextRace fails closed with paid_agent_context_race when authority changed", async () => {
  const { request } = await validRequest();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const { quote } = await buildQuote({ service_request: request, price: VALID_PRICE, expires_at: expiresAt });
  const result = checkPaidAgentContextRace({
    quote,
    authority_fingerprint_at_quote: "fp-1",
    current_authority_fingerprint: "fp-2"
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "paid_agent_context_race");
});

test("V7.5.0 checkPaidAgentContextRace fails closed when a fingerprint is missing rather than treating it as a match", () => {
  const result = checkPaidAgentContextRace({ quote: { quote_id: "x" }, authority_fingerprint_at_quote: "fp-1" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "authority_fingerprint_missing");
});

test("V7.5.0 checkReplayConsistency treats an untampered exact replay as safe", async () => {
  const { request } = await validRequest();
  const result = await checkReplayConsistency(request, request);
  assert.deepEqual(result, { ok: true, replay: true });
});

test("V7.5.0 checkReplayConsistency treats a different request as not-a-replay, not a conflict", async () => {
  const { descriptor, request: first } = await validRequest();
  const second = await buildServiceRequest({
    caller_actor_id: "chatgpt:cairnstone-v7",
    service_descriptor: descriptor,
    chain: "cairnstone-v6-project-memory",
    task: "an entirely different task",
    package_id: VALID_PACKAGE_ID
  });
  const result = await checkReplayConsistency(second.request, first);
  assert.deepEqual(result, { ok: true, replay: false });
});

test("V7.5.0 checkReplayConsistency fails closed with idempotency_conflict on a same-id-different-content collision", async () => {
  const { request } = await validRequest();
  const collided = { ...request, task: "a silently swapped task with the same claimed id" };
  const result = await checkReplayConsistency(collided, request);
  assert.equal(result.ok, false);
  assert.equal(result.error, "idempotency_conflict");
});

// ---------------------------------------------------------------------------
// Hardening per chatgpt:cairnstone-v7 AC1 review
// (stone 319be5a1da8e25e953966192a93d784b1254af7be9db4011f3268fb7535b3cdc)
// ---------------------------------------------------------------------------

test("V7.5.0 verifyServiceDescriptorIdentity accepts an untampered descriptor and rejects a tampered one", async () => {
  const descriptor = await validDescriptor();
  const ok = await verifyServiceDescriptorIdentity(descriptor);
  assert.deepEqual(ok, { ok: true });

  const tampered = { ...descriptor, pricing_route: { ...descriptor.pricing_route, price_atomic: "999999" } };
  const bad = await verifyServiceDescriptorIdentity(tampered);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "descriptor_id_mismatch");
});

test("V7.5.0 buildServiceRequest rejects a shape-valid but tampered descriptor (content-hash check, not just shape)", async () => {
  const descriptor = await validDescriptor();
  const tamperedDescriptor = { ...descriptor, profile_version: "9.9.9" };
  const result = await buildServiceRequest({
    caller_actor_id: "chatgpt:cairnstone-v7",
    service_descriptor: tamperedDescriptor,
    chain: "cairnstone-v6-project-memory",
    task: "some task",
    package_id: VALID_PACKAGE_ID
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "descriptor_id_mismatch");
});

test("V7.5.0 recomputeServiceDescriptorId ignores the descriptor_id field itself", async () => {
  const descriptor = await validDescriptor();
  const recomputed = await recomputeServiceDescriptorId(descriptor);
  assert.equal(recomputed, descriptor.descriptor_id);
});

test("V7.5.0 buildQuote rejects a shape-valid but tampered service_request (stale-id cannot be quoted)", async () => {
  const { request } = await validRequest();
  const tamperedRequest = { ...request, task: "a swapped task with the old id still attached" };
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const result = await buildQuote({ service_request: tamperedRequest, price: VALID_PRICE, expires_at: expiresAt });
  assert.equal(result.ok, false);
  assert.equal(result.error, "service_request_id_mismatch");
});

test("V7.5.0 verifyQuoteIdentity accepts an untampered quote and rejects a tampered one", async () => {
  const { request } = await validRequest();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const { quote } = await buildQuote({ service_request: request, price: VALID_PRICE, expires_at: expiresAt });

  const ok = await verifyQuoteIdentity(quote);
  assert.deepEqual(ok, { ok: true });

  const tamperedTerms = { ...quote, price_atomic: "5" };
  const badTerms = await verifyQuoteIdentity(tamperedTerms);
  assert.equal(badTerms.ok, false);
  assert.equal(badTerms.error, "quote_terms_digest_mismatch");

  const recomputed = await recomputeQuoteId(quote);
  const tamperedId = { ...quote, quote_terms_digest: recomputed.expectedTermsDigest, quote_id: "sha256:" + "b".repeat(64) };
  const badId = await verifyQuoteIdentity(tamperedId);
  assert.equal(badId.ok, false);
  assert.equal(badId.error, "quote_id_mismatch");
});

test("V7.5.0 validateQuote fails closed if authorized or verified is true, not only settled", async () => {
  const { request } = await validRequest();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const { quote } = await buildQuote({ service_request: request, price: VALID_PRICE, expires_at: expiresAt });

  const authorizedClaim = { ...quote, x402_settlement: { ...quote.x402_settlement, authorized: true } };
  const badAuth = validateQuote(authorizedClaim);
  assert.equal(badAuth.ok, false);
  assert.ok(badAuth.errors.some(e => e.startsWith("x402_settlement.authorized:")));

  const verifiedClaim = { ...quote, x402_settlement: { ...quote.x402_settlement, verified: true } };
  const badVerified = validateQuote(verifiedClaim);
  assert.equal(badVerified.ok, false);
  assert.ok(badVerified.errors.some(e => e.startsWith("x402_settlement.verified:")));
});

test("V7.5.0 isQuoteExpired fails closed (treats as expired) on an invalid nowIso instead of silently reporting fresh", async () => {
  const { request } = await validRequest();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const stillFreshNow = new Date(Date.now() + 60 * 1000).toISOString();
  const { quote } = await buildQuote({ service_request: request, price: VALID_PRICE, expires_at: expiresAt });
  assert.equal(isQuoteExpired(quote, "not-a-valid-timestamp"), true);
  assert.equal(isQuoteExpired(quote, stillFreshNow), false);
});

test("V7.5.0 checkQuotePriceMatchesAdvertisedRoute passes for a matching exact-mode quote and fails closed on divergence", async () => {
  const { descriptor, request } = await validRequest();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const matching = await buildQuote({
    service_request: request,
    price: { price_atomic: descriptor.pricing_route.price_atomic, asset: descriptor.pricing_route.asset, network: descriptor.pricing_route.network, pay_to: descriptor.pricing_route.pay_to },
    expires_at: expiresAt
  });
  assert.deepEqual(checkQuotePriceMatchesAdvertisedRoute(matching.quote, descriptor.pricing_route), { ok: true });

  const divergent = await buildQuote({ service_request: request, price: VALID_PRICE, expires_at: expiresAt });
  // VALID_PRICE has the same asset/network/price as the route fixture in this file,
  // so force a real divergence to prove the check fails closed.
  const wrongAsset = { ...divergent.quote, asset: "NOTUSDC" };
  const result = checkQuotePriceMatchesAdvertisedRoute(wrongAsset, descriptor.pricing_route);
  assert.equal(result.ok, false);
  assert.equal(result.error, "advertised_price_mismatch");
  assert.equal(result.field, "asset");
});

test("V7.5.0 checkQuotePriceMatchesAdvertisedRoute allows an upto-mode quote at or under the ceiling but not over it", async () => {
  const upToRoute = { ...VALID_PRICING_ROUTE, mode: "upto", price_atomic: "5000" };
  const descriptor = await validDescriptor({ pricing_route: upToRoute });
  const request = await buildServiceRequest({
    caller_actor_id: "chatgpt:cairnstone-v7",
    service_descriptor: descriptor,
    chain: "cairnstone-v6-project-memory",
    task: "some task",
    package_id: VALID_PACKAGE_ID
  });
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  const underCeiling = await buildQuote({
    service_request: request.request,
    price: { price_atomic: "1000", asset: "USDC", network: "base-sepolia", pay_to: upToRoute.pay_to },
    expires_at: expiresAt
  });
  assert.deepEqual(checkQuotePriceMatchesAdvertisedRoute(underCeiling.quote, descriptor.pricing_route), { ok: true });

  const overCeiling = await buildQuote({
    service_request: request.request,
    price: { price_atomic: "9999", asset: "USDC", network: "base-sepolia", pay_to: upToRoute.pay_to },
    expires_at: expiresAt
  });
  const result = checkQuotePriceMatchesAdvertisedRoute(overCeiling.quote, descriptor.pricing_route);
  assert.equal(result.ok, false);
  assert.equal(result.field, "price_atomic");
});

// ---------------------------------------------------------------------------
// Second hardening round per chatgpt:cairnstone-v7
// (stone e840964f53f0b7cd66d62b96cf5763a762e367e1eb0c2ef9059a4cb98a9779dc)
// ---------------------------------------------------------------------------

test("V7.5.0 validateServiceDescriptor fails closed if execution_authority/mutation_authority is omitted, null, or non-boolean, not only true", () => {
  const base = {
    schema: PAID_SERVICE_SCHEMA_V1,
    descriptor_id: VALID_PACKAGE_ID,
    service_id: "x",
    profile_id: "repo-debugger",
    profile_version: "0.1.1",
    chain_scope: { chain: "c" },
    compact_result_contract: { max_output_tokens: 100 },
    pricing_route: VALID_PRICING_ROUTE
  };

  const omitted = validateServiceDescriptor({ ...base, execution_authority: false });
  assert.equal(omitted.ok, false);
  assert.ok(omitted.errors.some(e => e.startsWith("mutation_authority:")));

  const nullValue = validateServiceDescriptor({ ...base, execution_authority: null, mutation_authority: false });
  assert.equal(nullValue.ok, false);
  assert.ok(nullValue.errors.some(e => e.startsWith("execution_authority:")));

  const stringValue = validateServiceDescriptor({ ...base, execution_authority: false, mutation_authority: "false" });
  assert.equal(stringValue.ok, false);
  assert.ok(stringValue.errors.some(e => e.startsWith("mutation_authority:")));

  const fullyValid = validateServiceDescriptor({ ...base, execution_authority: false, mutation_authority: false });
  assert.equal(fullyValid.ok, true);
});

test("V7.5.0 validateQuote fails closed if x402_settlement fields are omitted, null, or non-boolean, not only true", async () => {
  const { request } = await validRequest();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const { quote } = await buildQuote({ service_request: request, price: VALID_PRICE, expires_at: expiresAt });

  const omittedField = { ...quote, x402_settlement: { authorized: false, settled: false } }; // verified omitted
  const badOmitted = validateQuote(omittedField);
  assert.equal(badOmitted.ok, false);
  assert.ok(badOmitted.errors.some(e => e.startsWith("x402_settlement.verified:")));

  const nullField = { ...quote, x402_settlement: { ...quote.x402_settlement, verified: null } };
  const badNull = validateQuote(nullField);
  assert.equal(badNull.ok, false);
  assert.ok(badNull.errors.some(e => e.startsWith("x402_settlement.verified:")));

  const stringField = { ...quote, x402_settlement: { ...quote.x402_settlement, settled: "false" } };
  const badString = validateQuote(stringField);
  assert.equal(badString.ok, false);
  assert.ok(badString.errors.some(e => e.startsWith("x402_settlement.settled:")));

  assert.deepEqual(validateQuote(quote), { ok: true, errors: [] });
});

test("V7.5.0 checkQuotePriceMatchesAdvertisedRoute compares pay_to and fails closed on mismatch", async () => {
  const { descriptor, request } = await validRequest();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const { quote } = await buildQuote({
    service_request: request,
    price: { price_atomic: descriptor.pricing_route.price_atomic, asset: descriptor.pricing_route.asset, network: descriptor.pricing_route.network, pay_to: descriptor.pricing_route.pay_to },
    expires_at: expiresAt
  });
  assert.deepEqual(checkQuotePriceMatchesAdvertisedRoute(quote, descriptor.pricing_route), { ok: true });

  const wrongPayTo = { ...quote, pay_to: "0xdeadbeef00000000000000000000000000000000" };
  const result = checkQuotePriceMatchesAdvertisedRoute(wrongPayTo, descriptor.pricing_route);
  assert.equal(result.ok, false);
  assert.equal(result.error, "advertised_price_mismatch");
  assert.equal(result.field, "pay_to");
});

test("V7.5.0 checkQuotePriceMatchesAdvertisedRoute fails closed on an unknown/malformed advertised route instead of letting it fall through", async () => {
  const { descriptor, request } = await validRequest();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const { quote } = await buildQuote({
    service_request: request,
    price: { price_atomic: descriptor.pricing_route.price_atomic, asset: descriptor.pricing_route.asset, network: descriptor.pricing_route.network, pay_to: descriptor.pricing_route.pay_to },
    expires_at: expiresAt
  });

  const malformedRoute = { ...descriptor.pricing_route, mode: "unknown-mode" };
  const result = checkQuotePriceMatchesAdvertisedRoute(quote, malformedRoute);
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_pricing_route");
});

// ---------------------------------------------------------------------------
// V7.5.0 step 2: previewPaidAgentQuoteFromBody (deterministic quote/preview
// MCP tool wrapper). agentBootstrapFromBody is mocked here exactly the way
// src/index.js wires the real one -- these tests exercise the wrapper's own
// logic, not the (already separately tested) bootstrap internals.
// ---------------------------------------------------------------------------

function fixedBootstrapResult(overrides = {}) {
  return {
    ok: true,
    package_id: VALID_PACKAGE_ID,
    authority: {
      chain_head: { stone_hash: "chain-head-fixed" },
      path_heads: [
        { path: "src/paid-agent-catalog.js", stone_hash: "path-a" },
        { path: "docs/ROADMAP_V7.md", stone_hash: "path-b" }
      ]
    },
    ...overrides
  };
}

test("V7.5.0 previewPaidAgentQuoteFromBody produces a full preview using ONLY the bootstrap-sourced package_id/authority", async () => {
  let bootstrapCalls = 0;
  const deps = {
    agentBootstrapFromBody: async (body, env) => {
      bootstrapCalls += 1;
      assert.equal(body.actor_id, "chatgpt:cairnstone-v7");
      assert.equal(body.chain, "cairnstone-v6-project-memory");
      assert.equal(body.include_inbox, false);
      return fixedBootstrapResult();
    }
  };

  const result = await previewPaidAgentQuoteFromBody({
    actor_id: "chatgpt:cairnstone-v7",
    profile_id: "repo-debugger",
    chain: "cairnstone-v6-project-memory",
    task: "Inspect this accepted repo state and return a cited diagnosis",
    pricing_route: VALID_PRICING_ROUTE
  }, {}, deps);

  assert.equal(bootstrapCalls, 1);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.schema, PAID_AGENT_QUOTE_PREVIEW_SCHEMA_V1);
  assert.equal(result.package_id, VALID_PACKAGE_ID);
  assert.equal(result.service_request.package_id, VALID_PACKAGE_ID);
  assert.equal(result.quote.package_id, VALID_PACKAGE_ID);
  assert.equal(result.authority_fingerprint, computeAuthorityFingerprint(fixedBootstrapResult().authority));
  assert.equal(result.pricing_metadata.advertised, true);
  assert.equal(result.pricing_metadata.authoritative, false);
  assert.equal(result.pricing_metadata.x402_policy_evaluated, false);
  assert.equal(result.settlement.authorized, false);
  assert.equal(result.settlement.verified, false);
  assert.equal(result.settlement.settled, false);
  assert.deepEqual(validateServiceDescriptor(result.service_descriptor), { ok: true, errors: [] });
  assert.deepEqual(validateServiceRequest(result.service_request), { ok: true, errors: [] });
  assert.deepEqual(validateQuote(result.quote), { ok: true, errors: [] });
});

test("V7.5.0 previewPaidAgentQuoteFromBody ignores a caller-supplied package_id and never treats it as authority", async () => {
  const deps = { agentBootstrapFromBody: async () => fixedBootstrapResult() };
  const result = await previewPaidAgentQuoteFromBody({
    actor_id: "chatgpt:cairnstone-v7",
    profile_id: "repo-debugger",
    chain: "cairnstone-v6-project-memory",
    task: "some task",
    pricing_route: VALID_PRICING_ROUTE,
    package_id: "sha256:" + "f".repeat(64) // must be ignored entirely
  }, {}, deps);
  assert.equal(result.ok, true);
  assert.equal(result.package_id, VALID_PACKAGE_ID);
  assert.notEqual(result.package_id, "sha256:" + "f".repeat(64));
});

test("V7.5.0 previewPaidAgentQuoteFromBody propagates a bootstrap failure (e.g. context_compile_race) rather than fabricating a package_id", async () => {
  const deps = { agentBootstrapFromBody: async () => ({ ok: false, error: "context_compile_race", chain: "cairnstone-v6-project-memory" }) };
  const result = await previewPaidAgentQuoteFromBody({
    actor_id: "chatgpt:cairnstone-v7",
    profile_id: "repo-debugger",
    chain: "cairnstone-v6-project-memory",
    task: "some task",
    pricing_route: VALID_PRICING_ROUTE
  }, {}, deps);
  assert.equal(result.ok, false);
  assert.equal(result.error, "bootstrap_failed");
  assert.equal(result.detail.error, "context_compile_race");
});

test("V7.5.0 previewPaidAgentQuoteFromBody fails closed without calling deps.agentBootstrapFromBody when the request itself is invalid", async () => {
  let called = false;
  const deps = { agentBootstrapFromBody: async () => { called = true; return fixedBootstrapResult(); } };
  const result = await previewPaidAgentQuoteFromBody({
    actor_id: "not-namespaced",
    profile_id: "repo-debugger",
    chain: "cairnstone-v6-project-memory",
    task: "some task",
    pricing_route: VALID_PRICING_ROUTE
  }, {}, deps);
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_actor_id");
  assert.equal(called, false);
});

test("V7.5.0 previewPaidAgentQuoteFromBody fails closed for an unknown profile_id even with a successful bootstrap", async () => {
  const deps = { agentBootstrapFromBody: async () => fixedBootstrapResult() };
  const result = await previewPaidAgentQuoteFromBody({
    actor_id: "chatgpt:cairnstone-v7",
    profile_id: "not-a-real-profile",
    chain: "cairnstone-v6-project-memory",
    task: "some task",
    pricing_route: VALID_PRICING_ROUTE
  }, {}, deps);
  assert.equal(result.ok, false);
  assert.equal(result.error, "agent_profile_not_found");
});

test("V7.5.0 previewPaidAgentQuoteFromBody fails closed when the requested chain is outside the profile's scope", async () => {
  const deps = { agentBootstrapFromBody: async () => fixedBootstrapResult() };
  const result = await previewPaidAgentQuoteFromBody({
    actor_id: "chatgpt:cairnstone-v7",
    profile_id: "repo-debugger",
    chain: "some-unrelated-chain",
    task: "some task",
    pricing_route: VALID_PRICING_ROUTE
  }, {}, deps);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.startsWith("chain:")));
});

test("V7.5.0 previewPaidAgentQuoteFromBody fails closed when deps.agentBootstrapFromBody is missing", async () => {
  const result = await previewPaidAgentQuoteFromBody({
    actor_id: "chatgpt:cairnstone-v7",
    profile_id: "repo-debugger",
    chain: "cairnstone-v6-project-memory",
    task: "some task",
    pricing_route: VALID_PRICING_ROUTE
  }, {}, {});
  assert.deepEqual(result, { ok: false, error: "preview_dependencies_missing" });
});

test("V7.5.0 previewPaidAgentQuoteFromBody's authority_fingerprint changes when bootstrap-reported authority changes", async () => {
  const depsA = { agentBootstrapFromBody: async () => fixedBootstrapResult() };
  const depsB = {
    agentBootstrapFromBody: async () => fixedBootstrapResult({
      authority: { chain_head: { stone_hash: "chain-head-DIFFERENT" }, path_heads: [] }
    })
  };
  const input = {
    actor_id: "chatgpt:cairnstone-v7",
    profile_id: "repo-debugger",
    chain: "cairnstone-v6-project-memory",
    task: "some task",
    pricing_route: VALID_PRICING_ROUTE
  };
  const a = await previewPaidAgentQuoteFromBody(input, {}, depsA);
  const b = await previewPaidAgentQuoteFromBody(input, {}, depsB);
  assert.notEqual(a.authority_fingerprint, b.authority_fingerprint);
});

test("V7.5.0 computeAuthorityFingerprint is order-independent across path_heads and returns null for malformed input", () => {
  const a = computeAuthorityFingerprint({
    chain_head: { stone_hash: "h1" },
    path_heads: [{ path: "b.js", stone_hash: "2" }, { path: "a.js", stone_hash: "1" }]
  });
  const b = computeAuthorityFingerprint({
    chain_head: { stone_hash: "h1" },
    path_heads: [{ path: "a.js", stone_hash: "1" }, { path: "b.js", stone_hash: "2" }]
  });
  assert.equal(a, b);
  assert.equal(computeAuthorityFingerprint(null), null);
  assert.equal(computeAuthorityFingerprint({ chain_head: {} }), null);
});
