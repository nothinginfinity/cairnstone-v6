// V7.7.7e — Reconstructable execution environment + disposable sandbox attachment.
//
// Provider-neutral environment manifests, sandbox attachment records, and
// immutable sandbox-local execution receipts. Operational / reconstructability
// plane only — NEVER participates in chain_heads / path_heads / accepted project
// truth. Sandbox-local execution is NOT production/infrastructure mutation
// authority. Reuses existing workspace_capability + workspace_members (no second
// ticket). Never stores raw provider credentials / API keys / bearers / secrets.

import { sha256Text, stableJson } from "./agent-bootstrap.js";
import { authorizeWorkspaceRequest, getWorkspace } from "./workspace.js";
import { getCodeSession, normalizeReceiptRefs, scrubSecretsDeep } from "./code-session.js";

export const ENVIRONMENT_SANDBOX_SLICE = "V7.7.7e";
export const ENVIRONMENT_MANIFEST_SCHEMA = "cairnstone-environment-manifest-v1";
export const SANDBOX_ATTACHMENT_SCHEMA = "cairnstone-code-session-sandbox-attachment-v1";
export const EXECUTION_RECEIPT_SCHEMA = "cairnstone-execution-receipt-v1";

export const SANDBOX_EXECUTION_CLASSES = Object.freeze([
  "none",
  "local_build_test",
  "local_install_build_test"
]);

const SANDBOX_EXECUTION_CLASS_SET = new Set(SANDBOX_EXECUTION_CLASSES);

export const COMMAND_CLASSES = Object.freeze([
  "install",
  "build",
  "test",
  "lint",
  "other_local"
]);

const COMMAND_CLASS_SET = new Set(COMMAND_CLASSES);

/** Allowed command_class values keyed by sandbox_execution_class. */
export const ALLOWED_COMMANDS_BY_EXECUTION_CLASS = Object.freeze({
  none: Object.freeze([]),
  local_build_test: Object.freeze(["build", "test", "lint", "other_local"]),
  local_install_build_test: Object.freeze(["install", "build", "test", "lint", "other_local"])
});

export const SANDBOX_ATTACHMENT_STATUSES = Object.freeze([
  "attached",
  "hydrating",
  "ready",
  "executing",
  "detached",
  "failed",
  "destroyed"
]);

const SANDBOX_ATTACHMENT_STATUS_SET = new Set(SANDBOX_ATTACHMENT_STATUSES);

export const EXECUTION_RECEIPT_STATUSES = Object.freeze([
  "pass",
  "fail",
  "error",
  "timeout",
  "cancelled"
]);

const EXECUTION_RECEIPT_STATUS_SET = new Set(EXECUTION_RECEIPT_STATUSES);

export const ENVIRONMENT_SANDBOX_BROKER_TOOL_IDS = Object.freeze({
  environment_manifest_create: "cairnstone_environment_manifest_create",
  environment_manifest_get: "cairnstone_environment_manifest_get",
  attach_environment: "cairnstone_code_session_attach_environment",
  sandbox_attach: "cairnstone_code_session_sandbox_attach",
  sandbox_detach: "cairnstone_code_session_sandbox_detach",
  sandbox_get: "cairnstone_code_session_sandbox_get",
  execution_receipt_create: "cairnstone_execution_receipt_create",
  execution_receipt_get: "cairnstone_execution_receipt_get",
  execution_receipt_list: "cairnstone_execution_receipt_list"
});

export const ENVIRONMENT_SANDBOX_MUTATION_TOOL_IDS = Object.freeze([
  ENVIRONMENT_SANDBOX_BROKER_TOOL_IDS.environment_manifest_create,
  ENVIRONMENT_SANDBOX_BROKER_TOOL_IDS.attach_environment,
  ENVIRONMENT_SANDBOX_BROKER_TOOL_IDS.sandbox_attach,
  ENVIRONMENT_SANDBOX_BROKER_TOOL_IDS.sandbox_detach,
  ENVIRONMENT_SANDBOX_BROKER_TOOL_IDS.execution_receipt_create
]);

export const ENVIRONMENT_SANDBOX_READ_TOOL_IDS = Object.freeze([
  ENVIRONMENT_SANDBOX_BROKER_TOOL_IDS.environment_manifest_get,
  ENVIRONMENT_SANDBOX_BROKER_TOOL_IDS.sandbox_get,
  ENVIRONMENT_SANDBOX_BROKER_TOOL_IDS.execution_receipt_get,
  ENVIRONMENT_SANDBOX_BROKER_TOOL_IDS.execution_receipt_list
]);

const ACTOR_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,127}$/i;
const WORKSPACE_ID_RE = /^ws:[a-z0-9][a-z0-9._-]{0,127}$/i;
const CODE_SESSION_ID_RE = /^cs:[a-z0-9][a-z0-9._-]{0,127}$/i;
const ENV_MANIFEST_ID_RE = /^envmanifest:[a-z0-9][a-z0-9._-]{0,127}$/i;
const SANDBOX_ATTACHMENT_ID_RE = /^sandbox:[a-z0-9][a-z0-9._-]{0,127}$/i;
const EXEC_RECEIPT_ID_RE = /^execrcpt:[a-z0-9][a-z0-9._-]{0,127}$/i;
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SECRET_KEY_RE = /^(workspace_capability|mailbox_capability|capability|api[_-]?key|secret|bearer|token|password|credential|private[_-]?key|authorization)$/i;
const SECRET_NAME_RE = /(api[_-]?key|secret|bearer|\btoken\b|password|credential|private[_-]?key|authorization|workspace_capability|mailbox_capability)/i;
const ENV_BINDING_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const REDACTED_SECRET = "[REDACTED]";

const MAX_SOURCE_REPOS = 32;
const MAX_BASE_COMMITS = 32;
const MAX_RUNTIME_ENTRIES = 64;
const MAX_LOCKFILES = 64;
const MAX_COMMANDS = 32;
const MAX_ENV_BINDINGS = 128;
const MAX_ARTIFACT_CACHE_REFS = 100;
const MAX_ARTIFACT_REFS = 100;
const MAX_RECEIPT_LIST = 100;
const DEFAULT_RECEIPT_LIST = 20;
const MAX_RECEIPT_REFS = 100;
const MAX_COMMAND_SUMMARY = 2000;
const MAX_LOG_REF = 512;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function actorId(value, field) {
  if (!isNonEmptyString(value)) throw new Error(`Missing required string: ${field}`);
  const text = value.trim();
  if (!ACTOR_ID_RE.test(text)) throw new Error(`Invalid actor id for ${field}`);
  return text;
}

function workspaceId(value, field = "workspace_id") {
  if (!isNonEmptyString(value)) throw new Error(`Missing required string: ${field}`);
  const text = value.trim();
  if (!WORKSPACE_ID_RE.test(text)) throw new Error(`Invalid workspace id for ${field}`);
  return text;
}

function codeSessionId(value, field = "code_session_id") {
  if (!isNonEmptyString(value)) throw new Error(`Missing required string: ${field}`);
  const text = value.trim();
  if (!CODE_SESSION_ID_RE.test(text)) throw new Error(`Invalid code session id for ${field}`);
  return text;
}

function environmentManifestId(value, field = "environment_manifest_id") {
  if (!isNonEmptyString(value)) throw new Error(`Missing required string: ${field}`);
  const text = value.trim();
  if (!ENV_MANIFEST_ID_RE.test(text)) throw new Error(`Invalid environment manifest id for ${field}`);
  return text;
}

function sandboxAttachmentId(value, field = "attachment_id") {
  if (!isNonEmptyString(value)) throw new Error(`Missing required string: ${field}`);
  const text = value.trim();
  if (!SANDBOX_ATTACHMENT_ID_RE.test(text)) throw new Error(`Invalid sandbox attachment id for ${field}`);
  return text;
}

function executionReceiptId(value, field = "receipt_id") {
  if (!isNonEmptyString(value)) throw new Error(`Missing required string: ${field}`);
  const text = value.trim();
  if (!EXEC_RECEIPT_ID_RE.test(text)) throw new Error(`Invalid execution receipt id for ${field}`);
  return text;
}

function parseJsonField(text, fallback) {
  if (text === undefined || text === null || text === "") return fallback;
  if (typeof text !== "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function authorityClosedFields() {
  return {
    accepted_state_authority: false,
    chain_heads_mutated: false,
    path_heads_mutated: false,
    synthetic_global_head: false,
    production_mutation_authority: false,
    sandbox_local_execution_only: true
  };
}

function sandboxEnvBindings(env) {
  if (!env?.CAIRNSTONE_DB) return { ok: false, error: "missing_d1_binding", binding: "CAIRNSTONE_DB" };
  return { ok: true, db: env.CAIRNSTONE_DB, r2: env.CAIRNSTONE_RAW || null };
}

function requireActorField(body, field) {
  try {
    return { ok: true, value: actorId(body?.[field], field) };
  } catch (error) {
    return {
      ok: false,
      error: "invalid_environment_sandbox_actor",
      detail: String(error.message || error),
      field
    };
  }
}

/**
 * Reject secret-bearing keys after scrub. Fail closed — never persist secrets.
 */
export function assertSecretsAbsent(value, path = "$") {
  if (value === REDACTED_SECRET) {
    return {
      ok: false,
      error: "secrets_not_absent",
      path,
      detail: "redacted_placeholder_present"
    };
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const nested = assertSecretsAbsent(value[i], `${path}[${i}]`);
      if (!nested.ok) return nested;
    }
    return { ok: true, secrets_absent: true };
  }
  if (!isObject(value)) {
    if (typeof value === "string" && /workspace_capability|bearer\s+[a-z0-9._-]{16,}/i.test(value)) {
      return {
        ok: false,
        error: "secrets_not_absent",
        path,
        detail: "secret_like_string"
      };
    }
    return { ok: true, secrets_absent: true };
  }
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key) || /workspace_capability|mailbox_capability/i.test(key)) {
      return {
        ok: false,
        error: "secrets_not_absent",
        path: `${path}.${key}`,
        detail: "secret_key"
      };
    }
    const nested = assertSecretsAbsent(entry, `${path}.${key}`);
    if (!nested.ok) return nested;
  }
  return { ok: true, secrets_absent: true };
}

