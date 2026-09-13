# CairnStone Retrieval Fabric / Hybrid Retrieval Adapter Contract — Accepted Future Plan

status: accepted_future_architecture
implementation_started: false
activation_gate: do_not_preempt_v7_7_6_or_v7_7_7
chain: cairnstone-v6-project-memory
date: 2026-09-13

## Thesis

**CairnStone decides authority. Retrieval engines only propose evidence.**

Absorb the strongest Polygres/pgContext retrieval ideas without importing PostgreSQL as a second source of truth. CairnStone remains the provider-neutral authority, continuity, coordination, and control plane. Search/vector systems remain replaceable derived acceleration layers.

Target: **Polygres-class hybrid retrieval underneath CairnStone-class authority.**

## Non-negotiable invariant

Lexical, vector, graph, reranker, AI Search, Polygres, or future adapters may rank or nominate evidence. None may confer CairnStone authority.

Before returning grounded evidence, revalidate winners against the exact captured CairnStone Scope/authority snapshot. A semantically close historical Stone must never silently beat an accepted PATH_HEAD merely because its embedding is closer.

## Cloudflare-first architecture

```text
                         CAIRNSTONE AUTHORITY
                    +--------------------------+
GitHub commit ------>| Stone / path HEAD / HEAD |
R2 raw content ----->| Scope / provenance       |
                    +------------+-------------+
                                 |
                                 v
                     RETRIEVAL PLANNER
              +------------------+------------------+
              |                  |                  |
              v                  v                  v
        LEXICAL SIGNAL      SEMANTIC SIGNAL     GRAPH SIGNAL
          D1 FTS5             Vectorize          D1 edges
           BM25                  ANN              traversal
              |                  |                  |
              +------------------+------------------+
                                 |
                                 v
                       DETERMINISTIC FUSION
                              RRF
                                 |
                                 v
                       OPTIONAL RERANKER
                                 |
                                 v
                      AUTHORITY RECHECK
               HEAD / path HEAD / Git SHA / hash
                                 |
                                 v
                      BOUNDED R2 EXPANSION
                                 |
                                 v
                    Context Compiler / ASK / Code Session
```

## Capabilities to absorb

### P0 — dense semantic retrieval
Use Cloudflare Vectorize as a disposable semantic index over existing CairnStone ref identities. Do not create a competing chunk identity system.

Compact Vectorize metadata may include vault_id, chain_key, repo_key, stone_hash, authority_hint, source_type, and ref_version. D1 remains the richer verification/authority plane.

### P0 — BM25 + vector hybrid retrieval
Run D1 FTS5/BM25 and Vectorize semantic retrieval together. Lexical search remains essential for code symbols, tool IDs, versions, hashes, config keys, filenames, and paths. Semantic retrieval adds paraphrase/concept recall.

### P0 — deterministic Reciprocal Rank Fusion
Fuse candidate rankings in the CairnStone Worker with RRF. Preserve underlying per-signal ranks and provenance; do not collapse everything into one opaque score.

Conceptual result:

```json
{
  "ref": "fsl:...",
  "stone_hash": "...",
  "chain": "...",
  "path": "...",
  "commit_sha": "...",
  "authority_class": "PATH_HEAD",
  "signals": {
    "lexical_rank": 3,
    "semantic_rank": 1,
    "graph_rank": null
  },
  "fused_rank": 1
}
```

### P0 — filter-first ANN
Resolve CairnStone Scope first. Project a bounded filter set into Vectorize so semantic nearest-neighbor retrieval is narrowed before top-K selection where supported. Vectorize narrows; D1 verifies.

### P0 — exact authority/source recheck
Derived indexes are never truth. Recheck each winner for:
- stone/ref identity;
- membership in captured Scope;
- current authority classification for the snapshot;
- PATH_HEAD/CHAIN_HEAD identity when applicable;
- immutable Git provenance where present;
- content/ref identity needed for expansion.

If authority moved mid-request, fail closed using existing Scope race semantics rather than mixing generations.

### P0/P1 — graph-augmented retrieval
Use typed D1 edges as a retrieval signal after lexical/semantic discovery: supersedes, patches, reviews, documents, references. Graph relations may alter relevance/expansion choice but never manufacture authority.

Prefer lexicographic semantics:

```text
authority class
  -> retrieval relevance
  -> graph relationship
  -> optional rerank
```

### P1 — provider-neutral retrieval plan
Define operational `cairnstone-retrieval-plan-v1`:

```json
{
  "query": "...",
  "scope": {"mode": "multi", "chains": ["..."]},
  "signals": ["lexical", "semantic", "graph"],
  "filters": {
    "authority": ["CHAIN_HEAD", "PATH_HEAD"],
    "repo": ["nothinginfinity/cairnstone-v6"]
  },
  "fusion": {"method": "rrf"},
  "rerank": {"enabled": false},
  "budget": {"candidates": 50, "expanded": 8, "bytes": 40000}
}
```

This is operational state, never accepted-state authority.

