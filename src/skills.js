const DEFAULT_SKILLS_CHAIN = "cairnstone-v6-skills";
const DEFAULT_MANIFEST_PATH = "skills/manifest.json";
const MAX_SKILLS = 10;
const MAX_SKILL_BYTES = 100000;
const DEFAULT_MAX_RECOMMENDED_SKILL_BYTES = 12000;
const DEFAULT_MAX_ESTIMATED_TOKENS = 2000;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SKILL_ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

export const SKILLS_TOOL_DEFINITIONS = [
  {
    name: "cairnstone_list_skills",
    description: "V6.9: list the compact, Git-versioned skill catalog from the accepted CairnStone skills manifest. Returns metadata only; it does not load full skill bodies.",
    inputSchema: {
      type: "object",
      properties: {
        chain: { type: "string", description: `Skills chain. Defaults to ${DEFAULT_SKILLS_CHAIN}.` },
        include_disabled: { type: "boolean" }
      },
      additionalProperties: false
    }
  },
  {
    name: "cairnstone_get_skill",
    description: "V6.9: load one accepted skill by id. The active version is selected by CairnStone path HEAD, then fetched from its immutable Git commit SHA; mutable Git branches are never used as authority.",
    inputSchema: {
      type: "object",
      required: ["skill_id"],
      properties: {
        skill_id: { type: "string" },
        chain: { type: "string", description: `Skills chain. Defaults to ${DEFAULT_SKILLS_CHAIN}.` }
      },
      additionalProperties: false
    }
  },
  {
    name: "cairnstone_get_skill_bundle",
    description: "V6.9.1: compile a provenance-bearing bundle of accepted skills. Every body is selected by CairnStone path HEAD and loaded from its immutable Git commit; the bundle is safe for downstream MCP caches because mutable branches are never authority.",
    inputSchema: {
      type: "object",
      required: ["skill_ids"],
      properties: {
        skill_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: MAX_SKILLS },
        chain: { type: "string", description: `Skills chain. Defaults to ${DEFAULT_SKILLS_CHAIN}.` }
      },
      additionalProperties: false
    }
  },
  {
    name: "cairnstone_lint_skills",
    description: "V6.9.2: deterministically lint the accepted skill catalog and its accepted path HEADs. Checks duplicate IDs/paths, semantic versions, canonical paths, dependencies/cycles, trigger collisions, tool references, skill size/token budgets, and accepted-state completeness. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        chain: { type: "string", description: `Skills chain. Defaults to ${DEFAULT_SKILLS_CHAIN}.` },
        available_tools: { type: "array", items: { type: "string" }, maxItems: 500 },
        max_recommended_bytes: { type: "number", minimum: 1000, maximum: MAX_SKILL_BYTES },
        max_estimated_tokens: { type: "number", minimum: 100, maximum: 10000 }
      },
      additionalProperties: false
    }
  },
  {
    name: "cairnstone_resolve_skills",
    description: "V6.9: deterministically recommend the smallest useful set of accepted skills for a task using manifest metadata, triggers, tags, tool requirements, and already-loaded skills. Returns recommendations; it does not execute them.",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: { type: "string" },
        chain: { type: "string", description: `Skills chain. Defaults to ${DEFAULT_SKILLS_CHAIN}.` },
        available_tools: { type: "array", items: { type: "string" }, maxItems: 250 },
        loaded_skills: { type: "array", items: { type: "string" }, maxItems: 100 },
        max_skills: { type: "number", minimum: 1, maximum: MAX_SKILLS }
      },
      additionalProperties: false
    }
  }
];

export async function listSkillsFromBody(body = {}, env) {
  const chain = optionalString(body.chain) || DEFAULT_SKILLS_CHAIN;
  const loaded = await loadAcceptedManifest(env, chain);
  if (!loaded.ok) return loaded;
  const includeDisabled = body.include_disabled === true;
  const skills = loaded.manifest.skills
    .filter(skill => includeDisabled || skill.enabled !== false)
    .map(compactSkill);
  return {
    ok: true,
    chain,
    manifest: loaded.provenance,
    manifest_version: loaded.manifest.version,
    boot: Array.isArray(loaded.manifest.boot) ? loaded.manifest.boot : [],
    total: skills.length,
    skills
  };
}