export function normalizeSandboxExecutionClass(input) {
  if (input === undefined || input === null || input === "") {
    return { ok: true, sandbox_execution_class: "none" };
  }
  if (!isNonEmptyString(input)) {
    return { ok: false, error: "invalid_sandbox_execution_class" };
  }
  const value = String(input).trim();
  if (!SANDBOX_EXECUTION_CLASS_SET.has(value)) {
    return {
      ok: false,
      error: "invalid_sandbox_execution_class",
      allowed: [...SANDBOX_EXECUTION_CLASSES]
    };
  }
  return { ok: true, sandbox_execution_class: value };
}

export function normalizeCommandClass(input) {
  if (!isNonEmptyString(input)) {
    return { ok: false, error: "invalid_command_class" };
  }
  const value = String(input).trim();
  if (!COMMAND_CLASS_SET.has(value)) {
    return { ok: false, error: "invalid_command_class", allowed: [...COMMAND_CLASSES] };
  }
  return { ok: true, command_class: value };
}

export function commandClassAllowedForExecutionClass(sandbox_execution_class, command_class) {
  const allowed = ALLOWED_COMMANDS_BY_EXECUTION_CLASS[sandbox_execution_class] || [];
  return allowed.includes(command_class);
}

export function normalizeSourceRepos(input) {
  const list = Array.isArray(input) ? input : [];
  const repos = [...new Set(list.map(value => String(value || "").trim()).filter(Boolean))].sort();
  if (!repos.length) return { ok: false, error: "environment_manifest_source_repos_required" };
  if (repos.length > MAX_SOURCE_REPOS) {
    return { ok: false, error: "environment_manifest_source_repos_too_large", max: MAX_SOURCE_REPOS };
  }
  if (repos.some(repo => !REPO_RE.test(repo))) {
    return { ok: false, error: "invalid_environment_manifest_source_repo", allowed_shape: "owner/repo" };
  }
  return { ok: true, source_repos: repos };
}

export function normalizeBaseCommits(input, sourceRepos = []) {
  const list = Array.isArray(input) ? input : [];
  if (!list.length) return { ok: false, error: "environment_manifest_base_commits_required" };
  if (list.length > MAX_BASE_COMMITS) {
    return { ok: false, error: "environment_manifest_base_commits_too_large", max: MAX_BASE_COMMITS };
  }
  const commits = [];
  for (const entry of list) {
    if (!isObject(entry)) return { ok: false, error: "invalid_environment_manifest_base_commit" };
    const repo = String(entry.repo || "").trim();
    const commitSha = String(entry.commit_sha || entry.sha || "").trim().toLowerCase();
    if (!REPO_RE.test(repo) || !FULL_SHA_RE.test(commitSha)) {
      return {
        ok: false,
        error: "invalid_environment_manifest_base_commit",
        detail: "repo owner/repo + immutable 40-char commit_sha required"
      };
    }
    commits.push({
      repo,
      commit_sha: commitSha,
      authority_class: "immutable_git_base",
      accepted_state_authority: false
    });
  }
  commits.sort((a, b) => a.repo.localeCompare(b.repo) || a.commit_sha.localeCompare(b.commit_sha));
  const repoSet = new Set(sourceRepos);
  for (const commit of commits) {
    if (repoSet.size && !repoSet.has(commit.repo)) {
      return {
        ok: false,
        error: "environment_manifest_base_commit_repo_mismatch",
        repo: commit.repo,
        source_repos: sourceRepos
      };
    }
  }
  return { ok: true, base_commits: commits };
}

export function normalizeRuntime(input) {
  if (input === undefined || input === null || input === "") {
    return { ok: true, runtime: { languages: [], toolchains: [] } };
  }
  if (!isObject(input)) return { ok: false, error: "invalid_environment_manifest_runtime" };

  const languagesRaw = Array.isArray(input.languages) ? input.languages : [];
  const toolchainsRaw = Array.isArray(input.toolchains) ? input.toolchains : [];
  if (languagesRaw.length > MAX_RUNTIME_ENTRIES || toolchainsRaw.length > MAX_RUNTIME_ENTRIES) {
    return { ok: false, error: "environment_manifest_runtime_too_large", max: MAX_RUNTIME_ENTRIES };
  }

  const languages = [];
  for (const entry of languagesRaw) {
    if (typeof entry === "string" && entry.trim()) {
      languages.push({ name: entry.trim().slice(0, 128), version: null });
      continue;
    }
    if (!isObject(entry) || !isNonEmptyString(entry.name)) {
      return { ok: false, error: "invalid_environment_manifest_language" };
    }
    languages.push({
      name: String(entry.name).trim().slice(0, 128),
      version: isNonEmptyString(entry.version) ? String(entry.version).trim().slice(0, 128) : null
    });
  }

  const toolchains = [];
  for (const entry of toolchainsRaw) {
    if (typeof entry === "string" && entry.trim()) {
      toolchains.push({ name: entry.trim().slice(0, 128), version: null });
      continue;
    }
    if (!isObject(entry) || !isNonEmptyString(entry.name)) {
      return { ok: false, error: "invalid_environment_manifest_toolchain" };
    }
    toolchains.push({
      name: String(entry.name).trim().slice(0, 128),
      version: isNonEmptyString(entry.version) ? String(entry.version).trim().slice(0, 128) : null
    });
  }

  languages.sort((a, b) => a.name.localeCompare(b.name) || String(a.version || "").localeCompare(String(b.version || "")));
  toolchains.sort((a, b) => a.name.localeCompare(b.name) || String(a.version || "").localeCompare(String(b.version || "")));

  return { ok: true, runtime: { languages, toolchains } };
}

export function normalizeLockfiles(input) {
  if (input === undefined || input === null || input === "") {
    return { ok: true, lockfiles: [] };
  }
  if (!Array.isArray(input)) return { ok: false, error: "invalid_environment_manifest_lockfiles" };
  if (input.length > MAX_LOCKFILES) {
    return { ok: false, error: "environment_manifest_lockfiles_too_large", max: MAX_LOCKFILES };
  }
  const lockfiles = [];
  for (const entry of input) {
    if (typeof entry === "string" && entry.trim()) {
      lockfiles.push({ path: entry.trim().slice(0, 512), digest: null, kind: "lockfile" });
      continue;
    }
    if (!isObject(entry) || !isNonEmptyString(entry.path)) {
      return { ok: false, error: "invalid_environment_manifest_lockfile" };
    }
    lockfiles.push({
      path: String(entry.path).trim().slice(0, 512),
      digest: isNonEmptyString(entry.digest) ? String(entry.digest).trim().toLowerCase().slice(0, 128) : null,
      kind: isNonEmptyString(entry.kind) ? String(entry.kind).trim().slice(0, 64) : "lockfile"
    });
  }
  lockfiles.sort((a, b) => a.path.localeCompare(b.path));
  return { ok: true, lockfiles };
}

function normalizeCommandList(input, field) {
  if (input === undefined || input === null || input === "") {
    return { ok: true, commands: [] };
  }
  if (!Array.isArray(input)) return { ok: false, error: `invalid_environment_manifest_${field}` };
  if (input.length > MAX_COMMANDS) {
    return { ok: false, error: `environment_manifest_${field}_too_large`, max: MAX_COMMANDS };
  }
  const commands = [];
  for (const entry of input) {
    if (typeof entry === "string" && entry.trim()) {
      commands.push(entry.trim().slice(0, MAX_COMMAND_SUMMARY));
      continue;
    }
    if (!isObject(entry) || !isNonEmptyString(entry.command || entry.summary || entry.argv)) {
      return { ok: false, error: `invalid_environment_manifest_${field}_entry` };
    }
    const text = String(entry.command || entry.summary || entry.argv).trim().slice(0, MAX_COMMAND_SUMMARY);
    commands.push(text);
  }
  return { ok: true, commands };
}

/**
 * Env bindings are NAMES ONLY — never values. Reject secret-looking names.
 */
export function normalizeEnvBindings(input) {
  if (input === undefined || input === null || input === "") {
    return { ok: true, env_bindings: [] };
  }
  if (!Array.isArray(input)) return { ok: false, error: "invalid_environment_manifest_env_bindings" };
  if (input.length > MAX_ENV_BINDINGS) {
    return { ok: false, error: "environment_manifest_env_bindings_too_large", max: MAX_ENV_BINDINGS };
  }
  const names = [];
  for (const entry of input) {
    let name = null;
    if (typeof entry === "string") {
      name = entry.trim();
    } else if (isObject(entry)) {
      if (
        entry.value !== undefined
        || entry.secret !== undefined
        || entry.token !== undefined
        || entry.credential !== undefined
        || entry.api_key !== undefined
      ) {
        return {
          ok: false,
          error: "environment_manifest_env_binding_values_forbidden",
          detail: "names_only"
        };
      }
      if (!isNonEmptyString(entry.name)) {
        return { ok: false, error: "invalid_environment_manifest_env_binding" };
      }
      name = String(entry.name).trim();
    } else {
      return { ok: false, error: "invalid_environment_manifest_env_binding" };
    }
    if (!name || !ENV_BINDING_NAME_RE.test(name)) {
      return { ok: false, error: "invalid_environment_manifest_env_binding_name", name };
    }
    if (SECRET_NAME_RE.test(name)) {
      return {
        ok: false,
        error: "environment_manifest_env_binding_name_looks_like_secret",
        name
      };
    }
    names.push(name);
  }
  return { ok: true, env_bindings: [...new Set(names)].sort() };
}

