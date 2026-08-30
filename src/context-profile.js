// V7.6.0 -- Exact context-cost profiler
//
// Implements the accepted V7.6.0 slice of docs/ROADMAP_V7.md (stone
// ce335ec467b1a5aacc0be9f020460e163e4762b23faba2baabdf997873ef4085,
// commit 75f123e4d14b06d935ebebe86b6c720c44bb854a) and
// project-memory/v76-context-efficiency-optimization-plan.md.
//
// Hard invariants:
// - pure functions only: no I/O, no D1/R2/env access, no LLM calls, no
//   accepted-state mutation. Callers (e.g. agent-bootstrap.js, index.js)
//   own fetching the package body / live MCP tool definitions and pass
//   them in.
// - identical inputs must produce identical byte accounting (no
//   timestamps, no randomness, no object-key-order dependence beyond
//   JSON.stringify's own deterministic behavior for a given input shape).
// - tool-schema measurement must be computed from whatever exact tool
//   definition array the caller passes (e.g. the live `mcpTools()` result
//   from src/index.js) -- this module never hand-maintains or guesses at
//   schemas itself.
// - token counts are always clearly labeled ESTIMATES derived from a
//   documented, conservative heuristic, never presented as provider-exact
//   unless they came from real provider usage telemetry the caller
//   supplies separately (e.g. cairnstone_model_route's actual
//   input_tokens/output_tokens).

export const CONTEXT_PROFILE_SCHEMA = "cairnstone-context-profile-v1";

// Conservative, documented token estimator: ~4 UTF-8 bytes per token for
// mixed English-prose + JSON payloads. This is a heuristic, not a real
// tokenizer -- callers must not treat it as authoritative. It exists so
// context-cost figures are directionally comparable across sections and
// across time without requiring a live provider round-trip to measure.
const DEFAULT_BYTES_PER_TOKEN_ESTIMATE = 4;

const PACKAGE_SECTION_KEYS = [
  "authority",
  "coordination",
  "skills",
  "memory",
  "capabilities",
  "policy",
  "runtime",
  "limits"
];

/**
 * UTF-8 byte length of a value's JSON serialization. Returns 0 for
 * undefined/unserializable input rather than throwing, so a missing
 * optional section degrades to a zero-cost line item instead of failing
 * the whole profile.
 */
function jsonBytes(value) {
  if (value === undefined) return 0;
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return 0;
  }
  if (serialized === undefined) return 0;
  return new TextEncoder().encode(serialized).length;
}

function estimateTokens(bytes, bytesPerToken) {
  const divisor = Number.isFinite(bytesPerToken) && bytesPerToken > 0
    ? bytesPerToken
    : DEFAULT_BYTES_PER_TOKEN_ESTIMATE;
  return Math.ceil(bytes / divisor);
}

/**
 * Measure a compiled cairnstone_agent_bootstrap packageBody by section.
 *
 * `instructionsBytes` is accepted separately (rather than re-measuring
 * packageBody.instructions) so callers can pass the exact same
 * instructions-content byte count agent-bootstrap.js's own
 * enforceSizeDiscipline() already computes, keeping the two figures
 * reconcilable instead of two independently-rounded measurements of the
 * same string.
 */
export function computeBootstrapPackageProfile(packageBody, options = {}) {
  if (!packageBody || typeof packageBody !== "object") {
    return { ok: false, error: "invalid_package_body" };
  }

  const bytesPerToken = options.bytesPerTokenEstimate;
  const sectionBytes = {};
  for (const key of PACKAGE_SECTION_KEYS) {
    sectionBytes[`${key}_bytes`] = jsonBytes(packageBody[key]);
  }

  // schema/actor/request are top-level scalars/small objects outside the
  // named sections above, but they're still real package bytes -- without
  // this, packageBytes (the whole object) would exceed the tracked section
  // sum and "overhead_bytes" would go negative, which is a measurement bug,
  // not a real discrepancy to report.
  sectionBytes.metadata_bytes = jsonBytes({
    schema: packageBody.schema,
    actor: packageBody.actor,
    request: packageBody.request
  });

  const instructionsBytes = Number.isFinite(options.instructionsBytes)
    ? options.instructionsBytes
    : jsonBytes(packageBody.instructions);
  sectionBytes.instructions_bytes = instructionsBytes;

  const measuredSumBytes = Object.values(sectionBytes).reduce((a, b) => a + b, 0);
  const packageBytes = Number.isFinite(options.packageBytes)
    ? options.packageBytes
    : jsonBytes(packageBody);

  // Sections are measured independently (each JSON.stringify'd as a bare
  // value), so the combined package will always be somewhat larger than
  // the sum of those bare-value serializations -- the combined form adds
  // one set of top-level key labels ("authority":, "memory":, ...), commas,
  // and wrapping braces that no single section's own serialization
  // includes. That gap is expected structural overhead, not drift; report
  // it explicitly rather than silently ignoring the mismatch (acceptance:
  // "reconcile within defined encoding overhead").
  const overheadBytes = packageBytes - measuredSumBytes;

  const estimatedTokens = {};
  for (const [key, bytes] of Object.entries(sectionBytes)) {
    estimatedTokens[key.replace(/_bytes$/, "_tokens")] = estimateTokens(bytes, bytesPerToken);
  }
  estimatedTokens.package_tokens = estimateTokens(packageBytes, bytesPerToken);

  return {
    ok: true,
    schema: CONTEXT_PROFILE_SCHEMA,
    package_bytes: packageBytes,
    sections: sectionBytes,
    reconciliation: {
      measured_section_sum_bytes: measuredSumBytes,
      package_bytes: packageBytes,
      overhead_bytes: overheadBytes
    },
    estimated_tokens: estimatedTokens,
    estimator: {
      name: "bytes_per_token_heuristic",
      bytes_per_token: Number.isFinite(bytesPerToken) && bytesPerToken > 0
        ? bytesPerToken
        : DEFAULT_BYTES_PER_TOKEN_ESTIMATE,
      authoritative: false,
      note: "Conservative heuristic (UTF-8 bytes / bytes_per_token, rounded up). Not a real tokenizer; use actual provider input_tokens/output_tokens when available for authoritative counts."
    }
  };
}