export async function getSkillFromBody(body = {}, env) {
  const skillId = requiredString(body.skill_id, "skill_id");
  const chain = optionalString(body.chain) || DEFAULT_SKILLS_CHAIN;
  const loaded = await loadAcceptedManifest(env, chain);
  if (!loaded.ok) return loaded;
  const skill = loaded.manifest.skills.find(item => item && item.id === skillId && item.enabled !== false);
  if (!skill) return { ok: false, error: "skill_not_found", chain, skill_id: skillId };
  const accepted = await acceptedPath(env, chain, skill.path);
  if (!accepted.ok) return { ...accepted, skill_id: skillId };
  const fetched = await fetchAcceptedGitHubText(env, accepted);
  if (!fetched.ok) return { ...fetched, skill_id: skillId };
  return {
    ok: true,
    chain,
    skill: compactSkill(skill),
    provenance: accepted.provenance,
    content: fetched.content
  };
}

export async function getSkillBundleFromBody(body = {}, env) {
  const chain = optionalString(body.chain) || DEFAULT_SKILLS_CHAIN;
  const skillIds = [...new Set(normalizeStringArray(body.skill_ids))].sort();
  if (!skillIds.length) return { ok: false, error: "skill_ids_required", chain };
  if (skillIds.length > MAX_SKILLS) return { ok: false, error: "too_many_skills", chain, max_skills: MAX_SKILLS };

  const loaded = await loadAcceptedManifest(env, chain);
  if (!loaded.ok) return loaded;
  const skills = [];
  for (const skillId of skillIds) {
    const skill = loaded.manifest.skills.find(item => item && item.id === skillId && item.enabled !== false);
    if (!skill) return { ok: false, error: "skill_not_found", chain, skill_id: skillId };
    const accepted = await acceptedPath(env, chain, skill.path);
    if (!accepted.ok) return { ...accepted, skill_id: skillId };
    const fetched = await fetchAcceptedGitHubText(env, accepted);
    if (!fetched.ok) return { ...fetched, skill_id: skillId };
    skills.push({
      skill_id: skill.id,
      skill_version: skill.version,
      title: skill.title,
      description: skill.description || "",
      path: skill.path,
      tags: Array.isArray(skill.tags) ? skill.tags : [],
      triggers: Array.isArray(skill.triggers) ? skill.triggers : [],
      requires_tools: Array.isArray(skill.requires_tools) ? skill.requires_tools : [],
      dependencies: Array.isArray(skill.dependencies) ? skill.dependencies : [],
      manifest_head: loaded.provenance.stone_hash,
      stone_hash: accepted.provenance.stone_hash,
      commit_sha: accepted.provenance.commit_sha,
      content_identity: fetched.content_identity,
      authority: "cairnstone_path_head",
      content: fetched.content
    });
  }

  const identityPayload = {
    schema: "cairnstone-accepted-skill-bundle-v1",
    chain,
    manifest_head: loaded.provenance.stone_hash,
    manifest_commit_sha: loaded.provenance.commit_sha,
    manifest_content_identity: loaded.content_identity,
    skills: skills.map(skill => ({
      skill_id: skill.skill_id,
      skill_version: skill.skill_version,
      stone_hash: skill.stone_hash,
      commit_sha: skill.commit_sha,
      content_identity: skill.content_identity
    }))
  };

  return {
    ok: true,
    schema: "cairnstone-accepted-skill-bundle-v1",
    chain,
    authority: "cairnstone_path_head",
    manifest_head: loaded.provenance.stone_hash,
    manifest: { ...loaded.provenance, content_identity: loaded.content_identity },
    bundle_identity: { algorithm: "sha256", sha256: await sha256Text(stableJson(identityPayload)) },
    skills
  };
}

