import { sha256Text, stableJson } from "./agent-bootstrap.js";

export const HYDRATE_MAX_CANDIDATES = 25;

async function schemaHashOf(inputSchema) {
  return "sha256:" + (await sha256Text(stableJson(inputSchema || {})));
}

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

export async function hydrateSelectedContract(selected, deps = {}) {
  if (!selected || !selected.id) return { ok: false, error: "selected_required", execution_authority: false };
  const registry = deps.registry || deps.decisionRegistry || [];
  const mcpToolDefinitions = deps.mcpToolDefinitions || [];
  const toolDef = mcpToolDefinitions.find((item) => item && item.name === selected.id) || null;
  if (!toolDef) {
    return { ok: false, error: "contract_not_found", tool_id: selected.id, execution_authority: false };
  }
  const entry = registry.find((item) => item && item.tool_id === selected.id) || null;
  const schema_hash = await schemaHashOf(toolDef.inputSchema);
  const registry_schema_hash = entry ? await schemaHashOf(entry.input_schema) : null;
  if (entry && registry_schema_hash !== schema_hash) {
    return {
      ok: false,
      error: "schema_disagreement",
      tool_id: selected.id,
      schema_hash,
      registry_schema_hash,
      execution_authority: false
    };
  }
  const risk_class = entry ? entry.risk_class : null;
  const authorization = entry ? entry.authorization : null;
  if (!entry || risk_class !== "read" || authorization !== "automatic") {
    return {
      ok: false,
      error: "hydrate_not_automatic_read",
      tool_id: selected.id,
      classification_status: entry ? "classified" : "unclassified",
      risk_class,
      authorization,
      execution_authority: false
    };
  }
  return {
    ok: true,
    execution_authority: false,
    contract: {
      name: toolDef.name,
      description: toolDef.description || null,
      input_schema: toolDef.inputSchema,
      schema_hash,
      registry_schema_hash,
      classification_status: "classified",
      risk_class,
      authorization,
      broker_eligible: entry.available === true,
      schema_source: "canonical_mcpTools"
    }
  };
}
