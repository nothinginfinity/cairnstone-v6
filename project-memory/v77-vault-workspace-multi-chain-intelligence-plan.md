# V7.7 — Vault / Workspace Navigation + Multi-Chain Intelligence

Status: **PLANNED / READ-FIRST.** Begin after the active V7.6 optimization/interop track reaches its own acceptance gate. V7.7 must remain correct through the portable CairnStone runtime and must not depend on experimental V7.6.2b native MCP hydration.

## Product thesis

CairnStone should become the semantic navigation layer over every stoned project rather than a Console that requires the operator to know and manually type one chain at a time.

The user-facing mental model is **Scope**:

- one chain;
- one repository, resolved to all relevant CairnStone chains;
- an explicit set of repositories and/or chains;
- the bounded CairnStone vault;
- later, a named saved workspace that resolves to one of the above.

The selected Scope should carry across Chat, Evidence, Activity, Stones, and every correspondence/handoff view whose records contain enough provenance to be scoped honestly.

GitHub remains source-code/version-control authority. CairnStone provides accepted semantic state, handoffs, evidence, activity, graph relationships, compressed source knowledge, and grounded cross-project reasoning.

## Non-negotiable authority invariant

**Scope is navigation and retrieval context. Scope is not accepted-state authority.**

V7.7 must not create a synthetic global HEAD and must not collapse independent chains into one pseudo-chain. Every source chain retains its canonical chain HEAD, accepted per-path HEADs, graph, immutable stone identities, and source repo/path/commit provenance when available.

A cross-chain operation resolves an explicit authority snapshot containing the exact participating chain HEAD identities. Search hits and model evidence keep their original chain/repository/stone/path/commit identity and authority class. No read-only Scope operation may move chain heads, move path heads, execute tools, or grant mutation authority.

## V7.7.0 — Vault catalog and `cairnstone-scope-v1`

### Read-only catalog

Add a cheap discovery primitive, working name `cairnstone_vault_catalog`, so clients can discover the CairnStone universe without first knowing chain IDs.

A compact catalog record should contain only fields derivable from durable CairnStone state, for example:

```json
{
  "chain": "infinite-radio",
  "canonical_head": "full-hash",
  "repos": ["nothinginfinity/infinite-radio"],
  "stone_count": 123,
  "path_head_count": 18,
  "updated_at": "informational-only",
  "provenance_complete": true
}
```

Rules:

1. `canonical_head` comes directly from `chain_heads`, never timestamp inference.
2. Repository provenance may be absent. Chains without GitHub provenance remain visible and first-class.
3. Repository membership is derived from accepted CairnStone provenance, not mutable Git branch state.
4. Time fields are navigation metadata only and never decide authority.
5. Catalog reads are bounded, searchable/paginatable, and read-only.
6. If one chain genuinely contains accepted stones from multiple repositories, preserve `repos[]`; do not force a false single-repo identity.

### Scope request

Define a versioned request shape:

```json
{
  "schema": "cairnstone-scope-v1",
  "mode": "multi",
  "repos": [
    "nothinginfinity/infinite-radio",
    "nothinginfinity/cairnstone-v6"
  ],
  "chains": []
}
```

Initial modes:

- `single_chain`
- `repo`
- `multi`
- `vault`

Repository and chain selectors may coexist in `multi`. Resolution deduplicates chains deterministically.

### Resolved authority snapshot

The server returns a normalized snapshot rather than asking the browser to invent one:

```json
{
  "schema": "cairnstone-scope-snapshot-v1",
  "mode": "multi",
  "chains": [
    {"chain": "cairnstone-v6-project-memory", "head_hash": "..."},
    {"chain": "infinite-radio", "head_hash": "..."}
  ],
  "scope_id": "sha256(canonical selectors + resolved chain set)",
  "authority_digest": "sha256(canonical ordered chain/head tuples)"
}
```

The exact canonical serialization and hashing algorithm must be specified and fixture-tested. `scope_id` identifies what the user selected; `authority_digest` identifies the accepted chain-HEAD snapshot actually used for the operation.

### Race discipline

Scope compilation follows the V7 authority-first pattern:

1. resolve selectors to a canonical ordered chain set;
2. read each participating chain HEAD;
3. perform the bounded operation;
4. re-read relevant authority pointers before returning a result that claims snapshot consistency;
5. if a pointer changed, fail closed with `scope_compile_race` or deterministically restart once under a documented bounded policy.

