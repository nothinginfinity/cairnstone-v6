const MAX_CANDIDATES = 25;
const MAX_TASK_CHARS = 4000;

function parseSelected(payload) {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload || {});
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

export function jevConfigured(env) {
  return Boolean(env && typeof env.JEV_URL === "string" && env.JEV_URL.trim());
}

export async function scoreWithJev({ env, task, kind, candidates, fetchImpl } = {}) {
  if (!jevConfigured(env)) return { ok: false, error: "jev_not_configured" };
  const fetchFn = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (typeof fetchFn !== "function") return { ok: false, error: "jev_fetch_unavailable" };

  const compact = (Array.isArray(candidates) ? candidates : []).slice(0, MAX_CANDIDATES).map((c) => ({
    id: c.id || c.candidate_id,
    capability: c.capability || null,
    tool: c.tool || c.tool_name || null,
    title: c.title || c.name || null
  }));

  const headers = { "content-type": "application/json", accept: "application/json" };
  if (typeof env.JEV_TOKEN === "string" && env.JEV_TOKEN.trim()) {
    headers.authorization = `Bearer ${env.JEV_TOKEN.trim()}`;
  }

  try {
    const response = await fetchFn(env.JEV_URL.trim(), {
      method: "POST",
      headers,
      body: JSON.stringify({
        kind,
        task: String(task || "").slice(0, MAX_TASK_CHARS),
        candidates: compact
      })
    });
    if (!response || response.ok === false) {
      return { ok: false, error: `jev_http_${response && response.status ? response.status : "failed"}` };
    }
    const payload = typeof response.json === "function" ? await response.json() : response;
    const parsed = parseSelected(payload);
    if (!parsed.ok) return parsed;
    return { ok: true, selected_id: parsed.selected_id, confidence: parsed.confidence, model: "jev" };
  } catch (error) {
    return { ok: false, error: `jev_error:${String(error && error.message || error)}` };
  }
}

export const ASK_JEV_TOOL_DEFINITION = Object.freeze({
  name: "ask_jev",
  description: "V7.7.10h.2 optional Jev scorer façade. Same cairnstone-decision-v1 validation as cairnstone_capability_route. Not the default ladder. Unconfigured Jev fails closed. Never executes tools or moves HEADs.",
  inputSchema: {
    type: "object",
    required: ["kind", "candidates"],
    properties: {
      kind: { type: "string" },
      task: { type: "string" },
      candidates: { type: "array", items: { type: "object" } },
      candidate_set_digest: { type: "string" }
    },
    additionalProperties: false
  }
});
