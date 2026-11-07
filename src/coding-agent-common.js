// V7.7.10d.3 — Shared helpers for gated coding-agent adapters (Copilot / Cursor).
//
// Secrets resolve ONLY from Worker env bindings (never tool input).
// Never logs secret values. Never mints privileges, auto-merges, or deploys.
// Live launch requires human_commit (enforced upstream) + token + scope pins.

export const CODING_AGENT_SECRET_NAMES = Object.freeze({
  github_copilot_token: "GITHUB_COPILOT_AGENT_TOKEN",
  github_copilot_allowed_repo: "GITHUB_COPILOT_ALLOWED_REPO",
  github_copilot_allowed_branch: "GITHUB_COPILOT_ALLOWED_BRANCH",
  github_copilot_api_base: "GITHUB_COPILOT_API_BASE",
  cursor_cloud_api_key: "CURSOR_CLOUD_API_KEY",
  cursor_cloud_allowed_repo_url: "CURSOR_CLOUD_ALLOWED_REPO_URL",
  cursor_cloud_allowed_starting_ref: "CURSOR_CLOUD_ALLOWED_STARTING_REF",
  cursor_cloud_api_base: "CURSOR_CLOUD_API_BASE",
  max_concurrent: "CODING_AGENT_MAX_CONCURRENT"
});

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const SHORT_SHA_RE = /^[0-9a-f]{7,40}$/i;
const OWNER_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SECRET_FRAGMENT_RE = /(Bearer\s+)[^\s"']+|("?(?:authorization|token|api[_-]?key|secret)"?\s*[:=]\s*")[^"]+/gi;

/** In-isolate concurrency counters (best-effort; not cross-isolate durable). */
const ACTIVE_LIVE_JOBS = new Map();

export function authorityClosedFields(extra = {}) {
  return {
    accepted_state_authority: false,
    chain_heads_mutated: false,
    path_heads_mutated: false,
    grants_no_capability: true,
    ...extra
  };
}

export function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function readEnvString(env, name) {
  if (!env || !isNonEmptyString(name)) return null;
  const value = env[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function scrubSecrets(text, secrets = []) {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (!isNonEmptyString(secret)) continue;
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "g"), "[REDACTED]");
  }
  out = out.replace(SECRET_FRAGMENT_RE, (_, prefix, quoted) => {
    if (quoted) return `${quoted}[REDACTED]`;
    return `${prefix}[REDACTED]`;
  });
  return out;
}

export function normalizeFullSha(value) {
  if (!isNonEmptyString(value)) return null;
  const sha = String(value).trim().toLowerCase();
  return FULL_SHA_RE.test(sha) ? sha : null;
}

export function normalizeAnySha(value) {
  if (!isNonEmptyString(value)) return null;
  const sha = String(value).trim().toLowerCase();
  return SHORT_SHA_RE.test(sha) ? sha : null;
}

