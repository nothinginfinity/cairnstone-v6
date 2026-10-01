import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OBJECT_INSPECTOR_SCHEMA,
  OBJECT_LINK_SCHEMA,
  objectInspectFromBody,
  objectInspectorHtmlResponse,
  renderObjectInspectorHtml
} from "../src/object-inspector.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

function makeStone(hash, overrides = {}) {
  return {
    hash,
    title: `Stone ${hash[0]}`,
    author: "test:actor",
    created_at: "2026-10-01T00:00:00.000Z",
    repo: "nothinginfinity/cairnstone-v6",
    commit_sha: "1".repeat(40),
    chain_hash: "cairnstone-v6-project-memory",
    path: `project-memory/${hash[0]}.md`,
    stone_json: JSON.stringify({ layers: { lod5: `Summary ${hash[0]}` } }),
    ...overrides
  };
}

function makeEnv({ correspondence = [], chainHead = A, pathHeads = {}, stones = {}, edges = [] } = {}) {
  const correspondenceSet = new Set(correspondence);
  const stoneMap = new Map(Object.entries(stones));
  return {
    CAIRNSTONE_PUBLIC_BASE_URL: "https://example.test",
    CAIRNSTONE_DB: {
      prepare(sql) {
        let bound = [];
        return {
          bind(...args) { bound = args; return this; },
          async first() {
            if (sql.includes("FROM correspondence_deliveries")) {
              return correspondenceSet.has(bound[0]) ? { stone_hash: bound[0] } : null;
            }
            if (sql.includes("FROM chain_heads")) {
              return chainHead ? { head_hash: chainHead } : null;
            }
            if (sql.includes("FROM path_heads")) {
              const key = `${bound[0]}|${bound[1]}`;
              return Object.prototype.hasOwnProperty.call(pathHeads, key) ? { head_hash: pathHeads[key] } : null;
            }
            if (sql.includes("FROM stones WHERE hash")) return stoneMap.get(bound[0]) || null;
            return null;
          },
          async all() {
            if (sql.includes("FROM stone_edges WHERE from_hash")) {
              return { results: edges.filter(edge => edge.from_hash === bound[0]).slice(0, bound[1]) };
            }
            if (sql.includes("FROM stone_edges WHERE to_hash")) {
              return { results: edges.filter(edge => edge.to_hash === bound[0]).slice(0, bound[1]) };
            }
            return { results: [] };
          }
        };
      }
    }
  };
}

test("V7.7.11i non-Stone refs get a canonical universal deep link but no private hydration", async () => {
  const result = await objectInspectFromBody({ object_ref: "msg:private-message-id" }, makeEnv());
  assert.equal(result.ok, true);
  assert.equal(result.schema, OBJECT_INSPECTOR_SCHEMA);
  assert.equal(result.kind, "msg");
  assert.equal(result.inspection_status, "link_only");
  assert.equal(result.object_link.schema, OBJECT_LINK_SCHEMA);
  assert.equal(result.object_link.object_ref, "msg:private-message-id");
  assert.equal(result.object_link.https_url, "https://example.test/inspect?ref=msg%3Aprivate-message-id");
  assert.equal(result.object_link.secret_bearer_in_url, false);
  assert.equal(result.hydration.attempted, false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "orientation"), false);
  assert.equal(result.policy.relationship_grants_visibility, false);
});

test("V7.7.11i safe Stone inspection reports real HEAD classification and exact stored edges", async () => {
  const focal = makeStone(A, { title: "Inspector focal" });
  const related = makeStone(B, { title: "Related safe" });
  const env = makeEnv({
    chainHead: A,
    pathHeads: { [`${focal.chain_hash}|${focal.path}`]: A },
    stones: { [A]: focal, [B]: related },
    edges: [{ from_hash: A, to_hash: B, edge_type: "references", note: "exact stored edge" }]
  });
  const result = await objectInspectFromBody({ object_ref: `stone:${A}` }, env);
  assert.equal(result.ok, true);
  assert.equal(result.inspection_status, "hydrated");
  assert.equal(result.stone.hash, A);
  assert.equal(result.stone.title, "Inspector focal");
  assert.deepEqual(result.accepted_state.classification, ["CHAIN_HEAD", "PATH_HEAD"]);
  assert.equal(result.accepted_state.timestamp_ordering_used, false);
  assert.equal(result.edges.outbound.length, 1);
  assert.deepEqual(result.edges.outbound[0], {
    from_hash: A,
    to_hash: B,
    edge_type: "references",
    note: "exact stored edge",
    direction: "outbound"
  });
  assert.equal(result.related[0].title, "Related safe");
  assert.equal(result.graph.edges[0].type, "references");
  assert.equal(result.policy.chain_heads_mutated, false);
  assert.equal(result.policy.path_heads_mutated, false);
});

