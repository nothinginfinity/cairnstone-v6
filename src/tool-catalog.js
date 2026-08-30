import { sha256Text, stableJson } from "./agent-bootstrap.js";
import { DEFAULT_TOOL_BROKER_REGISTRY } from "./model-router.js";

// ---------------------------------------------------------------------------
// V7.6.2a: CairnStone Tool Vault -- discovery/hydration primitives
// ---------------------------------------------------------------------------
//
// Decision (stone 3383c36b93aeb8b5f2a6fb03261d7290bc39bcb84b8950da3de276bf32fa1e5f,
// AC1 message msg:53b7a134-e1eb-4e86-b62f-84d518ae8c58): separate discoverability
// from execution-policy coverage.
//
// - cairnstone_tool_search searches the COMPLETE canonical mcpTools() catalog,
//   including currently unclassified tools. Discovery grants no authority.
// - cairnstone_get_tool_contract hydrates the exact canonical mcpTools() schema
//   for any catalog tool. Broker policy is an overlay from
//   DEFAULT_TOOL_BROKER_REGISTRY, never a second hand-maintained registry.
// - For an unclassified tool: classification_status:"unclassified",
//   risk_class:null, authorization:null, broker_eligible:false. Never
//   fabricate/default a risk class; never hide the tool from discovery.
// - For a classified tool: join mcpTools() schema + broker metadata; fail
//   closed on any schema disagreement between the live tool definition and
//   the registered broker entry -- classification_status becomes
//   "schema_disagreement" (risk_class/authorization null, broker_eligible
//   false) while the real canonical schema is still returned, since
//   discovery itself grants no authority and must never be hidden.
// - V7.3 cairnstone_tool_policy_preview / cairnstone_tool_execute are
//   unchanged: they resolve only explicit DEFAULT_TOOL_BROKER_REGISTRY
//   entries, so unclassified or schema-disagreeing tools remain
//   denied/non-executable there regardless of what this module reports.
//
// Both tools take deps.mcpToolDefinitions (the exact live mcpTools() array,
// passed by the caller in index.js exactly like agentBootstrapFromBody's
// mcpToolDefinitions wiring) rather than importing mcpTools() directly, to
// avoid a circular import between index.js and this module. deps.registry
// optionally overrides DEFAULT_TOOL_BROKER_REGISTRY for tests.

export const TOOL_SEARCH_SCHEMA = "cairnstone-tool-search-v1";
export const TOOL_CONTRACT_SCHEMA = "cairnstone-tool-contract-v1";

const CLASSIFICATION_STATUSES = Object.freeze(["classified", "unclassified", "schema_disagreement"]);
const RISK_CLASSES = Object.freeze(["read", "mutation", "execution", "prohibited"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value));
}

function normalizeCatalog(deps) {
  return Array.isArray(deps.mcpToolDefinitions) ? deps.mcpToolDefinitions : [];
}

function normalizeRegistry(deps) {
  return Array.isArray(deps.registry) ? deps.registry : DEFAULT_TOOL_BROKER_REGISTRY;
}

async function schemaHashOf(inputSchema) {
  return "sha256:" + (await sha256Text(stableJson(inputSchema || {})));
}

// Deterministically joins one live mcpTools() definition against the broker
// registry overlay. Never fabricates risk_class/authorization; fails closed
// (treats as non-authoritative) on any schema disagreement rather than
// trusting stale/mismatched registry metadata.
async function classifyTool(toolDef, registry) {
  const canonicalSchemaHash = await schemaHashOf(toolDef.inputSchema);
  const entry = registry.find(item => item.tool_id === toolDef.name) || null;

  if (!entry) {
    return {
      classification_status: "unclassified",
      risk_class: null,
      authorization: null,
      broker_eligible: false,
      schema_hash: canonicalSchemaHash,
      registry_schema_hash: null,
      connector: null,
      handler: null
    };
  }

  const registrySchemaHash = await schemaHashOf(entry.input_schema);
  if (registrySchemaHash !== canonicalSchemaHash) {
    return {
      classification_status: "schema_disagreement",
      risk_class: null,
      authorization: null,
      broker_eligible: false,
      schema_hash: canonicalSchemaHash,
      registry_schema_hash: registrySchemaHash,
      connector: entry.connector || null,
      handler: entry.handler || null
    };
  }

  return {
    classification_status: "classified",
    risk_class: entry.risk_class,
    authorization: entry.authorization,
    broker_eligible: entry.available === true,
    schema_hash: canonicalSchemaHash,
    registry_schema_hash: registrySchemaHash,
    connector: entry.connector || null,
    handler: entry.handler || null
  };
}