Never silently combine evidence from two authority snapshots.

## V7.7.1 — Server-side multi-chain search

The browser must not implement cross-project intelligence by issuing N independent searches and merging them locally. The runtime owns scope resolution, ranking, authority classification, and limits.

Implementation may extend `cairnstone_find_v2` with an additive/versioned scope argument or introduce `cairnstone_find_scope`; choose after implementation review based on compatibility and schema clarity.

Each result preserves:

- chain;
- repository/repositories when known;
- stone hash;
- ref ID;
- path;
- immutable commit SHA when available;
- authority class such as `CHAIN_HEAD`, `PATH_HEAD`, `HISTORICAL`, or `DERIVED`;
- deterministic ranking evidence sufficient for tests.

### Ranking and fairness

A vault with one huge repository and several small ones must not allow corpus size alone to starve smaller selected projects.

Initial behavior should be deterministic and bounded:

1. retrieve a bounded candidate pool per participating chain;
2. score using current FTS/BM25 evidence within each chain or a documented normalized equivalent;
3. apply authority preference separately from textual relevance rather than hiding historical matches;
4. merge with deterministic tie-breaks;
5. cap total candidates, expansions, and bytes.

Vault mode gets explicit maximum chains/candidates/expanded bytes. When limits are reached, return coverage diagnostics rather than silently implying exhaustive results.

## V7.7.2 — Cross-chain grounded Q&A

Add scope-grounded Q&A, working name `cairnstone_ask_scope`.

```text
question + scope
  -> resolve exact scope snapshot
  -> load canonical orientation for participating chains under a budget
  -> scope-aware accepted-state search
  -> classify evidence by authority + provenance
  -> bounded expansion
  -> model synthesis
  -> citation validation
  -> authority-race recheck
  -> grounded answer + scope snapshot evidence
```

Evidence policy:

- represent canonical orientation for every participating chain, but use bounded summaries for large scopes rather than materializing every path head;
- prefer accepted path HEADs for current source facts;
- keep historical stones retrievable and visibly classified as historical;
- include cross-chain graph relationships only when real edges exist; never infer edges from similar names;
- validate every citation against evidence actually supplied to the model;
- retain enough provenance for the Console to show repo → chain → stone → path → commit where available.

`vault` is not permission to dump the vault into model context. Retrieval remains progressive: catalog/snapshot first, cheap metadata search, bounded winners, then exact expansion only for relevant refs. If a question is too broad for bounded synthesis, report the coverage limit and offer narrower scopes rather than pretending exhaustive coverage.

Initial `cairnstone_ask_scope` is non-persistent by default. If persisted cross-scope answers are added later, write them only into a derived workspace/ask chain with explicit source citations. Never move a source project's chain HEAD or path HEAD.

## V7.7.3 — Console global Scope navigation + Bird's Eye / Universe projection

Replace the current `Chain` field with a mobile-first **Scope** control that supports two complementary navigation modes: a fast searchable selector for known targets and an optional full-screen **Bird's Eye / Universe** spatial navigator for exploring a large stoned account. The spatial view is a projection of the same server-resolved `cairnstone-scope-v1` catalog and must never become a second source of project truth.

Opening Scope presents:

- **All CairnStone**
- repository groups with child chain IDs
- chains without repository provenance in an explicit ungrouped section
- search/filter
- multi-select
- advanced raw-chain entry when needed

After selection, show a compact summary such as:

```text
Scope
Infinite Radio + CairnStone
2 repos · 4 chains
```

For a single chain, preserve the current fast workflow and expose the exact chain ID.

### Bird's Eye / Universe projection

The Scope surface should expose an `Open Universe` / `Bird's Eye` action for cases where a list or dropdown stops scaling. The initial implementation may adapt the proven interaction/rendering patterns from `nothinginfinity/prax-your-universe` — Three.js scene, orbit/zoom controls, sphere and grid projections, raycast selection, typed node visuals, and detail-panel selection — but CairnStone owns a different data model. Prax is an implementation reference, not a persistence or authority dependency.

The visual hierarchy uses semantic zoom / level-of-detail rather than rendering the entire vault at once:

