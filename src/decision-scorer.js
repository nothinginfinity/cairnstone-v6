import {
  decide,
  digestCandidateSet,
  DECISION_SCHEMA,
  DECISION_KINDS
} from "./decision-plane.js";
import { scoreWithJev } from "./decision-jev.js";
import { seedAutomaticReadCandidates, hydrateSelectedContract } from "./decision-hydrate.js";

export const DEFAULT_SCORER_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MODEL_ALLOWLIST = new Set([DEFAULT_SCORER_MODEL]);
const MAX_TASK_CHARS = 4000;
const MAX_CANDIDATES = 25;

export const CAPABILITY_ROUTE_TOOL_DEFINITION = Object.freeze({
  name: "cairnstone_capability_route",
  description: "V7.7.10h.3: route or hydrate a bounded Tool Vault decision. Unique winners skip the model. mode=hydrate seeds automatic-read candidates from the broker when none are supplied and attaches schema_hash. Never executes tools or moves HEADs.",
  inputSchema: {
    type: "object",
    required: ["kind"],
    properties: {
      kind: { type: "string", enum: ["tool_route", "snippet_rank", "retain", "expand", "model_route", "executor_route", "escalate", "next_action"] },
      task: { type: "string" },
      candidates: { type: "array", items: { type: "object" } },
      mode: { type: "string", enum: ["auto", "deterministic", "model", "jev", "hydrate"] },
      model: { type: "string" },
      candidate_set_digest: { type: "string" }
    },
    additionalProperties: false
  }
});

const SYSTEM_PROMPT = [
  "You are the CairnStone decision-plane scorer.",
  "You may select only one candidate id from the supplied list.",
  "Never invent an id. Never execute a tool. Never grant authority.",
  "Return JSON only: {\"selected_id\":\"exact-id\",\"confidence\":0.0}."
].join(" ");

function modelText(output) {
  const text = output && (
    output.response
    || (typeof output.result === "string" ? output.result : output.result && output.result.response)
    || output.output_text
    || (output.choices && output.choices[0] && output.choices[0].message && output.choices[0].message.content)
  );
  return typeof text === "string" ? text.trim() : "";
}

export function parseScorerResponse(output) {
  const raw = modelText(output);
  if (!raw) return { ok: false, error: "empty_model_output" };
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, error: "malformed_model_output" };
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!parsed || typeof parsed.selected_id !== "string" || !parsed.selected_id.trim()) {
      return { ok: false, error: "selected_id_missing" };
    }
    return { ok: true, selected_id: parsed.selected_id.trim(), confidence: parsed.confidence ?? null };
  } catch {
    return { ok: false, error: "malformed_model_output" };
  }
}

export async function scoreWithWorkersAi({ env, task, kind, candidates, model = DEFAULT_SCORER_MODEL } = {}) {
  if (!MODEL_ALLOWLIST.has(model)) {
    return { ok: false, error: "model_not_allowed", model };
  }
  if (!env || !env.AI || typeof env.AI.run !== "function") {
    return { ok: false, error: "ai_binding_missing" };
  }
  const compact = (Array.isArray(candidates) ? candidates : []).slice(0, MAX_CANDIDATES).map((c) => ({
    id: c.id || c.candidate_id,
    capability: c.capability || null,
    tool: c.tool || c.tool_name || null,
    title: c.title || c.name || null
  }));
  try {
    const output = await env.AI.run(model, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `kind=${kind}\ntask=${String(task || "").slice(0, MAX_TASK_CHARS)}\ncandidates=${JSON.stringify(compact)}`
        }
      ],
      max_tokens: 200,
      temperature: 0.05
    });
    const parsed = parseScorerResponse(output);
    if (!parsed.ok) return parsed;
    return { ok: true, selected_id: parsed.selected_id, confidence: parsed.confidence, model };
  } catch (error) {
    return { ok: false, error: `model_error:${String(error && error.message || error)}` };
  }
}

