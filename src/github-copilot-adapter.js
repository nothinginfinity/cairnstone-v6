// V7.7.10d.3 — GitHub Copilot coding-agent adapter (Agent Tasks REST API).
//
// Official surface: POST/GET /agents/repos/{owner}/{repo}/tasks
// Docs: https://docs.github.com/en/rest/agent-tasks/agent-tasks
// Auth: fine-grained PAT / GitHub App user token with Agent Tasks R/W.
// Cancel: no documented cancel endpoint — local cancel + provider_cancel_unsupported.
// Never claims live without token + live evidence. Never logs secrets.

import {
  CODING_AGENT_SECRET_NAMES,
  authorityClosedFields,
  beginLiveJob,
  buildCompiledPrompt,
  endLiveJob,
  extractRepoFromRefs,
  fetchJson,
  isNonEmptyString,
  mapCopilotStateToTaskStatus,
  normalizeFullSha,
  parseOwnerRepo,
  readEnvString,
  resolveMaxConcurrent,
  scrubSecrets
} from "./coding-agent-common.js";

export const GITHUB_COPILOT_PROVIDER = "github-copilot";
export const GITHUB_COPILOT_API_VERSION = "2026-03-10";

export function resolveGitHubCopilotConfig(env = {}) {
  const token = readEnvString(env, CODING_AGENT_SECRET_NAMES.github_copilot_token);
  const allowedRepo = parseOwnerRepo(
    readEnvString(env, CODING_AGENT_SECRET_NAMES.github_copilot_allowed_repo)
  );
  const allowedBranch = readEnvString(env, CODING_AGENT_SECRET_NAMES.github_copilot_allowed_branch) || "main";
  const apiBase = (readEnvString(env, CODING_AGENT_SECRET_NAMES.github_copilot_api_base) || "https://api.github.com")
    .replace(/\/+$/, "");
  return {
    token_configured: Boolean(token),
    token_secret_name: CODING_AGENT_SECRET_NAMES.github_copilot_token,
    token,
    allowed_repo: allowedRepo,
    allowed_branch: allowedBranch,
    api_base: apiBase,
    max_concurrent: resolveMaxConcurrent(env)
  };
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_COPILOT_API_VERSION,
    Authorization: `Bearer ${token}`,
    "User-Agent": "cairnstone-v6-github-copilot-adapter"
  };
}

/**
 * Cheap live evidence probe: list tasks for the allowed repo (auth + entitlement).
 * Does not start a paid coding job.
 */