export function normalizeArtifactCacheRefs(input) {
  if (input === undefined || input === null || input === "") {
    return { ok: true, artifact_cache_refs: [] };
  }
  if (!Array.isArray(input)) return { ok: false, error: "invalid_environment_manifest_artifact_cache_refs" };
  if (input.length > MAX_ARTIFACT_CACHE_REFS) {
    return { ok: false, error: "environment_manifest_artifact_cache_refs_too_large", max: MAX_ARTIFACT_CACHE_REFS };
  }
  const refs = [];
  for (const item of input) {
    if (typeof item === "string" && item.trim()) {
      refs.push({ ref: item.trim().slice(0, 256), kind: "cache" });
      continue;
    }
    if (!isObject(item) || !isNonEmptyString(item.ref)) {
      return { ok: false, error: "invalid_environment_manifest_artifact_cache_ref" };
    }
    refs.push({
      ref: String(item.ref).trim().slice(0, 256),
      kind: isNonEmptyString(item.kind) ? String(item.kind).trim().slice(0, 64) : "cache"
    });
  }
  return { ok: true, artifact_cache_refs: refs };
}

export function normalizeSandboxAdapter(input) {
  if (input === undefined || input === null || input === "") {
    return { ok: true, sandbox_adapter: null };
  }
  if (typeof input === "string" && input.trim()) {
    return {
      ok: true,
      sandbox_adapter: {
        adapter_profile_id: input.trim().slice(0, 128),
        provider: null
      }
    };
  }
  if (!isObject(input)) return { ok: false, error: "invalid_environment_manifest_sandbox_adapter" };
  const adapter = {
    adapter_profile_id: isNonEmptyString(input.adapter_profile_id || input.profile_id)
      ? String(input.adapter_profile_id || input.profile_id).trim().slice(0, 128)
      : null,
    provider: isNonEmptyString(input.provider) ? String(input.provider).trim().slice(0, 64) : null
  };
  if (!adapter.adapter_profile_id && !adapter.provider) {
    return { ok: false, error: "invalid_environment_manifest_sandbox_adapter", detail: "empty" };
  }
  return { ok: true, sandbox_adapter: adapter };
}

/**
 * Normalize full environment manifest payload. secrets_absent always true.
 */
export function normalizeEnvironmentManifestPayload(input = {}) {
  if (!isObject(input)) return { ok: false, error: "invalid_environment_manifest_payload" };

  const secretProbe = assertSecretsAbsent(input);
  if (!secretProbe.ok) return secretProbe;

  const reposNorm = normalizeSourceRepos(input.source_repos);
  if (!reposNorm.ok) return reposNorm;
  const commitsNorm = normalizeBaseCommits(input.base_commits, reposNorm.source_repos);
  if (!commitsNorm.ok) return commitsNorm;
  const runtimeNorm = normalizeRuntime(input.runtime || {
    languages: input.languages,
    toolchains: input.toolchains
  });
  if (!runtimeNorm.ok) return runtimeNorm;
  const lockfilesNorm = normalizeLockfiles(input.lockfiles);
  if (!lockfilesNorm.ok) return lockfilesNorm;

  const installNorm = normalizeCommandList(input.install_commands, "install_commands");
  if (!installNorm.ok) return installNorm;
  const buildNorm = normalizeCommandList(input.build_commands, "build_commands");
  if (!buildNorm.ok) return buildNorm;
  const testNorm = normalizeCommandList(input.test_commands, "test_commands");
  if (!testNorm.ok) return testNorm;
  const lintNorm = normalizeCommandList(input.lint_commands, "lint_commands");
  if (!lintNorm.ok) return lintNorm;

  const bindingsNorm = normalizeEnvBindings(input.env_bindings);
  if (!bindingsNorm.ok) return bindingsNorm;
  const cacheNorm = normalizeArtifactCacheRefs(input.artifact_cache_refs);
  if (!cacheNorm.ok) return cacheNorm;
  const adapterNorm = normalizeSandboxAdapter(input.sandbox_adapter);
  if (!adapterNorm.ok) return adapterNorm;
  const classNorm = normalizeSandboxExecutionClass(input.sandbox_execution_class);
  if (!classNorm.ok) return classNorm;

  if (input.secrets_absent === false) {
    return { ok: false, error: "environment_manifest_secrets_must_be_absent" };
  }

  const payload = scrubSecretsDeep({
    schema: ENVIRONMENT_MANIFEST_SCHEMA,
    source_repos: reposNorm.source_repos,
    base_commits: commitsNorm.base_commits,
    workspace_snapshot_id: isNonEmptyString(input.workspace_snapshot_id)
      ? String(input.workspace_snapshot_id).trim().slice(0, 256)
      : null,
    tip_vector_digest: isNonEmptyString(input.tip_vector_digest)
      ? String(input.tip_vector_digest).trim().slice(0, 128)
      : null,
    runtime: runtimeNorm.runtime,
    lockfiles: lockfilesNorm.lockfiles,
    install_commands: installNorm.commands,
    build_commands: buildNorm.commands,
    test_commands: testNorm.commands,
    lint_commands: lintNorm.commands,
    env_bindings: bindingsNorm.env_bindings,
    artifact_cache_refs: cacheNorm.artifact_cache_refs,
    sandbox_adapter: adapterNorm.sandbox_adapter,
    sandbox_execution_class: classNorm.sandbox_execution_class,
    secrets_absent: true,
    accepted_state_authority: false,
    production_mutation_authority: false,
    sandbox_local_execution_only: true
  });

  const absent = assertSecretsAbsent(payload);
  if (!absent.ok) return absent;

  return {
    ok: true,
    payload,
    sandbox_execution_class: classNorm.sandbox_execution_class
  };
}

export function normalizeArtifactRefs(input) {
  if (input === undefined || input === null || input === "") {
    return { ok: true, artifact_refs: [] };
  }
  if (!Array.isArray(input)) return { ok: false, error: "invalid_execution_receipt_artifact_refs" };
  if (input.length > MAX_ARTIFACT_REFS) {
    return { ok: false, error: "execution_receipt_artifact_refs_too_large", max: MAX_ARTIFACT_REFS };
  }
  const refs = [];
  for (const item of input) {
    if (typeof item === "string" && item.trim()) {
      refs.push({ ref: item.trim().slice(0, 256), kind: "artifact" });
      continue;
    }
    if (!isObject(item) || !isNonEmptyString(item.ref)) {
      return { ok: false, error: "invalid_execution_receipt_artifact_ref" };
    }
    refs.push({
      ref: String(item.ref).trim().slice(0, 256),
      kind: isNonEmptyString(item.kind) ? String(item.kind).trim().slice(0, 64) : "artifact"
    });
  }
  return { ok: true, artifact_refs: refs };
}

export function rowToEnvironmentManifestRecord(row) {
  if (!row) return null;
  const payload = scrubSecretsDeep(parseJsonField(row.payload_json, {}));
  return {
    schema: ENVIRONMENT_MANIFEST_SCHEMA,
    environment_manifest_id: row.environment_manifest_id,
    workspace_id: row.workspace_id,
    code_session_id: row.code_session_id || null,
    payload,
    payload_digest: row.payload_digest,
    sandbox_execution_class: row.sandbox_execution_class || payload.sandbox_execution_class || "none",
    secrets_absent: true,
    created_by: row.created_by,
    created_at: row.created_at,
    ...authorityClosedFields()
  };
}

export function rowToSandboxAttachmentRecord(row) {
  if (!row) return null;
  const detail = scrubSecretsDeep(parseJsonField(row.detail_json, {}));
  return {
    schema: SANDBOX_ATTACHMENT_SCHEMA,
    attachment_id: row.attachment_id,
    code_session_id: row.code_session_id,
    workspace_id: row.workspace_id,
    environment_manifest_id: row.environment_manifest_id,
    actor_id: row.actor_id,
    adapter_profile_id: row.adapter_profile_id || null,
    status: row.status,
    detail,
    attached_at: row.attached_at,
    updated_at: row.updated_at,
    detached_at: row.detached_at || null,
    secrets_absent: true,
    ...authorityClosedFields()
  };
}

export function rowToExecutionReceiptRecord(row) {
  if (!row) return null;
  const payload = scrubSecretsDeep(parseJsonField(row.payload_json, {}));
  return {
    schema: EXECUTION_RECEIPT_SCHEMA,
    receipt_id: row.receipt_id,
    code_session_id: row.code_session_id,
    workspace_id: row.workspace_id,
    environment_manifest_id: row.environment_manifest_id || null,
    sandbox_attachment_id: row.sandbox_attachment_id || null,
    actor_id: row.actor_id,
    command_class: row.command_class,
    command_summary: row.command_summary,
    status: row.status,
    exit_code: row.exit_code === null || row.exit_code === undefined ? null : Number(row.exit_code),
    duration_ms: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    tip_vector_digest: row.tip_vector_digest || null,
    artifact_refs: parseJsonField(row.artifact_refs_json, []),
    log_ref: row.log_ref || null,
    payload,
    payload_digest: row.payload_digest,
    secrets_absent: true,
    production_mutation: false,
    created_at: row.created_at,
    ...authorityClosedFields()
  };
}

export async function getEnvironmentManifest(db, environment_manifest_id) {
  let id;
  try { id = environmentManifestId(environment_manifest_id); }
  catch { return null; }
  const row = await db.prepare(
    `SELECT environment_manifest_id, workspace_id, code_session_id, payload_json,
            payload_digest, sandbox_execution_class, secrets_absent, created_by, created_at,
            accepted_state_authority
     FROM environment_manifests WHERE environment_manifest_id = ?`
  ).bind(id).first();
  return rowToEnvironmentManifestRecord(row);
}

export async function getSandboxAttachment(db, attachment_id) {
  let id;
  try { id = sandboxAttachmentId(attachment_id); }
  catch { return null; }
  const row = await db.prepare(
    `SELECT attachment_id, code_session_id, workspace_id, environment_manifest_id,
            actor_id, adapter_profile_id, status, detail_json, attached_at, updated_at,
            detached_at, secrets_absent, accepted_state_authority
     FROM code_session_sandbox_attachments WHERE attachment_id = ?`
  ).bind(id).first();
  return rowToSandboxAttachmentRecord(row);
}