export async function routeDecision({
  kind,
  task = "",
  candidates = [],
  mode = "auto",
  model = DEFAULT_SCORER_MODEL,
  candidate_set_digest = null,
  env = null,
  scoreJev = null
} = {}) {
  const baseline = await decide({ kind, task, candidates, candidate_set_digest });
  if (baseline.ok && baseline.policy_outcome === "deterministic_winner") {
    return { ...baseline, mode: mode || "auto", scorer_attempted: false };
  }
  if (!baseline.ok && baseline.policy_outcome !== "ambiguous_no_winner") {
    return { ...baseline, mode: mode || "auto", scorer_attempted: false };
  }

  const resolvedMode = ["auto", "deterministic", "model", "jev"].includes(mode) ? mode : "auto";
  if (resolvedMode === "deterministic") {
    return { ...baseline, mode: resolvedMode, scorer_attempted: false };
  }

  const useJev = resolvedMode === "jev";
  const scored = useJev
    ? await (typeof scoreJev === "function" ? scoreJev({ env, task, kind, candidates }) : scoreWithJev({ env, task, kind, candidates }))
    : await scoreWithWorkersAi({ env, task, kind, candidates, model });
  const scorerSource = useJev ? "jev" : "workers_ai";
  if (!scored.ok) {
    return {
      ...baseline,
      mode: resolvedMode,
      scorer_attempted: true,
      scorer_fallback: scored.error,
      receipt: {
        ...baseline.receipt,
        scorer_source: scorerSource,
        fallback_reason: scored.error,
        policy_outcome: "ambiguous_no_winner"
      }
    };
  }

  const validated = await decide({
    kind,
    task,
    candidates,
    selected_id: scored.selected_id,
    scorer_source: scorerSource,
    confidence: scored.confidence,
    candidate_set_digest: candidate_set_digest || await digestCandidateSet(
      Array.isArray(candidates) ? candidates.filter((c) => c && c.eligible !== false) : []
    )
  });
  return {
    ...validated,
    mode: resolvedMode,
    scorer_attempted: true,
    scorer_model: scored.model || model
  };
}

export async function routeDecisionFromBody(body = {}, env = null) {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "body_required", schema: DECISION_SCHEMA };
  }
  const registry = env && Array.isArray(env.decisionRegistry) ? env.decisionRegistry : [];
  const mcpToolDefinitions = env && Array.isArray(env.mcpToolDefinitions) ? env.mcpToolDefinitions : [];
  let candidates = Array.isArray(body.candidates) ? body.candidates : [];
  if (body.mode === "hydrate") {
    if (body.kind !== "tool_route") {
      return { ok: false, error: "hydrate_requires_tool_route", schema: DECISION_SCHEMA, execution_authority: false };
    }
    if (!candidates.length) {
      candidates = seedAutomaticReadCandidates(registry, { task: body.task || "" });
    }
  } else if (!candidates.length) {
    return { ok: false, error: "candidates_required", schema: DECISION_SCHEMA, execution_authority: false };
  }
  const routeMode = body.mode === "hydrate" ? "deterministic" : (body.mode || "auto");
  const routed = await routeDecision({
    kind: body.kind,
    task: body.task || "",
    candidates,
    mode: routeMode,
    model: body.model || DEFAULT_SCORER_MODEL,
    candidate_set_digest: body.candidate_set_digest || null,
    env
  });
  if (body.mode !== "hydrate") return routed;
  if (!routed || !routed.ok || !routed.selected) {
    return { ...routed, hydrated: { ok: false, error: "no_selected_contract" }, execution_authority: false };
  }
  const hydrated = await hydrateSelectedContract(routed.selected, { registry, mcpToolDefinitions });
  if (!hydrated.ok) {
    return {
      ...routed,
      ok: false,
      selected: null,
      hydrated,
      error: hydrated.error,
      execution_authority: false
    };
  }
  return { ...routed, hydrated, execution_authority: false };
}
