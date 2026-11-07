// V7.7.10d.3 — Cursor Cloud / Background Agent adapter (Cloud Agents API v1).
//
// Official surface: https://api.cursor.com/v1/agents
// Auth: Cursor user or service-account API key (Basic or Bearer).
// Persist remote agent id + run id; map progress/error/cancel onto Task Run lifecycle.
// Never assumes a Cursor API key or subscription exists. Fail closed when absent.

import {
  CODING_AGENT_SECRET_NAMES,
  authorityClosedFields,
  beginLiveJob,
  buildNativePrompt,
  cursorAgentIdFromTaskRun,
  endLiveJob,
  extractRepoFromRefs,
  fetchJson,
  isNonEmptyString,
  mapCursorRunStatusToTaskStatus,
  normalizeFullSha,
  parseGithubRepoUrl,
  readEnvString,
  resolveMaxConcurrent,
  scrubSecrets
} from "./coding-agent-common.js";

export const CURSOR_CLOUD_PROVIDER = "cursor-cloud";

export function resolveCursorCloudConfig(env = {}) {
  const apiKey = readEnvString(env, CODING_AGENT_SECRET_NAMES.cursor_cloud_api_key);
  const allowedRepo = parseGithubRepoUrl(
    readEnvString(env, CODING_AGENT_SECRET_NAMES.cursor_cloud_allowed_repo_url)
  );
  const allowedStartingRef = readEnvString(
    env,
    CODING_AGENT_SECRET_NAMES.cursor_cloud_allowed_starting_ref
  );
  const apiBase = (readEnvString(env, CODING_AGENT_SECRET_NAMES.cursor_cloud_api_base) || "https://api.cursor.com")
    .replace(/\/+$/, "");
  return {
    token_configured: Boolean(apiKey),
    token_secret_name: CODING_AGENT_SECRET_NAMES.cursor_cloud_api_key,
    api_key: apiKey,
    allowed_repo: allowedRepo,
    allowed_starting_ref: allowedStartingRef,
    api_base: apiBase,
    max_concurrent: resolveMaxConcurrent(env)
  };
}

function cursorAuthHeader(apiKey) {
  // Cloud Agents API accepts Basic (key as username) or Bearer.
  const encoded = typeof btoa === "function"
    ? btoa(`${apiKey}:`)
    : Buffer.from(`${apiKey}:`, "utf8").toString("base64");
  return {
    Authorization: `Basic ${encoded}`,
    "Content-Type": "application/json",
    Accept: "application/json"
  };
}

/**
 * Cheap live evidence probe: GET /v1/me or list agents (auth + entitlement).
 * Does not start a paid cloud agent run.
 */