export async function lintSkillsFromBody(body = {}, env) {
  const chain = optionalString(body.chain) || DEFAULT_SKILLS_CHAIN;
  const loaded = await loadAcceptedManifest(env, chain);
  if (!loaded.ok) return loaded;

  const bodies = {};
  const acceptedPaths = {};
  const runtimeIssues = [];
  for (const skill of loaded.manifest.skills) {
    if (!skill || typeof skill !== "object" || !optionalString(skill.path)) continue;
    const accepted = await acceptedPath(env, chain, skill.path);
    if (!accepted.ok) {
      if (accepted.error !== "accepted_skill_path_missing") runtimeIssues.push({ severity: "error", code: accepted.error, skill_id: optionalString(skill.id), path: skill.path });
      continue;
    }
    acceptedPaths[skill.path] = accepted.provenance;
    const fetched = await fetchAcceptedGitHubText(env, accepted);
    if (!fetched.ok) {
      runtimeIssues.push({ severity: "error", code: fetched.error, skill_id: optionalString(skill.id), path: skill.path });
      continue;
    }
    bodies[skill.path] = fetched.content;
  }

  const catalog = lintSkillCatalog({
    manifest: loaded.manifest,
    bodies,
    accepted_paths: acceptedPaths,
    available_tools: normalizeStringArray(body.available_tools),
    require_accepted_paths: true,
    max_recommended_bytes: clampNumber(body.max_recommended_bytes, DEFAULT_MAX_RECOMMENDED_SKILL_BYTES, 1000, MAX_SKILL_BYTES),
    max_estimated_tokens: clampNumber(body.max_estimated_tokens, DEFAULT_MAX_ESTIMATED_TOKENS, 100, 10000)
  });
  const issues = [...runtimeIssues, ...catalog.issues];
  const errorCount = issues.filter(issue => issue.severity === "error").length;
  const warningCount = issues.filter(issue => issue.severity === "warning").length;
  return {
    ok: true,
    valid: errorCount === 0,
    chain,
    mode: "accepted_state",
    authority: "cairnstone_path_head",
    manifest: loaded.provenance,
    total_skills: loaded.manifest.skills.length,
    summary: { errors: errorCount, warnings: warningCount, issues: issues.length },
    issues,
    policy: { mutable_branch_is_authority: false, accepted_state_required: true }
  };
}

