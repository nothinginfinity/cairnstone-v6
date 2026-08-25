import assert from "node:assert/strict";
import { test } from "node:test";
import { createCorrespondenceService } from "../src/correspondence.js";

function makeHarness(options = {}) {
  const deliveries = [];
  const stones = new Map();
  const raw = new Map();
  let stoneCreates = 0;
  let tick = 0;

  const store = {
    async findByMessage(senderId, messageId) {
      return deliveries.filter(row => row.sender_id === senderId && row.message_id === messageId).sort((a, b) => a.recipient_id.localeCompare(b.recipient_id));
    },
    async insertDeliveries(rows) {
      for (const row of rows) {
        const exists = deliveries.some(existing => existing.sender_id === row.sender_id && existing.message_id === row.message_id && existing.recipient_id === row.recipient_id);
        if (!exists) deliveries.push({ ...row });
      }
      return this.findByMessage(rows[0].sender_id, rows[0].message_id);
    },
    async listInbox(recipientId, options = {}) {
      return deliveries
        .filter(row => row.recipient_id === recipientId && (!options.status || row.status === options.status))
        .slice(0, options.limit || 50)
        .map(row => ({ ...row, stone_json: stones.get(row.stone_hash).stone_json }));
    },
    async getDelivery(recipientId, selector) {
      return deliveries.find(row => row.recipient_id === recipientId && (selector.message_id ? row.message_id === selector.message_id : row.stone_hash === selector.stone_hash)) || null;
    },
    async markRead(id, readAt) {
      const row = deliveries.find(item => item.id === id);
      if (!row) return null;
      if (row.status === "queued" || row.status === "delivered") row.status = "read";
      row.delivered_at ||= readAt;
      row.read_at ||= readAt;
      return { ...row };
    },
    async getStoneRecord(stoneHash) {
      return stones.get(stoneHash) || null;
    }
  };

  const service = createCorrespondenceService({
    store,
    async createStone(body) {
      stoneCreates += 1;
      const stoneHash = `stone-${stoneCreates}`;
      const rawKey = `raw/${stoneHash}.txt`;
      const stone = {
        border: {
          hash: stoneHash,
          title: body.title,
          author: body.author,
          path: body.path,
          chain: body.chain || null
        },
        metadata: body.metadata,
        layers: {
          lod5: `${body.title}: compact correspondence message`,
          lod1: { raw_key: rawKey }
        }
      };
      stones.set(stoneHash, { hash: stoneHash, raw_key: rawKey, stone_json: JSON.stringify(stone) });
      raw.set(rawKey, body.content);
      return { ok: true, stone_hash: stoneHash, stone, input: body };
    },
    async readRaw(rawKey) {
      return raw.get(rawKey) ?? null;
    },
    now() {
      tick += 1;
      return `2026-08-21T02:00:0${tick}.000Z`;
    },
    randomUUID() {
      return "generated-message-id";
    },
    async hash(value) {
      return `hash:${value}`;
    },
    mirrorHandoff: options.mirrorHandoff || null
  });

  return { service, deliveries, stones, raw, get stoneCreates() { return stoneCreates; } };
}

test("AC1 Agent A -> immutable message stone -> Agent B inbox -> read", async () => {
  const h = makeHarness();
  const message = {
    message_id: "msg:ac1-proof",
    from: "agent:chatgpt:jared",
    to: ["agent:claude:jared"],
    subject: "AC1 mailbox proof",
    content: "One immutable message body.",
    intent: "handoff",
    priority: "normal"
  };

  const sent = await h.service.sendMessage(message);
  assert.equal(sent.ok, true);
  assert.equal(sent.idempotent_replay, false);
  assert.equal(sent.stone_hash, "stone-1");
  assert.equal(sent.chain_head_written, false);
  assert.equal(h.stoneCreates, 1);
  assert.equal(h.deliveries.length, 1);

  const storedBefore = structuredClone(h.stones.get(sent.stone_hash));
  const inbox = await h.service.getInbox({ recipient_id: "agent:claude:jared" });
  assert.equal(inbox.ok, true);
  assert.equal(inbox.total, 1);
  assert.equal(inbox.messages[0].stone_hash, sent.stone_hash);
  assert.equal(inbox.messages[0].status, "delivered");
  assert.match(inbox.messages[0].lod5, /compact correspondence message/);

  const read = await h.service.readMessage({ recipient_id: "agent:claude:jared", message_id: "msg:ac1-proof" });
  assert.equal(read.ok, true);
  assert.equal(read.content, message.content);
  assert.equal(read.stone_hash, sent.stone_hash);
  assert.equal(read.delivery.status, "read");
  assert.equal(read.mutation_scope, "delivery_state_only");
  assert.deepEqual(h.stones.get(sent.stone_hash), storedBefore, "reading must not mutate the message stone");
  assert.equal(h.deliveries[0].status, "read");
});