/**
 * Measure the exact live MCP tool-definition array a server advertises
 * (e.g. the return value of src/index.js's mcpTools()). Never hand-maintain
 * a parallel list here -- callers must pass the real definitions.
 */
export function computeMcpSchemaProfile(mcpToolDefinitions, options = {}) {
  if (!Array.isArray(mcpToolDefinitions)) {
    return { ok: false, error: "invalid_tool_definitions" };
  }

  const bytesPerToken = options.bytesPerTokenEstimate;
  const perTool = mcpToolDefinitions.map(tool => {
    const bytes = jsonBytes(tool);
    return {
      name: tool && typeof tool.name === "string" ? tool.name : null,
      schema_bytes: bytes,
      estimated_schema_tokens: estimateTokens(bytes, bytesPerToken)
    };
  });

  const totalSchemaBytes = perTool.reduce((sum, item) => sum + item.schema_bytes, 0);

  return {
    ok: true,
    schema: CONTEXT_PROFILE_SCHEMA,
    tool_count: mcpToolDefinitions.length,
    total_schema_bytes: totalSchemaBytes,
    estimated_total_schema_tokens: estimateTokens(totalSchemaBytes, bytesPerToken),
    per_tool: perTool,
    estimator: {
      name: "bytes_per_token_heuristic",
      bytes_per_token: Number.isFinite(bytesPerToken) && bytesPerToken > 0
        ? bytesPerToken
        : DEFAULT_BYTES_PER_TOKEN_ESTIMATE,
      authoritative: false
    }
  };
}

/**
 * Combine a bootstrap package profile and (optionally) an MCP schema
 * profile into one total-startup-footprint figure, optionally expressed
 * as a percentage of a caller-declared context window.
 *
 * Both inputs are optional so this can profile "just bootstrap" or
 * "just tool schemas" as well as the combined figure -- the caller decides
 * what it has measured.
 */
export function computeCombinedStartupProfile({ bootstrapProfile = null, mcpSchemaProfile = null, maxContextTokens = null } = {}) {
  const totalBytes =
    (bootstrapProfile && bootstrapProfile.ok ? bootstrapProfile.package_bytes : 0) +
    (mcpSchemaProfile && mcpSchemaProfile.ok ? mcpSchemaProfile.total_schema_bytes : 0);

  const totalEstimatedTokens =
    (bootstrapProfile && bootstrapProfile.ok ? bootstrapProfile.estimated_tokens.package_tokens : 0) +
    (mcpSchemaProfile && mcpSchemaProfile.ok ? mcpSchemaProfile.estimated_total_schema_tokens : 0);

  const result = {
    ok: true,
    schema: CONTEXT_PROFILE_SCHEMA,
    total_bytes: totalBytes,
    total_estimated_tokens: totalEstimatedTokens,
    includes_bootstrap: !!(bootstrapProfile && bootstrapProfile.ok),
    includes_mcp_schema: !!(mcpSchemaProfile && mcpSchemaProfile.ok)
  };

  if (Number.isFinite(maxContextTokens) && maxContextTokens > 0) {
    result.context_window_tokens = maxContextTokens;
    result.context_window_pct = Number(((totalEstimatedTokens / maxContextTokens) * 100).toFixed(2));
  }

  return result;
}