export async function getExecutionReceipt(db, receipt_id) {
  let id;
  try { id = executionReceiptId(receipt_id); }
  catch { return null; }
  const row = await db.prepare(
    `SELECT receipt_id, code_session_id, workspace_id, environment_manifest_id,
            sandbox_attachment_id, actor_id, command_class, command_summary, status,
            exit_code, duration_ms, tip_vector_digest, artifact_refs_json, log_ref,
            payload_json, payload_digest, secrets_absent, production_mutation,
            accepted_state_authority, created_at
     FROM code_session_execution_receipts WHERE receipt_id = ?`
  ).bind(id).first();
  return rowToExecutionReceiptRecord(row);
}

export async function createEnvironmentManifest(db, {
  environment_manifest_id = null,
  workspace_id,
  code_session_id = null,
  created_by,
  ...rawPayload
} = {}) {
  let wsId;
  let creator;
  let sessionId = null;
  try {
    wsId = workspaceId(workspace_id);
    creator = actorId(created_by, "created_by");
    if (code_session_id !== undefined && code_session_id !== null && code_session_id !== "") {
      sessionId = codeSessionId(code_session_id);
    }
  } catch (error) {
    return {
      ok: false,
      error: "invalid_environment_manifest_create",
      detail: String(error.message || error),
      ...authorityClosedFields()
    };
  }

  const workspace = await getWorkspace(db, wsId);
  if (!workspace) {
    return { ok: false, error: "workspace_not_found", workspace_id: wsId, ...authorityClosedFields() };
  }

  if (sessionId) {
    const session = await getCodeSession(db, sessionId);
    if (!session) {
      return { ok: false, error: "code_session_not_found", code_session_id: sessionId, ...authorityClosedFields() };
    }
    if (session.workspace_id !== wsId) {
      return {
        ok: false,
        error: "environment_manifest_workspace_mismatch",
        workspace_id: wsId,
        code_session_id: sessionId,
        ...authorityClosedFields()
      };
    }
  }

  const normalized = normalizeEnvironmentManifestPayload(rawPayload);
  if (!normalized.ok) return { ...normalized, ...authorityClosedFields() };

  const payloadDigest = await sha256Text(stableJson(normalized.payload));
  let manifestId;
  if (isNonEmptyString(environment_manifest_id)) {
    try { manifestId = environmentManifestId(environment_manifest_id); }
    catch (error) {
      return {
        ok: false,
        error: "invalid_environment_manifest_id",
        detail: String(error.message || error),
        ...authorityClosedFields()
      };
    }
  } else {
    manifestId = `envmanifest:${payloadDigest.slice(0, 40)}`;
  }

  const now = new Date().toISOString();
  try {
    await db.prepare(
      `INSERT INTO environment_manifests (
        environment_manifest_id, workspace_id, code_session_id, payload_json,
        payload_digest, sandbox_execution_class, secrets_absent, created_by, created_at,
        accepted_state_authority
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 0)`
    ).bind(
      manifestId,
      wsId,
      sessionId,
      stableJson(normalized.payload),
      payloadDigest,
      normalized.sandbox_execution_class,
      creator,
      now
    ).run();
  } catch (error) {
    const message = String(error.message || error);
    if (message.includes("UNIQUE") || message.includes("constraint")) {
      return {
        ok: false,
        error: "environment_manifest_already_exists",
        environment_manifest_id: manifestId,
        ...authorityClosedFields()
      };
    }
    throw error;
  }

  const record = await getEnvironmentManifest(db, manifestId);
  return {
    ok: true,
    ...record,
    ...authorityClosedFields()
  };
}

/**
 * CAS-attach an environment manifest id onto a Code Session.
 * Bumps session_revision. Never moves HEADs.
 */
export async function attachEnvironmentManifestToSession(db, {
  code_session_id,
  environment_manifest_id,
  actor_id,
  base_revision
} = {}) {
  let sessionId;
  let manifestId;
  let actor;
  try {
    sessionId = codeSessionId(code_session_id);
    manifestId = environmentManifestId(environment_manifest_id);
    actor = actorId(actor_id, "actor_id");
  } catch (error) {
    return {
      ok: false,
      error: "invalid_attach_environment_request",
      detail: String(error.message || error),
      ...authorityClosedFields()
    };
  }

  if (!Number.isInteger(base_revision) || base_revision < 1) {
    return { ok: false, error: "code_session_base_revision_required", ...authorityClosedFields() };
  }

  const session = await getCodeSession(db, sessionId);
  if (!session) {
    return { ok: false, error: "code_session_not_found", code_session_id: sessionId, ...authorityClosedFields() };
  }

  const manifest = await getEnvironmentManifest(db, manifestId);
  if (!manifest) {
    return {
      ok: false,
      error: "environment_manifest_not_found",
      environment_manifest_id: manifestId,
      ...authorityClosedFields()
    };
  }
  if (manifest.workspace_id !== session.workspace_id) {
    return {
      ok: false,
      error: "environment_manifest_workspace_mismatch",
      workspace_id: session.workspace_id,
      environment_manifest_id: manifestId,
      ...authorityClosedFields()
    };
  }

  if (session.session_revision !== base_revision) {
    return {
      ok: false,
      error: "code_session_conflict",
      code_session_id: sessionId,
      expected_session_revision: session.session_revision,
      provided_base_revision: base_revision,
      ...authorityClosedFields()
    };
  }

  const nextRevision = base_revision + 1;
  const now = new Date().toISOString();
  const updated = await db.prepare(
    `UPDATE code_sessions
     SET environment_manifest_id = ?, session_revision = ?, updated_at = ?
     WHERE code_session_id = ? AND session_revision = ?`
  ).bind(manifestId, nextRevision, now, sessionId, base_revision).run();
  const changes = updated?.meta?.changes ?? updated?.changes ?? 0;
  if (!changes) {
    const raced = await getCodeSession(db, sessionId);
    return {
      ok: false,
      error: "code_session_conflict",
      code_session_id: sessionId,
      expected_session_revision: raced?.session_revision || null,
      provided_base_revision: base_revision,
      ...authorityClosedFields()
    };
  }

  // Best-effort annotate manifest with session pointer (non-authoritative).
  await db.prepare(
    `UPDATE environment_manifests
     SET code_session_id = ?
     WHERE environment_manifest_id = ? AND (code_session_id IS NULL OR code_session_id = ?)`
  ).bind(sessionId, manifestId, sessionId).run();

  const fresh = await getCodeSession(db, sessionId);
  return {
    ok: true,
    code_session_id: sessionId,
    environment_manifest_id: manifestId,
    session_revision: fresh?.session_revision || nextRevision,
    actor_id: actor,
    environment_manifest: manifest,
    ...authorityClosedFields()
  };
}

/**
 * Attach a disposable sandbox to a Code Session.
 * Updates latest_sandbox_attachment_id without requiring session_revision CAS bump.
 */
export async function attachSandbox(db, {
  attachment_id = null,
  code_session_id,
  environment_manifest_id = null,
  actor_id,
  adapter_profile_id = null,
  status = "attached",
  detail = {}
} = {}) {
  let sessionId;
  let actor;
  try {
    sessionId = codeSessionId(code_session_id);
    actor = actorId(actor_id, "actor_id");
  } catch (error) {
    return {
      ok: false,
      error: "invalid_sandbox_attach_request",
      detail: String(error.message || error),
      ...authorityClosedFields()
    };
  }

  if (!SANDBOX_ATTACHMENT_STATUS_SET.has(status)) {
    return {
      ok: false,
      error: "invalid_sandbox_attachment_status",
      allowed: [...SANDBOX_ATTACHMENT_STATUSES],
      ...authorityClosedFields()
    };
  }
  if (status === "detached" || status === "destroyed") {
    return {
      ok: false,
      error: "invalid_sandbox_attach_status",
      detail: "use_detach",
      ...authorityClosedFields()
    };
  }

  const session = await getCodeSession(db, sessionId);
  if (!session) {
    return { ok: false, error: "code_session_not_found", code_session_id: sessionId, ...authorityClosedFields() };
  }

  let manifestId = null;
  if (isNonEmptyString(environment_manifest_id)) {
    try { manifestId = environmentManifestId(environment_manifest_id); }
    catch (error) {
      return {
        ok: false,
        error: "invalid_environment_manifest_id",
        detail: String(error.message || error),
        ...authorityClosedFields()
      };
    }
  } else if (isNonEmptyString(session.environment_manifest_id)) {
    manifestId = session.environment_manifest_id;
  }
  if (!manifestId) {
    return {
      ok: false,
      error: "environment_manifest_id_required",
      code_session_id: sessionId,
      ...authorityClosedFields()
    };
  }

  const manifest = await getEnvironmentManifest(db, manifestId);
  if (!manifest) {
    return {
      ok: false,
      error: "environment_manifest_not_found",
      environment_manifest_id: manifestId,
      ...authorityClosedFields()
    };
  }
  if (manifest.workspace_id !== session.workspace_id) {
    return {
      ok: false,
      error: "environment_manifest_workspace_mismatch",
      ...authorityClosedFields()
    };
  }

  const detailScrubbed = scrubSecretsDeep(isObject(detail) ? detail : {});
  const absent = assertSecretsAbsent(detailScrubbed);
  if (!absent.ok) return { ...absent, ...authorityClosedFields() };

  const adapterId = isNonEmptyString(adapter_profile_id)
    ? String(adapter_profile_id).trim().slice(0, 128)
    : (manifest.payload?.sandbox_adapter?.adapter_profile_id || null);

  const now = new Date().toISOString();
  const seed = {
    schema: SANDBOX_ATTACHMENT_SCHEMA,
    code_session_id: sessionId,
    workspace_id: session.workspace_id,
    environment_manifest_id: manifestId,
    actor_id: actor,
    adapter_profile_id: adapterId,
    status,
    detail: detailScrubbed,
    attached_at: now,
    secrets_absent: true,
    accepted_state_authority: false
  };
  const digest = await sha256Text(stableJson(seed));

  let id;
  if (isNonEmptyString(attachment_id)) {
    try { id = sandboxAttachmentId(attachment_id); }
    catch (error) {
      return {
        ok: false,
        error: "invalid_sandbox_attachment_id",
        detail: String(error.message || error),
        ...authorityClosedFields()
      };
    }
  } else {
    id = `sandbox:${digest.slice(0, 32)}`;
  }

  try {
    await db.prepare(
      `INSERT INTO code_session_sandbox_attachments (
        attachment_id, code_session_id, workspace_id, environment_manifest_id,
        actor_id, adapter_profile_id, status, detail_json, attached_at, updated_at,
        detached_at, secrets_absent, accepted_state_authority
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, 0)`
    ).bind(
      id,
      sessionId,
      session.workspace_id,
      manifestId,
      actor,
      adapterId,
      status,
      stableJson(detailScrubbed),
      now,
      now
    ).run();
  } catch (error) {
    const message = String(error.message || error);
    if (message.includes("UNIQUE") || message.includes("constraint")) {
      return {
        ok: false,
        error: "sandbox_attachment_already_exists",
        attachment_id: id,
        ...authorityClosedFields()
      };
    }
    throw error;
  }

  await db.prepare(
    `UPDATE code_sessions
     SET latest_sandbox_attachment_id = ?, updated_at = ?
     WHERE code_session_id = ?`
  ).bind(id, now, sessionId).run();

  const record = await getSandboxAttachment(db, id);
  return {
    ok: true,
    ...record,
    latest_sandbox_attachment_id: id,
    ...authorityClosedFields()
  };
}

