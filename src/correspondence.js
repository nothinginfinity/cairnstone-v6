const MESSAGE_SCHEMA = "cairnstone-message-v1";
const MESSAGE_TYPE = "correspondence";
const ALLOWED_INTENTS = new Set(["message", "handoff", "task_request", "task_result", "ack"]);
const ALLOWED_PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const ALLOWED_STATUSES = new Set(["queued", "delivered", "read", "acked", "archived"]);
const MAX_MESSAGE_BYTES = 900000;
const MAX_RECIPIENTS = 25;
const HANDOFF_SCHEMA = "cairnstone-handoff-v1";
const GITHUB_INBOX_MIRROR_SCHEMA = "cairnstone-github-inbox-mirror-v1";
const DEFAULT_GITHUB_INBOX_BRANCH = "main";
const DEFAULT_GITHUB_INBOX_PREFIX = "cairnstone-inbox";
const MAX_HANDOFF_TASK_BYTES = 24000;
const MAX_HANDOFF_REFS = 25;

export const HANDOFF_DISPATCH_TOOL_DEFINITION = {
  name: "cairnstone_dispatch_handoff",
  description: "V7.2: package and dispatch one compact provenance-bearing handoff through immutable AC1 correspondence. Carries task/chain/package identity, continuation stone refs, and an optional immutable GitHub artifact pointer. Transport grants no execution, mutation, or accepted-state authority.",
  inputSchema: {
    type: "object",
    required: ["from", "to", "task", "chain"],
    properties: {
      from: { type: "string" },
      to: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 25 },
      task: { type: "string", description: "Bounded handoff task/instruction; grants no authority." },
      chain: { type: "string", maxLength: 300 },
      package_id: { type: "string", description: "Optional V7.0 sha256 package identity." },
      continuation_refs: {
        type: "array", maxItems: 25,
        items: {
          type: "object", required: ["stone_hash"],
          properties: { stone_hash: { type: "string" }, path: { type: "string" }, note: { type: "string" } },
          additionalProperties: false
        }
      },
      github_artifact: {
        type: "object", required: ["owner", "repo", "path", "commit_sha"],
        properties: {
          owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" },
          commit_sha: { type: "string", description: "Immutable 40-hex commit SHA; mutable refs are rejected." }
        },
        additionalProperties: false
      },
      github_inbox: {
        type: "object", required: ["owner", "repo"],
        description: "Optional external GitHub-backed transport mirror. AC1 remains authority; GitHub is an inspectable asynchronous mirror only.",
        properties: {
          owner: { type: "string" }, repo: { type: "string" },
          branch: { type: "string", description: "Transport branch. Defaults to main; it is never accepted-state authority." },
          path_prefix: { type: "string", description: "Directory prefix for deterministic per-recipient message files. Defaults to cairnstone-inbox." }
        },
        additionalProperties: false
      },
      message_id: { type: "string" }, thread_id: { type: "string" }, subject: { type: "string" },
      priority: { type: "string", enum: ["low", "normal", "high", "urgent"] }
    },
    additionalProperties: false
  }
};

