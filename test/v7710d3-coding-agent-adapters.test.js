import test from "node:test";
import assert from "node:assert/strict";
import {
  invokeExecutorAdapter,
  getAdapterContract,
  COPILOT_ADAPTER_CONTRACT,
  CURSOR_ADAPTER_CONTRACT,
  pollCodingAgentStatus,
  cancelCodingAgentJob,
  buildDispatchContextEnvelope
} from "../src/executor-adapters.js";
import {
  executorHealth,
  executorHealthAsync,
  getExecutorProfile
} from "../src/executor-profile.js";
import {
  proposeTaskRun,
  dispatchTaskRun,
  cancelTaskRun,
  taskRunStatus
} from "../src/task-run.js";
import {
  CODING_AGENT_SECRET_NAMES,
  resetLiveJobCounters,
  cursorAgentIdFromTaskRun,
  mapCopilotStateToTaskStatus,
  mapCursorRunStatusToTaskStatus,
  scrubSecrets
} from "../src/coding-agent-common.js";
import {
  probeGitHubCopilotHealth,
  dispatchGitHubCopilotTask,
  getGitHubCopilotTaskStatus,
  cancelGitHubCopilotTask
} from "../src/github-copilot-adapter.js";
import {
  probeCursorCloudHealth,
  dispatchCursorCloudAgent,
  getCursorCloudRunStatus,
  cancelCursorCloudRun
} from "../src/cursor-cloud-adapter.js";

const ACTOR = "console:jared";
const FULL_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const STALE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REPO = "nothinginfinity/cairnstone-v6";
const REPO_REF = `repo:${REPO}@${FULL_SHA}`;
const OBJECT_REF = "msg:v7710d3-coding-agent";

