# V7.0 — Context Compiler Contract

Status: **implemented and live-accepted; authority-first retrieval correctness hardening accepted on runtime 0.5.12**
Phase boundary: **foundational V7 slice after frozen V6.10 control-plane baseline**
Runtime implementation: **complete; V7.0 authority-first retrieval hardening live-accepted in GitHub Actions run 32915664885**

## 1. Purpose

V7 changes the role of CairnStone from a collection of trustworthy memory/skill/control-plane primitives into a provider-neutral agent runtime foundation.

The first V7 primitive is one deterministic operation:

`agent_bootstrap`

It compiles the exact accepted context an agent needs before an LLM is invoked.

V7.0 deliberately does **not** call an LLM, choose a model, send provider credentials, execute tools, grant mutation authority, or change any CairnStone accepted state. Its output is a bounded, provenance-bearing, content-identified context package that a later runtime/provider adapter can consume.

The architectural invariant is:

> CairnStone defines the agent state; the LLM is a replaceable reasoning engine that receives that state.

## 2. Frozen V6 inputs

V7.0 builds on, but does not redefine, the V6 control plane:

- canonical project-memory chain and deterministic `cairnstone_resume_chain`;
- canonical operating-guide path HEAD and immutable Git provenance;
- AC1 correspondence metadata;
- accepted `cairnstone-v6-skills` manifest/path HEADs;
- deterministic `cairnstone_resolve_skills`;
- provenance-bearing `cairnstone_get_skill_bundle`;
- deterministic search / accepted-state evidence;
- V6.10 Skills Sub-Agent as a later optional advisory layer, never authority.

V6.10 remains frozen except for explicit correctness/security backports.

## 3. Proposed MCP operation

### `cairnstone_agent_bootstrap`

Logical signature:

```text
cairnstone_agent_bootstrap(
  actor_id,
  task,
  chain,
  capabilities?,
  loaded_skills?,
  limits?,
  include_inbox?,
  mode? // legacy_full | optimized_sparse
)
```

The name may be shortened to `agent_bootstrap` internally, but the public CairnStone MCP tool should remain namespaced.

### Required input

```json
{
  "actor_id": "chatgpt:cairnstone-v7",
  "task": "Review the latest deployment failure and determine the next safe action.",
  "chain": "cairnstone-v6-project-memory"
}
```

Rules:

- `actor_id` uses the existing `namespace:identifier` convention.
- `task` is descriptive input only; it grants no authority.
- `chain` is the accepted-state/memory chain to compile.
- No API keys, provider secrets, bearer tokens, wallet secrets, or other credentials are accepted.

### Optional capability input

```json
{
  "capabilities": {
    "tools": [
      {
        "id": "AFO GitHub API MCP.list_workflow_runs",
        "available": true,
        "class": "read"
      },
      {
        "id": "AFO GitHub API MCP.trigger_workflow_dispatch",
        "available": true,
        "class": "mutation"
      }
    ],
    "supports_tool_calls": true,
    "max_context_tokens": 32000
  }
}
```

The compiler may use this only to:

- filter/rank deterministic skill recommendations;
- report missing required capabilities;
- size the returned package.

It may **not** convert tool availability into permission.

Allowed tool classes are:

- `read`
- `mutation`
- `execution`
- `unknown`

Unknown remains unknown; the compiler must not guess elevated authority.

### Optional limits

Recommended defaults:

```json
{
  "limits": {
    "max_skills": 5,
    "max_memory_hits": 6,
    "max_memory_bytes": 24000,
    "max_inbox_items": 10,
    "max_package_bytes": 64000
  }
}
```

Server-enforced hard ceilings must exist even if the caller requests larger values.

## 4. Deterministic compile pipeline

The operation runs this order and no other:

```text
INPUT
  ↓
validate actor/task/chain/capabilities
  ↓
health/runtime identity
  ↓
resume accepted chain state
  ↓
resolve canonical instruction path HEAD
  ↓
read compact AC1 inbox state (no status mutation)
  ↓
deterministic skill resolution
  ↓
load accepted boot + selected skill bundle
  ↓
deterministic bounded memory retrieval
  ↓
classify authority/provenance
  ↓
compile tool-capability coverage/policy evidence
  ↓
canonicalize package
  ↓
SHA-256 package identity
  ↓
RETURN
```