export async function probeCursorCloudHealth(env = {}, {
  fetchImpl = null,
  sleepFn = null
} = {}) {
  const cfg = resolveCursorCloudConfig(env);
  const checkedAt = new Date().toISOString();
  if (!cfg.token_configured) {
    return {
      ok: true,
      provider: CURSOR_CLOUD_PROVIDER,
      availability: "stub",
      health: {
        status: "stub",
        adapter_live: false,
        dry_run: true,
        token_configured: false,
        live_evidence: false,
        blocker: "missing_secret",
        missing_secret_name: cfg.token_secret_name,
        checked_at: checkedAt
      },
      ...authorityClosedFields()
    };
  }
  if (!cfg.allowed_repo) {
    return {
      ok: true,
      provider: CURSOR_CLOUD_PROVIDER,
      availability: "blocked",
      health: {
        status: "blocked",
        adapter_live: false,
        dry_run: true,
        token_configured: true,
        live_evidence: false,
        blocker: "allowed_repo_not_configured",
        required_secret_name: CODING_AGENT_SECRET_NAMES.cursor_cloud_allowed_repo_url,
        checked_at: checkedAt
      },
      ...authorityClosedFields()
    };
  }

  // Prefer /v1/me when present; fall back to list agents (limit=1).
  const meUrl = `${cfg.api_base}/v1/me`;
  let result = await fetchJson(meUrl, {
    method: "GET",
    headers: cursorAuthHeader(cfg.api_key),
    token: cfg.api_key,
    fetchImpl,
    sleepFn,
    maxRetries: 1
  });
  if (!result.ok && (result.status === 404 || result.error === "provider_http_error")) {
    result = await fetchJson(`${cfg.api_base}/v1/agents?limit=1`, {
      method: "GET",
      headers: cursorAuthHeader(cfg.api_key),
      token: cfg.api_key,
      fetchImpl,
      sleepFn,
      maxRetries: 1
    });
  }

  if (!result.ok) {
    return {
      ok: true,
      provider: CURSOR_CLOUD_PROVIDER,
      availability: "blocked",
      health: {
        status: "blocked",
        adapter_live: false,
        dry_run: true,
        token_configured: true,
        live_evidence: false,
        blocker: result.error || "probe_failed",
        http_status: result.status || null,
        detail: result.detail || null,
        checked_at: checkedAt
      },
      ...authorityClosedFields()
    };
  }

  return {
    ok: true,
    provider: CURSOR_CLOUD_PROVIDER,
    availability: "available",
    health: {
      status: "healthy",
      adapter_live: true,
      dry_run: false,
      token_configured: true,
      live_evidence: true,
      allowed_repo_url: cfg.allowed_repo.url,
      allowed_starting_ref: cfg.allowed_starting_ref || null,
      checked_at: checkedAt
    },
    ...authorityClosedFields()
  };
}

function resolveDispatchRepo(cfg, task_run, envelope) {
  if (!cfg.allowed_repo) {
    return { ok: false, error: "allowed_repo_not_configured" };
  }
  const refs = [
    ...(Array.isArray(envelope?.attachment_refs) ? envelope.attachment_refs : []),
    ...(Array.isArray(envelope?.object_refs) ? envelope.object_refs : []),
    ...(Array.isArray(task_run?.attachment_refs) ? task_run.attachment_refs : []),
    ...(Array.isArray(task_run?.object_refs) ? task_run.object_refs : [])
  ];
  const fromRefs = extractRepoFromRefs(refs);
  if (fromRefs && fromRefs.full_name.toLowerCase() !== cfg.allowed_repo.full_name.toLowerCase()) {
    return {
      ok: false,
      error: "repo_not_in_allowlist",
      detail: `requested=${fromRefs.full_name} allowed=${cfg.allowed_repo.full_name}`
    };
  }
  return { ok: true, repo: cfg.allowed_repo };
}

/**
 * Live dispatch via Cursor Cloud Agents API v1.
 * Uses client-supplied agentId derived from task_run_id for idempotency.
 */