export function parseOwnerRepo(value) {
  if (!isNonEmptyString(value)) return null;
  let text = String(value).trim();
  text = text.replace(/^https?:\/\/github\.com\//i, "");
  text = text.replace(/\.git$/i, "");
  text = text.replace(/^repo:/i, "");
  text = text.split("@")[0].split("#")[0].replace(/\/+$/, "");
  if (!OWNER_REPO_RE.test(text)) return null;
  const [owner, repo] = text.split("/");
  return { owner, repo, full_name: `${owner}/${repo}` };
}

export function parseGithubRepoUrl(value) {
  const parsed = parseOwnerRepo(value);
  if (!parsed) return null;
  return {
    ...parsed,
    url: `https://github.com/${parsed.full_name}`
  };
}

export function extractRepoFromRefs(refs = []) {
  for (const ref of refs) {
    const s = String(ref || "");
    const m = s.match(/\brepo:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/i)
      || s.match(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i);
    if (m) return parseOwnerRepo(m[1]);
  }
  return null;
}

export function extractShaFromRefs(refs = []) {
  for (const ref of refs) {
    const s = String(ref || "");
    const m = s.match(/@([0-9a-f]{40})\b/i)
      || s.match(/\brepo_sha:([0-9a-f]{40})\b/i)
      || s.match(/@([0-9a-f]{7,39})\b/i);
    if (m) return normalizeAnySha(m[1]);
  }
  return null;
}

export function resolveMaxConcurrent(env) {
  const raw = readEnvString(env, CODING_AGENT_SECRET_NAMES.max_concurrent);
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(Math.floor(n), 64);
}

export function concurrencyGateKey(provider) {
  return `coding-agent:${provider}`;
}

export function beginLiveJob(provider, { max = null } = {}) {
  const key = concurrencyGateKey(provider);
  const current = ACTIVE_LIVE_JOBS.get(key) || 0;
  if (max != null && current >= max) {
    return {
      ok: false,
      error: "coding_agent_concurrency_limit",
      detail: `active=${current} max=${max}`,
      ...authorityClosedFields()
    };
  }
  ACTIVE_LIVE_JOBS.set(key, current + 1);
  return { ok: true, active: current + 1, max };
}

export function endLiveJob(provider) {
  const key = concurrencyGateKey(provider);
  const current = ACTIVE_LIVE_JOBS.get(key) || 0;
  ACTIVE_LIVE_JOBS.set(key, Math.max(0, current - 1));
}

/** Test-only reset. */
export function resetLiveJobCounters() {
  ACTIVE_LIVE_JOBS.clear();
}

export function sleep(ms, { sleepFn = null } = {}) {
  if (typeof sleepFn === "function") return sleepFn(ms);
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Bounded HTTP with retries for 429/5xx. Never throws secrets in errors.
 */
export async function fetchJson(url, {
  method = "GET",
  headers = {},
  body = null,
  token = null,
  fetchImpl = null,
  maxRetries = 2,
  retryDelayMs = 25,
  sleepFn = null,
  timeoutMs = 15000
} = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== "function") {
    return { ok: false, error: "fetch_unavailable", status: 0 };
  }

  const finalHeaders = { ...headers };
  if (token && !finalHeaders.Authorization && !finalHeaders.authorization) {
    finalHeaders.Authorization = `Bearer ${token}`;
  }
  if (body != null && !finalHeaders["Content-Type"] && !finalHeaders["content-type"]) {
    finalHeaders["Content-Type"] = "application/json";
  }

  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response;
    try {
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = controller
        ? setTimeout(() => controller.abort(), timeoutMs)
        : null;
      response = await fetchFn(url, {
        method,
        headers: finalHeaders,
        body: body == null ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
        signal: controller?.signal
      });
      if (timer) clearTimeout(timer);
    } catch (error) {
      lastError = {
        ok: false,
        error: "http_transport_error",
        detail: scrubSecrets(String(error?.message || error), [token]),
        attempt
      };
      if (attempt < maxRetries) {
        await sleep(retryDelayMs * (attempt + 1), { sleepFn });
        continue;
      }
      return lastError;
    }

    const status = response.status;
    let parsed = null;
    let text = "";
    try {
      text = await response.text();
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    const retryable = status === 429 || status >= 500;
    if (retryable && attempt < maxRetries) {
      await sleep(retryDelayMs * (attempt + 1), { sleepFn });
      continue;
    }

    if (status === 401 || status === 403) {
      return {
        ok: false,
        error: "provider_permission_denied",
        status,
        detail: scrubSecrets(text.slice(0, 500), [token]),
        body: typeof parsed === "object" ? scrubObjectSecrets(parsed, [token]) : null
      };
    }

    if (status < 200 || status >= 300) {
      return {
        ok: false,
        error: "provider_http_error",
        status,
        detail: scrubSecrets(text.slice(0, 500), [token]),
        body: typeof parsed === "object" ? scrubObjectSecrets(parsed, [token]) : null
      };
    }

    return {
      ok: true,
      status,
      body: parsed,
      raw_text_len: text.length
    };
  }

  return lastError || { ok: false, error: "http_retries_exhausted" };
}

function scrubObjectSecrets(value, secrets, depth = 0) {
  if (depth > 6 || value == null) return value;
  if (typeof value === "string") return scrubSecrets(value, secrets);
  if (Array.isArray(value)) return value.map(v => scrubObjectSecrets(v, secrets, depth + 1));
  if (typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (/token|secret|authorization|api[_-]?key/i.test(k) && typeof v === "string") {
      out[k] = "[REDACTED]";
    } else {
      out[k] = scrubObjectSecrets(v, secrets, depth + 1);
    }
  }
  return out;
}

export function mapCopilotStateToTaskStatus(state) {
  const s = String(state || "").toLowerCase();
  switch (s) {
    case "queued":
      return { task_status: "queued", dispatch_state: "dispatched", terminal: false };
    case "in_progress":
    case "waiting_for_user":
    case "idle":
      // idle/waiting are still active provider sessions — never invent completed
      return { task_status: "running", dispatch_state: "running", terminal: false };
    case "completed":
      return { task_status: "completed", dispatch_state: "completed", terminal: true };
    case "failed":
    case "timed_out":
      return { task_status: "failed", dispatch_state: "failed", terminal: true };
    case "cancelled":
      return { task_status: "cancelled", dispatch_state: "cancelled", terminal: true };
    default:
      return { task_status: "queued", dispatch_state: "dispatched", terminal: false, unknown_state: true };
  }
}

export function mapCursorRunStatusToTaskStatus(status) {
  const s = String(status || "").toUpperCase();
  switch (s) {
    case "CREATING":
      return { task_status: "queued", dispatch_state: "dispatched", terminal: false };
    case "RUNNING":
      return { task_status: "running", dispatch_state: "running", terminal: false };
    case "FINISHED":
      return { task_status: "completed", dispatch_state: "completed", terminal: true };
    case "ERROR":
    case "FAILED":
      return { task_status: "failed", dispatch_state: "failed", terminal: true };
    case "CANCELLED":
    case "CANCELED":
      return { task_status: "cancelled", dispatch_state: "cancelled", terminal: true };
    default:
      return { task_status: "queued", dispatch_state: "dispatched", terminal: false, unknown_state: true };
  }
}

/**
 * Deterministic bc- id for Cursor idempotent create (uuid-like from task_run_id).
 */
export function cursorAgentIdFromTaskRun(taskRunId) {
  const raw = String(taskRunId || "tr:unknown");
  let h1 = 2166136261;
  let h2 = 2166136261 ^ 0x9e3779b9;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 16777619);
    h2 ^= c + i;
    h2 = Math.imul(h2, 16777619);
  }
  const a = (h1 >>> 0).toString(16).padStart(8, "0");
  const b = (h2 >>> 0).toString(16).padStart(8, "0");
  const c = ((h1 ^ h2) >>> 0).toString(16).padStart(8, "0");
  const d = ((h1 + h2) >>> 0).toString(16).padStart(8, "0");
  return `bc-${a}-${b.slice(0, 4)}-${c.slice(0, 4)}-${d.slice(0, 4)}-${a}${b}`.slice(0, 47);
}