1. **Vault view** — one account/universe root plus repository constellations;
2. **Repository view** — repository nodes are the primary visible objects at normal Bird's Eye distance;
3. **Chain unfold** — selecting or zooming into a repository unfolds only that repository's relevant CairnStone chains;
4. **Intelligence unfold** — only on explicit drill-down, reveal bounded milestones, accepted HEADs/path HEADs, handoffs, evidence, or other high-value objects. Individual stones are not rendered as a default galaxy of thousands of dots.

Selecting one or more visible repo/chain nodes produces the same canonical selectors as the list/search UI and resolves through the same server-side Scope contract. Switching between list, grid, and sphere/Universe views must preserve the pending selection rather than create parallel selection state.

Spatial coordinates, clustering, animation, and visual proximity are **projection metadata only**. They may be recomputed freely and never imply accepted-state authority or a factual CairnStone graph relationship. Permanent rendered relationship lines are allowed only for real stored CairnStone edges or other explicitly grounded relationships. Search/retrieval/reasoning paths may be visualized temporarily, but must use a distinct style/state and disappear without writing graph edges.

At large scale, the browser receives/render only the current LOD plus bounded nearby/selected metadata. Opening `All CairnStone` is not permission to materialize every stone or send the entire vault to the model. Catalog → filtered candidates → selected repo/chains → bounded intelligence unfold is the required progression.

The Universe view should remain optional. Search, recents, keyboard-friendly list/grid navigation, and raw chain entry remain first-class fallbacks for accessibility, low-power devices, and users who already know the target.

### Shared Console state

The Console should have one resolved Scope state, not independent chain fields per panel. At minimum it drives:

- Chat/delegated read-only reasoning;
- Evidence;
- Stones/search;
- Activity when activity carries matching provenance.

Handoff/Inbox must be handled honestly. AC1 records that explicitly identify chain/repository/source refs can be filtered into Scope. Records without trustworthy project provenance remain visible as unscoped correspondence or under an All Correspondence view. Never infer repository ownership from actor names or subject text.

Changing Scope should resolve a fresh server snapshot, update the compact header, invalidate result caches tied to the old `scope_id`/`authority_digest`, preserve the current tab where sensible, and never alter accepted CairnStone state.

On mobile, the fast selector uses a sheet/dialog with 44px+ targets, search, clear selection, and an explicit Apply action for multi-select. The Bird's Eye view may occupy a full-screen modal/surface with touch orbit/pan/zoom, a persistent search escape hatch, a clear `Back to list` action, and an explicit Apply action. Preserve the existing no-horizontal-overflow acceptance behavior and provide a non-WebGL/list fallback if spatial rendering is unavailable.

## V7.7.4 — Saved workspaces and cross-repo operating views

After raw scope semantics are accepted, add named convenience scopes such as:

- `CairnStone Platform`
- `Music Projects`
- `Financial Software`
- `Everything`

A saved workspace is a user/navigation artifact, not chain authority. Initial definitions may live in browser local storage. Cross-device persistence can later use an operational table outside accepted-state authority tables.

A saved workspace stores selectors, not frozen accepted state. Opening it resolves a new authority snapshot so the user sees current accepted chain HEADs.

Cross-repo views can then use the same Scope contract for recent accepted milestones, handoffs, evidence by project, activity timelines, canonical HEAD summaries, search, and chat. Any `recent` ordering is navigation metadata, never authority.

## V7.7.5 — Acceptance and scale gate

The milestone is not complete until live acceptance proves the following.

### Deterministic runtime

- catalog discovers every fixture/live test chain, including a chain with null repo provenance;
- repo selector resolves only chains grounded in that repository's accepted provenance;
- multi selector deduplicates deterministically;
- same selectors + same chain HEADs produce the same snapshot identities;
- changing a participating chain HEAD changes `authority_digest`;
- deliberate mid-request authority changes are detected;
- no Scope read changes chain HEADs/path HEADs.

### Search

- single-chain scope is parity-compatible with current `cairnstone_find_v2`;
- one-repo search does not leak another repo;
- multi-repo search returns relevant hits from more than one repo;
- historical evidence remains labeled;
- tie-breaks are deterministic;
- a much larger selected chain does not automatically starve a smaller relevant chain;
- vault mode respects explicit candidate/byte/expansion limits.

### Grounded Q&A