/**
 * Detach or destroy a sandbox attachment. Own actor only.
 */
export async function detachSandbox(db, {
  attachment_id,
  actor_id,
  status = "detached",
  detail = null
} = {}) {
  let id;
  let actor;
  try {
    id = sandboxAttachmentId(attachment_id);
    actor = actorId(actor_id, "actor_id");
  } catch (error) {
    return {
      ok: false,
      error: "invalid_sandbox_detach_request",
      detail: String(error.message || error),
      ...authorityClosedFields()
    };
  }

  if (status !== "detached" && status !== "destroyed") {
    return {
      ok: false,
      error: "invalid_sandbox_detach_status",
      allowed: ["detached", "destroyed"],
      ...authorityClosedFields()
    };
  }

  const current = await getSandboxAttachment(db, id);
  if (!current) {
    return { ok: false, error: "sandbox_attachment_not_found", attachment_id: id, ...authorityClosedFields() };
  }
  if (current.actor_id !== actor) {
    return {
      ok: false,
      error: "sandbox_attachment_actor_mismatch",
      attachment_id: id,
      actor_id: actor,
      owner_actor_id: current.actor_id,
      ...authorityClosedFields()
    };
  }
  if (current.status === "detached" || current.status === "destroyed") {
    return {
      ok: false,
      error: "sandbox_attachment_already_detached",
      attachment_id: id,
      status: current.status,
      ...authorityClosedFields()
    };
  }

  const now = new Date().toISOString();
  let nextDetail = current.detail || {};
  if (detail !== undefined && detail !== null) {
    const scrubbed = scrubSecretsDeep(isObject(detail) ? detail : { note: String(detail) });
    const absent = assertSecretsAbsent(scrubbed);
    if (!absent.ok) return { ...absent, ...authorityClosedFields() };
    nextDetail = { ...nextDetail, ...scrubbed };
  }

  await db.prepare(
    `UPDATE code_session_sandbox_attachments
     SET status = ?, detail_json = ?, updated_at = ?, detached_at = ?
     WHERE attachment_id = ? AND actor_id = ?`
  ).bind(status, stableJson(nextDetail), now, now, id, actor).run();

  const record = await getSandboxAttachment(db, id);
  return {
    ok: true,
    ...record,
    ...authorityClosedFields()
  };
}

/**
 * Create an immutable sandbox-local execution receipt.
 * Updates session latest_execution_receipt_refs; CAS when base_revision provided.
 */
export async function createExecutionReceipt(db, {
  receipt_id = null,
  code_session_id,
  actor_id,
  command_class,
  command_summary,
  status,
  exit_code = null,
  duration_ms = null,
  tip_vector_digest = null,
  artifact_refs = [],
  log_ref = null,
  environment_manifest_id = null,
  sandbox_attachment_id = null,
  base_revision = null,
  detail = null
} = {}) {
  let sessionId;
  let actor;
  try {
    sessionId = codeSessionId(code_session_id);
    actor = actorId(actor_id, "actor_id");
  } catch (error) {
    return {
      ok: false,
      error: "invalid_execution_receipt_create",
      detail: String(error.message || error),
      ...authorityClosedFields()
    };
  }

  const cmdNorm = normalizeCommandClass(command_class);
  if (!cmdNorm.ok) return { ...cmdNorm, ...authorityClosedFields() };
  if (!isNonEmptyString(command_summary)) {
    return { ok: false, error: "execution_receipt_command_summary_required", ...authorityClosedFields() };
  }
  if (!EXECUTION_RECEIPT_STATUS_SET.has(status)) {
    return {
      ok: false,
      error: "invalid_execution_receipt_status",
      allowed: [...EXECUTION_RECEIPT_STATUSES],
      ...authorityClosedFields()
    };
  }

  const session = await getCodeSession(db, sessionId);
  if (!session) {
    return { ok: false, error: "code_session_not_found", code_session_id: sessionId, ...authorityClosedFields() };
  }

  let manifestId = null;
  if (isNonEmptyString(environment_manifest_id)) {
    try { manifestId = environmentManifestId(environment_manifest_id); }
    catch (error) {
      return {
        ok: false,
        error: "invalid_environment_manifest_id",
        detail: String(error.message || error),
        ...authorityClosedFields()
      };
    }
  } else if (isNonEmptyString(session.environment_manifest_id)) {
    manifestId = session.environment_manifest_id;
  }

  let attachmentId = null;
  if (isNonEmptyString(sandbox_attachment_id)) {
    try { attachmentId = sandboxAttachmentId(sandbox_attachment_id); }
    catch (error) {
      return {
        ok: false,
        error: "invalid_sandbox_attachment_id",
        detail: String(error.message || error),
        ...authorityClosedFields()
      };
    }
  }

  let executionClass = "none";
  if (manifestId) {
    const manifest = await getEnvironmentManifest(db, manifestId);
    if (!manifest) {
      return {
        ok: false,
        error: "environment_manifest_not_found",
        environment_manifest_id: manifestId,
        ...authorityClosedFields()
      };
    }
    if (manifest.workspace_id !== session.workspace_id) {
      return { ok: false, error: "environment_manifest_workspace_mismatch", ...authorityClosedFields() };
    }
    executionClass = manifest.sandbox_execution_class || "none";
  }

  if (attachmentId) {
    const attachment = await getSandboxAttachment(db, attachmentId);
    if (!attachment) {
      return {
        ok: false,
        error: "sandbox_attachment_not_found",
        attachment_id: attachmentId,
        ...authorityClosedFields()
      };
    }
    if (attachment.code_session_id !== sessionId) {
      return {
        ok: false,
        error: "sandbox_attachment_session_mismatch",
        attachment_id: attachmentId,
        ...authorityClosedFields()
      };
    }
    if (!manifestId) manifestId = attachment.environment_manifest_id;
  }

  if (!commandClassAllowedForExecutionClass(executionClass, cmdNorm.command_class)) {
    return {
      ok: false,
      error: "command_class_not_allowed_for_sandbox_execution_class",
      sandbox_execution_class: executionClass,
      command_class: cmdNorm.command_class,
      allowed: [...(ALLOWED_COMMANDS_BY_EXECUTION_CLASS[executionClass] || [])],
      ...authorityClosedFields()
    };
  }

  const artifactsNorm = normalizeArtifactRefs(artifact_refs);
  if (!artifactsNorm.ok) return { ...artifactsNorm, ...authorityClosedFields() };

  const summary = String(command_summary).trim().slice(0, MAX_COMMAND_SUMMARY);
  const logRef = isNonEmptyString(log_ref) ? String(log_ref).trim().slice(0, MAX_LOG_REF) : null;
  const tipDigest = isNonEmptyString(tip_vector_digest)
    ? String(tip_vector_digest).trim().slice(0, 128)
    : null;

  let exitCode = null;
  if (exit_code !== undefined && exit_code !== null && exit_code !== "") {
    const n = Number(exit_code);
    if (!Number.isInteger(n)) {
      return { ok: false, error: "invalid_execution_receipt_exit_code", ...authorityClosedFields() };
    }
    exitCode = n;
  }

  let durationMs = null;
  if (duration_ms !== undefined && duration_ms !== null && duration_ms !== "") {
    const n = Number(duration_ms);
    if (!Number.isInteger(n) || n < 0) {
      return { ok: false, error: "invalid_execution_receipt_duration_ms", ...authorityClosedFields() };
    }
    durationMs = n;
  }

  const detailScrubbed = scrubSecretsDeep(isObject(detail) ? detail : {});
  const payload = scrubSecretsDeep({
    schema: EXECUTION_RECEIPT_SCHEMA,
    code_session_id: sessionId,
    workspace_id: session.workspace_id,
    environment_manifest_id: manifestId,
    sandbox_attachment_id: attachmentId,
    actor_id: actor,
    command_class: cmdNorm.command_class,
    command_summary: summary,
    status,
    exit_code: exitCode,
    duration_ms: durationMs,
    tip_vector_digest: tipDigest,
    artifact_refs: artifactsNorm.artifact_refs,
    log_ref: logRef,
    detail: detailScrubbed,
    sandbox_execution_class: executionClass,
    secrets_absent: true,
    production_mutation: false,
    accepted_state_authority: false,
    production_mutation_authority: false,
    sandbox_local_execution_only: true
  });
  const absent = assertSecretsAbsent(payload);
  if (!absent.ok) return { ...absent, ...authorityClosedFields() };

  const payloadDigest = await sha256Text(stableJson(payload));
  let id;
  if (isNonEmptyString(receipt_id)) {
    try { id = executionReceiptId(receipt_id); }
    catch (error) {
      return {
        ok: false,
        error: "invalid_execution_receipt_id",
        detail: String(error.message || error),
        ...authorityClosedFields()
      };
    }
  } else {
    id = `execrcpt:${payloadDigest.slice(0, 40)}`;
  }

  const now = new Date().toISOString();
  try {
    await db.prepare(
      `INSERT INTO code_session_execution_receipts (
        receipt_id, code_session_id, workspace_id, environment_manifest_id,
        sandbox_attachment_id, actor_id, command_class, command_summary, status,
        exit_code, duration_ms, tip_vector_digest, artifact_refs_json, log_ref,
        payload_json, payload_digest, secrets_absent, production_mutation,
        accepted_state_authority, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?)`
    ).bind(
      id,
      sessionId,
      session.workspace_id,
      manifestId,
      attachmentId,
      actor,
      cmdNorm.command_class,
      summary,
      status,
      exitCode,
      durationMs,
      tipDigest,
      stableJson(artifactsNorm.artifact_refs),
      logRef,
      stableJson(payload),
      payloadDigest,
      now
    ).run();
  } catch (error) {
    const message = String(error.message || error);
    if (message.includes("UNIQUE") || message.includes("constraint")) {
      return {
        ok: false,
        error: "execution_receipt_already_exists",
        receipt_id: id,
        ...authorityClosedFields()
      };
    }
    throw error;
  }

  const nextRef = {
    ref: id,
    kind: cmdNorm.command_class,
    status
  };
  const priorRefs = Array.isArray(session.latest_execution_receipt_refs)
    ? session.latest_execution_receipt_refs
    : [];
  const refsNorm = normalizeReceiptRefs([nextRef, ...priorRefs].slice(0, MAX_RECEIPT_REFS));
  if (!refsNorm.ok) return { ...refsNorm, ...authorityClosedFields() };

  if (base_revision !== undefined && base_revision !== null && base_revision !== "") {
    if (!Number.isInteger(base_revision) || base_revision < 1) {
      return { ok: false, error: "code_session_base_revision_required", ...authorityClosedFields() };
    }
    if (session.session_revision !== base_revision) {
      return {
        ok: false,
        error: "code_session_conflict",
        code_session_id: sessionId,
        expected_session_revision: session.session_revision,
        provided_base_revision: base_revision,
        receipt_id: id,
        note: "receipt_persisted_session_refs_not_updated",
        ...authorityClosedFields()
      };
    }
    const nextRevision = base_revision + 1;
    const updated = await db.prepare(
      `UPDATE code_sessions
       SET latest_execution_receipt_refs_json = ?, session_revision = ?, updated_at = ?
       WHERE code_session_id = ? AND session_revision = ?`
    ).bind(
      stableJson(refsNorm.latest_execution_receipt_refs),
      nextRevision,
      now,
      sessionId,
      base_revision
    ).run();
    const changes = updated?.meta?.changes ?? updated?.changes ?? 0;
    if (!changes) {
      const raced = await getCodeSession(db, sessionId);
      return {
        ok: false,
        error: "code_session_conflict",
        code_session_id: sessionId,
        expected_session_revision: raced?.session_revision || null,
        provided_base_revision: base_revision,
        receipt_id: id,
        note: "receipt_persisted_session_refs_not_updated",
        ...authorityClosedFields()
      };
    }
  } else {
    await db.prepare(
      `UPDATE code_sessions
       SET latest_execution_receipt_refs_json = ?, updated_at = ?
       WHERE code_session_id = ?`
    ).bind(stableJson(refsNorm.latest_execution_receipt_refs), now, sessionId).run();
  }

  const record = await getExecutionReceipt(db, id);
  const fresh = await getCodeSession(db, sessionId);
  return {
    ok: true,
    ...record,
    session_revision: fresh?.session_revision || session.session_revision,
    latest_execution_receipt_refs: fresh?.latest_execution_receipt_refs || refsNorm.latest_execution_receipt_refs,
    ...authorityClosedFields()
  };
}

