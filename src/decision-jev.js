import { DECISION_KINDS } from "./decision-plane.js";

const MAX_CANDIDATES = 25;
const MAX_TASK_CHARS = 4000;
const MAX_DESC_CHARS = 200;
export const JEV_TIMEOUT_MS = 3000;
export const JEV_MAX_RESPONSE_BYTES = 4096;
export const JEV_WORKERS_AI_MODEL = "typesafe/jev";

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

function parseBindingChoice(payload) {
  const raw = payload && payload.answers && payload.answers.selected ? payload.answers.selected : null;
  if (!raw || typeof raw !== "object") return { ok: false, error: "malformed_model_output" };
  const choice = typeof raw.choice === "string" ? raw.choice.trim() : "";
  if (!choice) return { ok: false, error: "selected_id_missing" };
  return {
    ok: true,
    selected_id: choice,
    confidence: raw.confidence ?? null,
    probabilities: raw.probabilities && typeof raw.probabilities === "object" ? raw.probabilities : null
  };
}

function abortSignal(timeoutMs) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }
  return undefined;
}

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error("jev_timeout");
      err.name = "TimeoutError";
      reject(err);
    }, timeoutMs);
    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function httpConfigured(env) {
  return Boolean(env && typeof env.JEV_URL === "string" && env.JEV_URL.trim());
}

function bindingConfigured(env) {
  return Boolean(env && env.AI && typeof env.AI.run === "function");
}

export function jevConfigured(env) {
  return httpConfigured(env) || bindingConfigured(env);
}

function compactCandidates(candidates) {
  const compact = [];
  const seen = new Set();
  for (const c of Array.isArray(candidates) ? candidates.slice(0, MAX_CANDIDATES) : []) {
    const id = typeof (c && (c.id || c.candidate_id)) === "string" ? String(c.id || c.candidate_id).trim() : "";
    if (!id) return { ok: false, error: "jev_empty_candidate_id" };
    if (seen.has(id)) return { ok: false, error: "jev_duplicate_candidate_id" };
    seen.add(id);
    const title = c.title || c.name || null;
    const description = typeof c.description === "string" ? c.description.slice(0, MAX_DESC_CHARS) : null;
    compact.push({
      id,
      capability: c.capability || null,
      tool: c.tool || c.tool_name || null,
      title,
      description
    });
  }
  return { ok: true, compact };
}

function criteriaFromCompact(compact) {
  const criteria = {};
  for (const c of compact) {
    criteria[c.id] = String(c.description || c.title || c.tool || c.capability || c.id).slice(0, MAX_DESC_CHARS);
  }
  return criteria;
}

function boundRaw(raw, maxBytes) {
  const text = typeof raw === "string" ? raw : JSON.stringify(raw || {});
  const bytes = typeof TextEncoder !== "undefined" ? new TextEncoder().encode(text).length : text.length;
  if (bytes > maxBytes) return { ok: false, error: "jev_response_too_large", bytes, max_bytes: maxBytes };
  return { ok: true, text, bytes };
}

async function scoreHttp({ env, task, kind, compact, fetchImpl, timeoutMs, maxBytes }) {
  const fetchFn = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (typeof fetchFn !== "function") return { ok: false, error: "jev_fetch_unavailable", transport: "http" };

  const headers = { "content-type": "application/json", accept: "application/json" };
  if (typeof env.JEV_TOKEN === "string" && env.JEV_TOKEN.trim()) {
    headers.authorization = `Bearer ${env.JEV_TOKEN.trim()}`;
  }

  try {
    const response = await fetchFn(env.JEV_URL.trim(), {
      method: "POST",
      headers,
      signal: abortSignal(timeoutMs),
      body: JSON.stringify({
        kind,
        task: String(task || "").slice(0, MAX_TASK_CHARS),
        candidates: compact
      })
    });
    if (!response || response.ok === false) {
      return { ok: false, error: `jev_http_${response && response.status ? response.status : "failed"}`, transport: "http" };
    }
    let raw;
    if (typeof response.text === "function") {
      raw = await response.text();
    } else if (typeof response.json === "function") {
      raw = JSON.stringify(await response.json());
    } else {
      raw = typeof response === "string" ? response : JSON.stringify(response || {});
    }
    const sized = boundRaw(raw, maxBytes);
    if (!sized.ok) return { ...sized, transport: "http" };
    const parsed = parseSelected(sized.text);
    if (!parsed.ok) return { ...parsed, transport: "http" };
    return { ok: true, selected_id: parsed.selected_id, confidence: parsed.confidence, model: "jev", transport: "http" };
  } catch (error) {
    const name = error && error.name;
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, error: "jev_timeout", transport: "http" };
    }
    return { ok: false, error: `jev_error:${String((error && error.message) || error)}`, transport: "http" };
  }
}