test("V7.2 handoff dispatch creates a compact immutable AC1 package with zero authority", async () => {
  const h = makeHarness();
  const packageId = `sha256:${"a".repeat(64)}`;
  const continuationStone = "b".repeat(64);
  const commitSha = "c".repeat(40);
  const handoff = {
    message_id: "msg:v72-handoff",
    from: "agent:chatgpt:jared",
    to: ["agent:claude:jared"],
    task: "Continue the bounded V7.2 Console work.",
    chain: "cairnstone-v6-project-memory",
    package_id: packageId,
    continuation_refs: [{ stone_hash: continuationStone, path: "project-memory/v72-read-only-delegation-live.md", note: "Canonical continuation" }],
    github_artifact: { owner: "nothinginfinity", repo: "cairnstone-v6", path: "docs/ROADMAP_V7.md", commit_sha: commitSha },
    priority: "high"
  };

  const sent = await h.service.dispatchHandoff(handoff);
  assert.equal(sent.ok, true);
  assert.equal(sent.idempotent_replay, false);
  assert.equal(sent.chain_head_written, false);
  assert.equal(sent.handoff.schema, "cairnstone-handoff-v1");
  assert.equal(sent.handoff.package_id, packageId);
  assert.equal(sent.handoff.continuation_ref_count, 1);
  assert.equal(sent.handoff.policy.execution_authority, false);
  assert.equal(sent.handoff.policy.mutation_authority, false);
  assert.equal(sent.handoff.policy.accepted_state_authority, false);
  assert.equal(h.stoneCreates, 1);

  const inbox = await h.service.getInbox({ recipient_id: "agent:claude:jared" });
  assert.equal(inbox.total, 1);
  assert.equal(inbox.messages[0].intent, "handoff");
  assert.equal(inbox.messages[0].priority, "high");

  const read = await h.service.readMessage({ recipient_id: "agent:claude:jared", message_id: "msg:v72-handoff" });
  const payload = JSON.parse(read.content);
  assert.equal(payload.schema, "cairnstone-handoff-v1");
  assert.equal(payload.chain, "cairnstone-v6-project-memory");
  assert.equal(payload.package_id, packageId);
  assert.equal(payload.continuation_refs[0].stone_hash, continuationStone);
  assert.equal(payload.github_artifact.commit_sha, commitSha);
  assert.equal(payload.policy.transport_only, true);
  assert.equal(payload.policy.execution_authority, false);
  assert.equal(payload.policy.mutation_authority, false);
  assert.equal(payload.policy.accepted_state_authority, false);
});

test("V7.2 handoff dispatch is idempotent and rejects mutable GitHub artifact refs", async () => {
  const h = makeHarness();
  const base = {
    message_id: "msg:v72-replay",
    from: "agent:chatgpt:jared",
    to: ["agent:claude:jared"],
    task: "Continue V7.2.",
    chain: "cairnstone-v6-project-memory",
    github_artifact: { owner: "nothinginfinity", repo: "cairnstone-v6", path: "docs/ROADMAP_V7.md", commit_sha: "d".repeat(40) }
  };
  const first = await h.service.dispatchHandoff(base);
  const replay = await h.service.dispatchHandoff(base);
  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.stone_hash, first.stone_hash);
  assert.equal(h.stoneCreates, 1);

  await assert.rejects(
    () => h.service.dispatchHandoff({ ...base, message_id: "msg:v72-bad-ref", github_artifact: { ...base.github_artifact, commit_sha: "main" } }),
    /Invalid github_artifact\.commit_sha/
  );
  assert.equal(h.stoneCreates, 1);
});