export function createD1CorrespondenceStore(env) {
  if (!env?.CAIRNSTONE_DB) throw new Error("Missing D1 binding CAIRNSTONE_DB");

  return {
    async findByMessage(senderId, messageId) {
      const result = await env.CAIRNSTONE_DB.prepare(
        `SELECT * FROM correspondence_deliveries
         WHERE sender_id = ? AND message_id = ?
         ORDER BY recipient_id ASC`
      ).bind(senderId, messageId).all();
      return result?.results || [];
    },

    async insertDeliveries(rows) {
      if (!rows.length) return [];
      const statements = rows.map(row => env.CAIRNSTONE_DB.prepare(
        `INSERT INTO correspondence_deliveries
           (id,stone_hash,message_id,message_fingerprint,recipient_id,sender_id,thread_id,status,created_at,delivered_at,read_at,acked_at,archived_at,claimed_by,claimed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(sender_id,message_id,recipient_id) DO NOTHING`
      ).bind(
        row.id,
        row.stone_hash,
        row.message_id,
        row.message_fingerprint,
        row.recipient_id,
        row.sender_id,
        row.thread_id,
        row.status,
        row.created_at,
        row.delivered_at,
        row.read_at,
        row.acked_at,
        row.archived_at,
        row.claimed_by,
        row.claimed_at
      ));
      await env.CAIRNSTONE_DB.batch(statements);
      return this.findByMessage(rows[0].sender_id, rows[0].message_id);
    },

    async listInbox(recipientId, options = {}) {
      const limit = clamp(Number(options.limit || 50), 1, 200);
      const status = options.status || null;
      const sql = status
        ? `SELECT d.*, s.stone_json
           FROM correspondence_deliveries d
           JOIN stones s ON s.hash = d.stone_hash
           WHERE d.recipient_id = ? AND d.status = ?
           ORDER BY d.created_at DESC LIMIT ?`
        : `SELECT d.*, s.stone_json
           FROM correspondence_deliveries d
           JOIN stones s ON s.hash = d.stone_hash
           WHERE d.recipient_id = ?
           ORDER BY d.created_at DESC LIMIT ?`;
      const stmt = env.CAIRNSTONE_DB.prepare(sql);
      const result = status
        ? await stmt.bind(recipientId, status, limit).all()
        : await stmt.bind(recipientId, limit).all();
      return result?.results || [];
    },

    async getDelivery(recipientId, selector) {
      if (selector.message_id) {
        return env.CAIRNSTONE_DB.prepare(
          `SELECT * FROM correspondence_deliveries
           WHERE recipient_id = ? AND message_id = ?
           ORDER BY created_at DESC LIMIT 1`
        ).bind(recipientId, selector.message_id).first();
      }
      return env.CAIRNSTONE_DB.prepare(
        `SELECT * FROM correspondence_deliveries
         WHERE recipient_id = ? AND stone_hash = ?
         ORDER BY created_at DESC LIMIT 1`
      ).bind(recipientId, selector.stone_hash).first();
    },

    async markRead(deliveryId, readAt) {
      await env.CAIRNSTONE_DB.prepare(
        `UPDATE correspondence_deliveries
         SET status = CASE WHEN status IN ('queued','delivered') THEN 'read' ELSE status END,
             delivered_at = COALESCE(delivered_at, ?),
             read_at = COALESCE(read_at, ?)
         WHERE id = ?`
      ).bind(readAt, readAt, deliveryId).run();
      return env.CAIRNSTONE_DB.prepare(
        "SELECT * FROM correspondence_deliveries WHERE id = ?"
      ).bind(deliveryId).first();
    },

    async getStoneRecord(stoneHash) {
      return env.CAIRNSTONE_DB.prepare(
        "SELECT hash, raw_key, stone_json FROM stones WHERE hash = ?"
      ).bind(stoneHash).first();
    }
  };
}