- one answer can cite at least two genuinely different repositories;
- every citation is present in supplied evidence;
- source provenance and authority class are retained;
- a historical stone cannot masquerade as a current path HEAD;
- a scope authority race fails closed or re-resolves under the documented policy;
- model/provider changes do not change accepted authority snapshot identity.

### Console

- Scope selector lists repository groups and raw chains correctly;
- fast list/search selection and Bird's Eye / Universe selection resolve to the same canonical Scope selectors and `scope_id`;
- single-chain, repo, multi-repo, and All CairnStone modes work on mobile;
- Bird's Eye supports repository-level overview, bounded chain unfold, multi-select, search-to-focus, sphere/grid or equivalent spatial projections, and a deterministic return to the normal Console;
- visual coordinates/proximity never create authority or graph edges; permanent relationship lines correspond only to grounded stored relationships, while temporary retrieval/reasoning paths are visibly non-persistent;
- large fixtures prove semantic LOD: repository overview does not materialize every chain/stone, and chain/intelligence children load only for focused/selected regions under explicit bounds;
- WebGL/spatial failure falls back to usable list/search Scope navigation;
- Chat, Evidence, Activity, and Stones use the same resolved Scope where supported;
- correspondence is filtered only where provenance supports it;
- stale scoped results are invalidated after Scope changes;
- no horizontal overflow at the accepted mobile viewport.

### Real live proof

Use at least three genuinely stoned repositories with materially different histories. Demonstrate:

1. single-chain lookup;
2. all relevant chains for one repository;
3. an explicit two-or-more-repository scope;
4. vault-wide bounded discovery/search;
5. a grounded cross-repo answer with valid citations;
6. zero accepted-state mutation from the entire read-only workflow.

The same core functionality must work through full `/mcp` and portable `/mcp/core` Tool Vault execution. Native V7.6.2b hydration may improve ergonomics after interop acceptance but cannot be a correctness dependency.

## Data-model guidance

Prefer deriving the initial catalog from existing durable `stones`, `chain_heads`, and `path_heads` state and adding indexes/views only where measured query cost requires them. Do not introduce a second registry whose contents can drift from accepted state.

Likely derived relationships:

```text
chain
  -> chain_head
  -> accepted path_heads
  -> stone repo provenance
  -> normalized repo memberships
```

If one chain legitimately contains accepted stones from multiple repositories, preserve that fact rather than forcing a single `repo`. Operational saved-workspace state, if server-persisted later, lives outside accepted-state authority tables.

## Compatibility and rollout

V7.7 is additive:

- existing single-chain APIs remain valid;
- current Console `cs.chain` local storage should migrate automatically to a `single_chain` Scope;
- existing chain naming conventions remain valid;
- no source repo must be re-stoned merely to participate;
- V7.6 portability guarantees remain intact;
- V7.3 mutation/authorization boundaries remain unchanged;
- V7.4 cross-project agent profiles are complementary but do not define Scope authority.

Recommended implementation order:

```text
V7.7.0 catalog + scope snapshot contract
  -> V7.7.1 scope-aware deterministic search
  -> V7.7.2 cross-chain grounded Q&A
  -> V7.7.3 Console Scope selector/shared state + Bird's Eye / Universe projection
  -> V7.7.4 saved workspaces/cross-repo operating views
  -> V7.7.5 live scale + race + citation acceptance
```

Do not start with the visual dropdown alone. The server-side scope contract, authority snapshot, and retrieval semantics must exist first so the UI cannot become a second source of project truth.

## Explicit non-goals for first V7.7

- no synthetic global chain HEAD;
- no automatic cross-project mutation;
- no model-created workspace authority;
- no bulk re-stoning of all GitHub repositories;
- no dependence on mutable branch state for project membership;
- no requirement that every correspondence record be force-assigned to a repo;
- no unbounded all-vault model prompt;
- no replacement of GitHub as source/version-control authority.

## Definition of done

V7.7 is complete when CairnStone can answer, from the Console and runtime, questions such as:

- “What is the current accepted state of Infinite Radio?”
- “Show the latest handoffs and evidence for this repo.”
- “Compare how authorization is implemented in CairnStone and another selected project.”
- “Across these selected repos, where did we implement temporary private links?”
- “Across all CairnStone, which projects have unresolved work related to AI generation quality?”

Every answer must remain bounded, citation-valid, provenance-preserving, authority-race-safe, and read-only unless a later explicitly authorized workflow crosses the existing V7.3 mutation boundary.