test("V7.2 optional GitHub inbox mirror is explicit and remains non-authoritative", async () => {
  let mirrored = null;
  const h = makeHarness({
    async mirrorHandoff(input) {
      mirrored = input;
      return {
        ok: true,
        schema: "cairnstone-github-inbox-mirror-v1",
        authority: "ac1_message_stone",
        ac1_stone_hash: input.sent.stone_hash,
        artifacts: [{ recipient: input.handoff.to[0], path: "cairnstone-inbox/agent_claude_jared/msg_v72-mirror.json", commit_sha: "e".repeat(40) }],
        failures: [],
        isolated: false,
        ac1_message_preserved: true
      };
    }
  });
  const sent = await h.service.dispatchHandoff({
    message_id: "msg:v72-mirror",
    from: "agent:chatgpt:jared",
    to: ["agent:claude:jared"],
    task: "Mirror this bounded handoff asynchronously.",
    chain: "cairnstone-v6-project-memory",
    github_inbox: { owner: "nothinginfinity", repo: "cairnstone-v6-console", branch: "main", path_prefix: "cairnstone-inbox" }
  });

  assert.equal(sent.ok, true);
  assert.equal(sent.github_inbox_mirror.ok, true);
  assert.equal(sent.github_inbox_mirror.authority, "ac1_message_stone");
  assert.equal(sent.github_inbox_mirror.ac1_stone_hash, sent.stone_hash);
  assert.equal(mirrored.target.repo, "cairnstone-v6-console");
  assert.equal(mirrored.handoff.policy.external_mirror_authority, false);
  assert.equal(mirrored.handoff.github_inbox.path_prefix, "cairnstone-inbox");

  const read = await h.service.readMessage({ recipient_id: "agent:claude:jared", message_id: "msg:v72-mirror" });
  const payload = JSON.parse(read.content);
  assert.equal(payload.github_inbox.repo, "cairnstone-v6-console");
  assert.equal(payload.policy.execution_authority, false);
  assert.equal(payload.policy.mutation_authority, false);
  assert.equal(payload.policy.accepted_state_authority, false);
  assert.equal(payload.policy.external_mirror_authority, false);
});

test("V7.2 GitHub inbox mirror failure is isolated from the canonical AC1 handoff", async () => {
  const h = makeHarness({
    async mirrorHandoff() {
      throw new Error("mirror transport unavailable");
    }
  });
  const sent = await h.service.dispatchHandoff({
    message_id: "msg:v72-mirror-failure",
    from: "agent:chatgpt:jared",
    to: ["agent:claude:jared"],
    task: "Preserve AC1 even if the external mirror fails.",
    chain: "cairnstone-v6-project-memory",
    github_inbox: { owner: "nothinginfinity", repo: "cairnstone-v6-console" }
  });

  assert.equal(sent.ok, true);
  assert.equal(sent.github_inbox_mirror.ok, false);
  assert.equal(sent.github_inbox_mirror.error, "github_inbox_mirror_failed");
  assert.equal(sent.github_inbox_mirror.isolated, true);
  assert.equal(sent.github_inbox_mirror.ac1_message_preserved, true);
  assert.equal(sent.github_inbox_mirror.stone_hash, sent.stone_hash);
  assert.equal(h.stoneCreates, 1);
  const inbox = await h.service.getInbox({ recipient_id: "agent:claude:jared" });
  assert.equal(inbox.total, 1);
  assert.equal(inbox.messages[0].stone_hash, sent.stone_hash);
});

test("AC1 retry reuses the original stone and creates no duplicate delivery", async () => {
  const h = makeHarness();
  const message = {
    message_id: "msg:retry-proof",
    from: "agent:chatgpt:jared",
    to: ["agent:claude:jared"],
    content: "Idempotent retry body."
  };

  const first = await h.service.sendMessage(message);
  const second = await h.service.sendMessage(message);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.idempotent_replay, true);
  assert.equal(second.stone_hash, first.stone_hash);
  assert.equal(h.stoneCreates, 1);
  assert.equal(h.deliveries.length, 1);
});

test("AC1 message_id reuse with changed content fails closed", async () => {
  const h = makeHarness();
  const base = {
    message_id: "msg:conflict-proof",
    from: "agent:chatgpt:jared",
    to: ["agent:claude:jared"]
  };

  assert.equal((await h.service.sendMessage({ ...base, content: "original" })).ok, true);
  const conflict = await h.service.sendMessage({ ...base, content: "changed" });

  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, "idempotency_conflict");
  assert.equal(h.stoneCreates, 1);
  assert.equal(h.deliveries.length, 1);
});