export function lintSkillCatalog(options = {}) {
  const manifest = options.manifest;
  const bodies = options.bodies && typeof options.bodies === "object" ? options.bodies : {};
  const acceptedPaths = options.accepted_paths && typeof options.accepted_paths === "object" ? options.accepted_paths : {};
  const suppliedTools = new Set(normalizeStringArray(options.available_tools));
  const requireAcceptedPaths = options.require_accepted_paths === true;
  const requireBodies = options.require_bodies === true;
  const maxRecommendedBytes = clampNumber(options.max_recommended_bytes, DEFAULT_MAX_RECOMMENDED_SKILL_BYTES, 1000, MAX_SKILL_BYTES);
  const maxEstimatedTokens = clampNumber(options.max_estimated_tokens, DEFAULT_MAX_ESTIMATED_TOKENS, 100, 10000);
  const issues = [];
  const add = (severity, code, fields = {}) => issues.push({ severity, code, ...fields });

  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.skills)) {
    add("error", "manifest_invalid_shape");
    return { valid: false, summary: { errors: 1, warnings: 0, issues: 1 }, issues };
  }

  const registryTools = new Set(normalizeStringArray(manifest.tool_registry));
  const availableTools = suppliedTools.size ? suppliedTools : registryTools;
  for (const tool of registryTools) if (!isValidToolRefSyntax(tool)) add("error", "invalid_tool_registry_entry", { tool });

  const skills = manifest.skills;
  const idCounts = new Map();
  const pathCounts = new Map();
  const ids = new Set();
  for (const skill of skills) {
    const id = skill && optionalString(skill.id);
    const path = skill && optionalString(skill.path);
    if (id) { ids.add(id); idCounts.set(id, (idCounts.get(id) || 0) + 1); }
    if (path) pathCounts.set(path, (pathCounts.get(path) || 0) + 1);
  }

  for (const [id, count] of idCounts) if (count > 1) add("error", "duplicate_skill_id", { skill_id: id, count });
  for (const [path, count] of pathCounts) if (count > 1) add("error", "duplicate_skill_path", { path, count });

  const triggerOwners = new Map();
  for (let index = 0; index < skills.length; index += 1) {
    const skill = skills[index];
    if (!skill || typeof skill !== "object") { add("error", "skill_invalid_shape", { index }); continue; }
    const id = optionalString(skill.id);
    const path = optionalString(skill.path);
    if (!id) add("error", "skill_id_missing", { index });
    else if (!SKILL_ID_RE.test(id)) add("error", "skill_id_invalid", { skill_id: id });
    if (!optionalString(skill.version) || !SEMVER_RE.test(String(skill.version))) add("error", "skill_version_invalid_semver", { skill_id: id, version: skill.version || null });
    if (!path) add("error", "skill_path_missing", { skill_id: id });
    if (id && path) {
      const expectedPath = canonicalSkillPath(id);
      if (path !== expectedPath) add("error", "manifest_path_mismatch", { skill_id: id, path, expected_path: expectedPath });
    }

    for (const dependency of normalizeStringArray(skill.dependencies)) if (!ids.has(dependency)) add("error", "missing_dependency", { skill_id: id, dependency });

    for (const trigger of normalizeStringArray(skill.triggers)) {
      const normalizedTrigger = normalize(trigger);
      if (!normalizedTrigger) continue;
      if (!triggerOwners.has(normalizedTrigger)) triggerOwners.set(normalizedTrigger, []);
      triggerOwners.get(normalizedTrigger).push(id || `index:${index}`);
    }

    for (const tool of normalizeStringArray(skill.requires_tools)) {
      if (!isValidToolRefSyntax(tool)) add("error", "invalid_tool_reference", { skill_id: id, tool, reason: "invalid_syntax" });
      else if (availableTools.size && !availableTools.has(tool)) add("error", "invalid_tool_reference", { skill_id: id, tool, reason: "not_in_tool_registry" });
    }

    if (path) {
      const hasBody = Object.prototype.hasOwnProperty.call(bodies, path);
      const skillBody = hasBody ? bodies[path] : undefined;
      if (requireBodies && !hasBody) add("error", "skill_file_missing", { skill_id: id, path });
      if (hasBody && typeof skillBody !== "string") add("error", "skill_file_invalid", { skill_id: id, path });
      if (typeof skillBody === "string") {
        const bytes = new TextEncoder().encode(skillBody).length;
        if (bytes > MAX_SKILL_BYTES) add("error", "skill_too_large", { skill_id: id, path, bytes, max_bytes: MAX_SKILL_BYTES });
        else if (bytes > maxRecommendedBytes) add("warning", "skill_large", { skill_id: id, path, bytes, recommended_max_bytes: maxRecommendedBytes });
      }
      if (requireAcceptedPaths && !Object.prototype.hasOwnProperty.call(acceptedPaths, path)) add("error", "missing_accepted_path", { skill_id: id, path });
    }

    const estimatedTokens = Number(skill.estimated_tokens);
    if (Number.isFinite(estimatedTokens) && estimatedTokens > maxEstimatedTokens) add("warning", "estimated_tokens_large", { skill_id: id, estimated_tokens: estimatedTokens, recommended_max_tokens: maxEstimatedTokens });
  }

  for (const [trigger, owners] of triggerOwners) {
    const uniqueOwners = [...new Set(owners)];
    if (uniqueOwners.length > 1) add("warning", "trigger_collision", { trigger, skill_ids: uniqueOwners });
  }

  for (const bootId of normalizeStringArray(manifest.boot)) if (!ids.has(bootId)) add("error", "boot_skill_missing", { skill_id: bootId });
  for (const cycle of findDependencyCycles(skills)) add("error", "dependency_cycle", { cycle });

  const errorCount = issues.filter(issue => issue.severity === "error").length;
  const warningCount = issues.filter(issue => issue.severity === "warning").length;
  return { valid: errorCount === 0, summary: { errors: errorCount, warnings: warningCount, issues: issues.length }, issues };
}