export async function listExecutionReceipts(db, {
  code_session_id,
  limit = DEFAULT_RECEIPT_LIST
} = {}) {
  let sessionId;
  try { sessionId = codeSessionId(code_session_id); }
  catch (error) {
    return {
      ok: false,
      error: "invalid_code_session_id",
      detail: String(error.message || error),
      ...authorityClosedFields()
    };
  }
  const bounded = Math.min(Math.max(Number(limit) || DEFAULT_RECEIPT_LIST, 1), MAX_RECEIPT_LIST);
  const rows = await db.prepare(
    `SELECT receipt_id, code_session_id, workspace_id, environment_manifest_id,
            sandbox_attachment_id, actor_id, command_class, command_summary, status,
            exit_code, duration_ms, tip_vector_digest, artifact_refs_json, log_ref,
            payload_json, payload_digest, secrets_absent, production_mutation,
            accepted_state_authority, created_at
     FROM code_session_execution_receipts
     WHERE code_session_id = ?
     ORDER BY created_at DESC
     LIMIT ?`
  ).bind(sessionId, bounded).all();
  const receipts = (rows?.results || []).map(rowToExecutionReceiptRecord);
  return {
    ok: true,
    code_session_id: sessionId,
    count: receipts.length,
    limit: bounded,
    receipts,
    ...authorityClosedFields()
  };
}

/**
 * Compact environment/sandbox summary for compile-context wiring.
 * Never accepted-state authority; never includes secret values.
 */
export async function summarizeEnvironmentSandboxForContext(db, {
  code_session_id = null,
  environment_manifest_id = null,
  latest_sandbox_attachment_id = null,
  latest_execution_receipt_refs = []
} = {}) {
  let manifest = null;
  let attachment = null;

  if (isNonEmptyString(environment_manifest_id)) {
    manifest = await getEnvironmentManifest(db, environment_manifest_id);
  }
  if (isNonEmptyString(latest_sandbox_attachment_id)) {
    attachment = await getSandboxAttachment(db, latest_sandbox_attachment_id);
  }

  const refsNorm = normalizeReceiptRefs(latest_execution_receipt_refs);
  const refs = refsNorm.ok ? refsNorm.latest_execution_receipt_refs : [];

  return scrubSecretsDeep({
    ok: true,
    code_session_id: isNonEmptyString(code_session_id) ? String(code_session_id).trim() : null,
    environment_manifest_id: manifest?.environment_manifest_id || (isNonEmptyString(environment_manifest_id) ? String(environment_manifest_id).trim() : null),
    environment_manifest: manifest
      ? {
        environment_manifest_id: manifest.environment_manifest_id,
        payload_digest: manifest.payload_digest,
        sandbox_execution_class: manifest.sandbox_execution_class,
        source_repos: manifest.payload?.source_repos || [],
        base_commits: manifest.payload?.base_commits || [],
        runtime: manifest.payload?.runtime || null,
        lockfiles: manifest.payload?.lockfiles || [],
        env_bindings: manifest.payload?.env_bindings || [],
        sandbox_adapter: manifest.payload?.sandbox_adapter || null,
        secrets_absent: true
      }
      : null,
    latest_sandbox_attachment_id: attachment?.attachment_id
      || (isNonEmptyString(latest_sandbox_attachment_id) ? String(latest_sandbox_attachment_id).trim() : null),
    sandbox_attachment: attachment
      ? {
        attachment_id: attachment.attachment_id,
        status: attachment.status,
        actor_id: attachment.actor_id,
        adapter_profile_id: attachment.adapter_profile_id,
        environment_manifest_id: attachment.environment_manifest_id,
        attached_at: attachment.attached_at,
        detached_at: attachment.detached_at,
        secrets_absent: true
      }
      : null,
    latest_execution_receipt_refs: refs.slice(0, MAX_RECEIPT_REFS),
    secrets_absent: true,
    ...authorityClosedFields()
  });
}

async function authorizeSandboxRequest(db, env, {
  workspace_capability,
  actor_id,
  workspace_id,
  requiredScopes = []
} = {}) {
  const auth = await authorizeWorkspaceRequest(db, env, {
    workspace_capability,
    actor_id,
    workspace_id,
    requiredScopes,
    requireMembership: true
  });
  if (!auth.ok) return auth;
  return {
    ...auth,
    ...authorityClosedFields()
  };
}

// ---------------------------------------------------------------------------
// FromBody handlers (capability + membership; mirror code-session.js)
// ---------------------------------------------------------------------------

export async function createEnvironmentManifestFromBody(body = {}, env = {}) {
  const bindings = sandboxEnvBindings(env);
  if (!bindings.ok) return bindings;

  const creator = requireActorField(body, "created_by");
  if (!creator.ok) return creator;
  if (!isNonEmptyString(body.workspace_id)) {
    return { ok: false, error: "workspace_id_required_for_create", ...authorityClosedFields() };
  }
  if (!isNonEmptyString(body.workspace_capability)) {
    return { ok: false, error: "workspace_capability_required", ...authorityClosedFields() };
  }

  const auth = await authorizeSandboxRequest(bindings.db, env, {
    workspace_capability: body.workspace_capability,
    actor_id: creator.value,
    workspace_id: body.workspace_id,
    requiredScopes: ["write_draft"]
  });
  if (!auth.ok) return auth;

  return createEnvironmentManifest(bindings.db, {
    environment_manifest_id: body.environment_manifest_id,
    workspace_id: auth.workspace_id,
    code_session_id: body.code_session_id,
    created_by: creator.value,
    source_repos: body.source_repos,
    base_commits: body.base_commits,
    workspace_snapshot_id: body.workspace_snapshot_id,
    tip_vector_digest: body.tip_vector_digest,
    runtime: body.runtime,
    languages: body.languages,
    toolchains: body.toolchains,
    lockfiles: body.lockfiles,
    install_commands: body.install_commands,
    build_commands: body.build_commands,
    test_commands: body.test_commands,
    lint_commands: body.lint_commands,
    env_bindings: body.env_bindings,
    artifact_cache_refs: body.artifact_cache_refs,
    sandbox_adapter: body.sandbox_adapter,
    sandbox_execution_class: body.sandbox_execution_class,
    secrets_absent: body.secrets_absent
  });
}