Prohibited during V7.0 compilation:

- Workers AI;
- BYOK provider calls;
- `cairnstone_skill_agent`;
- `cairnstone_ask`;
- tool execution on behalf of the agent;
- any GitHub/Cloudflare mutation;
- any chain/path HEAD movement;
- correspondence status mutation;
- automatic freshness acceptance.

## 5. Context package schema

Proposed schema identifier:

`cairnstone-agent-context-v1`

Top-level shape:

```json
{
  "ok": true,
  "schema": "cairnstone-agent-context-v1",
  "package_id": "sha256:<hex>",
  "actor": {},
  "request": {},
  "runtime": {},
  "authority": {},
  "instructions": {},
  "coordination": {},
  "skills": {},
  "memory": {},
  "capabilities": {},
  "policy": {},
  "limits": {},
  "provenance": {}
}
```

### 5.1 Actor / request

```json
{
  "actor": {
    "actor_id": "chatgpt:cairnstone-v7"
  },
  "request": {
    "task": "...",
    "chain": "cairnstone-v6-project-memory"
  }
}
```

No provider identity belongs in the authority portion of the package. A later router may add an outer runtime envelope containing provider/model choice without changing the context package itself.

### 5.2 Runtime

```json
{
  "runtime": {
    "cairnstone_version": "0.x.x",
    "protocol": "FSL-CCR Stone v6",
    "compiled_at": "ISO-8601"
  }
}
```

`compiled_at` is operational metadata and should be excluded from `package_id` hashing unless the implementation explicitly defines it as part of the canonical snapshot.

### 5.3 Authority snapshot

```json
{
  "authority": {
    "chain": "cairnstone-v6-project-memory",
    "chain_head": {
      "stone_hash": "<full hash>",
      "path": "<path|null>",
      "repo": "<repo|null>",
      "commit_sha": "<immutable sha|null>"
    },
    "path_heads": [
      {
        "path": "docs/AI_OPERATING_GUIDE.md",
        "stone_hash": "<full hash>",
        "repo": "nothinginfinity/cairnstone-v6",
        "commit_sha": "<immutable sha>"
      }
    ],
    "timestamp_ordering_used": false
  }
}
```

The package must preserve full hashes. No "latest by created_at" inference is allowed.

#### V7.6.1 sparse-authority compatibility extension

`legacy_full` remains the default and preserves the authority shape above. An explicit `optimized_sparse` mode may transmit only a deterministic task-relevant subset in `authority.path_heads`, but it MUST also carry a `cairnstone-sparse-authority-v1` envelope containing: the full accepted path-head count, a deterministic SHA-256 digest over the complete sorted accepted `(path, stone_hash)` pointer set, an authority-manifest identity binding that digest to the canonical chain HEAD, represented/omitted counts, and a deterministic expansion mechanism. The complete accepted pointer set remains server-side authority.

Sparse mode changes transmission, not authority. The initial and final race snapshots MUST still cover every accepted path HEAD, including omitted heads. `package_id` MUST commit to the full sparse authority manifest/root so changing an omitted accepted path HEAD changes package identity. Represented task-relevant path heads remain normal full-hash records and may be expanded to the complete set through `cairnstone_resume_chain`, with the returned full set checked against the expected sparse digest/root. Spatial, lexical, or retrieval relevance never promotes historical evidence into accepted authority.

### 5.4 Canonical instructions

The compiler identifies the accepted operating guide from the chain/path HEAD, not mutable Git `main`.

```json
{
  "instructions": {
    "path": "docs/AI_OPERATING_GUIDE.md",
    "stone_hash": "<full hash>",
    "repo": "nothinginfinity/cairnstone-v6",
    "commit_sha": "<immutable sha>",
    "content_identity": {
      "sha256": "<hex>",
      "git_blob_sha": "<hex>",
      "bytes": 0
    },
    "content": "<bounded accepted guide body>"
  }
}
```

