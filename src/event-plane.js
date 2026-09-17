import {
  TASK_RUN_MAX_DELEGATION_DEPTH,
  getTaskRun,
  listTaskRuns
} from "./task-run.js";

export const EVENT_SCHEMA = "cairnstone-event-v1";
export const TREE_SCHEMA = "cairnstone-agent-tree-v1";
const MAX_LIST = 100;
const DEFAULT_LIST = 20;

export const EVENT_TYPES = Object.freeze({
  proposed: "task_run.proposed",
  dispatched: "task_run.dispatched",
  status: "task_run.status",
  completed: "task_run.completed",
  failed: "task_run.failed"
});

export const EVENT_PLANE_BROKER_TOOL_IDS = Object.freeze({
  event_list: "cairnstone_event_list",
  agent_tree: "cairnstone_agent_tree"
});

function authorityClosedFields() {
  return {
    accepted_state_authority: false,
    chain_heads_mutated: false,
    path_heads_mutated: false
  };
}

function eventTypeFromTaskRun(taskRun = {}) {
  const status = taskRun.status || null;
  const dispatchState = taskRun.dispatch_state || "not_dispatched";
  if (status === "failed" || dispatchState === "failed") return EVENT_TYPES.failed;
  if (status === "completed" || dispatchState === "completed") return EVENT_TYPES.completed;
  if (status === "proposed" && dispatchState === "not_dispatched") return EVENT_TYPES.proposed;
  if (dispatchState === "dispatched" || status === "queued") return EVENT_TYPES.dispatched;
  return EVENT_TYPES.status;
}

function eventSortTime(taskRun = {}) {
  return taskRun.updated_at
    || taskRun.completed_at
    || taskRun.started_at
    || taskRun.created_at
    || "";
}

function normalizedParentId(taskRun = {}) {
  return taskRun.parent_task_run_id || taskRun.parent_id || null;
}

export function eventFromTaskRun(taskRun = {}) {
  return {
    schema: EVENT_SCHEMA,
    event_type: eventTypeFromTaskRun(taskRun),
    task_run_id: taskRun.task_run_id || null,
    parent_task_run_id: normalizedParentId(taskRun),
    status: taskRun.status || null,
    dispatch_state: taskRun.dispatch_state || "not_dispatched",
    occurred_at: eventSortTime(taskRun) || null,
    ...authorityClosedFields()
  };
}

export function projectAgentTree(taskRuns = []) {
  const nodesById = new Map();
  for (const taskRun of taskRuns || []) {
    if (!taskRun?.task_run_id) continue;
    nodesById.set(taskRun.task_run_id, {
      task_run_id: taskRun.task_run_id,
      parent_task_run_id: normalizedParentId(taskRun),
      status: taskRun.status || null,
      dispatch_state: taskRun.dispatch_state || "not_dispatched",
      children: [],
      depth: null
    });
  }

  const roots = [];
  for (const node of nodesById.values()) {
    const parent = node.parent_task_run_id ? nodesById.get(node.parent_task_run_id) : null;
    if (!parent) {
      node.parent_task_run_id = null;
      roots.push(node);
      continue;
    }
    parent.children.push(node);
  }

  const cappedRoots = [];
  const visit = (node, depth) => {
    if (!node || depth > TASK_RUN_MAX_DELEGATION_DEPTH) return null;
    const next = {
      ...node,
      depth,
      children: []
    };
    if (depth < TASK_RUN_MAX_DELEGATION_DEPTH) {
      for (const child of node.children) {
        const projected = visit(child, depth + 1);
        if (projected) next.children.push(projected);
      }
    }
    return next;
  };

  for (const root of roots) {
    const projected = visit(root, 0);
    if (projected) cappedRoots.push(projected);
  }

  return {
    ok: true,
    schema: TREE_SCHEMA,
    max_delegation_depth: TASK_RUN_MAX_DELEGATION_DEPTH,
    roots: cappedRoots,
    total_roots: cappedRoots.length,
    ...authorityClosedFields()
  };
}

export function listEventsFromTaskRuns(taskRuns = [], { since = null, limit = DEFAULT_LIST } = {}) {
  const lim = Number.isInteger(limit) ? Math.max(1, Math.min(MAX_LIST, limit)) : DEFAULT_LIST;
  const sinceValue = typeof since === "string" && since.trim() ? since.trim() : null;

  const events = (taskRuns || [])
    .map(eventFromTaskRun)
    .filter(event => !sinceValue || (event.occurred_at && event.occurred_at > sinceValue))
    .sort((a, b) => {
      const at = a.occurred_at || "";
      const bt = b.occurred_at || "";
      if (at > bt) return -1;
      if (at < bt) return 1;
      return String(b.task_run_id || "").localeCompare(String(a.task_run_id || ""));
    })
    .slice(0, lim);

  return {
    ok: true,
    schema: EVENT_SCHEMA,
    events,
    total: events.length,
    ...authorityClosedFields()
  };
}