export async function getEnvironmentManifestFromBody(body = {}, env = {}) {
  const bindings = sandboxEnvBindings(env);
  if (!bindings.ok) return bindings;

  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  if (!isNonEmptyString(body.environment_manifest_id)) {
    return { ok: false, error: "environment_manifest_id_required", ...authorityClosedFields() };
  }
  if (!isNonEmptyString(body.workspace_capability)) {
    return { ok: false, error: "workspace_capability_required", ...authorityClosedFields() };
  }

  const record = await getEnvironmentManifest(bindings.db, body.environment_manifest_id);
  if (!record) {
    return {
      ok: false,
      error: "environment_manifest_not_found",
      environment_manifest_id: body.environment_manifest_id,
      ...authorityClosedFields()
    };
  }

  const auth = await authorizeSandboxRequest(bindings.db, env, {
    workspace_capability: body.workspace_capability,
    actor_id: actor.value,
    workspace_id: record.workspace_id,
    requiredScopes: ["ls"]
  });
  if (!auth.ok) return auth;

  return {
    ok: true,
    ...record,
    membership_role: auth.membership_role,
    ...authorityClosedFields()
  };
}

export async function attachEnvironmentManifestToSessionFromBody(body = {}, env = {}) {
  const bindings = sandboxEnvBindings(env);
  if (!bindings.ok) return bindings;

  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  if (!isNonEmptyString(body.code_session_id)) {
    return { ok: false, error: "code_session_id_required", ...authorityClosedFields() };
  }
  if (!isNonEmptyString(body.environment_manifest_id)) {
    return { ok: false, error: "environment_manifest_id_required", ...authorityClosedFields() };
  }
  if (!isNonEmptyString(body.workspace_capability)) {
    return { ok: false, error: "workspace_capability_required", ...authorityClosedFields() };
  }

  const session = await getCodeSession(bindings.db, body.code_session_id);
  if (!session) {
    return {
      ok: false,
      error: "code_session_not_found",
      code_session_id: body.code_session_id,
      ...authorityClosedFields()
    };
  }

  const auth = await authorizeSandboxRequest(bindings.db, env, {
    workspace_capability: body.workspace_capability,
    actor_id: actor.value,
    workspace_id: session.workspace_id,
    requiredScopes: ["write_draft"]
  });
  if (!auth.ok) return auth;

  return attachEnvironmentManifestToSession(bindings.db, {
    code_session_id: session.code_session_id,
    environment_manifest_id: body.environment_manifest_id,
    actor_id: actor.value,
    base_revision: body.base_revision
  });
}

export async function attachSandboxFromBody(body = {}, env = {}) {
  const bindings = sandboxEnvBindings(env);
  if (!bindings.ok) return bindings;

  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  if (!isNonEmptyString(body.code_session_id)) {
    return { ok: false, error: "code_session_id_required", ...authorityClosedFields() };
  }
  if (!isNonEmptyString(body.workspace_capability)) {
    return { ok: false, error: "workspace_capability_required", ...authorityClosedFields() };
  }

  const session = await getCodeSession(bindings.db, body.code_session_id);
  if (!session) {
    return {
      ok: false,
      error: "code_session_not_found",
      code_session_id: body.code_session_id,
      ...authorityClosedFields()
    };
  }

  const auth = await authorizeSandboxRequest(bindings.db, env, {
    workspace_capability: body.workspace_capability,
    actor_id: actor.value,
    workspace_id: session.workspace_id,
    requiredScopes: ["write_draft"]
  });
  if (!auth.ok) return auth;

  return attachSandbox(bindings.db, {
    attachment_id: body.attachment_id,
    code_session_id: session.code_session_id,
    environment_manifest_id: body.environment_manifest_id,
    actor_id: actor.value,
    adapter_profile_id: body.adapter_profile_id,
    status: body.status || "attached",
    detail: body.detail
  });
}

export async function detachSandboxFromBody(body = {}, env = {}) {
  const bindings = sandboxEnvBindings(env);
  if (!bindings.ok) return bindings;

  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  if (!isNonEmptyString(body.attachment_id)) {
    return { ok: false, error: "attachment_id_required", ...authorityClosedFields() };
  }
  if (!isNonEmptyString(body.workspace_capability)) {
    return { ok: false, error: "workspace_capability_required", ...authorityClosedFields() };
  }

  const attachment = await getSandboxAttachment(bindings.db, body.attachment_id);
  if (!attachment) {
    return {
      ok: false,
      error: "sandbox_attachment_not_found",
      attachment_id: body.attachment_id,
      ...authorityClosedFields()
    };
  }

  const auth = await authorizeSandboxRequest(bindings.db, env, {
    workspace_capability: body.workspace_capability,
    actor_id: actor.value,
    workspace_id: attachment.workspace_id,
    requiredScopes: ["write_draft"]
  });
  if (!auth.ok) return auth;

  return detachSandbox(bindings.db, {
    attachment_id: attachment.attachment_id,
    actor_id: actor.value,
    status: body.status || "detached",
    detail: body.detail
  });
}

export async function getSandboxAttachmentFromBody(body = {}, env = {}) {
  const bindings = sandboxEnvBindings(env);
  if (!bindings.ok) return bindings;

  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  if (!isNonEmptyString(body.workspace_capability)) {
    return { ok: false, error: "workspace_capability_required", ...authorityClosedFields() };
  }

  let attachment = null;
  if (isNonEmptyString(body.attachment_id)) {
    attachment = await getSandboxAttachment(bindings.db, body.attachment_id);
  } else if (isNonEmptyString(body.code_session_id)) {
    const session = await getCodeSession(bindings.db, body.code_session_id);
    if (!session) {
      return {
        ok: false,
        error: "code_session_not_found",
        code_session_id: body.code_session_id,
        ...authorityClosedFields()
      };
    }
    // Prefer explicit latest pointer via raw column when available.
    const row = await bindings.db.prepare(
      `SELECT latest_sandbox_attachment_id FROM code_sessions WHERE code_session_id = ?`
    ).bind(session.code_session_id).first();
    const latestId = row?.latest_sandbox_attachment_id || null;
    if (!latestId) {
      return {
        ok: false,
        error: "sandbox_attachment_not_found",
        code_session_id: session.code_session_id,
        ...authorityClosedFields()
      };
    }
    attachment = await getSandboxAttachment(bindings.db, latestId);
  } else {
    return {
      ok: false,
      error: "attachment_id_or_code_session_id_required",
      ...authorityClosedFields()
    };
  }

  if (!attachment) {
    return {
      ok: false,
      error: "sandbox_attachment_not_found",
      attachment_id: body.attachment_id || null,
      ...authorityClosedFields()
    };
  }

  const auth = await authorizeSandboxRequest(bindings.db, env, {
    workspace_capability: body.workspace_capability,
    actor_id: actor.value,
    workspace_id: attachment.workspace_id,
    requiredScopes: ["ls"]
  });
  if (!auth.ok) return auth;

  return {
    ok: true,
    ...attachment,
    membership_role: auth.membership_role,
    ...authorityClosedFields()
  };
}

export async function createExecutionReceiptFromBody(body = {}, env = {}) {
  const bindings = sandboxEnvBindings(env);
  if (!bindings.ok) return bindings;

  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  if (!isNonEmptyString(body.code_session_id)) {
    return { ok: false, error: "code_session_id_required", ...authorityClosedFields() };
  }
  if (!isNonEmptyString(body.workspace_capability)) {
    return { ok: false, error: "workspace_capability_required", ...authorityClosedFields() };
  }

  const session = await getCodeSession(bindings.db, body.code_session_id);
  if (!session) {
    return {
      ok: false,
      error: "code_session_not_found",
      code_session_id: body.code_session_id,
      ...authorityClosedFields()
    };
  }

  const auth = await authorizeSandboxRequest(bindings.db, env, {
    workspace_capability: body.workspace_capability,
    actor_id: actor.value,
    workspace_id: session.workspace_id,
    requiredScopes: ["write_draft"]
  });
  if (!auth.ok) return auth;

  return createExecutionReceipt(bindings.db, {
    receipt_id: body.receipt_id,
    code_session_id: session.code_session_id,
    actor_id: actor.value,
    command_class: body.command_class,
    command_summary: body.command_summary,
    status: body.status,
    exit_code: body.exit_code,
    duration_ms: body.duration_ms,
    tip_vector_digest: body.tip_vector_digest,
    artifact_refs: body.artifact_refs,
    log_ref: body.log_ref,
    environment_manifest_id: body.environment_manifest_id,
    sandbox_attachment_id: body.sandbox_attachment_id,
    base_revision: body.base_revision,
    detail: body.detail
  });
}

export async function getExecutionReceiptFromBody(body = {}, env = {}) {
  const bindings = sandboxEnvBindings(env);
  if (!bindings.ok) return bindings;

  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  if (!isNonEmptyString(body.receipt_id)) {
    return { ok: false, error: "receipt_id_required", ...authorityClosedFields() };
  }
  if (!isNonEmptyString(body.workspace_capability)) {
    return { ok: false, error: "workspace_capability_required", ...authorityClosedFields() };
  }

  const record = await getExecutionReceipt(bindings.db, body.receipt_id);
  if (!record) {
    return {
      ok: false,
      error: "execution_receipt_not_found",
      receipt_id: body.receipt_id,
      ...authorityClosedFields()
    };
  }

  const auth = await authorizeSandboxRequest(bindings.db, env, {
    workspace_capability: body.workspace_capability,
    actor_id: actor.value,
    workspace_id: record.workspace_id,
    requiredScopes: ["ls"]
  });
  if (!auth.ok) return auth;

  return {
    ok: true,
    ...record,
    membership_role: auth.membership_role,
    ...authorityClosedFields()
  };
}

export async function listExecutionReceiptsFromBody(body = {}, env = {}) {
  const bindings = sandboxEnvBindings(env);
  if (!bindings.ok) return bindings;

  const actor = requireActorField(body, "actor_id");
  if (!actor.ok) return actor;
  if (!isNonEmptyString(body.code_session_id)) {
    return { ok: false, error: "code_session_id_required", ...authorityClosedFields() };
  }
  if (!isNonEmptyString(body.workspace_capability)) {
    return { ok: false, error: "workspace_capability_required", ...authorityClosedFields() };
  }

  const session = await getCodeSession(bindings.db, body.code_session_id);
  if (!session) {
    return {
      ok: false,
      error: "code_session_not_found",
      code_session_id: body.code_session_id,
      ...authorityClosedFields()
    };
  }

  const auth = await authorizeSandboxRequest(bindings.db, env, {
    workspace_capability: body.workspace_capability,
    actor_id: actor.value,
    workspace_id: session.workspace_id,
    requiredScopes: ["ls"]
  });
  if (!auth.ok) return auth;

  const listed = await listExecutionReceipts(bindings.db, {
    code_session_id: session.code_session_id,
    limit: body.limit
  });
  if (!listed.ok) return listed;
  return {
    ...listed,
    membership_role: auth.membership_role,
    ...authorityClosedFields()
  };
}

