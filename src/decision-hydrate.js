import { sha256Text, stableJson } from "./agent-bootstrap.js";

export const HYDRATE_MAX_CANDIDATES = 25;

function tokens(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 3);
}

export function scoreVaultCandidate(entry, task) {
  const taskTokens = new Set(tokens(task));
  if (!taskTokens.size) return 0;
  const hay = tokens(`${entry.tool_id || ""} ${entry.description || ""} ${entry.handler || ""}`);
  let hits = 0;
  for (const t of hay) if (taskTokens.has(t)) hits += 1;
  return hits;
}

export function seedAutomaticReadCandidates(registry = [], { task = "", limit = HYDRATE_MAX_CANDIDATES } = {}) {
  const pool = (Array.isArray(registry) ? registry : [])
    .filter((e) => e && e.available !== false && e.risk_class === "read" && e.authorization === "automatic")
    .map((e) => ({
      id: e.tool_id,
      capability: e.handler || e.tool_id,
      tool: e.tool_id,
      title: e.tool_id,
      risk_class: e.risk_class,
      authorization: e.authorization,
      eligible: true,
      _score: scoreVaultCandidate(e, task)
    }));
  const scored = task && tokens(task).length
    ? pool.filter((c) => c._score > 0)
    : [];
  scored.sort((a, b) => b._score - a._score || a.id.localeCompare(b.id));
  return scored.slice(0, limit).map(({ _score, ...c }) => c);
}

export async function hydrateSelectedContract(selected, registry = []) {
  if (!selected || !selected.id) return { ok: false, error: "selected_required" };
  const entry = (Array.isArray(registry) ? registry : []).find((e) => e && e.tool_id === selected.id);
  if (!entry) return { ok: false, error: "contract_not_in_registry", tool_id: selected.id };
  if (entry.risk_class !== "read" || entry.authorization !== "automatic") {
    return {
      ok: false,
      error: "hydrate_not_automatic_read",
      tool_id: selected.id,
      risk_class: entry.risk_class,
      authorization: entry.authorization,
      execution_authority: false
    };
  }
  const schema_hash = "sha256:" + (await sha256Text(stableJson(entry.input_schema || {})));
  return {
    ok: true,
    execution_authority: false,
    contract: {
      name: entry.tool_id,
      description: entry.description || null,
      input_schema: entry.input_schema,
      schema_hash,
      risk_class: entry.risk_class,
      authorization: entry.authorization,
      broker_eligible: true
    }
  };
}