export function createCorrespondenceService({
  store,
  createStone,
  readRaw,
  now = () => new Date().toISOString(),
  randomUUID = () => crypto.randomUUID(),
  hash = sha256,
  mirrorHandoff = null
}) {
  if (!store) throw new Error("Missing correspondence store");
  if (typeof createStone !== "function") throw new Error("Missing createStone dependency");
  if (typeof readRaw !== "function") throw new Error("Missing readRaw dependency");

  return {
    async sendMessage(body = {}) {
      const senderId = actorId(body.from, "from");
      const recipients = recipientIds(body.to);
      const content = messageContent(body.content);
      const messageId = opaqueId(body.message_id || `msg:${randomUUID()}`, "message_id");
      const threadId = opaqueId(body.thread_id || messageId, "thread_id");
      const intent = body.intent === undefined ? "message" : String(body.intent);
      const priority = body.priority === undefined ? "normal" : String(body.priority);
      if (!ALLOWED_INTENTS.has(intent)) return { ok: false, error: "invalid_intent", allowed: [...ALLOWED_INTENTS] };
      if (!ALLOWED_PRIORITIES.has(priority)) return { ok: false, error: "invalid_priority", allowed: [...ALLOWED_PRIORITIES] };
      const subject = optionalText(body.subject, "subject", 500);

      const contract = {
        type: MESSAGE_TYPE,
        schema: MESSAGE_SCHEMA,
        message_id: messageId,
        from: senderId,
        to: recipients,
        thread_id: threadId,
        intent,
        priority,
        subject
      };
      const fingerprint = await hash(stableJson({ ...contract, content }));
      const existing = await store.findByMessage(senderId, messageId);

      if (existing.length) {
        const hashes = [...new Set(existing.map(row => row.stone_hash))];
        const fingerprints = [...new Set(existing.map(row => row.message_fingerprint))];
        const existingRecipients = [...new Set(existing.map(row => row.recipient_id))].sort();
        if (hashes.length !== 1 || fingerprints.length !== 1 || fingerprints[0] !== fingerprint || !sameStrings(existingRecipients, recipients)) {
          return {
            ok: false,
            error: "idempotency_conflict",
            message_id: messageId,
            sender_id: senderId,
            detail: "message_id already exists with different content, metadata, recipients, or stone identity"
          };
        }
        return {
          ok: true,
          idempotent_replay: true,
          message_id: messageId,
          thread_id: threadId,
          stone_hash: hashes[0],
          deliveries: existing.map(deliveryCard)
        };
      }

      const created = await createStone({
        title: subject || `Message from ${senderId}`,
        author: senderId,
        content,
        path: `correspondence/${safePathSegment(messageId)}.txt`,
        metadata: {
          type: MESSAGE_TYPE,
          schema: MESSAGE_SCHEMA,
          correspondence: { ...contract, message_fingerprint: fingerprint }
        },
        set_as_head: false
      });
      if (!created?.ok) return created || { ok: false, error: "message_stone_create_failed" };

      const createdAt = now();
      const rows = [];
      for (const recipientId of recipients) {
        rows.push({
          id: await hash(`delivery:${created.stone_hash}:${recipientId}`),
          stone_hash: created.stone_hash,
          message_id: messageId,
          message_fingerprint: fingerprint,
          recipient_id: recipientId,
          sender_id: senderId,
          thread_id: threadId,
          status: "delivered",
          created_at: createdAt,
          delivered_at: createdAt,
          read_at: null,
          acked_at: null,
          archived_at: null,
          claimed_by: null,
          claimed_at: null
        });
      }
      const deliveries = await store.insertDeliveries(rows);
      return {
        ok: true,
        idempotent_replay: false,
        message_id: messageId,
        thread_id: threadId,
        stone_hash: created.stone_hash,
        recipients,
        deliveries: deliveries.map(deliveryCard),
        immutable_message_stone: true,
        chain_head_written: false
      };
    },

    async dispatchHandoff(body = {}) {
      const senderId = actorId(body.from, "from");
      const recipients = recipientIds(body.to);
      const task = boundedText(body.task, "task", MAX_HANDOFF_TASK_BYTES);
      const chain = opaqueId(body.chain, "chain");
      const packageId = normalizePackageId(body.package_id);
      const continuationRefs = normalizeContinuationRefs(body.continuation_refs);
      const githubArtifact = normalizeGitHubArtifact(body.github_artifact);
      const githubInbox = normalizeGitHubInboxTarget(body.github_inbox);
      const messageId = opaqueId(body.message_id || `msg:${randomUUID()}`, "message_id");
      const threadId = opaqueId(body.thread_id || messageId, "thread_id");
      const priority = body.priority === undefined ? "normal" : String(body.priority);
      if (!ALLOWED_PRIORITIES.has(priority)) return { ok: false, error: "invalid_priority", allowed: [...ALLOWED_PRIORITIES] };
      const subject = optionalText(body.subject, "subject", 500) || "CairnStone V7 handoff";
      const handoff = {
        schema: HANDOFF_SCHEMA,
        from: senderId,
        to: recipients,
        thread_id: threadId,
        task,
        chain,
        package_id: packageId,
        continuation_refs: continuationRefs,
        github_artifact: githubArtifact,
        github_inbox: githubInbox,
        policy: handoffPolicy()
      };
      const sent = await this.sendMessage({
        from: senderId, to: recipients, content: stableJson(handoff), message_id: messageId, thread_id: threadId,
        intent: "handoff", priority, subject
      });
      if (!sent?.ok) return sent;
      const out = {
        ...sent,
        handoff: {
          schema: HANDOFF_SCHEMA, chain, package_id: packageId, continuation_ref_count: continuationRefs.length,
          github_artifact: githubArtifact, github_inbox: githubInbox, policy: handoffPolicy()
        }
      };
      if (githubInbox) {
        if (typeof mirrorHandoff !== "function") {
          out.github_inbox_mirror = {
            ok: false,
            error: "github_inbox_mirror_unavailable",
            isolated: true,
            ac1_message_preserved: true,
            stone_hash: sent.stone_hash
          };
        } else {
          try {
            out.github_inbox_mirror = await mirrorHandoff({ target: githubInbox, handoff, sent, subject, priority });
          } catch (error) {
            out.github_inbox_mirror = {
              ok: false,
              error: "github_inbox_mirror_failed",
              detail: String(error && error.message ? error.message : error),
              isolated: true,
              ac1_message_preserved: true,
              stone_hash: sent.stone_hash
            };
          }
        }
      }
      return out;
    },

    async getInbox(body = {}) {
      const recipientId = actorId(body.recipient_id, "recipient_id");
      const status = body.status === undefined ? null : String(body.status);
      if (status && !ALLOWED_STATUSES.has(status)) return { ok: false, error: "invalid_status", allowed: [...ALLOWED_STATUSES] };
      const rows = await store.listInbox(recipientId, { status, limit: body.limit });
      return {
        ok: true,
        recipient_id: recipientId,
        total: rows.length,
        messages: rows.map(inboxCard)
      };
    },

    async readMessage(body = {}) {
      const recipientId = actorId(body.recipient_id, "recipient_id");
      const messageId = body.message_id ? opaqueId(body.message_id, "message_id") : null;
      const stoneHash = body.stone_hash ? opaqueId(body.stone_hash, "stone_hash") : null;
      if (Boolean(messageId) === Boolean(stoneHash)) {
        return { ok: false, error: "message_selector_required", detail: "Pass exactly one of message_id or stone_hash." };
      }

      const delivery = await store.getDelivery(recipientId, { message_id: messageId, stone_hash: stoneHash });
      if (!delivery) return { ok: false, error: "message_not_found", recipient_id: recipientId };
      const stoneRecord = await store.getStoneRecord(delivery.stone_hash);
      if (!stoneRecord) return { ok: false, error: "message_stone_not_found", stone_hash: delivery.stone_hash };

      const stone = parseStone(stoneRecord.stone_json);
      const rawKey = stoneRecord.raw_key || stone?.layers?.lod1?.raw_key;
      if (!rawKey) return { ok: false, error: "message_raw_key_missing", stone_hash: delivery.stone_hash };
      const content = await readRaw(rawKey);
      if (content === null || content === undefined) return { ok: false, error: "message_raw_not_found", raw_key: rawKey };

      const updatedDelivery = await store.markRead(delivery.id, now());
      return {
        ok: true,
        message_id: delivery.message_id,
        thread_id: delivery.thread_id,
        stone_hash: delivery.stone_hash,
        content,
        metadata: stone?.metadata?.correspondence || null,
        lod5: stone?.layers?.lod5 || "",
        delivery: deliveryCard(updatedDelivery || delivery),
        immutable_message_stone: true,
        mutation_scope: "delivery_state_only"
      };
    }
  };
}