export async function toolSearchFromBody(body, _env, deps = {}) {
  if (body !== undefined && body !== null && !isObject(body)) {
    return { ok: false, error: "invalid_tool_search_request" };
  }
  const catalog = normalizeCatalog(deps);
  if (!catalog.length) return { ok: false, error: "tool_catalog_unavailable" };
  const registry = normalizeRegistry(deps);

  const rawQuery = typeof body?.query === "string" ? body.query.trim() : "";
  const terms = rawQuery ? rawQuery.toLowerCase().split(/\s+/).filter(Boolean) : [];

  const riskClassFilter = typeof body?.risk_class === "string" && body.risk_class.trim() ? body.risk_class.trim() : null;
  if (riskClassFilter && !RISK_CLASSES.includes(riskClassFilter)) {
    return { ok: false, error: "invalid_risk_class", allowed: [...RISK_CLASSES] };
  }

  const statusFilter = typeof body?.classification_status === "string" && body.classification_status.trim()
    ? body.classification_status.trim()
    : null;
  if (statusFilter && !CLASSIFICATION_STATUSES.includes(statusFilter)) {
    return { ok: false, error: "invalid_classification_status", allowed: [...CLASSIFICATION_STATUSES] };
  }

  const limitRaw = Number(body?.limit);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.trunc(limitRaw))) : 50;

  const matches = [];
  for (const toolDef of catalog) {
    if (!toolDef || typeof toolDef.name !== "string") continue;
    if (terms.length) {
      const haystack = `${toolDef.name} ${toolDef.description || ""}`.toLowerCase();
      if (!terms.some(term => haystack.includes(term))) continue;
    }
    const classification = await classifyTool(toolDef, registry);
    if (riskClassFilter && classification.risk_class !== riskClassFilter) continue;
    if (statusFilter && classification.classification_status !== statusFilter) continue;
    matches.push({
      name: toolDef.name,
      description: toolDef.description || "",
      classification_status: classification.classification_status,
      risk_class: classification.risk_class,
      authorization: classification.authorization,
      broker_eligible: classification.broker_eligible
    });
  }

  return {
    ok: true,
    schema: TOOL_SEARCH_SCHEMA,
    query: rawQuery || null,
    filters: { risk_class: riskClassFilter, classification_status: statusFilter },
    catalog_total: catalog.length,
    total: matches.length,
    truncated: matches.length > limit,
    tools: matches.slice(0, limit),
    authority: "discovery_only",
    policy: {
      grants_execution_authority: false,
      grants_broker_authority: false,
      schema_source: "canonical_mcpTools",
      broker_source: "DEFAULT_TOOL_BROKER_REGISTRY_overlay"
    }
  };
}

export const TOOL_SEARCH_TOOL_DEFINITION = {
  name: "cairnstone_tool_search",
  description: "V7.6.2a Tool Vault discovery: searches the COMPLETE canonical mcpTools() catalog, including tools not yet classified in the broker registry. Discovery grants no execution or broker authority. Each match reports classification_status ('classified' | 'unclassified' | 'schema_disagreement'); unclassified or schema-disagreeing tools report risk_class:null, authorization:null, broker_eligible:false rather than a fabricated default, and are never hidden from results. Returns compact metadata only (name, description, classification) -- use cairnstone_get_tool_contract to hydrate the exact input schema and full classification for one selected tool.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Keyword(s) matched against tool name and description, case-insensitive, any-term match. Omit to list the full catalog subject to other filters." },
      risk_class: { type: "string", enum: [...RISK_CLASSES], description: "Only meaningful for classified tools; unclassified/disagreeing tools have risk_class:null and are excluded by this filter." },
      classification_status: { type: "string", enum: [...CLASSIFICATION_STATUSES] },
      limit: { type: "number", minimum: 1, maximum: 200 }
    },
    additionalProperties: false
  }
};

export async function toolContractFromBody(body, _env, deps = {}) {
  if (!isObject(body)) return { ok: false, error: "invalid_tool_contract_request" };
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "";
  if (!name) return { ok: false, error: "missing_tool_name" };

  const catalog = normalizeCatalog(deps);
  if (!catalog.length) return { ok: false, error: "tool_catalog_unavailable" };
  const registry = normalizeRegistry(deps);

  const toolDef = catalog.find(item => item && item.name === name) || null;
  if (!toolDef) return { ok: false, error: "tool_not_found", name };

  const classification = await classifyTool(toolDef, registry);

  return {
    ok: true,
    schema: TOOL_CONTRACT_SCHEMA,
    name: toolDef.name,
    description: toolDef.description || "",
    input_schema: cloneJson(toolDef.inputSchema || { type: "object" }),
    classification_status: classification.classification_status,
    risk_class: classification.risk_class,
    authorization: classification.authorization,
    broker_eligible: classification.broker_eligible,
    schema_hash: classification.schema_hash,
    registry_schema_hash: classification.registry_schema_hash,
    connector: classification.connector,
    handler: classification.handler,
    authority: "discovery_only",
    policy: {
      grants_execution_authority: false,
      grants_broker_authority: false,
      schema_source: "canonical_mcpTools",
      broker_source: "DEFAULT_TOOL_BROKER_REGISTRY_overlay"
    }
  };
}

export const TOOL_CONTRACT_TOOL_DEFINITION = {
  name: "cairnstone_get_tool_contract",
  description: "V7.6.2a Tool Vault hydration: returns the exact canonical mcpTools() contract (name, description, inputSchema) for one tool in the full MCP catalog, joined with its broker classification as a metadata overlay from DEFAULT_TOOL_BROKER_REGISTRY -- broker policy is never a second hand-maintained registry, only ever an overlay on the live tool source. Fails closed on any disagreement between the live tool schema and the registered broker entry: classification_status becomes 'schema_disagreement' (risk_class/authorization null, broker_eligible false) while the real canonical schema is still returned, since discovery grants no authority and must never be hidden. Unclassified tools return the same honest nulls. schema_hash is recomputed deterministically from the canonical hydrated inputSchema on every call, not cached.",
  inputSchema: {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string", description: "Exact tool name from the canonical mcpTools() catalog, e.g. 'cairnstone_resume_chain'." }
    },
    additionalProperties: false
  }
};