export async function resolveSkillsFromBody(body = {}, env) {
  const task = requiredString(body.task, "task");
  const chain = optionalString(body.chain) || DEFAULT_SKILLS_CHAIN;
  const maxSkills = clampNumber(body.max_skills, 3, 1, MAX_SKILLS);
  const loadedIds = new Set(normalizeStringArray(body.loaded_skills));
  const availableTools = new Set(normalizeStringArray(body.available_tools));
  const loaded = await loadAcceptedManifest(env, chain);
  if (!loaded.ok) return loaded;

  const taskNorm = normalize(task);
  const taskTokens = new Set(tokenize(taskNorm));
  const boot = (Array.isArray(loaded.manifest.boot) ? loaded.manifest.boot : [])
    .filter(id => !loadedIds.has(id));

  const scored = loaded.manifest.skills
    .filter(skill => skill && skill.enabled !== false && !loadedIds.has(skill.id) && !boot.includes(skill.id))
    .map(skill => scoreSkill(skill, taskNorm, taskTokens, availableTools))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id))
    .slice(0, maxSkills);

  return {
    ok: true,
    chain,
    task,
    manifest: loaded.provenance,
    boot,
    recommendations: scored.map(({ skill, score, reasons, missing_tools }) => ({
      skill_id: skill.id,
      title: skill.title,
      path: skill.path,
      version: skill.version,
      score,
      reasons,
      missing_tools,
      dependencies: Array.isArray(skill.dependencies) ? skill.dependencies : []
    })),
    policy: {
      progressive_loading: true,
      accepted_state_only: true,
      mutable_branch_is_authority: false,
      max_skills: maxSkills
    }
  };
}

function scoreSkill(skill, taskNorm, taskTokens, availableTools) {
  let score = 0;
  const reasons = [];
  const triggers = normalizeStringArray(skill.triggers);
  for (const trigger of triggers) {
    const normalized = normalize(trigger);
    if (normalized && taskNorm.includes(normalized)) {
      score += 8;
      reasons.push(`trigger:${trigger}`);
    }
  }

  const metadataTokens = new Set(tokenize([
    skill.id,
    skill.title,
    skill.description,
    ...(Array.isArray(skill.tags) ? skill.tags : [])
  ].filter(Boolean).join(" ").toLowerCase()));
  let overlap = 0;
  for (const token of taskTokens) if (metadataTokens.has(token)) overlap += 1;
  if (overlap) {
    score += overlap * 2;
    reasons.push(`token_overlap:${overlap}`);
  }

  const requiredTools = normalizeStringArray(skill.requires_tools);
  const missingTools = availableTools.size
    ? requiredTools.filter(tool => !availableTools.has(tool))
    : [];
  if (availableTools.size && requiredTools.length && missingTools.length === 0) {
    score += 2;
    reasons.push("required_tools_available");
  }
  if (missingTools.length) {
    score = Math.max(0, score - Math.min(4, missingTools.length));
    reasons.push(`missing_tools:${missingTools.length}`);
  }

  return { skill, score, reasons, missing_tools: missingTools };
}

async function loadAcceptedManifest(env, chain) {
  requireBindings(env);
  const accepted = await acceptedPath(env, chain, DEFAULT_MANIFEST_PATH);
  if (!accepted.ok) return accepted;
  const fetched = await fetchAcceptedGitHubText(env, accepted);
  if (!fetched.ok) return fetched;
  let manifest;
  try {
    manifest = JSON.parse(fetched.content);
  } catch {
    return { ok: false, error: "skills_manifest_invalid_json", chain, path: DEFAULT_MANIFEST_PATH };
  }
  if (!manifest || !Array.isArray(manifest.skills)) {
    return { ok: false, error: "skills_manifest_invalid_shape", chain, path: DEFAULT_MANIFEST_PATH };
  }
  return { ok: true, manifest, provenance: accepted.provenance, content_identity: fetched.content_identity };
}

async function acceptedPath(env, chain, path) {
  requireBindings(env);
  const row = await env.CAIRNSTONE_DB.prepare(
    `SELECT ph.head_hash AS stone_hash, ph.updated_at AS accepted_at,
            s.repo AS repo, s.path AS path, s.commit_sha AS commit_sha, s.title AS title
     FROM path_heads ph
     JOIN stones s ON s.hash = ph.head_hash
     WHERE ph.chain = ? AND ph.path = ?`
  ).bind(chain, path).first();
  if (!row) return { ok: false, error: "accepted_skill_path_missing", chain, path };
  if (row.path !== path) return { ok: false, error: "accepted_skill_path_mismatch", chain, path, stone_path: row.path };
  if (!isCommitSha(row.commit_sha)) return { ok: false, error: "accepted_skill_commit_not_immutable", chain, path, commit_sha: row.commit_sha || null };
  if (!row.repo || !String(row.repo).includes("/")) return { ok: false, error: "accepted_skill_repo_missing", chain, path };
  return {
    ok: true,
    provenance: {
      stone_hash: row.stone_hash,
      accepted_at: row.accepted_at,
      repo: row.repo,
      path: row.path,
      commit_sha: row.commit_sha,
      title: row.title || null
    }
  };
}