export async function dispatchCursorCloudAgent({
  env = {},
  task_run = null,
  envelope = null,
  immutable_base_sha = null,
  existing_external_agent_id = null,
  existing_external_run_id = null,
  auto_create_pr = true,
  fetchImpl = null,
  sleepFn = null,
  now = null
} = {}) {
  const createdAt = now || new Date().toISOString();
  const cfg = resolveCursorCloudConfig(env);

  if (!cfg.token_configured) {
    return {
      ok: false,
      error: "cursor_cloud_api_key_not_configured",
      detail: `Worker secret ${cfg.token_secret_name} required for live Cursor Cloud adapter`,
      availability: "stub",
      ...authorityClosedFields()
    };
  }

  const fullSha = normalizeFullSha(immutable_base_sha);
  if (!fullSha) {
    return {
      ok: false,
      error: "immutable_base_sha_required",
      detail: "40-hex SHA required for live Cursor Cloud dispatch (startingRef pin)",
      ...authorityClosedFields()
    };
  }

  if (cfg.allowed_starting_ref) {
    const allowed = cfg.allowed_starting_ref;
    const allowedSha = normalizeFullSha(allowed);
    if (allowedSha && allowedSha !== fullSha) {
      return {
        ok: false,
        error: "stale_base_sha",
        detail: "immutable_base_sha does not match CURSOR_CLOUD_ALLOWED_STARTING_REF pin",
        expected_sha: allowedSha,
        provided_sha: fullSha,
        ...authorityClosedFields()
      };
    }
    // If allowed_starting_ref is a branch name, startingRef for the API is still the exact SHA;
    // branch allowlist is informational / operator policy — SHA is the hard pin.
  }

  const repoResult = resolveDispatchRepo(cfg, task_run, envelope);
  if (!repoResult.ok) {
    return { ...repoResult, ...authorityClosedFields() };
  }

  const gate = beginLiveJob(CURSOR_CLOUD_PROVIDER, { max: cfg.max_concurrent });
  if (!gate.ok) return gate;

  try {
    if (isNonEmptyString(existing_external_agent_id) && isNonEmptyString(existing_external_run_id)) {
      const status = await getCursorCloudRunStatus({
        env,
        agent_id: existing_external_agent_id,
        run_id: existing_external_run_id,
        fetchImpl,
        sleepFn
      });
      if (!status.ok) return { ...status, ...authorityClosedFields() };
      return {
        ok: true,
        provider: CURSOR_CLOUD_PROVIDER,
        adapter_live: true,
        dry_run: false,
        idempotent_replay: true,
        external_agent_id: existing_external_agent_id,
        external_run_id: existing_external_run_id,
        external_identity: status.external_identity,
        provider_state: status.provider_state,
        task_status: status.task_status,
        dispatch_state: status.dispatch_state,
        pr_refs: status.pr_refs,
        artifact_refs: status.artifact_refs,
        result_summary: status.result_summary,
        immutable_base_sha: fullSha,
        allowed_repo_url: repoResult.repo.url,
        created_at: createdAt,
        ...authorityClosedFields()
      };
    }

    const agentId = cursorAgentIdFromTaskRun(task_run?.task_run_id);
    const promptText = buildNativePrompt({
      task_run,
      envelope,
      immutable_base_sha: fullSha,
      extra_lines: [
        `repo_url=${repoResult.repo.url}`,
        `startingRef=${fullSha}`,
        "Prefer CairnStone MCP refs over re-fetching unbounded context."
      ]
    });

    const body = {
      agentId,
      prompt: { text: promptText.slice(0, 60_000) },
      name: `CairnStone ${task_run?.task_run_id || "task"}`.slice(0, 100),
      repos: [
        {
          url: repoResult.repo.url,
          startingRef: fullSha
        }
      ],
      autoCreatePR: auto_create_pr !== false,
      workOnCurrentBranch: false
    };

    const createResult = await fetchJson(`${cfg.api_base}/v1/agents`, {
      method: "POST",
      headers: cursorAuthHeader(cfg.api_key),
      token: cfg.api_key,
      body,
      fetchImpl,
      sleepFn,
      maxRetries: 2
    });

    // Idempotent: same agentId already exists → load it instead of launching twice.
    if (!createResult.ok && createResult.status === 409) {
      const existing = await fetchJson(`${cfg.api_base}/v1/agents/${encodeURIComponent(agentId)}`, {
        method: "GET",
        headers: cursorAuthHeader(cfg.api_key),
        token: cfg.api_key,
        fetchImpl,
        sleepFn,
        maxRetries: 1
      });
      if (!existing.ok) {
        return {
          ok: false,
          error: "cursor_cloud_idempotent_lookup_failed",
          detail: existing.detail || null,
          status: existing.status || 409,
          ...authorityClosedFields()
        };
      }
      const agent = existing.body || {};
      const runId = agent.latestRunId || null;
      if (!isNonEmptyString(agent.id) || !isNonEmptyString(runId)) {
        return {
          ok: false,
          error: "cursor_cloud_idempotent_missing_identity",
          detail: "409 conflict but agent/run identity incomplete; refuse false running claim",
          ...authorityClosedFields()
        };
      }
      const status = await getCursorCloudRunStatus({
        env,
        agent_id: agent.id,
        run_id: runId,
        fetchImpl,
        sleepFn
      });
      if (!status.ok) return { ...status, idempotent_replay: true, ...authorityClosedFields() };
      return {
        ok: true,
        provider: CURSOR_CLOUD_PROVIDER,
        adapter_live: true,
        dry_run: false,
        idempotent_replay: true,
        external_agent_id: agent.id,
        external_run_id: runId,
        external_identity: status.external_identity,
        provider_state: status.provider_state,
        task_status: status.task_status,
        dispatch_state: status.dispatch_state,
        pr_refs: status.pr_refs,
        artifact_refs: status.artifact_refs,
        result_summary: status.result_summary,
        immutable_base_sha: fullSha,
        allowed_repo_url: repoResult.repo.url,
        created_at: createdAt,
        ...authorityClosedFields()
      };
    }

    if (!createResult.ok) {
      return {
        ok: false,
        error: createResult.error || "cursor_cloud_dispatch_failed",
        status: createResult.status || null,
        detail: createResult.detail || null,
        ...authorityClosedFields()
      };
    }

    const agent = createResult.body?.agent || {};
    const run = createResult.body?.run || {};
    const externalAgentId = isNonEmptyString(agent.id) ? String(agent.id) : null;
    const externalRunId = isNonEmptyString(run.id) ? String(run.id) : null;
    if (!externalAgentId || !externalRunId) {
      return {
        ok: false,
        error: "cursor_cloud_missing_run_identity",
        detail: "provider response lacked agent.id or run.id; refuse false running claim",
        ...authorityClosedFields()
      };
    }

    const mapped = mapCursorRunStatusToTaskStatus(run.status || "CREATING");
    const artifactRefs = [
      `cursor_agent:${externalAgentId}`,
      `cursor_run:${externalRunId}`,
      ...(agent.url ? [`url:${agent.url}`] : [])
    ];

    return {
      ok: true,
      provider: CURSOR_CLOUD_PROVIDER,
      adapter_live: true,
      dry_run: false,
      idempotent_replay: false,
      external_agent_id: externalAgentId,
      external_run_id: externalRunId,
      external_identity: {
        kind: "cursor_cloud_agent_run",
        agent_id: externalAgentId,
        run_id: externalRunId,
        url: agent.url || null
      },
      provider_state: run.status || "CREATING",
      task_status: mapped.task_status,
      dispatch_state: mapped.dispatch_state,
      pr_refs: [],
      artifact_refs: artifactRefs,
      result_summary: `cursor-cloud live agent ${externalAgentId} run ${externalRunId} status=${run.status || "CREATING"}`,
      immutable_base_sha: fullSha,
      allowed_repo_url: repoResult.repo.url,
      created_at: createdAt,
      provider_payload_summary: {
        agent_status: agent.status || null,
        run_status: run.status || null
      },
      ...authorityClosedFields()
    };
  } finally {
    endLiveJob(CURSOR_CLOUD_PROVIDER);
  }
}