export async function probeGitHubCopilotHealth(env = {}, {
  fetchImpl = null,
  sleepFn = null
} = {}) {
  const cfg = resolveGitHubCopilotConfig(env);
  const checkedAt = new Date().toISOString();
  if (!cfg.token_configured) {
    return {
      ok: true,
      provider: GITHUB_COPILOT_PROVIDER,
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
      provider: GITHUB_COPILOT_PROVIDER,
      availability: "blocked",
      health: {
        status: "blocked",
        adapter_live: false,
        dry_run: true,
        token_configured: true,
        live_evidence: false,
        blocker: "allowed_repo_not_configured",
        required_secret_name: CODING_AGENT_SECRET_NAMES.github_copilot_allowed_repo,
        checked_at: checkedAt
      },
      ...authorityClosedFields()
    };
  }

  const url = `${cfg.api_base}/agents/repos/${cfg.allowed_repo.owner}/${cfg.allowed_repo.repo}/tasks?per_page=1`;
  const result = await fetchJson(url, {
    method: "GET",
    headers: githubHeaders(cfg.token),
    token: cfg.token,
    fetchImpl,
    sleepFn,
    maxRetries: 1
  });

  if (!result.ok) {
    return {
      ok: true,
      provider: GITHUB_COPILOT_PROVIDER,
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
    provider: GITHUB_COPILOT_PROVIDER,
    availability: "available",
    health: {
      status: "healthy",
      adapter_live: true,
      dry_run: false,
      token_configured: true,
      live_evidence: true,
      allowed_repo: cfg.allowed_repo.full_name,
      allowed_branch: cfg.allowed_branch,
      checked_at: checkedAt
    },
    ...authorityClosedFields()
  };
}

async function verifyImmutableBaseSha({
  cfg,
  owner,
  repo,
  branch,
  immutable_base_sha,
  fetchImpl,
  sleepFn
}) {
  const fullSha = normalizeFullSha(immutable_base_sha);
  if (!fullSha) {
    return { ok: false, error: "immutable_base_sha_required", detail: "40-hex SHA required for live Copilot dispatch" };
  }

  // Resolve branch tip and require exact match (fail closed on stale tip).
  const refUrl = `${cfg.api_base}/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`;
  const refResult = await fetchJson(refUrl, {
    method: "GET",
    headers: githubHeaders(cfg.token),
    token: cfg.token,
    fetchImpl,
    sleepFn,
    maxRetries: 1
  });
  if (!refResult.ok) {
    return {
      ok: false,
      error: refResult.error === "provider_permission_denied"
        ? "provider_permission_denied"
        : "base_ref_lookup_failed",
      detail: refResult.detail || null,
      status: refResult.status || null
    };
  }

  const tipSha = normalizeFullSha(refResult.body?.object?.sha);
  if (!tipSha) {
    return { ok: false, error: "base_ref_sha_missing", detail: "git ref response lacked object.sha" };
  }
  if (tipSha !== fullSha) {
    return {
      ok: false,
      error: "stale_base_sha",
      detail: "allowed branch tip does not match immutable_base_sha",
      expected_sha: fullSha,
      branch_tip_sha: tipSha,
      branch
    };
  }
  return { ok: true, immutable_base_sha: fullSha, branch_tip_sha: tipSha };
}

function resolveDispatchRepo(cfg, task_run, envelope) {
  const refs = [
    ...(Array.isArray(envelope?.attachment_refs) ? envelope.attachment_refs : []),
    ...(Array.isArray(envelope?.object_refs) ? envelope.object_refs : []),
    ...(Array.isArray(task_run?.attachment_refs) ? task_run.attachment_refs : []),
    ...(Array.isArray(task_run?.object_refs) ? task_run.object_refs : [])
  ];
  const fromRefs = extractRepoFromRefs(refs);
  if (!cfg.allowed_repo) {
    return { ok: false, error: "allowed_repo_not_configured" };
  }
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
 * Live dispatch via GitHub Agent Tasks API.
 * Idempotent: if opts.existing_external_task_id is set, poll that task instead of creating.
 */
export async function dispatchGitHubCopilotTask({
  env = {},
  task_run = null,
  envelope = null,
  compiled_pack = null,
  immutable_base_sha = null,
  existing_external_task_id = null,
  create_pull_request = true,
  fetchImpl = null,
  sleepFn = null,
  now = null
} = {}) {
  const createdAt = now || new Date().toISOString();
  const cfg = resolveGitHubCopilotConfig(env);

  if (!cfg.token_configured) {
    return {
      ok: false,
      error: "github_copilot_token_not_configured",
      detail: `Worker secret ${cfg.token_secret_name} required for live Copilot adapter`,
      availability: "stub",
      ...authorityClosedFields()
    };
  }

  const repoResult = resolveDispatchRepo(cfg, task_run, envelope);
  if (!repoResult.ok) {
    return { ...repoResult, ...authorityClosedFields() };
  }
  const { owner, repo, full_name } = repoResult.repo;
  const branch = cfg.allowed_branch;

  const shaCheck = await verifyImmutableBaseSha({
    cfg,
    owner,
    repo,
    branch,
    immutable_base_sha,
    fetchImpl,
    sleepFn
  });
  if (!shaCheck.ok) {
    return { ...shaCheck, ...authorityClosedFields() };
  }

  const gate = beginLiveJob(GITHUB_COPILOT_PROVIDER, { max: cfg.max_concurrent });
  if (!gate.ok) return gate;

  try {
    // Idempotent re-entry: poll existing external task instead of creating a second job.
    if (isNonEmptyString(existing_external_task_id)) {
      const status = await getGitHubCopilotTaskStatus({
        env,
        owner,
        repo,
        task_id: existing_external_task_id,
        fetchImpl,
        sleepFn
      });
      if (!status.ok) {
        return { ...status, ...authorityClosedFields() };
      }
      return {
        ok: true,
        provider: GITHUB_COPILOT_PROVIDER,
        adapter_live: true,
        dry_run: false,
        idempotent_replay: true,
        external_task_id: existing_external_task_id,
        external_identity: status.external_identity,
        provider_state: status.provider_state,
        task_status: status.task_status,
        dispatch_state: status.dispatch_state,
        pr_refs: status.pr_refs,
        artifact_refs: status.artifact_refs,
        result_summary: status.result_summary,
        immutable_base_sha: shaCheck.immutable_base_sha,
        allowed_repo: full_name,
        allowed_branch: branch,
        created_at: createdAt,
        ...authorityClosedFields()
      };
    }

    const prompt = buildCompiledPrompt({
      compiled_pack,
      immutable_base_sha: shaCheck.immutable_base_sha,
      extra_lines: [
        `target_repo=${full_name}`,
        `base_ref=${branch}`,
        `task_run_id=${task_run?.task_run_id || ""}`
      ]
    });

    const url = `${cfg.api_base}/agents/repos/${owner}/${repo}/tasks`;
    const createResult = await fetchJson(url, {
      method: "POST",
      headers: githubHeaders(cfg.token),
      token: cfg.token,
      body: {
        prompt: prompt.slice(0, 60_000),
        base_ref: branch,
        create_pull_request: create_pull_request !== false
      },
      fetchImpl,
      sleepFn,
      maxRetries: 2
    });

    if (!createResult.ok) {
      return {
        ok: false,
        error: createResult.error || "github_copilot_dispatch_failed",
        status: createResult.status || null,
        detail: createResult.detail || null,
        ...authorityClosedFields()
      };
    }

    const task = createResult.body || {};
    const externalTaskId = isNonEmptyString(task.id) ? String(task.id) : null;
    if (!externalTaskId) {
      return {
        ok: false,
        error: "github_copilot_missing_task_id",
        detail: "provider response lacked task id; refuse false running claim",
        ...authorityClosedFields()
      };
    }

    const mapped = mapCopilotStateToTaskStatus(task.state || "queued");
    const prRefs = extractPrRefsFromArtifacts(task.artifacts, full_name);
    const artifactRefs = [
      `github_agent_task:${full_name}:${externalTaskId}`,
      ...(task.html_url ? [`url:${task.html_url}`] : [])
    ];

    return {
      ok: true,
      provider: GITHUB_COPILOT_PROVIDER,
      adapter_live: true,
      dry_run: false,
      idempotent_replay: false,
      external_task_id: externalTaskId,
      external_identity: {
        kind: "github_agent_task",
        owner,
        repo,
        task_id: externalTaskId,
        html_url: task.html_url || null,
        url: task.url || null
      },
      provider_state: task.state || "queued",
      task_status: mapped.task_status,
      dispatch_state: mapped.dispatch_state,
      pr_refs: prRefs,
      artifact_refs: artifactRefs,
      result_summary: `github-copilot live task ${externalTaskId} state=${task.state || "queued"}`,
      immutable_base_sha: shaCheck.immutable_base_sha,
      allowed_repo: full_name,
      allowed_branch: branch,
      created_at: createdAt,
      provider_payload_summary: {
        name: task.name || null,
        session_count: task.session_count ?? null,
        state: task.state || null
      },
      ...authorityClosedFields()
    };
  } finally {
    // Count is for in-flight create attempts; long-running jobs are tracked via Task Run rows.
    endLiveJob(GITHUB_COPILOT_PROVIDER);
  }
}

function extractPrRefsFromArtifacts(artifacts, fullName) {
  const out = [];
  if (!Array.isArray(artifacts)) return out;
  for (const art of artifacts) {
    if (art?.type === "pull" && art?.data?.id != null) {
      out.push(`pr:github.com/${fullName}#${art.data.id}`);
    } else if (art?.type === "branch" && art?.data?.head_ref) {
      out.push(`branch:${art.data.head_ref}`);
    }
  }
  return out;
}

export async function getGitHubCopilotTaskStatus({
  env = {},
  owner = null,
  repo = null,
  task_id,
  fetchImpl = null,
  sleepFn = null
} = {}) {
  const cfg = resolveGitHubCopilotConfig(env);
  if (!cfg.token_configured) {
    return {
      ok: false,
      error: "github_copilot_token_not_configured",
      ...authorityClosedFields()
    };
  }
  if (!isNonEmptyString(task_id)) {
    return { ok: false, error: "task_id_required", ...authorityClosedFields() };
  }

  const o = owner || cfg.allowed_repo?.owner;
  const r = repo || cfg.allowed_repo?.repo;
  if (!o || !r) {
    return { ok: false, error: "repo_required_for_status", ...authorityClosedFields() };
  }

  const url = `${cfg.api_base}/agents/repos/${o}/${r}/tasks/${encodeURIComponent(task_id)}`;
  const result = await fetchJson(url, {
    method: "GET",
    headers: githubHeaders(cfg.token),
    token: cfg.token,
    fetchImpl,
    sleepFn,
    maxRetries: 1
  });
  if (!result.ok) {
    return {
      ok: false,
      error: result.error || "github_copilot_status_failed",
      status: result.status || null,
      detail: result.detail || null,
      ...authorityClosedFields()
    };
  }

  const task = result.body || {};
  if (!isNonEmptyString(task.state)) {
    return {
      ok: false,
      error: "github_copilot_status_unknown",
      detail: "provider response lacked state; refuse false complete/running claim",
      ...authorityClosedFields()
    };
  }

  const mapped = mapCopilotStateToTaskStatus(task.state);
  if (mapped.unknown_state) {
    return {
      ok: false,
      error: "github_copilot_unmapped_state",
      detail: scrubSecrets(String(task.state), [cfg.token]),
      ...authorityClosedFields()
    };
  }

  const fullName = `${o}/${r}`;
  return {
    ok: true,
    provider: GITHUB_COPILOT_PROVIDER,
    adapter_live: true,
    dry_run: false,
    external_task_id: String(task.id || task_id),
    external_identity: {
      kind: "github_agent_task",
      owner: o,
      repo: r,
      task_id: String(task.id || task_id),
      html_url: task.html_url || null,
      url: task.url || null
    },
    provider_state: task.state,
    task_status: mapped.task_status,
    dispatch_state: mapped.dispatch_state,
    terminal: mapped.terminal,
    pr_refs: extractPrRefsFromArtifacts(task.artifacts, fullName),
    artifact_refs: [
      `github_agent_task:${fullName}:${task.id || task_id}`,
      ...(task.html_url ? [`url:${task.html_url}`] : [])
    ],
    result_summary: `github-copilot task ${task.id || task_id} state=${task.state}`,
    failure_reason: mapped.task_status === "failed"
      ? (task.sessions?.[0]?.error?.message || `provider_state:${task.state}`)
      : null,
    ...authorityClosedFields()
  };
}

/**
 * Cancel: GitHub Agent Tasks API has no documented cancel endpoint.
 * Local Task Run cancel still proceeds; provider cancel is unsupported.
 */
export async function cancelGitHubCopilotTask() {
  return {
    ok: true,
    provider: GITHUB_COPILOT_PROVIDER,
    provider_cancel: false,
    provider_cancel_unsupported: true,
    detail: "GitHub Agent Tasks API documents no cancel endpoint; stop session via GitHub UI if needed",
    ...authorityClosedFields()
  };
}