export async function sendMessageFromBody(body, env, deps = {}) {
  const service = createRuntimeService(env, deps);
  return service.sendMessage(body);
}

export async function dispatchHandoffFromBody(body, env, deps = {}) {
  const service = createRuntimeService(env, deps);
  return service.dispatchHandoff(body);
}

export async function getInboxFromBody(body, env, deps = {}) {
  const service = createRuntimeService(env, deps);
  return service.getInbox(body);
}

export async function readMessageFromBody(body, env, deps = {}) {
  const service = createRuntimeService(env, deps);
  return service.readMessage(body);
}

function createRuntimeService(env, deps) {
  if (!env?.CAIRNSTONE_RAW) throw new Error("Missing R2 binding CAIRNSTONE_RAW");
  const store = deps.store || createD1CorrespondenceStore(env);
  const createStone = deps.createStone;
  if (typeof createStone !== "function") throw new Error("Missing createStone dependency");
  const readRaw = deps.readRaw || (async rawKey => {
    const object = await env.CAIRNSTONE_RAW.get(rawKey);
    return object ? object.text() : null;
  });
  const mirrorHandoff = deps.mirrorHandoff || (env.GITHUB_TOKEN ? createGitHubInboxMirror(env, { fetchFn: deps.fetchFn }) : null);
  return createCorrespondenceService({ store, createStone, readRaw, now: deps.now, randomUUID: deps.randomUUID, hash: deps.hash, mirrorHandoff });
}

function boundedText(value, name, maxBytes) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing required string: ${name}`);
  const text = value.trim();
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > maxBytes) throw new Error(`${name} too large: max ${maxBytes} bytes`);
  return text;
}

function normalizePackageId(value) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).trim();
  if (!/^sha256:[0-9a-f]{64}$/i.test(text)) throw new Error("Invalid package_id");
  return `sha256:${text.slice(7).toLowerCase()}`;
}

function normalizeContinuationRefs(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("Invalid continuation_refs");
  if (value.length > MAX_HANDOFF_REFS) throw new Error(`Too many continuation refs: max ${MAX_HANDOFF_REFS}`);
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Invalid continuation_refs[${index}]`);
    const stoneHash = String(item.stone_hash || "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(stoneHash)) throw new Error(`Invalid continuation_refs[${index}].stone_hash`);
    const path = optionalText(item.path, `continuation_refs[${index}].path`, 500);
    const note = optionalText(item.note, `continuation_refs[${index}].note`, 1000);
    return { stone_hash: stoneHash, path, note };
  });
}

