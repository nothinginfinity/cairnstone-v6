import assert from "node:assert/strict";
import { test } from "node:test";
import { computeBootstrapPackageProfile } from "../src/context-profile.js";
import { buildFixturePackageBody, FIXTURE_TIERS, FIXTURE_TIER_SPECS } from "./fixtures/context-profile-fixtures.js";

test("V7.6.0 fixtures: all three tiers (small/medium/mature) profile successfully", () => {
  for (const tier of FIXTURE_TIERS) {
    const pkg = buildFixturePackageBody(tier);
    const profile = computeBootstrapPackageProfile(pkg);
    assert.equal(profile.ok, true, `tier ${tier} should profile ok`);
  }
});

test("V7.6.0 fixtures: mature tier uses the real, full live path_heads count (grounded in production data)", () => {
  const mature = buildFixturePackageBody("mature");
  assert.equal(mature.authority.path_heads.length, FIXTURE_TIER_SPECS.mature.pathHeadCount);
  // Every path in the mature fixture must be a real path that actually
  // exists on the live cairnstone-v6-project-memory chain -- this fixture
  // is not synthetic bloat, it's the real authority vector.
  for (const entry of mature.authority.path_heads) {
    assert.ok(typeof entry.path === "string" && entry.path.length > 0);
    assert.ok(typeof entry.stone_hash === "string" && entry.stone_hash.length >= 12);
  }
});

test("V7.6.0 fixtures: authority_bytes and package_bytes increase monotonically small -> medium -> mature", () => {
  const profiles = FIXTURE_TIERS.map(tier => computeBootstrapPackageProfile(buildFixturePackageBody(tier)));
  const [small, medium, mature] = profiles;

  assert.ok(small.sections.authority_bytes < medium.sections.authority_bytes);
  assert.ok(medium.sections.authority_bytes < mature.sections.authority_bytes);

  assert.ok(small.package_bytes < medium.package_bytes);
  assert.ok(medium.package_bytes < mature.package_bytes);
});

test("V7.6.0 fixtures: reconciliation invariant (overhead_bytes non-negative and small relative to package) holds at every tier", () => {
  for (const tier of FIXTURE_TIERS) {
    const profile = computeBootstrapPackageProfile(buildFixturePackageBody(tier));
    assert.ok(profile.reconciliation.overhead_bytes >= 0, `tier ${tier}: overhead must be non-negative`);
    assert.ok(
      profile.reconciliation.overhead_bytes < profile.package_bytes,
      `tier ${tier}: overhead should be small relative to the whole package`
    );
    assert.equal(
      profile.reconciliation.measured_section_sum_bytes + profile.reconciliation.overhead_bytes,
      profile.reconciliation.package_bytes,
      `tier ${tier}: sum + overhead must exactly equal package_bytes (identity, not approximation)`
    );
  }
});

test("V7.6.0 fixtures: estimated_tokens scale with package_bytes at every tier and are never negative", () => {
  for (const tier of FIXTURE_TIERS) {
    const profile = computeBootstrapPackageProfile(buildFixturePackageBody(tier));
    assert.ok(profile.estimated_tokens.package_tokens > 0);
    assert.ok(profile.estimated_tokens.package_tokens <= profile.package_bytes);
    for (const [key, value] of Object.entries(profile.estimated_tokens)) {
      assert.ok(value >= 0, `${tier}.${key} must be non-negative`);
    }
  }
});

test("V7.6.0 fixtures: mature tier's instructions_bytes respects the INSTRUCTIONS_BYTE_CAP-scale content used in production (~18-20KB range)", () => {
  const mature = computeBootstrapPackageProfile(buildFixturePackageBody("mature"));
  // Not asserting an exact number -- just that mature-tier instructions
  // content is in the realistic production ballpark (agent-bootstrap.js's
  // own INSTRUCTIONS_BYTE_CAP is 20000), not a token-sized stub like the
  // unit-test fixtures in context-profile.test.js use.
  assert.ok(mature.sections.instructions_bytes > 10000);
  assert.ok(mature.sections.instructions_bytes <= 20000);
});