async function scoreBinding({ env, task, kind, compact, timeoutMs, maxBytes }) {
  if (!bindingConfigured(env)) return { ok: false, error: "jev_ai_unavailable", transport: "binding" };
  const payload = {
    state: {
      kind,
      task: String(task || "").slice(0, MAX_TASK_CHARS),
      candidates: compact
    },
    questions: {
      selected: {
        type: "choice",
        instructions: `Which candidate best fulfils the task for this ${kind || "decision"} kind? Choose only from the supplied candidate ids.`,
        criteria: criteriaFromCompact(compact)
      }
    }
  };
  try {
    const response = await withTimeout(env.AI.run(JEV_WORKERS_AI_MODEL, payload), timeoutMs);
    const sized = boundRaw(response, maxBytes);
    if (!sized.ok) return { ...sized, transport: "binding" };
    let parsedPayload = response;
    if (typeof response === "string") {
      try {
        parsedPayload = JSON.parse(response);
      } catch {
        return { ok: false, error: "malformed_model_output", transport: "binding" };
      }
    }
    const parsed = parseBindingChoice(parsedPayload);
    if (!parsed.ok) return { ...parsed, transport: "binding" };
    return {
      ok: true,
      selected_id: parsed.selected_id,
      confidence: parsed.confidence,
      probabilities: parsed.probabilities,
      model: "jev",
      transport: "binding"
    };
  } catch (error) {
    const name = error && error.name;
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, error: "jev_timeout", transport: "binding" };
    }
    return { ok: false, error: `jev_ai_error:${String((error && error.message) || error)}`, transport: "binding" };
  }
}

export async function scoreWithJev({
  env,
  task,
  kind,
  candidates,
  fetchImpl,
  timeoutMs = JEV_TIMEOUT_MS,
  maxBytes = JEV_MAX_RESPONSE_BYTES
} = {}) {
  if (!jevConfigured(env)) return { ok: false, error: "jev_not_configured" };

  const packed = compactCandidates(candidates);
  if (!packed.ok) return packed;

  if (httpConfigured(env)) {
    return scoreHttp({ env, task, kind, compact: packed.compact, fetchImpl, timeoutMs, maxBytes });
  }
  return scoreBinding({ env, task, kind, compact: packed.compact, timeoutMs, maxBytes });
}

export const ASK_JEV_TOOL_DEFINITION = Object.freeze({
  name: "ask_jev",
  description:
    "V7.7.10h.5 optional Jev scorer façade. Workers AI typesafe/jev binding when JEV_URL is unset; HTTP JEV_URL remains the override. Same cairnstone-decision-v1 validation as cairnstone_capability_route. Not the default ladder. Unconfigured Jev fails closed. Never executes tools or moves HEADs.",
  inputSchema: {
    type: "object",
    required: ["kind", "candidates"],
    properties: {
      kind: { type: "string", enum: [...DECISION_KINDS] },
      task: { type: "string" },
      candidates: { type: "array", items: { type: "object" } },
      candidate_set_digest: { type: "string" }
    },
    additionalProperties: false
  }
});
