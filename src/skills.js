const DEFAULT_SKILLS_CHAIN = "cairnstone-v6-skills";
const DEFAULT_MANIFEST_PATH = "skills/manifest.json";
const MAX_SKILLS = 10;
const MAX_SKILL_BYTES = 100000;

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