### P1 — optional bounded reranking
Add only after deterministic hybrid retrieval is accepted. Desired degradation:
- reranker unavailable -> BM25 + Vectorize + graph + RRF;
- Vectorize unavailable -> BM25 + graph;
- graph unavailable -> lexical + semantic;
- no derived index may block deterministic authority lookup/resume.

Retrieval quality may degrade; authority correctness may not.

## Adapter model

Native adapters:
- `d1-fts`: BM25/FTS5, exact metadata/path/source filters, graph and authority verification.
- `vectorize`: dense semantic ANN with Scope-derived filtering; derived index only.
- `r2-content`: bounded raw expansion; no ranking/authority by itself.
- `workers-ai-rerank`: optional advisory rerank; zero authority.

Future external adapters behind the same contract:
- Cloudflare AI Search;
- Polygres/pgContext;
- PostgreSQL/pgvector;
- Qdrant/other vector stores;
- enterprise search/APIs;
- future sparse or late-interaction engines.

External adapters return candidate evidence + source identity + retrieval diagnostics. CairnStone performs final authority validation.

## AI Search policy

Cloudflare AI Search is appropriate for large external or R2-backed document corpora, PDFs, customer document collections, and research libraries. Expose it as a source/retrieval adapter, not the canonical CairnStone Stone authority engine. Avoid competing chunk identities where CairnStone refs already exist.

## Polygres policy

Do not add PostgreSQL merely to imitate Polygres.

Absorb:
- dense + lexical hybrid retrieval;
- filter-aware ANN;
- RRF;
- exact source recheck;
- structured filters;
- composable retrieval;
- optional reranking.

Polygres itself may later be exposed as `cairnstone-storage-adapter-polygres` for applications already using it.

Do not absorb:
- general-purpose PostgreSQL transaction semantics;
- ORM/relational OLTP responsibilities;
- ANN/HNSW internals;
- vector-engine quantization/index-maintenance internals;
- a second database authority model;
- timestamp-derived currentness;
- model/reranker output as accepted state.

## First bounded implementation slice

Candidate: **Hybrid Retrieval Fabric A — deterministic lexical + semantic fusion**.

Minimum acceptance behavior:
1. Resolve exact `cairnstone-scope-v1` and capture authority snapshot.
2. Generate D1 FTS/BM25 candidates.
3. Generate Vectorize semantic candidates using Scope-derived filters.
4. Fuse deterministically with RRF.
5. Re-check winners against the exact authority snapshot.
6. Expand only bounded winning refs from R2.
7. Re-check authority before returning.
8. Return provenance plus per-signal diagnostics.
9. Never move chain/path HEADs.
10. Preserve current `find_scope` semantics when semantic infrastructure is unavailable.

Do not start with reranking.

## Integration targets

After live acceptance, integrate beneath:
- `cairnstone_find_scope`;
- `cairnstone_ask_scope`;
- V7 Context Compiler memory selection;
- semantic skill/memory discovery where useful;
- V7.7.7 Persistent Code Mode resume/context compilation;
- federated/external Scope adapters.

No caller should need to know which backend produced candidates unless diagnostics are requested.

## Acceptance benchmark 

The defining question:

> Does hybrid retrieval find more useful evidence while NEVER degrading CairnStone authority, provenance, determinism, bounded context, or race protection?

Evaluation corpus must include:
- exact identifier queries where BM25 should dominate;
- paraphrased conceptual queries where semantic retrieval adds recall;
- accepted vs historical near-duplicates;
- superseded/patch/review graph relationships;
- multi-chain Scope and repo isolation;
- concurrent HEAD movement/race tests;
- Vectorize/reranker outage degradation.

Measure:
- recall@k;
- accepted-authority precision;
- historical false-promotion count = 0;
- Scope leakage count = 0;
- race/mixed-generation count = 0;
- expanded bytes/tokens;
- latency/cost;
- fallback behavior.

## Sequencing

This plan is accepted now as future architecture. It does **not** change the active roadmap sequence.

1. Finish/live-accept V7.7.6 credential/invite lifecycle.
2. Activate/execute V7.7.7 Persistent Code Mode under its accepted gates.
3. Schedule Retrieval Fabric as an orthogonal bounded slice when it will not destabilize those acceptance tests, or pull it forward only if V7.7.7 demonstrates semantic retrieval as a measured dependency.
4. Do not replace START HERE or project-memory chain HEAD merely to record this plan.
5. When implementation activates, create a new explicit implementation START HERE/roadmap transition with its own acceptance gate.

## End state

```text
CairnStone Scope
   |
   +-- CairnStone Vault -> D1 FTS / Vectorize / D1 graph
   +-- GitHub
   +-- External data -> AI Search / Polygres / SQL / APIs
   |
   v
retrieval adapters
   |
BM25 + semantic + graph
   |
deterministic fusion
   |
authority validation
   |
context compiler
   |
ChatGPT / Claude / Grok / Workers AI / future models
```

**CairnStone owns durable state, authority, provenance, context compilation, policy, and continuity. Storage/search systems remain replaceable retrieval substrates.**