function makeDb() {
  const db = { taskRuns: new Map(), routeReceipts: new Map() };
  return {
    prepare(sql) {
      const args = [];
      return {
        bind(...bound) {
          args.push(...bound);
          return this;
        },
        async run() {
          if (sql.includes("INSERT INTO task_runs")) {
            const [
              taskRunId, schema, conversationId, parentTurnId, requestedBy,
              assignee, intent, attachmentRefsJson, objectRefsJson, note,
              capsJson, policy, budgetJson, parentId, delegationDepth,
              createdAt, updatedAt
            ] = args;
            db.taskRuns.set(taskRunId, {
              task_run_id: taskRunId,
              schema,
              status: "proposed",
              conversation_id: conversationId,
              parent_turn_id: parentTurnId,
              requested_by: requestedBy,
              assignee_actor_id: assignee,
              requested_intent: intent,
              intent_mode: "propose-action",
              attachment_refs_json: attachmentRefsJson,
              object_refs_json: objectRefsJson,
              note,
              dispatch_state: "not_dispatched",
              selected_executor_id: null,
              executor_route_reason: null,
              required_capabilities_json: capsJson || "[]",
              policy_preset: policy || null,
              budget_envelope_json: budgetJson || null,
              parent_task_run_id: parentId || null,
              child_task_run_ids_json: "[]",
              delegation_depth: delegationDepth || 0,
              route_receipt_id: null,
              route_receipt_json: null,
              adapter_job_id: null,
              receipt_refs_json: "[]",
              artifact_refs_json: "[]",
              pr_refs_json: "[]",
              test_refs_json: "[]",
              result_summary: null,
              failure_reason: null,
              human_committed_by: null,
              human_committed_at: null,
              started_at: null,
              completed_at: null,
              created_at: createdAt,
              updated_at: updatedAt,
              cancelled_at: null,
              accepted_state_authority: 0
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.includes("INSERT") && sql.includes("executor_route_receipts")) {
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.includes("UPDATE task_runs SET") && sql.includes("human_committed_by")) {
            const [
              status, dispatchState, selectedExecutorId, executorRouteReason,
              capsJson, policy, budgetJson, routeReceiptId, routeReceiptJson,
              adapterJobId, receiptRefsJson, artifactRefsJson, prRefsJson,
              resultSummary, failureReason,
              humanCommittedBy, humanCommittedAt, startedAt, completedAt, updatedAt,
              taskRunId
            ] = args;
            const row = db.taskRuns.get(taskRunId);
            db.taskRuns.set(taskRunId, {
              ...row,
              status,
              dispatch_state: dispatchState,
              selected_executor_id: selectedExecutorId,
              executor_route_reason: executorRouteReason,
              required_capabilities_json: capsJson,
              policy_preset: policy,
              budget_envelope_json: budgetJson,
              route_receipt_id: routeReceiptId,
              route_receipt_json: routeReceiptJson,
              adapter_job_id: adapterJobId,
              receipt_refs_json: receiptRefsJson,
              artifact_refs_json: artifactRefsJson || "[]",
              pr_refs_json: prRefsJson || "[]",
              result_summary: resultSummary,
              failure_reason: failureReason,
              human_committed_by: humanCommittedBy,
              human_committed_at: humanCommittedAt,
              started_at: startedAt,
              completed_at: completedAt,
              updated_at: updatedAt
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.includes("UPDATE task_runs SET") && sql.includes("pr_refs_json") && !sql.includes("human_committed_by")) {
            const [
              status, dispatchState, resultSummary, failureReason,
              prRefsJson, artifactRefsJson, _terminalFlag, completedAt, updatedAt, taskRunId
            ] = args;
            const row = db.taskRuns.get(taskRunId);
            db.taskRuns.set(taskRunId, {
              ...row,
              status,
              dispatch_state: dispatchState,
              result_summary: resultSummary,
              failure_reason: failureReason,
              pr_refs_json: prRefsJson,
              artifact_refs_json: artifactRefsJson,
              completed_at: completedAt || row.completed_at,
              updated_at: updatedAt
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.includes("UPDATE task_runs SET") && sql.includes("status = 'cancelled'")) {
            const [failureReason, cancelledAt, completedAt, updatedAt, taskRunId] = args;
            const row = db.taskRuns.get(taskRunId);
            const dispatchState = row.dispatch_state === "not_dispatched" ? "not_dispatched" : "cancelled";
            db.taskRuns.set(taskRunId, {
              ...row,
              status: "cancelled",
              dispatch_state: dispatchState,
              failure_reason: failureReason,
              cancelled_at: cancelledAt,
              completed_at: completedAt,
              updated_at: updatedAt
            });
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        },
        async first() {
          if (sql.includes("FROM task_runs WHERE task_run_id")) {
            return db.taskRuns.get(args[0]) || null;
          }
          return null;
        },
        async all() {
          return { results: [] };
        }
      };
    },
    _raw: db
  };
}

function jsonResponse(status, body) {
  return {
    status,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    }
  };
}

function makeMockFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: (init.method || "GET").toUpperCase(), init });
    return handler(String(url), init, calls);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function copilotEnv(overrides = {}) {
  return {
    [CODING_AGENT_SECRET_NAMES.github_copilot_token]: "ghp_test_copilot_token_not_real",
    [CODING_AGENT_SECRET_NAMES.github_copilot_allowed_repo]: REPO,
    [CODING_AGENT_SECRET_NAMES.github_copilot_allowed_branch]: "main",
    [CODING_AGENT_SECRET_NAMES.github_copilot_api_base]: "https://api.github.test",
    ...overrides
  };
}

function cursorEnv(overrides = {}) {
  return {
    [CODING_AGENT_SECRET_NAMES.cursor_cloud_api_key]: "cursor_test_api_key_not_real",
    [CODING_AGENT_SECRET_NAMES.cursor_cloud_allowed_repo_url]: `https://github.com/${REPO}`,
    [CODING_AGENT_SECRET_NAMES.cursor_cloud_api_base]: "https://api.cursor.test",
    ...overrides
  };
}

test("scrubSecrets never echoes token material", () => {
  const scrubbed = scrubSecrets("Authorization: Bearer ghp_test_copilot_token_not_real ok", [
    "ghp_test_copilot_token_not_real"
  ]);
  assert.equal(scrubbed.includes("ghp_test_copilot_token_not_real"), false);
  assert.match(scrubbed, /\[REDACTED\]/);
});

test("status mappers never invent completed from unknown", () => {
  assert.equal(mapCopilotStateToTaskStatus("completed").task_status, "completed");
  assert.equal(mapCopilotStateToTaskStatus("in_progress").task_status, "running");
  assert.equal(mapCopilotStateToTaskStatus("weird").unknown_state, true);
  assert.equal(mapCursorRunStatusToTaskStatus("FINISHED").task_status, "completed");
  assert.equal(mapCursorRunStatusToTaskStatus("RUNNING").task_status, "running");
  assert.equal(mapCursorRunStatusToTaskStatus("NOPE").unknown_state, true);
});

test("seed health stays stub without env; never claims live", () => {
  const health = executorHealth("exec:github-copilot");
  assert.equal(health.availability, "stub");
  assert.equal(health.health.adapter_live, false);
  assert.equal(getExecutorProfile("exec:github-copilot").executor.availability, "stub");
  assert.equal(COPILOT_ADAPTER_CONTRACT.live_path, true);
  assert.equal(getAdapterContract("exec:github-copilot").adapter_live, false);
});

test("Copilot health: missing token → stub", async () => {
  const probed = await probeGitHubCopilotHealth({});
  assert.equal(probed.availability, "stub");
  assert.equal(probed.health.adapter_live, false);
  assert.equal(probed.health.token_configured, false);
  assert.equal(probed.health.live_evidence, false);
});

test("Copilot health: token without allowlist → blocked", async () => {
  const probed = await probeGitHubCopilotHealth({
    [CODING_AGENT_SECRET_NAMES.github_copilot_token]: "tok"
  });
  assert.equal(probed.availability, "blocked");
  assert.equal(probed.health.adapter_live, false);
  assert.equal(probed.health.blocker, "allowed_repo_not_configured");
});

test("Copilot health: token + live probe evidence → available", async () => {
  const fetchImpl = makeMockFetch(() => jsonResponse(200, { tasks: [] }));
  const probed = await probeGitHubCopilotHealth(copilotEnv(), { fetchImpl });
  assert.equal(probed.availability, "available");
  assert.equal(probed.health.adapter_live, true);
  assert.equal(probed.health.live_evidence, true);
  assert.equal(probed.health.dry_run, false);
});

test("Copilot health: permission denial → blocked not live", async () => {
  const fetchImpl = makeMockFetch(() => jsonResponse(403, { message: "Resource not accessible" }));
  const probed = await probeGitHubCopilotHealth(copilotEnv(), { fetchImpl });
  assert.equal(probed.availability, "blocked");
  assert.equal(probed.health.adapter_live, false);
  assert.equal(probed.health.blocker, "provider_permission_denied");
});

test("Copilot dispatch: missing token fails closed for live API", async () => {
  const result = await dispatchGitHubCopilotTask({
    env: {},
    immutable_base_sha: FULL_SHA,
    task_run: { task_run_id: "tr:c1", note: "x" },
    compiled_pack: { body: "hi", receipt_digest: "d" }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "github_copilot_token_not_configured");
});

test("Copilot dispatch: stale base SHA fails closed", async () => {
  resetLiveJobCounters();
  const fetchImpl = makeMockFetch((url) => {
    if (url.includes("/git/ref/heads/")) {
      return jsonResponse(200, { object: { sha: FULL_SHA } });
    }
    return jsonResponse(500, { message: "should not create" });
  });
  const result = await dispatchGitHubCopilotTask({
    env: copilotEnv(),
    immutable_base_sha: STALE_SHA,
    task_run: { task_run_id: "tr:stale", attachment_refs: [REPO_REF] },
    compiled_pack: { body: "fix", receipt_digest: "d", provenance_refs: [REPO_REF] },
    fetchImpl
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "stale_base_sha");
  assert.equal(fetchImpl.calls.some(c => c.method === "POST"), false);
});

test("Copilot dispatch: successful create + PR artifact + receipt identity", async () => {
  resetLiveJobCounters();
  const fetchImpl = makeMockFetch((url, init) => {
    if (url.includes("/git/ref/heads/")) {
      return jsonResponse(200, { object: { sha: FULL_SHA } });
    }
    if (url.includes("/tasks") && (init.method || "GET").toUpperCase() === "POST") {
      return jsonResponse(201, {
        id: "task_abc123",
        html_url: "https://github.com/nothinginfinity/cairnstone-v6/tasks/task_abc123",
        state: "queued",
        artifacts: [{ provider: "github", type: "pull", data: { id: 42 } }]
      });
    }
    return jsonResponse(404, { message: "nope" });
  });
  const result = await dispatchGitHubCopilotTask({
    env: copilotEnv(),
    immutable_base_sha: FULL_SHA,
    task_run: { task_run_id: "tr:ok", attachment_refs: [REPO_REF], note: "ship it" },
    compiled_pack: { body: "compiled body", receipt_digest: "digest1", provenance_refs: [REPO_REF] },
    fetchImpl
  });
  assert.equal(result.ok, true);
  assert.equal(result.adapter_live, true);
  assert.equal(result.dry_run, false);
  assert.equal(result.external_task_id, "task_abc123");
  assert.equal(result.task_status, "queued");
  assert.ok(result.pr_refs.includes("pr:github.com/nothinginfinity/cairnstone-v6#42"));
  assert.equal(result.accepted_state_authority, false);
});

test("Copilot dispatch: permission denial", async () => {
  resetLiveJobCounters();
  const fetchImpl = makeMockFetch((url) => {
    if (url.includes("/git/ref/heads/")) {
      return jsonResponse(200, { object: { sha: FULL_SHA } });
    }
    return jsonResponse(403, { message: "Must have admin rights" });
  });
  const result = await dispatchGitHubCopilotTask({
    env: copilotEnv(),
    immutable_base_sha: FULL_SHA,
    task_run: { task_run_id: "tr:deny", attachment_refs: [REPO_REF] },
    compiled_pack: { body: "x", receipt_digest: "d" },
    fetchImpl
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "provider_permission_denied");
});

test("Copilot status + cancel unsupported", async () => {
  const fetchImpl = makeMockFetch(() => jsonResponse(200, {
    id: "task_abc123",
    state: "in_progress",
    artifacts: []
  }));
  const status = await getGitHubCopilotTaskStatus({
    env: copilotEnv(),
    task_id: "task_abc123",
    fetchImpl
  });
  assert.equal(status.ok, true);
  assert.equal(status.task_status, "running");
  assert.equal(status.provider_state, "in_progress");

  const cancel = await cancelGitHubCopilotTask();
  assert.equal(cancel.ok, true);
  assert.equal(cancel.provider_cancel_unsupported, true);
});

test("Copilot retries on 500 then succeeds", async () => {
  resetLiveJobCounters();
  let posts = 0;
  const fetchImpl = makeMockFetch((url, init) => {
    if (url.includes("/git/ref/heads/")) {
      return jsonResponse(200, { object: { sha: FULL_SHA } });
    }
    if ((init.method || "GET").toUpperCase() === "POST") {
      posts += 1;
      if (posts === 1) return jsonResponse(500, { message: "temporary" });
      return jsonResponse(201, { id: "task_retry", state: "queued", artifacts: [] });
    }
    return jsonResponse(404, {});
  });
  const result = await dispatchGitHubCopilotTask({
    env: copilotEnv(),
    immutable_base_sha: FULL_SHA,
    task_run: { task_run_id: "tr:retry", attachment_refs: [REPO_REF] },
    compiled_pack: { body: "x", receipt_digest: "d" },
    fetchImpl,
    sleepFn: async () => {}
  });
  assert.equal(result.ok, true);
  assert.equal(result.external_task_id, "task_retry");
  assert.ok(posts >= 2);
});

test("Copilot idempotent dispatch via existing_external_task_id", async () => {
  resetLiveJobCounters();
  let posts = 0;
  const fetchImpl = makeMockFetch((url, init) => {
    if (url.includes("/git/ref/heads/")) {
      return jsonResponse(200, { object: { sha: FULL_SHA } });
    }
    if ((init.method || "GET").toUpperCase() === "POST") {
      posts += 1;
      return jsonResponse(201, { id: "should_not", state: "queued" });
    }
    if (url.includes("/tasks/task_existing")) {
      return jsonResponse(200, { id: "task_existing", state: "in_progress", artifacts: [] });
    }
    return jsonResponse(404, {});
  });
  const result = await dispatchGitHubCopilotTask({
    env: copilotEnv(),
    immutable_base_sha: FULL_SHA,
    existing_external_task_id: "task_existing",
    task_run: { task_run_id: "tr:idem", attachment_refs: [REPO_REF] },
    compiled_pack: { body: "x", receipt_digest: "d" },
    fetchImpl
  });
  assert.equal(result.ok, true);
  assert.equal(result.idempotent_replay, true);
  assert.equal(result.external_task_id, "task_existing");
  assert.equal(posts, 0);
});

test("invokeExecutorAdapter Copilot without token remains dry-run stub", async () => {
  const envelope = buildDispatchContextEnvelope({
    executor_id: "exec:github-copilot",
    task_run: {
      task_run_id: "tr:stub",
      attachment_refs: [REPO_REF],
      note: "n",
      requested_intent: "ask-to-work"
    },
    base_commit_sha: FULL_SHA
  });
  assert.equal(envelope.ok, true);
  const invoked = await invokeExecutorAdapter({
    executor_id: "exec:github-copilot",
    task_run: {
      task_run_id: "tr:stub",
      attachment_refs: [REPO_REF],
      note: "n",
      requested_intent: "ask-to-work"
    },
    base_commit_sha: FULL_SHA,
    env: {}
  });
  assert.equal(invoked.ok, true);
  assert.equal(invoked.receipt.adapter_live, false);
  assert.equal(invoked.receipt.dry_run, true);
});

test("invokeExecutorAdapter Copilot live path via mocked env", async () => {
  resetLiveJobCounters();
  const fetchImpl = makeMockFetch((url, init) => {
    if (url.includes("/git/ref/heads/")) {
      return jsonResponse(200, { object: { sha: FULL_SHA } });
    }
    if ((init.method || "GET").toUpperCase() === "POST") {
      return jsonResponse(201, {
        id: "task_live",
        state: "queued",
        html_url: "https://example.test/task_live",
        artifacts: []
      });
    }
    return jsonResponse(404, {});
  });
  const env = { ...copilotEnv(), __coding_agent_fetch: fetchImpl, __coding_agent_sleep: async () => {} };
  const invoked = await invokeExecutorAdapter({
    executor_id: "exec:github-copilot",
    task_run: {
      task_run_id: "tr:live-copilot",
      attachment_refs: [REPO_REF],
      note: "implement",
      requested_intent: "ask-to-work"
    },
    base_commit_sha: FULL_SHA,
    env
  });
  assert.equal(invoked.ok, true);
  assert.equal(invoked.receipt.adapter_live, true);
  assert.equal(invoked.receipt.dry_run, false);
  assert.equal(invoked.receipt.external_job.external_task_id, "task_live");
  assert.equal(invoked.task_status, "queued");
});

test("invokeExecutorAdapter Copilot live without SHA fails closed", async () => {
  const env = { ...copilotEnv(), __coding_agent_fetch: makeMockFetch(() => jsonResponse(500, {})) };
  const invoked = await invokeExecutorAdapter({
    executor_id: "exec:github-copilot",
    task_run: {
      task_run_id: "tr:no-sha",
      attachment_refs: [OBJECT_REF],
      note: "no sha"
    },
    env
  });
  assert.equal(invoked.ok, false);
  assert.equal(invoked.error, "immutable_base_sha_required");
});

test("task_run dispatch+status+cancel for Copilot live (mocked)", async () => {
  resetLiveJobCounters();
  const fetchImpl = makeMockFetch((url, init) => {
    if (url.includes("/git/ref/heads/")) {
      return jsonResponse(200, { object: { sha: FULL_SHA } });
    }
    if ((init.method || "GET").toUpperCase() === "POST" && url.includes("/tasks")) {
      return jsonResponse(201, {
        id: "task_flow",
        state: "queued",
        artifacts: [{ provider: "github", type: "pull", data: { id: 9 } }]
      });
    }
    if (url.includes("/tasks/task_flow")) {
      return jsonResponse(200, {
        id: "task_flow",
        state: "completed",
        artifacts: [{ provider: "github", type: "pull", data: { id: 9 } }]
      });
    }
    return jsonResponse(404, {});
  });
  const env = { ...copilotEnv(), __coding_agent_fetch: fetchImpl, __coding_agent_sleep: async () => {} };
  const db = makeDb();
  await proposeTaskRun(db, {
    task_run_id: "tr:copilot-flow",
    requested_by: ACTOR,
    attachment_refs: [REPO_REF],
    required_capabilities: ["repo.read", "repo.edit", "repo.pr"],
    note: "open pr"
  });
  const dispatched = await dispatchTaskRun(db, {
    task_run_id: "tr:copilot-flow",
    human_commit: true,
    committed_by: ACTOR,
    preferred_executor: "exec:github-copilot",
    base_commit_sha: FULL_SHA,
    env
  });
  assert.equal(dispatched.ok, true);
  assert.equal(dispatched.adapter_receipt.adapter_live, true);
  assert.ok(dispatched.task_run.artifact_refs.some(r => String(r).startsWith("extjob:github_agent_task:")));
  assert.ok(dispatched.task_run.pr_refs.includes("pr:github.com/nothinginfinity/cairnstone-v6#9"));

  const status = await taskRunStatus(db, "tr:copilot-flow", ACTOR, { env });
  assert.equal(status.ok, true);
  assert.equal(status.provider_status?.ok, true, JSON.stringify(status.provider_status));
  assert.equal(status.status, "completed");
  assert.equal(status.provider_status.provider_state, "completed");

  // Second dispatch of same run fails (idempotent at Task Run layer)
  const again = await dispatchTaskRun(db, {
    task_run_id: "tr:copilot-flow",
    human_commit: true,
    committed_by: ACTOR,
    preferred_executor: "exec:github-copilot",
    base_commit_sha: FULL_SHA,
    env
  });
  assert.equal(again.ok, false);
  assert.equal(again.error, "task_run_not_dispatchable");
});

test("Cursor health: missing key → stub; probe success → available", async () => {
  const missing = await probeCursorCloudHealth({});
  assert.equal(missing.availability, "stub");
  assert.equal(missing.health.adapter_live, false);

  const fetchImpl = makeMockFetch((url) => {
    if (url.endsWith("/v1/me")) return jsonResponse(200, { apiKeyName: "test" });
    return jsonResponse(404, {});
  });
  const ok = await probeCursorCloudHealth(cursorEnv(), { fetchImpl });
  assert.equal(ok.availability, "available");
  assert.equal(ok.health.adapter_live, true);
  assert.equal(ok.health.live_evidence, true);
});

test("Cursor dispatch success + status + cancel", async () => {
  resetLiveJobCounters();
  const agentId = cursorAgentIdFromTaskRun("tr:cursor-1");
  const fetchImpl = makeMockFetch((url, init) => {
    const method = (init.method || "GET").toUpperCase();
    if (method === "POST" && url.endsWith("/v1/agents")) {
      const body = JSON.parse(init.body);
      assert.equal(body.repos[0].startingRef, FULL_SHA);
      assert.equal(body.agentId, agentId);
      assert.match(body.prompt.text, /immutable_base_sha=/);
      assert.match(body.prompt.text, /CairnStone-native/);
      return jsonResponse(201, {
        agent: {
          id: agentId,
          status: "ACTIVE",
          url: `https://cursor.com/agents/${agentId}`,
          latestRunId: "run-1"
        },
        run: { id: "run-1", agentId, status: "CREATING" }
      });
    }
    if (method === "GET" && url.includes("/runs/run-1")) {
      return jsonResponse(200, {
        id: "run-1",
        agentId,
        status: "FINISHED",
        git: { branches: [{ branch: "cursor/fix", prUrl: "https://github.com/o/r/pull/3" }] }
      });
    }
    if (method === "POST" && url.includes("/cancel")) {
      return jsonResponse(200, { id: "run-1", status: "CANCELLED" });
    }
    return jsonResponse(404, {});
  });

  const dispatched = await dispatchCursorCloudAgent({
    env: cursorEnv(),
    task_run: { task_run_id: "tr:cursor-1", attachment_refs: [REPO_REF], note: "native" },
    envelope: {
      task_run_id: "tr:cursor-1",
      attachment_refs: [REPO_REF],
      object_refs: [],
      access_grant_ids: [],
      note: "native"
    },
    immutable_base_sha: FULL_SHA,
    fetchImpl
  });
  assert.equal(dispatched.ok, true);
  assert.equal(dispatched.external_agent_id, agentId);
  assert.equal(dispatched.external_run_id, "run-1");
  assert.equal(dispatched.task_status, "queued");

  const status = await getCursorCloudRunStatus({
    env: cursorEnv(),
    agent_id: agentId,
    run_id: "run-1",
    fetchImpl
  });
  assert.equal(status.ok, true);
  assert.equal(status.task_status, "completed");
  assert.ok(status.pr_refs.some(r => r.includes("pr_url:")));

  const cancel = await cancelCursorCloudRun({
    env: cursorEnv(),
    agent_id: agentId,
    run_id: "run-1",
    fetchImpl
  });
  assert.equal(cancel.ok, true);
  assert.equal(cancel.provider_cancel, true);
});

test("Cursor missing token / stale SHA / permission denial", async () => {
  const noTok = await dispatchCursorCloudAgent({
    env: {},
    immutable_base_sha: FULL_SHA,
    task_run: { task_run_id: "tr:c" }
  });
  assert.equal(noTok.error, "cursor_cloud_api_key_not_configured");

  const stale = await dispatchCursorCloudAgent({
    env: cursorEnv({
      [CODING_AGENT_SECRET_NAMES.cursor_cloud_allowed_starting_ref]: STALE_SHA
    }),
    immutable_base_sha: FULL_SHA,
    task_run: { task_run_id: "tr:c2", attachment_refs: [REPO_REF] }
  });
  assert.equal(stale.error, "stale_base_sha");

  const fetchImpl = makeMockFetch(() => jsonResponse(401, { message: "unauthorized" }));
  const denied = await dispatchCursorCloudAgent({
    env: cursorEnv(),
    immutable_base_sha: FULL_SHA,
    task_run: { task_run_id: "tr:c3", attachment_refs: [REPO_REF] },
    fetchImpl
  });
  assert.equal(denied.error, "provider_permission_denied");
});

test("Cursor idempotent 409 replay loads existing agent/run", async () => {
  resetLiveJobCounters();
  const agentId = cursorAgentIdFromTaskRun("tr:cursor-idem");
  let creates = 0;
  const fetchImpl = makeMockFetch((url, init) => {
    const method = (init.method || "GET").toUpperCase();
    if (method === "POST" && url.endsWith("/v1/agents")) {
      creates += 1;
      return jsonResponse(409, { error: "agent_id_conflict" });
    }
    if (method === "GET" && url.endsWith(`/v1/agents/${agentId}`)) {
      return jsonResponse(200, { id: agentId, latestRunId: "run-existing", status: "ACTIVE" });
    }
    if (method === "GET" && url.includes("/runs/run-existing")) {
      return jsonResponse(200, { id: "run-existing", agentId, status: "RUNNING" });
    }
    return jsonResponse(404, {});
  });
  const result = await dispatchCursorCloudAgent({
    env: cursorEnv(),
    task_run: { task_run_id: "tr:cursor-idem", attachment_refs: [REPO_REF] },
    immutable_base_sha: FULL_SHA,
    fetchImpl
  });
  assert.equal(result.ok, true);
  assert.equal(result.idempotent_replay, true);
  assert.equal(result.external_run_id, "run-existing");
  assert.equal(result.task_status, "running");
  assert.equal(creates, 1);
});

test("Cursor refuse false complete when status missing", async () => {
  const fetchImpl = makeMockFetch(() => jsonResponse(200, { id: "run-x", agentId: "bc-x" }));
  const status = await getCursorCloudRunStatus({
    env: cursorEnv(),
    agent_id: "bc-x",
    run_id: "run-x",
    fetchImpl
  });
  assert.equal(status.ok, false);
  assert.equal(status.error, "cursor_cloud_status_unknown");
});

test("executorHealthAsync overlays coding agents from env probe", async () => {
  const fetchImpl = makeMockFetch((url) => {
    if (url.includes("api.github.test")) return jsonResponse(200, { tasks: [] });
    if (url.includes("/v1/me")) return jsonResponse(200, { ok: true });
    return jsonResponse(200, { items: [] });
  });
  const env = {
    ...copilotEnv(),
    ...cursorEnv(),
    __coding_agent_fetch: fetchImpl
  };
  const health = await executorHealthAsync(null, env);
  const copilot = health.executors.find(e => e.executor_id === "exec:github-copilot");
  const cursor = health.executors.find(e => e.executor_id === "exec:cursor-cloud");
  assert.equal(copilot.availability, "available");
  assert.equal(copilot.health.adapter_live, true);
  assert.equal(cursor.availability, "available");
  assert.equal(cursor.health.adapter_live, true);
  assert.equal(copilot.seed_availability, "stub");
});

test("pollCodingAgentStatus + cancelCodingAgentJob wrappers", async () => {
  const fetchImpl = makeMockFetch((url, init) => {
    if (url.includes("api.github.test") && url.includes("/tasks/")) {
      return jsonResponse(200, { id: "t1", state: "failed" });
    }
    if ((init.method || "GET").toUpperCase() === "POST" && url.includes("/cancel")) {
      return jsonResponse(200, { status: "CANCELLED" });
    }
    return jsonResponse(404, {});
  });
  const gh = await pollCodingAgentStatus({
    executor_id: "exec:github-copilot",
    external_job: { kind: "github_agent_task", owner: "nothinginfinity", repo: "cairnstone-v6", external_task_id: "t1" },
    env: { ...copilotEnv(), __coding_agent_fetch: fetchImpl }
  });
  assert.equal(gh.task_status, "failed");

  const cancelCursor = await cancelCodingAgentJob({
    executor_id: "exec:cursor-cloud",
    external_job: { kind: "cursor_cloud_agent_run", external_agent_id: "bc-1", external_run_id: "run-1" },
    env: { ...cursorEnv(), __coding_agent_fetch: fetchImpl }
  });
  assert.equal(cancelCursor.provider_cancel, true);
});

test("task_run cancel for Cursor attempts provider cancel", async () => {
  resetLiveJobCounters();
  const agentId = cursorAgentIdFromTaskRun("tr:cursor-cancel");
  const fetchImpl = makeMockFetch((url, init) => {
    const method = (init.method || "GET").toUpperCase();
    if (method === "POST" && url.endsWith("/v1/agents")) {
      return jsonResponse(201, {
        agent: { id: agentId, url: "https://cursor.com/agents/x", latestRunId: "run-c" },
        run: { id: "run-c", agentId, status: "RUNNING" }
      });
    }
    if (method === "POST" && url.includes("/cancel")) {
      return jsonResponse(200, { status: "CANCELLED" });
    }
    return jsonResponse(404, {});
  });
  const env = { ...cursorEnv(), __coding_agent_fetch: fetchImpl, __coding_agent_sleep: async () => {} };
  const db = makeDb();
  await proposeTaskRun(db, {
    task_run_id: "tr:cursor-cancel",
    requested_by: ACTOR,
    attachment_refs: [REPO_REF],
    required_capabilities: ["repo.read", "repo.edit", "repo.pr"]
  });
  const dispatched = await dispatchTaskRun(db, {
    task_run_id: "tr:cursor-cancel",
    human_commit: true,
    committed_by: ACTOR,
    preferred_executor: "exec:cursor-cloud",
    base_commit_sha: FULL_SHA,
    env
  });
  assert.equal(dispatched.ok, true);
  assert.equal(dispatched.adapter_receipt.adapter_live, true);
  assert.equal(dispatched.task_run.status, "running");

  const cancelled = await cancelTaskRun(db, {
    task_run_id: "tr:cursor-cancel",
    actor_id: ACTOR,
    env
  });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.task_run.status, "cancelled");
  assert.equal(cancelled.provider_cancel.provider_cancel, true);
});