If a chain does not define an accepted canonical instruction path, the compiler must either:

- use an explicit server-side configured fallback contract; or
- fail with a typed `canonical_instructions_unavailable` error.

It must never silently read mutable `main` as authority.

### 5.5 Coordination / AC1

Bootstrap must check coordination without consuming messages.

```json
{
  "coordination": {
    "recipient_id": "chatgpt:cairnstone-v7",
    "unread_count": 0,
    "items": [
      {
        "message_id": "...",
        "sender_id": "...",
        "thread_id": "...",
        "status": "delivered",
        "priority": "high",
        "subject": "...",
        "stone_hash": "<full hash>",
        "lod5": "..."
      }
    ]
  }
}
```

V7.0 uses non-mutating inbox listing only. `read_message` is outside bootstrap because it changes delivery state.

A later runtime may explicitly read a selected message after bootstrap.

### 5.6 Skills

V7.0 always uses deterministic accepted-state routing.

```json
{
  "skills": {
    "chain": "cairnstone-v6-skills",
    "manifest_head": "<full hash>",
    "resolution_mode": "deterministic",
    "boot": ["core.orient"],
    "recommendations": [],
    "ambiguous": false,
    "accepted_bundle": {
      "bundle_identity": {
        "algorithm": "sha256",
        "sha256": "<hex>"
      },
      "skills": []
    }
  }
}
```

Rules:

- `core.orient` is included unless already declared loaded.
- specialized skills come only from `cairnstone_resolve_skills`;
- bodies come only from accepted path HEADs via the accepted bundle boundary;
- mutable branches are never authority;
- the compiler never calls `cairnstone_skill_agent`.

If deterministic routing is ambiguous, return:

```json
{
  "ambiguous": true,
  "advisory_model_may_help_later": true
}
```

The later V7.1 runtime may choose to call the V6.10 advisory sub-agent, but the context compiler remains deterministic.

### 5.7 Memory / evidence

Memory retrieval is bounded and deterministic.

The package always contains:

1. canonical chain HEAD orientation;
2. accepted path-HEAD authority identity — all accepted path-HEAD metadata in `legacy_full`, or the cryptographically complete full-set root/count plus represented task-relevant path-HEAD metadata in `optimized_sparse`;
3. task-relevant memory/evidence selected through deterministic search;
4. authority classification for every included evidence item.

Example:

```json
{
  "memory": {
    "query": "<deterministically normalized task>",
    "items": [
      {
        "authority_class": "CHAIN_HEAD",
        "stone_hash": "<full hash>",
        "path": "...",
        "ref_id": "...",
        "line_start": 1,
        "line_end": 40,
        "content": "...",
        "freshness": "NOT_CHECKED"
      }
    ],
    "truncated": false
  }
}
```

Allowed authority classes:

- `CHAIN_HEAD`
- `PATH_HEAD`
- `HISTORICAL`
- `CORRESPONDENCE`

Retrieval rank never changes authority classification.

Current accepted-state authority also controls presentation order: matching `CHAIN_HEAD` evidence is ordered before matching `PATH_HEAD`, which is ordered before `HISTORICAL`; lexical/BM25 relevance remains the tie-breaker within an authority class.

For tasks deterministically classified as current-state/status/next/roadmap queries, if an authoritative matching item exists for a path, superseded `HISTORICAL` matches for that same path are filtered before bounded expansion. Explicit history/comparison queries disable this same-path suppression. Disabling suppression means historical candidates remain eligible; finite `max_memory_hits`, memory-byte, and package-byte budgets may still omit them after higher-authority evidence fills the budget.

The output `memory.retrieval_policy` records the authority ordering, whether current-state same-path suppression applied, and how many historical candidates were suppressed.

Historical evidence can be included when relevant, but must not be presented as current accepted state.

V7.0 does not require live freshness checks by default because those perform external GitHub reads and may add latency/non-determinism. A future explicit option may request freshness evidence, but freshness must remain separate from acceptance authority.