export async function getCursorCloudRunStatus({
  env = {},
  agent_id,
  run_id,
  fetchImpl = null,
  sleepFn = null
} = {}) {
  const cfg = resolveCursorCloudConfig(env);
  if (!cfg.token_configured) {
    return {
      ok: false,
      error: "cursor_cloud_api_key_not_configured",
      ...authorityClosedFields()
    };
  }
  if (!isNonEmptyString(agent_id) || !isNonEmptyString(run_id)) {
    return { ok: false, error: "agent_id_and_run_id_required", ...authorityClosedFields() };
  }

  const url = `${cfg.api_base}/v1/agents/${encodeURIComponent(agent_id)}/runs/${encodeURIComponent(run_id)}`;
  const result = await fetchJson(url, {
    method: "GET",
    headers: cursorAuthHeader(cfg.api_key),
    token: cfg.api_key,
    fetchImpl,
    sleepFn,
    maxRetries: 1
  });
  if (!result.ok) {
    return {
      ok: false,
      error: result.error || "cursor_cloud_status_failed",
      status: result.status || null,
      detail: result.detail || null,
      ...authorityClosedFields()
    };
  }

  const run = result.body || {};
  if (!isNonEmptyString(run.status)) {
    return {
      ok: false,
      error: "cursor_cloud_status_unknown",
      detail: "provider response lacked status; refuse false complete/running claim",
      ...authorityClosedFields()
    };
  }

  const mapped = mapCursorRunStatusToTaskStatus(run.status);
  if (mapped.unknown_state) {
    return {
      ok: false,
      error: "cursor_cloud_unmapped_status",
      detail: scrubSecrets(String(run.status), [cfg.api_key]),
      ...authorityClosedFields()
    };
  }

  const prRefs = [];
  const branches = run.git?.branches || [];
  for (const b of branches) {
    if (b?.branch) prRefs.push(`branch:${b.branch}`);
    if (b?.prUrl) prRefs.push(`pr_url:${b.prUrl}`);
  }

  return {
    ok: true,
    provider: CURSOR_CLOUD_PROVIDER,
    adapter_live: true,
    dry_run: false,
    external_agent_id: String(run.agentId || agent_id),
    external_run_id: String(run.id || run_id),
    external_identity: {
      kind: "cursor_cloud_agent_run",
      agent_id: String(run.agentId || agent_id),
      run_id: String(run.id || run_id),
      url: null
    },
    provider_state: run.status,
    task_status: mapped.task_status,
    dispatch_state: mapped.dispatch_state,
    terminal: mapped.terminal,
    pr_refs: prRefs,
    artifact_refs: [
      `cursor_agent:${run.agentId || agent_id}`,
      `cursor_run:${run.id || run_id}`
    ],
    result_summary: `cursor-cloud run ${run.id || run_id} status=${run.status}`,
    failure_reason: mapped.task_status === "failed"
      ? (run.error?.message || `provider_status:${run.status}`)
      : null,
    ...authorityClosedFields()
  };
}