export function buildNativePrompt({ task_run, envelope, immutable_base_sha, extra_lines = [] } = {}) {
  const lines = [
    "CairnStone-native task envelope (resolve refs via authorized CairnStone MCP when available).",
    `task_run_id=${task_run?.task_run_id || envelope?.task_run_id || ""}`,
    `intent=${task_run?.requested_intent || envelope?.intent || ""}`,
    `note=${String(task_run?.note || envelope?.note || "").slice(0, 1500)}`,
    `attachment_refs=${JSON.stringify(envelope?.attachment_refs || task_run?.attachment_refs || [])}`,
    `object_refs=${JSON.stringify(envelope?.object_refs || task_run?.object_refs || [])}`,
    `access_grant_ids=${JSON.stringify(envelope?.access_grant_ids || [])}`,
    `immutable_base_sha=${immutable_base_sha || ""}`,
    "CONSTRAINTS: do not merge, do not deploy, do not move CairnStone HEADs, do not treat PR as accepted state.",
    ...extra_lines
  ];
  return lines.join("\n");
}

export function buildCompiledPrompt({ compiled_pack, immutable_base_sha, extra_lines = [] } = {}) {
  const body = compiled_pack?.body || "";
  const lines = [
    "CairnStone compiled_context pack (bounded; provenance-preserving).",
    `receipt_digest=${compiled_pack?.receipt_digest || ""}`,
    `immutable_base_sha=${immutable_base_sha || compiled_pack?.immutable_base_sha || ""}`,
    `provenance_refs=${JSON.stringify(compiled_pack?.provenance_refs || [])}`,
    "CONSTRAINTS: do not merge, do not deploy, do not move CairnStone HEADs, do not treat PR as accepted state.",
    "---",
    body,
    ...extra_lines
  ];
  return lines.join("\n");
}