test("V7.7.11i correspondence-backed focal Stone fails closed before metadata or graph hydration", async () => {
  const env = makeEnv({ correspondence: [A], stones: { [A]: makeStone(A, { title: "Must stay private" }) } });
  const result = await objectInspectFromBody({ object_ref: `stone:${A}` }, env);
  assert.equal(result.ok, true);
  assert.equal(result.inspection_status, "restricted");
  assert.equal(result.restricted, true);
  assert.equal(result.stone, null);
  assert.equal(result.accepted_state, null);
  assert.equal(result.edges, null);
  assert.equal(result.graph, null);
  assert.equal(JSON.stringify(result).includes("Must stay private"), false);
  assert.equal(result.policy.relationship_grants_visibility, false);
});

test("V7.7.11i related correspondence Stones are ref-safe redacted placeholders", async () => {
  const focal = makeStone(A, { title: "Safe focal" });
  const privateRelated = makeStone(C, { title: "Private related title" });
  const env = makeEnv({
    correspondence: [C],
    stones: { [A]: focal, [C]: privateRelated },
    edges: [{ from_hash: C, to_hash: A, edge_type: "references", note: "private edge annotation must not leak" }]
  });
  const result = await objectInspectFromBody({ object_ref: `stone:${A}` }, env);
  assert.equal(result.ok, true);
  assert.equal(result.restricted_related_count, 1);
  assert.equal(result.related[0].object_ref, `stone:${C}`);
  assert.equal(result.related[0].restricted, true);
  assert.equal(Object.prototype.hasOwnProperty.call(result.related[0], "title"), false);
  assert.equal(JSON.stringify(result).includes("Private related title"), false);
  assert.equal(JSON.stringify(result).includes("private edge annotation must not leak"), false);
  assert.equal(result.edges.inbound[0].note, null);
  assert.equal(result.edges.inbound[0].restricted_target, true);
  const relatedNode = result.graph.nodes.find(node => node.id === C);
  assert.equal(relatedNode.restricted, true);
  assert.equal(relatedNode.title, null);
});

test("V7.7.11i historical Stone classification never infers authority from timestamp", async () => {
  const focal = makeStone(B);
  const env = makeEnv({ chainHead: A, stones: { [B]: focal }, pathHeads: {} });
  const result = await objectInspectFromBody({ object_ref: `stone:${B}` }, env);
  assert.deepEqual(result.accepted_state.classification, ["HISTORICAL"]);
  assert.equal(result.accepted_state.accepted, false);
  assert.equal(result.accepted_state.timestamp_ordering_used, false);
});

test("V7.7.11i.2 HTTPS inspector renders mobile Summary/Graph/Source/Related/Messages safely", async () => {
  const focal = makeStone(A, {
    title: "<script>alert('x')</script>",
    stone_json: JSON.stringify({ layers: { lod5: "Summary <img src=x onerror=alert(1)>" } })
  });
  const related = makeStone(B, { title: "Related <b>Stone</b>" });
  const env = makeEnv({
    chainHead: A,
    pathHeads: { [`${focal.chain_hash}|${focal.path}`]: A },
    stones: { [A]: focal, [B]: related },
    edges: [{ from_hash: A, to_hash: B, edge_type: "references", note: "safe edge" }]
  });
  const result = await objectInspectFromBody({ object_ref: `stone:${A}` }, env);
  const html = renderObjectInspectorHtml(result);
  assert.match(html, /viewport-fit=cover/);
  for (const section of ["Summary", "Graph", "Source", "Related", "Messages"]) assert.match(html, new RegExp(section));
  assert.equal(html.includes("<script>alert('x')</script>"), false);
  assert.equal(html.includes("<img src=x onerror=alert(1)>"), false);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /Bounded Stone relationship graph/);
  assert.match(html, /JSON view/);
});

test("V7.7.11i.2 restricted HTTPS view never reveals correspondence-backed metadata", async () => {
  const env = makeEnv({ correspondence: [A], stones: { [A]: makeStone(A, { title: "Private title must not render" }) } });
  const result = await objectInspectFromBody({ object_ref: `stone:${A}` }, env);
  const html = renderObjectInspectorHtml(result);
  assert.match(html, /Restricted Stone/);
  assert.match(html, /authenticated correspondence surface/);
  assert.equal(html.includes("Private title must not render"), false);
});

test("V7.7.11i.2 HTML response is private/no-store and frame-compatible", async () => {
  const result = await objectInspectFromBody({ object_ref: "msg:private-message-id" }, makeEnv());
  const response = objectInspectorHtmlResponse(result);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/html/);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-frame-options"), null);
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(await response.text(), /Universal object deep link/);
});

test("V7.7.11i object links fail closed to HTTPS when public base override is insecure", async () => {
  const env = makeEnv();
  env.CAIRNSTONE_PUBLIC_BASE_URL = "http://insecure.example.test";
  const result = await objectInspectFromBody({ object_ref: "msg:private-message-id" }, env);
  assert.equal(result.ok, true);
  assert.match(result.object_link.https_url, /^https:\/\/cairnstone-v6\.jaredtechfit\.workers\.dev\/inspect\?/);
  assert.equal(result.object_link.https_url.includes("insecure.example.test"), false);
});