### 5.8 Capabilities and policy

```json
{
  "capabilities": {
    "available_tools": [],
    "missing_required_tools": [],
    "supports_tool_calls": true
  },
  "policy": {
    "context_compiler_called_llm": false,
    "execution_authority": false,
    "mutation_authority": false,
    "provider_credentials_in_package": false,
    "accepted_state_only_for_authority": true,
    "mutable_branch_is_authority": false
  }
}
```

The compiler reports capability; it does not grant permission.

Permissioning belongs to a later execution-policy layer.

## 6. Package identity / immutability

The package needs a stable content identity so two providers can prove they received the same agent state.

Recommended rule:

1. Build a canonical JSON object excluding explicitly ephemeral fields such as compile latency and optionally `compiled_at`.
2. Sort object keys recursively.
3. Preserve array order where order has semantic meaning.
4. Serialize UTF-8 without insignificant whitespace.
5. Compute SHA-256.
6. Return:

```text
package_id = "sha256:" + hex_digest
```

The hashed payload must include at minimum:

- actor ID;
- task;
- chain;
- chain HEAD;
- accepted path HEADs represented in the package; in `optimized_sparse`, also the deterministic full accepted path-head digest/root and full/represented/omitted counts so omitted authority remains identity-bearing;
- canonical instruction identity/content identity;
- AC1 inbox snapshot metadata included in the package;
- accepted skills manifest HEAD;
- selected skill IDs/versions/stone hashes/commit SHAs/content identities;
- memory retrieval policy plus included memory evidence identities, authority classes, and semantic order;
- capability metadata that affected selection;
- effective size limits;
- policy flags.

A provider/model choice must **not** alter `package_id` when all agent context is otherwise identical.

Because memory evidence ordering now carries authority semantics, `package_id` must change when the retrieval policy, evidence authority classes, or semantic evidence order changes even if the same evidence identity set is present.

This is the key cross-provider invariant.

## 7. Determinism definition

For identical normalized input and identical authoritative/read-model state, V7.0 must produce the same hash-bearing payload.

Permitted reasons for a new package identity include:

- chain HEAD changed;
- a represented path HEAD changed; in `optimized_sparse`, any omitted accepted path HEAD changing must also change the full authority digest/root and therefore `package_id`;
- operating guide accepted version changed;
- AC1 inbox snapshot included in the package changed;
- skills manifest/path HEAD changed;
- deterministic memory retrieval result changed because accepted/search state changed;
- caller capability input changed;
- task/actor/limits changed.

A model/provider change alone is not a permitted reason.

## 8. Error model

Typed failures should include at least:

- `invalid_actor_id`
- `invalid_task`
- `chain_not_found`
- `canonical_head_missing`
- `canonical_instructions_unavailable`
- `accepted_instruction_source_not_immutable`
- `skills_manifest_unavailable`
- `accepted_skill_bundle_invalid`
- `package_size_limit_exceeded`
- `context_compile_race`

`context_compile_race` is important: if authoritative state changes between the initial snapshot and final package assembly, fail closed and retry from a new snapshot rather than mixing generations.

## 9. Race / snapshot protection

V7.0 must protect against one request mixing state generations.

At minimum:

1. snapshot chain HEAD + the complete accepted path-HEAD vector + skills manifest HEAD before expansion (sparse transmission never narrows the race-protected authority vector);
2. compile instructions/skills/memory;
3. re-read the minimal authority vector before hashing;
4. if any authority pointer used in the package changed, return `context_compile_race`.

This mirrors the V6.10 manifest-race protection principle at the whole-agent-context level.

## 10. Size discipline

The compiler is an **information compiler**, not a dump endpoint.

Rules:

- include full canonical instructions when within the effective budget;
- in `legacy_full`, include compact metadata for all accepted path HEADs; in `optimized_sparse`, include the cryptographically complete full-set authority root/count plus only deterministic task-relevant represented head metadata; never include all bodies;
- include only selected skill bodies;
- include bounded task-relevant memory windows;
- include compact inbox metadata by default;
- never preload the entire skill catalog;
- never dump an entire large chain by default.