// ---------------------------------------------------------------------------
// MCP tool definitions
// ---------------------------------------------------------------------------

const AUTH_PROPS = Object.freeze({
  actor_id: { type: "string" },
  workspace_capability: { type: "string" }
});

export const ENVIRONMENT_MANIFEST_CREATE_TOOL_DEFINITION = Object.freeze({
  name: ENVIRONMENT_SANDBOX_BROKER_TOOL_IDS.environment_manifest_create,
  description: "V7.7.7e: create provider-neutral cairnstone-environment-manifest-v1 for reconstructable sandbox environments. Requires write_draft. Never stores secrets; secrets_absent always true. Never accepted-state authority; never HEADs.",
  inputSchema: {
    type: "object",
    required: ["workspace_id", "created_by", "workspace_capability", "source_repos", "base_commits"],
    properties: {
      workspace_id: { type: "string" },
      created_by: { type: "string" },
      workspace_capability: { type: "string" },
      environment_manifest_id: { type: "string" },
      code_session_id: { type: "string" },
      source_repos: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 32 },
      base_commits: {
        type: "array",
        minItems: 1,
        maxItems: 32,
        items: {
          type: "object",
          required: ["repo", "commit_sha"],
          properties: {
            repo: { type: "string" },
            commit_sha: { type: "string" }
          },
          additionalProperties: false
        }
      },
      workspace_snapshot_id: { type: "string" },
      tip_vector_digest: { type: "string" },
      runtime: {
        type: "object",
        properties: {
          languages: { type: "array", maxItems: 64 },
          toolchains: { type: "array", maxItems: 64 }
        },
        additionalProperties: false
      },
      lockfiles: { type: "array", maxItems: 64 },
      install_commands: { type: "array", maxItems: 32 },
      build_commands: { type: "array", maxItems: 32 },
      test_commands: { type: "array", maxItems: 32 },
      lint_commands: { type: "array", maxItems: 32 },
      env_bindings: {
        type: "array",
        maxItems: 128,
        description: "Binding NAMES only — never values/secrets."
      },
      artifact_cache_refs: { type: "array", maxItems: 100 },
      sandbox_adapter: {
        type: "object",
        properties: {
          adapter_profile_id: { type: "string" },
          provider: { type: "string" }
        },
        additionalProperties: false
      },
      sandbox_execution_class: {
        type: "string",
        enum: ["none", "local_build_test", "local_install_build_test"]
      },
      secrets_absent: { type: "boolean" }
    },
    additionalProperties: false
  }
});

export const ENVIRONMENT_MANIFEST_GET_TOOL_DEFINITION = Object.freeze({
  name: ENVIRONMENT_SANDBOX_BROKER_TOOL_IDS.environment_manifest_get,
  description: "V7.7.7e: read cairnstone-environment-manifest-v1. Requires workspace membership + ls. Never accepted-state authority.",
  inputSchema: {
    type: "object",
    required: ["environment_manifest_id", "actor_id", "workspace_capability"],
    properties: {
      environment_manifest_id: { type: "string" },
      ...AUTH_PROPS
    },
    additionalProperties: false
  }
});

export const CODE_SESSION_ATTACH_ENVIRONMENT_TOOL_DEFINITION = Object.freeze({
  name: ENVIRONMENT_SANDBOX_BROKER_TOOL_IDS.attach_environment,
  description: "V7.7.7e: CAS-attach environment_manifest_id onto a Code Session (base_revision). Requires write_draft. Never moves HEADs; never production/deploy authority.",
  inputSchema: {
    type: "object",
    required: ["code_session_id", "environment_manifest_id", "actor_id", "workspace_capability", "base_revision"],
    properties: {
      code_session_id: { type: "string" },
      environment_manifest_id: { type: "string" },
      base_revision: { type: "number", minimum: 1 },
      ...AUTH_PROPS
    },
    additionalProperties: false
  }
});

export const CODE_SESSION_SANDBOX_ATTACH_TOOL_DEFINITION = Object.freeze({
  name: ENVIRONMENT_SANDBOX_BROKER_TOOL_IDS.sandbox_attach,
  description: "V7.7.7e: attach disposable sandbox to a Code Session and set latest_sandbox_attachment_id. Replaceable compute only. Requires write_draft. Never accepted-state; never HEADs.",
  inputSchema: {
    type: "object",
    required: ["code_session_id", "actor_id", "workspace_capability"],
    properties: {
      code_session_id: { type: "string" },
      environment_manifest_id: { type: "string" },
      attachment_id: { type: "string" },
      adapter_profile_id: { type: "string" },
      status: {
        type: "string",
        enum: ["attached", "hydrating", "ready", "executing", "failed"]
      },
      detail: { type: "object" },
      ...AUTH_PROPS
    },
    additionalProperties: false
  }
});

export const CODE_SESSION_SANDBOX_DETACH_TOOL_DEFINITION = Object.freeze({
  name: ENVIRONMENT_SANDBOX_BROKER_TOOL_IDS.sandbox_detach,
  description: "V7.7.7e: detach or destroy own sandbox attachment (status detached|destroyed). Own actor only. Requires write_draft. Never HEADs.",
  inputSchema: {
    type: "object",
    required: ["attachment_id", "actor_id", "workspace_capability"],
    properties: {
      attachment_id: { type: "string" },
      status: { type: "string", enum: ["detached", "destroyed"] },
      detail: { type: "object" },
      ...AUTH_PROPS
    },
    additionalProperties: false
  }
});

export const CODE_SESSION_SANDBOX_GET_TOOL_DEFINITION = Object.freeze({
  name: ENVIRONMENT_SANDBOX_BROKER_TOOL_IDS.sandbox_get,
  description: "V7.7.7e: read sandbox attachment by attachment_id or latest for code_session_id. Requires ls. Never accepted-state authority.",
  inputSchema: {
    type: "object",
    required: ["actor_id", "workspace_capability"],
    properties: {
      attachment_id: { type: "string" },
      code_session_id: { type: "string" },
      ...AUTH_PROPS
    },
    additionalProperties: false
  }
});

export const EXECUTION_RECEIPT_CREATE_TOOL_DEFINITION = Object.freeze({
  name: ENVIRONMENT_SANDBOX_BROKER_TOOL_IDS.execution_receipt_create,
  description: "V7.7.7e: create immutable sandbox-local execution receipt. Command class must be allowed by sandbox_execution_class. Updates latest_execution_receipt_refs (CAS if base_revision). Never production/deploy/merge; never HEADs; never stores secrets.",
  inputSchema: {
    type: "object",
    required: [
      "code_session_id",
      "actor_id",
      "workspace_capability",
      "command_class",
      "command_summary",
      "status"
    ],
    properties: {
      code_session_id: { type: "string" },
      receipt_id: { type: "string" },
      environment_manifest_id: { type: "string" },
      sandbox_attachment_id: { type: "string" },
      command_class: {
        type: "string",
        enum: ["install", "build", "test", "lint", "other_local"]
      },
      command_summary: { type: "string" },
      status: {
        type: "string",
        enum: ["pass", "fail", "error", "timeout", "cancelled"]
      },
      exit_code: { type: "number" },
      duration_ms: { type: "number", minimum: 0 },
      tip_vector_digest: { type: "string" },
      artifact_refs: { type: "array", maxItems: 100 },
      log_ref: { type: "string" },
      base_revision: { type: "number", minimum: 1 },
      detail: { type: "object" },
      ...AUTH_PROPS
    },
    additionalProperties: false
  }
});

export const EXECUTION_RECEIPT_GET_TOOL_DEFINITION = Object.freeze({
  name: ENVIRONMENT_SANDBOX_BROKER_TOOL_IDS.execution_receipt_get,
  description: "V7.7.7e: read immutable cairnstone-execution-receipt-v1. Requires ls. Evidence of sandbox-local run only — never production/deploy authority.",
  inputSchema: {
    type: "object",
    required: ["receipt_id", "actor_id", "workspace_capability"],
    properties: {
      receipt_id: { type: "string" },
      ...AUTH_PROPS
    },
    additionalProperties: false
  }
});

export const EXECUTION_RECEIPT_LIST_TOOL_DEFINITION = Object.freeze({
  name: ENVIRONMENT_SANDBOX_BROKER_TOOL_IDS.execution_receipt_list,
  description: "V7.7.7e: list recent immutable execution receipts for a Code Session (newest-first, bounded). Requires ls.",
  inputSchema: {
    type: "object",
    required: ["code_session_id", "actor_id", "workspace_capability"],
    properties: {
      code_session_id: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: 100 },
      ...AUTH_PROPS
    },
    additionalProperties: false
  }
});

export const ENVIRONMENT_SANDBOX_MCP_TOOL_DEFINITIONS = Object.freeze([
  ENVIRONMENT_MANIFEST_CREATE_TOOL_DEFINITION,
  ENVIRONMENT_MANIFEST_GET_TOOL_DEFINITION,
  CODE_SESSION_ATTACH_ENVIRONMENT_TOOL_DEFINITION,
  CODE_SESSION_SANDBOX_ATTACH_TOOL_DEFINITION,
  CODE_SESSION_SANDBOX_DETACH_TOOL_DEFINITION,
  CODE_SESSION_SANDBOX_GET_TOOL_DEFINITION,
  EXECUTION_RECEIPT_CREATE_TOOL_DEFINITION,
  EXECUTION_RECEIPT_GET_TOOL_DEFINITION,
  EXECUTION_RECEIPT_LIST_TOOL_DEFINITION
]);