function normalizeGitHubArtifact(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid github_artifact");
  const owner = githubPart(value.owner, "github_artifact.owner");
  const repo = githubPart(value.repo, "github_artifact.repo");
  const path = String(value.path || "").trim().replace(/^\/+/, "");
  if (!path || path.includes("..") || path.includes("\\")) throw new Error("Invalid github_artifact.path");
  const commitSha = String(value.commit_sha || "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error("Invalid github_artifact.commit_sha");
  return { owner, repo, path, commit_sha: commitSha };
}

function normalizeGitHubInboxTarget(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid github_inbox");
  const owner = githubPart(value.owner, "github_inbox.owner");
  const repo = githubPart(value.repo, "github_inbox.repo");
  const branch = String(value.branch || DEFAULT_GITHUB_INBOX_BRANCH).trim();
  if (!/^[A-Za-z0-9_./-]+$/.test(branch) || branch.includes("..")) throw new Error("Invalid github_inbox.branch");
  const pathPrefix = String(value.path_prefix || DEFAULT_GITHUB_INBOX_PREFIX).trim().replace(/^\/+|\/+$/g, "");
  if (!pathPrefix || pathPrefix.includes("..") || pathPrefix.includes("\\")) throw new Error("Invalid github_inbox.path_prefix");
  return { owner, repo, branch, path_prefix: pathPrefix };
}

function githubPart(value, name) {
  const text = String(value || "").trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(text)) throw new Error(`Invalid ${name}`);
  return text;
}

export function createGitHubInboxMirror(env, deps = {}) {
  const token = String(env?.GITHUB_TOKEN || "").trim();
  const fetchFn = deps.fetchFn || fetch;
  return async ({ target, handoff, sent, subject, priority }) => {
    if (!token) {
      return { ok: false, error: "github_token_unavailable", isolated: true, ac1_message_preserved: true, stone_hash: sent.stone_hash };
    }
    const artifacts = [];
    const failures = [];
    for (const recipient of handoff.to) {
      const path = `${target.path_prefix}/${safePathSegment(recipient)}/${safePathSegment(sent.message_id)}.json`;
      const payload = JSON.stringify({
        schema: GITHUB_INBOX_MIRROR_SCHEMA,
        authority: "ac1_message_stone",
        ac1: {
          message_id: sent.message_id,
          thread_id: sent.thread_id,
          stone_hash: sent.stone_hash,
          immutable_message_stone: true
        },
        envelope: { subject, priority, recipient },
        handoff,
        policy: {
          transport_mirror_only: true,
          execution_authority: false,
          mutation_authority: false,
          accepted_state_authority: false
        }
      }, null, 2) + "\n";
      const result = await putGitHubMirrorFile({ target, path, payload, token, fetchFn, messageId: sent.message_id });
      if (result.ok) artifacts.push({ recipient, ...result });
      else failures.push({ recipient, ...result });
    }
    return {
      ok: failures.length === 0,
      schema: GITHUB_INBOX_MIRROR_SCHEMA,
      authority: "ac1_message_stone",
      ac1_stone_hash: sent.stone_hash,
      artifacts,
      failures,
      isolated: failures.length > 0,
      ac1_message_preserved: true
    };
  };
}