export async function cancelCursorCloudRun({
  env = {},
  agent_id,
  run_id,
  fetchImpl = null,
  sleepFn = null
} = {}) {
  const cfg = resolveCursorCloudConfig(env);
  if (!cfg.token_configured) {
    return {
      ok: false,
      error: "cursor_cloud_api_key_not_configured",
      provider_cancel: false,
      ...authorityClosedFields()
    };
  }
  if (!isNonEmptyString(agent_id) || !isNonEmptyString(run_id)) {
    return {
      ok: false,
      error: "agent_id_and_run_id_required",
      provider_cancel: false,
      ...authorityClosedFields()
    };
  }

  const url = `${cfg.api_base}/v1/agents/${encodeURIComponent(agent_id)}/runs/${encodeURIComponent(run_id)}/cancel`;
  const result = await fetchJson(url, {
    method: "POST",
    headers: cursorAuthHeader(cfg.api_key),
    token: cfg.api_key,
    body: {},
    fetchImpl,
    sleepFn,
    maxRetries: 1
  });

  if (!result.ok) {
    // 409 run_not_cancellable → treat as non-fatal if already terminal
    if (result.status === 409) {
      return {
        ok: true,
        provider: CURSOR_CLOUD_PROVIDER,
        provider_cancel: false,
        already_terminal_or_not_cancellable: true,
        detail: result.detail || "run_not_cancellable",
        ...authorityClosedFields()
      };
    }
    return {
      ok: false,
      error: result.error || "cursor_cloud_cancel_failed",
      status: result.status || null,
      detail: result.detail || null,
      provider_cancel: false,
      ...authorityClosedFields()
    };
  }

  return {
    ok: true,
    provider: CURSOR_CLOUD_PROVIDER,
    provider_cancel: true,
    external_agent_id: agent_id,
    external_run_id: run_id,
    ...authorityClosedFields()
  };
}