async function fetchAcceptedGitHubText(env, accepted) {
  const provenance = accepted.provenance;
  const [owner, repo] = String(provenance.repo).split("/", 2);
  const encodedPath = String(provenance.path).split("/").map(encodeURIComponent).join("/");
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(provenance.commit_sha)}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "cairnstone-v6-skills"
    }
  });
  if (!response.ok) return { ok: false, error: "accepted_skill_github_fetch_failed", status: response.status, provenance };
  const data = await response.json();
  if (!data || data.encoding !== "base64" || typeof data.content !== "string") {
    return { ok: false, error: "accepted_skill_github_response_invalid", provenance };
  }
  const content = decodeBase64Utf8(data.content.replace(/\s+/g, ""));
  const bytes = new TextEncoder().encode(content).length;
  if (bytes > MAX_SKILL_BYTES) return { ok: false, error: "accepted_skill_too_large", bytes, provenance };
  return {
    ok: true,
    content,
    content_identity: {
      sha256: await sha256Text(content),
      git_blob_sha: /^[0-9a-f]{40}$/i.test(String(data.sha || "")) ? String(data.sha).toLowerCase() : null,
      bytes
    }
  };
}

function decodeBase64Utf8(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function canonicalSkillPath(skillId) {
  return `skills/${String(skillId).split(".").join("/")}/SKILL.md`;
}

function isValidToolRefSyntax(tool) {
  const value = String(tool || "").trim();
  if (/^cairnstone_[a-z0-9_]+$/.test(value)) return true;
  return /^[^.\n]+\.[A-Za-z0-9_]+$/.test(value);
}

function findDependencyCycles(skills) {
  const graph = new Map();
  for (const skill of skills) {
    const id = skill && optionalString(skill.id);
    if (id) graph.set(id, normalizeStringArray(skill.dependencies));
  }
  const visited = new Set();
  const visiting = new Set();
  const stack = [];
  const cycles = [];
  const seen = new Set();
  const visit = id => {
    if (visited.has(id)) return;
    visiting.add(id);
    stack.push(id);
    for (const dependency of graph.get(id) || []) {
      if (!graph.has(dependency)) continue;
      if (visiting.has(dependency)) {
        const start = stack.indexOf(dependency);
        const cycle = [...stack.slice(start), dependency];
        const key = cycle.join("->");
        if (!seen.has(key)) { seen.add(key); cycles.push(cycle); }
      } else if (!visited.has(dependency)) visit(dependency);
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) if (!visited.has(id)) visit(id);
  return cycles;
}

function compactSkill(skill) {
  return {
    id: skill.id,
    title: skill.title,
    version: skill.version,
    status: skill.status || "stable",
    description: skill.description || "",
    path: skill.path,
    tags: Array.isArray(skill.tags) ? skill.tags : [],
    triggers: Array.isArray(skill.triggers) ? skill.triggers : [],
    requires_tools: Array.isArray(skill.requires_tools) ? skill.requires_tools : [],
    dependencies: Array.isArray(skill.dependencies) ? skill.dependencies : [],
    estimated_tokens: Number.isFinite(Number(skill.estimated_tokens)) ? Number(skill.estimated_tokens) : null,
    enabled: skill.enabled !== false
  };
}

function normalize(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function tokenize(value) {
  return normalize(value).match(/[a-z0-9_]+/g) || [];
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === "string" && item.trim()).map(item => item.trim()) : [];
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredString(value, field) {
  const out = optionalString(value);
  if (!out) throw new Error(`${field} is required`);
  return out;
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function isCommitSha(value) {
  return /^[0-9a-f]{40}$/i.test(String(value || ""));
}

async function sha256Text(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requireBindings(env) {
  if (!env || !env.CAIRNSTONE_DB) throw new Error("CAIRNSTONE_DB binding missing");
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN binding missing");
}