async function putGitHubMirrorFile({ target, path, payload, token, fetchFn, messageId }) {
  const api = `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  const headers = {
    "User-Agent": "cairnstone-v6-worker",
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Authorization": `Bearer ${token}`
  };
  const existingResponse = await fetchFn(`${api}?ref=${encodeURIComponent(target.branch)}`, { headers });
  if (existingResponse.status === 200) {
    const existing = await existingResponse.json();
    const existingText = decodeBase64Utf8(existing.content || "");
    if (existingText !== payload) {
      return { ok: false, error: "github_inbox_mirror_conflict", status: 409, owner: target.owner, repo: target.repo, branch: target.branch, path };
    }
    const commitSha = await resolveGitHubTransportCommit(target, token, fetchFn);
    return {
      ok: true,
      idempotent_replay: true,
      owner: target.owner,
      repo: target.repo,
      branch: target.branch,
      path,
      blob_sha: existing.sha || null,
      commit_sha: commitSha,
      html_url: existing.html_url || null
    };
  }
  if (existingResponse.status !== 404) {
    return { ok: false, error: "github_inbox_lookup_failed", status: existingResponse.status, owner: target.owner, repo: target.repo, branch: target.branch, path };
  }

  const createdResponse = await fetchFn(api, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `CairnStone inbox mirror: ${messageId}`,
      content: encodeBase64Utf8(payload),
      branch: target.branch
    })
  });
  if (!createdResponse.ok) {
    return { ok: false, error: "github_inbox_write_failed", status: createdResponse.status, owner: target.owner, repo: target.repo, branch: target.branch, path };
  }
  const created = await createdResponse.json();
  return {
    ok: true,
    idempotent_replay: false,
    owner: target.owner,
    repo: target.repo,
    branch: target.branch,
    path,
    blob_sha: created.content?.sha || null,
    commit_sha: created.commit?.sha || null,
    html_url: created.content?.html_url || null
  };
}

async function resolveGitHubTransportCommit(target, token, fetchFn) {
  const url = `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/commits/${encodeURIComponent(target.branch)}`;
  const response = await fetchFn(url, {
    headers: {
      "User-Agent": "cairnstone-v6-worker",
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Authorization": `Bearer ${token}`
    }
  });
  if (!response.ok) return null;
  const data = await response.json();
  return typeof data?.sha === "string" ? data.sha : null;
}

function encodeBase64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64Utf8(value) {
  const binary = atob(String(value || "").replace(/\s+/g, ""));
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function handoffPolicy() {
  return { transport_only: true, execution_authority: false, mutation_authority: false, accepted_state_authority: false, external_mirror_authority: false };
}

function recipientIds(value) {
  const list = Array.isArray(value) ? value : [];
  if (!list.length) throw new Error("Missing required array: to");
  if (list.length > MAX_RECIPIENTS) throw new Error(`Too many recipients: max ${MAX_RECIPIENTS}`);
  return [...new Set(list.map((item, index) => actorId(item, `to[${index}]`)))].sort();
}

function actorId(value, name) {
  const text = opaqueId(value, name);
  if (!text.includes(":")) throw new Error(`Invalid actor id: ${name}`);
  if (!/^[A-Za-z][A-Za-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(text)) throw new Error(`Invalid actor id: ${name}`);
  return text;
}

function opaqueId(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing required string: ${name}`);
  const text = value.trim();
  if (text.length > 240 || /[\u0000-\u001f\u007f]/.test(text)) throw new Error(`Invalid identifier: ${name}`);
  return text;
}

function messageContent(value) {
  if (typeof value !== "string" || !value.length) throw new Error("Missing required string: content");
  const bytes = new TextEncoder().encode(value).length;
  if (bytes > MAX_MESSAGE_BYTES) throw new Error(`Message too large: max ${MAX_MESSAGE_BYTES} bytes`);
  return value;
}

function optionalText(value, name, maxLength) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`Invalid string: ${name}`);
  const text = value.trim();
  if (text.length > maxLength) throw new Error(`${name} too long`);
  return text || null;
}

function safePathSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 160) || "message";
}

function inboxCard(row) {
  const stone = parseStone(row.stone_json);
  const metadata = stone?.metadata?.correspondence || {};
  return {
    message_id: row.message_id,
    stone_hash: row.stone_hash,
    sender_id: row.sender_id,
    recipient_id: row.recipient_id,
    thread_id: row.thread_id,
    status: row.status,
    subject: metadata.subject || null,
    intent: metadata.intent || "message",
    priority: metadata.priority || "normal",
    lod5: stone?.layers?.lod5 || "",
    created_at: row.created_at,
    delivered_at: row.delivered_at,
    read_at: row.read_at
  };
}

function deliveryCard(row) {
  return {
    id: row.id,
    stone_hash: row.stone_hash,
    message_id: row.message_id,
    recipient_id: row.recipient_id,
    sender_id: row.sender_id,
    thread_id: row.thread_id,
    status: row.status,
    created_at: row.created_at,
    delivered_at: row.delivered_at,
    read_at: row.read_at
  };
}

function parseStone(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return null; }
}

function sameStrings(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

async function sha256(value) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