export function subscribeHonesty() {
  return {
    ok: false,
    error: "upgrade_unavailable",
    detail: "V7.7.10f first slice keeps DO/WS live upgrades residual; use poll/list projections only in this slice.",
    ...authorityClosedFields()
  };
}

function envDb(env = {}) {
  if (!env?.CAIRNSTONE_DB) {
    return { ok: false, error: "missing_d1_binding", detail: "CAIRNSTONE_DB required" };
  }
  return { ok: true, db: env.CAIRNSTONE_DB };
}

export async function listEventPlaneFromBody(body = {}, env = {}) {
  const bindings = envDb(env);
  if (!bindings.ok) return bindings;

  let taskRuns = [];
  if (body.task_run_id) {
    const single = await getTaskRun(bindings.db, body.task_run_id, body.actor_id);
    if (!single?.ok) return single;
    if (body.status && single.task_run?.status !== body.status) {
      return { ok: true, schema: EVENT_SCHEMA, events: [], total: 0, ...authorityClosedFields() };
    }
    taskRuns = single.task_run ? [single.task_run] : [];
  } else {
    const listed = await listTaskRuns(bindings.db, {
      actor_id: body.actor_id,
      status: body.status || null,
      limit: body.limit
    });
    if (!listed?.ok) return listed;
    taskRuns = listed.task_runs || [];
  }

  return listEventsFromTaskRuns(taskRuns, { since: body.since || null, limit: body.limit });
}

async function listChildrenForParent(db, actorId, parentId, limit = MAX_LIST) {
  const children = await listTaskRuns(db, {
    actor_id: actorId,
    parent_task_run_id: parentId,
    limit
  });
  if (!children?.ok) return children;
  return { ok: true, task_runs: children.task_runs || [] };
}

export async function agentTreeFromBody(body = {}, env = {}) {
  const bindings = envDb(env);
  if (!bindings.ok) return bindings;

  if (body.root_task_run_id) {
    const root = await getTaskRun(bindings.db, body.root_task_run_id, body.actor_id);
    if (!root?.ok) return root;
    const all = [root.task_run];

    const levelOne = await listChildrenForParent(bindings.db, body.actor_id, root.task_run.task_run_id, body.limit);
    if (!levelOne.ok) return levelOne;
    all.push(...levelOne.task_runs);

    if (TASK_RUN_MAX_DELEGATION_DEPTH >= 2) {
      for (const child of levelOne.task_runs) {
        if (!child?.task_run_id) continue;
        const levelTwo = await listChildrenForParent(bindings.db, body.actor_id, child.task_run_id, body.limit);
        if (!levelTwo.ok) return levelTwo;
        all.push(...levelTwo.task_runs);
      }
    }

    return projectAgentTree(all);
  }

  const listed = await listTaskRuns(bindings.db, {
    actor_id: body.actor_id,
    limit: body.limit
  });
  if (!listed?.ok) return listed;
  return projectAgentTree(listed.task_runs || []);
}

export const EVENT_PLANE_LIST_TOOL_DEFINITION = Object.freeze({
  name: EVENT_PLANE_BROKER_TOOL_IDS.event_list,
  description: "V7.7.10f first slice: read-only operational event projection over Task Runs. Poll/list only; no DO/WS upgrades in this slice.",
  inputSchema: {
    type: "object",
    required: ["actor_id"],
    properties: {
      actor_id: { type: "string" },
      task_run_id: { type: "string" },
      status: { type: "string" },
      since: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: MAX_LIST }
    },
    additionalProperties: false
  }
});

export const EVENT_PLANE_TREE_TOOL_DEFINITION = Object.freeze({
  name: EVENT_PLANE_BROKER_TOOL_IDS.agent_tree,
  description: "V7.7.10f first slice: read-only agent tree projection over Task Runs with delegation depth cap.",
  inputSchema: {
    type: "object",
    required: ["actor_id"],
    properties: {
      actor_id: { type: "string" },
      root_task_run_id: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: MAX_LIST }
    },
    additionalProperties: false
  }
});

export const EVENT_PLANE_MCP_TOOL_DEFINITIONS = Object.freeze([
  EVENT_PLANE_LIST_TOOL_DEFINITION,
  EVENT_PLANE_TREE_TOOL_DEFINITION
]);