Return package accounting:

```json
{
  "limits": {
    "effective_max_package_bytes": 64000,
    "package_bytes": 41200,
    "skills_bytes": 7200,
    "memory_bytes": 18000,
    "instructions_bytes": 16000,
    "truncated": false
  }
}
```

If required canonical content cannot fit safely, fail or return an explicit structured truncation state. Never silently omit authority-critical instructions.

## 11. Security boundaries

V7.0 must reject or strip:

- API keys;
- OAuth bearer tokens;
- provider secrets;
- wallet private keys/seed phrases;
- arbitrary caller-supplied "accepted" hashes that bypass CairnStone;
- model-produced skill IDs;
- model-produced authority labels.

Candidate content, correspondence text, skill text, and memory are data inside the package. They do not gain instruction precedence over the canonical operating guide merely because they contain imperative language.

## 12. Relationship to V7.1 provider router

V7.1 consumes a completed V7.0 package.

```text
actor + task + chain
        ↓
V7.0 agent_bootstrap
        ↓
cairnstone-agent-context-v1
package_id = sha256:...
        ↓
V7.1 provider-neutral router
        ↓
Workers AI / OpenAI / Anthropic / xAI / Gemini / other
```

V7.1 may:

- choose a provider/model;
- translate the context package into provider message/tool schema;
- call AI Gateway;
- invoke the V6.10 Skills Sub-Agent when bootstrap flags genuine routing ambiguity;
- collect model outputs/tool intents.

V7.1 must not redefine accepted-state authority.

Provider credentials live only in the router/provider layer and never in the immutable context package.

## 13. Relationship to V7.2 console

The console should expose the same V7.0 package humans and agents use.

The evidence inspector can show:

- package ID;
- chain HEAD;
- instruction commit;
- skill manifest HEAD;
- loaded skills and their immutable commits;
- memory citations;
- inbox coordination state;
- available vs missing tools;
- provider/model chosen by V7.1.

This makes the UI an inspector/controller for the same runtime contract rather than a separate source of truth.

## 14. V7.0 acceptance contract

V7.0 implementation is complete only when all of the following pass.

### A. No-model proof

Instrument a bootstrap call and prove:

- Workers AI calls: 0;
- external BYOK model calls: 0;
- Skills Sub-Agent calls: 0;
- ASK1 calls: 0.

### B. Same-state reproducibility

Run the same request twice without changing accepted/read-model state.

Require:

- identical `package_id`;
- identical hashed payload;
- ephemeral timing fields may differ only if excluded from the hash.

### C. Cross-provider neutrality

Feed the same compiled package to two test provider adapters or mock adapters.

Require:

- identical V7.0 `package_id`;
- provider/model identity exists only outside the authority package.

### D. Accepted-instruction authority

Advance Git `main` for the guide without moving its CairnStone path HEAD.

Require bootstrap still compiles the accepted immutable guide version.

### E. Skills authority

Create an unaccepted candidate skill edit.

Require bootstrap uses only the accepted manifest/path HEAD catalog.

### F. Coordination snapshot

Place a delivered AC1 message in the actor inbox.

Require bootstrap reports it without changing delivery status to `read`.

### G. Race failure

Change a used authority pointer during compile.

Require `context_compile_race`; never return a mixed-generation package.

### H. No execution authority

Every successful result states:

```json
{
  "execution_authority": false,
  "mutation_authority": false
}
```

### I. Package bounds

Oversized requested context must respect hard server ceilings and return explicit accounting/truncation/error behavior.

### J. Direct MCP acceptance

Production acceptance must verify through direct MCP JSON-RPC, not only internal unit tests or server health advertisement.

## 15. Definition of done

V7.0 is done when CairnStone can deterministically answer:

> "What exact agent state should any capable model receive for actor X, task Y, on chain Z, right now?"

with one bounded, immutable, content-identified package whose authority can be independently inspected and whose construction required no LLM.

Only after that contract is implemented and live accepted should V7.1 provider-neutral model routing begin.
