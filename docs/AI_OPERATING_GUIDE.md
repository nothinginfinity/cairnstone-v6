# AFO Toolchain & CairnStone V6 Operating Guide

This is the canonical operating guide for any AI assistant (Claude, ChatGPT, or
other MCP-capable clients) working on Jared Edwards's AFO/CairnStone
ecosystem, especially the `nothinginfinity/cairnstone-v6` project. It replaces
all prior V5-based instructions.

If you were pointed here by a project-instructions link, read this file in
full before doing any repo work, debugging, or CairnStone tool calls in this
project. It encodes patterns already proven across real sessions — including
a real coordination failure between concurrent Claude and ChatGPT sessions on
2026-08-23 that this guide exists specifically to prevent from recurring.

---

## 1. Canonical location — read this first

**As of 2026-08-19, CairnStone V6 is canonical.** This supersedes any
instructions that say V5 is authoritative.

- **Canonical project-memory chain:** `cairnstone-v6-project-memory`, in
  **CairnStone V6's own vault** (`cairnstone-v6.jaredtechfit.workers.dev/mcp`).
  This is where all new project-memory work — orientation stones, completion
  reports, decisions, handoffs — belongs.
- **V5 status:** frozen legacy reference as of V5 stone
  `cec5932628a2af83ba6b3bf373aee4a433721080f19f77b96e2ef327a4cf785e` (the
  "V6.8 COMPLETE" stone). Read V5 (`cairnstone-v5.jaredtechfit.workers.dev/mcp`)
  only for historical context or explicit, on-demand migration of specific
  old content into V6. Do not write new project-memory stones there.
- **A confusing naming collision to watch for:** V6's vault also contains a
  chain literally named `cairnstone-v6` — this is a separate 2-stone
  **protected runtime isolation-bootstrap chain** (just `wrangler.toml`),
  unrelated to project memory. Never confuse `cairnstone-v6` (the runtime
  chain) with `cairnstone-v6-project-memory` (the actual canonical chain).
  Do not write project-memory content into the runtime chain.
- **Migration policy is on-demand, not bulk.** Don't try to import all of V5
  into V6 at once. Pull specific old content into V6 only when a specific
  need arises, using `cairnstone_import_v5_bundle` (dry-run by default, fails
  closed on any destination collision).

## 2. Why this document exists: the coordination incident

On 2026-08-23, a Claude session and a concurrent ChatGPT session were both
working on this exact project without knowing about each other. ChatGPT had
already declared the V5→V6 cutover (2026-08-19), written the AC1
correspondence design roadmap (2026-08-21), and left a work-in-progress
handoff stone for the ASK1 feature four minutes before the Claude session
deployed that same feature. Neither session's instructions told it to check
for concurrent activity. The result: real, correct work got recorded in the
wrong (frozen-legacy) location, and a second attempt at "fixing" it nearly
left the canonical chain's graph in a disconnected, two-branch state before
the mismatch was caught and reconciled.

**The fix is procedural, not just corrective:** always resume the canonical
V6 chain and check the AC1 inbox before starting work (Section 9), and use
AC1 correspondence to leave a status note when your session materially
changes shared project state — especially if you know or suspect another
session (human-directed AI or otherwise) might be working the same project
concurrently.

## 3. What CairnStone V6 is

CairnStone V6 (MCP endpoint `cairnstone-v6.jaredtechfit.workers.dev/mcp`) is
a persistent, cross-chat/cross-client compression, indexing, and now
correspondence system backed by Cloudflare D1 (catalog + graph) and R2 (raw
content). It is the successor to CairnStone V5, with a cleaner data model:

- **Stone** — one compressed unit (a file, a note, a completion report, a
  message). Has a `hash`, `border` (title/author/created/repo/path/commit/
  chain), `layers` (lod1–lod5), `metadata`.
- **Ref** — an ~80-line chunk of a stone's raw content, with its own
  `ref_id`, keywords, preview, flags.
- **LOD ladder** (cheap → expensive): lod5 one-liner, lod4 +keywords/flags,
  lod3 per-ref summary, lod2 full ref index, lod1 pointer to raw R2 content.
  Read cheap layers first.
- **Chain** — a string tag grouping related stones (e.g. one per repo, or a
  dedicated project-memory chain).
- **Edge** — a typed, directed relationship between two stones in a real
  graph table. See Section 5.
- **Chain HEAD** — one pointer per chain marking the canonical, current
  stone for that chain overall.
- **Path HEAD** — (V6-only, did not exist in V5) a separate pointer per
  `(chain, path)` marking the canonical, current stone for one specific file
  path within a chain. Chain HEAD and path HEAD are independent: a chain's
  overall orientation can advance without any individual path's accepted
  version changing, and vice versa.
- **Commit-SHA-anchored writes.** V6's `cairnstone_commit_v2` fails closed
  unless a GitHub-sourced write resolves to an immutable 40-hex commit SHA.
  V5 allowed stoning against a branch name; V6 does not.
- **Correspondence** (new in V6, AC1) — immutable message stones with
  mutable per-recipient delivery state, for AI-to-AI coordination. See
  Section 6.
- **Grounded Q&A** (new in V6, ASK1) — `cairnstone_ask`, retrieval + LLM
  synthesis with authority classification and citation validation. See
  Section 7.

## 4. Tool reference

Call `cairnstone_health` first in any new session to confirm the live tool
count and version — this list will keep growing.

### Core stoning
- `cairnstone_create_stone` — inline content.
- `cairnstone_create_github_file_stone` — fetch a GitHub file server-side and
  stone it. Prefer this over pasting raw content.
- `cairnstone_create_repo_stones` — walk a whole repo, stone accepted files,
  generate an orientation stone, auto-link, optionally set head.
- `cairnstone_commit_v2` — **the primary write tool.** One call: create a
  stone (inline or GitHub-fetched), dedupe by content within `(chain, path)`,
  set the path head automatically, optionally set the chain head, create
  typed edges. Replaces the old create+link+set_head sequence.
- `cairnstone_fetch_github_file` — verify a GitHub fetch without stoning it.

### Reading / orientation
- `cairnstone_resume_chain` — **call this first when picking up work on a
  chain.** For normal continuation, use V7.7.1a `detail=start_here`: it returns
  a bounded `cairnstone-start-here-card-v1` with canonical chain HEAD identity,
  path/repo/commit provenance, bounded summary/metadata, and the `next`
  continuation while transmitting zero path-head/edge payload. Its
  `cairnstone-sparse-authority-v1` envelope still commits to and re-verifies
  the complete accepted path-head vector before return. Expand deliberately:
  use `detail=compact` when you need accepted path-head/HEAD-edge context or a
  delta/path-specific view, and `detail=full` only when the complete accepted
  path-head vector plus every HEAD edge must be transmitted. `detail=full`
  remains the backward-compatible wire default for older clients. All modes
  are read-only; authority still comes from chain HEAD + per-path HEADs.
- `cairnstone_manifest_v2` — token-efficient chain manifest.
  `detail=orientation` uses the V7.6.3 bounded orientation response;
  `detail=summary` and `detail=compact` preserve their legacy shapes and still
  scale with the number of accepted path HEADs; `detail=full` remains the
  explicit full graph form. Treat serialized size as measured telemetry, not
  a fixed byte constant. `since=<ISO date>` supports delta pickup, and
  orientation also accepts exact `paths[]`.
- `cairnstone_get_chain_manifest` — the older, fuller manifest call (every
  stone's lod5 + every edge). Still useful for a full graph dump.
- `cairnstone_stone_v2` — read one stone by hash. No `level` → compact
  record (border + lod5 + lod4). With `level=lod1..lod5` → that exact layer.
- `cairnstone_get_stone` / `cairnstone_get_lod` — older equivalents.
- `cairnstone_list_stones` — broad discovery / chain filter without edge
  detail.
- `cairnstone_find_by_source` — deterministic `(owner, repo, path[,
  commit_sha])` lookup, no fuzzy matching.

### Search
- `cairnstone_find_v2` — **prefer this over `cairnstone_search`.** FTS5 +
  bm25 vault-wide search with `match_mode`: `any` (default, OR across
  terms), `all` (AND), `phrase` (exact adjacent sequence; a fully-quoted
  query is always treated as a phrase). Optional `expand:true` to inline the
  top hits' raw content.
- `cairnstone_query_and_expand` — tokenizes a query, ranks refs by term
  overlap within one stone, expands only the winners.
- `cairnstone_search` — legacy single-keyword substring match. Weak on
  multi-word phrases; use `find_v2` instead.
- `cairnstone_expand` — pull an exact raw line-window when you already know
  what you want (by `ref_id`, or by `stone_hash + path + line_start`). Full
  hashes and unique >=8-character short hashes are valid. When chaining from
  `cairnstone_find_v2`, prefer the returned `ref` directly, or use
  `expand:true` when you already know you want the matching content so the
  search+read completes in one tool call.

### Vault Scope / multi-chain retrieval (V7.7)
- `cairnstone_vault_catalog` — bounded discovery of available chains/repos and
  their current authority identities. Use it to discover scope candidates,
  not to synthesize a global HEAD.
- `cairnstone_resolve_scope` — deterministically normalize requested
  chains/repos into `cairnstone-scope-v1`, preserving each participating
  chain's own authority identity.
- `cairnstone_find_scope` — bounded server-side search across the resolved
  Scope. Treat Scope strictly as navigation/retrieval context: it never
  creates synthetic global authority, never promotes historical evidence, and
  never changes any participating chain/path HEAD.
- For multi-chain work, prefer `vault_catalog → resolve_scope → find_scope`
  rather than manually stitching independent searches together. Preserve
  source chain + HEAD/path provenance in downstream reasoning. Cross-chain
  grounded Q&A (`cairnstone_ask_scope`) is **not yet production-shipped**;
  do not invent or assume that tool until live health/tool discovery exposes
  and accepted-state documentation confirms it.

### Graph
- `cairnstone_link_stones` — create a typed edge. Five types:

  | Edge type | Use when |
  |---|---|
  | `supersedes` | A re-stoned/updated version replaces an older one as canonical |
  | `patches` | A stone fixes a problem found in another stone |
  | `documents` | An orientation/summary/completion stone describes other stones |
  | `reviews` | A review-report stone evaluates another stone |
  | `references` | Generic/loose relationship — fallback, not the default |

  Pick the specific type whenever one applies.
- `cairnstone_set_head` — mark a stone as the chain-level canonical HEAD.
  This is semantic/orientation state only — it does **not** change any path
  head.
- `cairnstone_set_path_head` — explicitly accept one stone as canonical for
  `(chain, path)`. Never changes chain-level HEAD.

### Freshness & reconciliation (V6-only, did not exist in V5)
- `cairnstone_check_source_freshness` — live-check whether an accepted path
  head still matches the current GitHub file content. Records commit SHA as
  provenance only; unrelated commits elsewhere don't create false drift.
  Never advances heads.
- `cairnstone_get_source_freshness` — cheap read of the last-recorded
  freshness check for `(chain, path)`. No GitHub call.
- `cairnstone_freshness_status` — chain-wide summary from recorded checks
  only (no live GitHub calls). Splits drifted vs in-sync, flags never-checked
  path heads.
- `cairnstone_reconcile_repo` — resolves a repo ref to one immutable commit,
  walks the full git tree once, classifies every path as
  added/changed/removed/in_sync against accepted state. Read-only —
  never writes heads or stones automatically.

### Migration
- `cairnstone_import_v5_bundle` — explicitly preview (default) or import
  (`dry_run:false` + `confirm_import:true`) one complete V5 chain snapshot,
  preserving exact V5 hashes/edges/HEAD. No override mode; destination
  collisions fail closed.

### Correspondence (AC1 — V6-only, cross-session/cross-model coordination)
- `cairnstone_send_message(from, to[], content, message_id?, thread_id?,
  intent?, priority?, subject?)` — creates one immutable message stone plus
  per-recipient delivery rows. Idempotent by `(sender_id, message_id)`: exact
  replay returns the existing stone; conflicting replay (same message_id,
  different content/recipients) fails with `idempotency_conflict`. Never
  writes chain_head.
- `cairnstone_get_inbox(recipient_id, status?, limit?)` — list compact
  correspondence metadata for one recipient. Read-only.
- `cairnstone_read_message(recipient_id, message_id? | stone_hash?)` —
  returns the message content and advances delivery status
  `queued/delivered → read`. Mutates delivery state only, never the message
  stone itself.
- **Actor ID format:** `namespace:identifier`. Main interactive sessions use two
  canonical mailbox planes under the same model namespace:
  - **Chat plane:** `<namespace>:chat` for conversation, coordination, and design
    questions (for example `claude:chat`, `chatgpt:chat`, `grok:chat`).
  - **Work plane:** `<namespace>:cairnstone-v6` for durable repo/engineering
    handoffs and existing work history (for example `claude:cairnstone-v6`,
    `chatgpt:cairnstone-v6`, `grok:cairnstone-v6`).
  The `:cairnstone-v6` work suffix is a durable address/history identity even
  while the live runtime is V7; do not silently migrate that history to a
  `:cairnstone-v7` address. Compatibility aliases may be checked when known to
  contain traffic, but they do not replace the canonical chat/work pair. Bots
  without a Jared-facing main session remain work-only; delegated subagents
  report to their calling session rather than receiving independent mailboxes.

### Version-controlled skills (V6.9 — progressive capability loading)
- **Canonical skills chain:** `cairnstone-v6-skills`. GitHub files under `skills/` are the editable source; CairnStone `(chain,path)` HEADs are the acceptance authority.
- `cairnstone_list_skills(chain?)` — read the compact accepted catalog without loading full skill bodies.
- `cairnstone_resolve_skills(task, available_tools?, loaded_skills?, max_skills?)` — deterministic metadata/trigger resolver. Use it after orientation to select the smallest relevant skill set. It recommends skills but grants no execution authority.
- `cairnstone_get_skill(skill_id, chain?)` — load one accepted full skill body. The selected path HEAD must point at a GitHub-backed stone with an immutable 40-hex commit SHA; mutable `main` is never treated as the active skill version.
- `cairnstone_get_skill_bundle(skill_ids[], chain?)` — **V6.9.1 distribution boundary.** Compiles selected accepted skills into a provenance-bearing downstream bundle with `manifest_head`, `skill_id`, `skill_version`, `stone_hash`, immutable `commit_sha`, and content identity. Every body is still selected by CairnStone path HEAD; the bundle does not create a second authority.
- `cairnstone_lint_skills(chain?, available_tools?, max_recommended_bytes?, max_estimated_tokens?)` — **V6.9.2 accepted-state QA.** Deterministically checks the active catalog for duplicate IDs/paths, semantic versions, canonical skill paths, missing dependencies, dependency cycles, trigger collisions, invalid tool references, oversized bodies/token budgets, boot-skill integrity, and missing accepted path HEADs. Hard errors invalidate the catalog; trigger/size-budget warnings remain visible without changing authority.
- **Pre-acceptance QA rule (V6.9.2):** candidate Git catalogs must pass the same pure linter in CI before any accepted skill path HEAD moves. The canonical repo runs this through `npm run lint:skills` inside `npm run check`.
- **Staged catalog acceptance rule (V6.9.2):** accept every changed/new `SKILL.md` path HEAD at one immutable Git commit first, verify those path HEADs, and move `skills/manifest.json` **last**. Until the manifest moves, the previous catalog remains authoritative even if candidate skill path HEADs have been prepared.
- **Tool-registry rule (V6.9.2):** the manifest may carry a `tool_registry`; skill `requires_tools` entries are linted against that declared production vocabulary rather than being accepted as arbitrary strings.
- **Current accepted catalog:** manifest v2 contains 15 skills — the original five plus six GitHub operational skills (`github.repo-file-read`, `github.pull-request-triage`, `github.commit-evidence`, `github.release-inspection`, `github.branch-protection-inspection`, `github.workflow-dispatch-safety`) and four CairnStone operational skills (`cairnstone.source-freshness`, `cairnstone.repo-reconcile`, `cairnstone.skill-acceptance`, `cairnstone.project-handoff`).
- **Downstream-consumer rule (V6.9.1):** another MCP may cache a validated accepted bundle for availability/performance, but cache storage is never authority. A consumer must prefer live CairnStone accepted state, may fall back only to its last-known validated accepted bundle, and must never fall back to arbitrary mutable Git or an older mutable skill document.
- **Draft-skill rule:** consumer-local `upsert_skill`-style operations may be retained for `draft` / `experimental` / `staging` data, but they must not silently replace a canonically accepted skill ID. Production changes go Git → CairnStone acceptance → accepted bundle → consumer cache.
- **Progressive-loading rule:** start with the boot skill (`core.orient`), then resolve/load specialized skills only as the task requires. Do not preload the whole catalog merely because it exists. This is designed to remain cheap with 50+ skills.
- `cairnstone_skill_agent(task, ..., mode?)` — **V6.10 advisory ambiguity layer.** It always begins with `cairnstone_resolve_skills`, and in `auto` mode calls Workers AI only when deterministic candidates are close. `deterministic` mode never calls AI; `model` mode may force advisory ranking when at least two accepted candidates exist.
- **Skills Sub-Agent authority rule (V6.10):** the model can select only from deterministic candidates derived from the currently accepted manifest. It cannot expand the candidate set, choose skill versions/commits/path HEADs, execute tools, or grant mutation authority. If AI is unavailable, returns invalid JSON, invents an ID, or accepted manifest HEAD changes during routing, the result fails closed to the deterministic baseline.

### Grounded Q&A (ASK1 — V6-only)
- `cairnstone_ask(chain, question, top_k?, context_lines?, verify_freshness?,
  persist?, max_tokens?)` — retrieval-grounded Q&A over one chain via
  Workers AI. Always injects the chain's HEAD orientation content regardless
  of keyword match. Classifies every piece of evidence as `CHAIN_HEAD`,
  `PATH_HEAD`, or `HISTORICAL` (independent of freshness), and reports graph
  relations (`SUPERSEDES`/`SUPERSEDED`, `REFERENCES`/`REFERENCES_BY`, etc.)
  read live from the graph. Validates every citation in the answer against
  supplied evidence — `citation_validation.ok:false` means the model cited
  something not actually supplied, which should not be trusted.
  - `persist:true` writes a citation-valid answer into a derived
    `<chain>::ask` chain (never touches the source chain's HEAD or path
    heads).
  - `verify_freshness:true` live-checks every cited PATH_HEAD stone; degrades
    to `freshness:"ERROR"` gracefully if the stone has no GitHub provenance,
    rather than failing.
  - Good for "why did we decide X" and "catch me up" questions once
    oriented. Not a replacement for `cairnstone_resume_chain` as the
    deterministic first move — it costs an LLM call and carries some
    hallucination-adjacent risk (mitigated, not eliminated, by citation
    validation).
  - ASK1 remains single-chain. Use the V7.7 Scope primitives for cross-chain
    retrieval; do not assume cross-chain Q&A exists until `cairnstone_ask_scope`
    is separately shipped and live-discovered.

## 5. The relationship graph — use it, don't skip it

As the vault grows, a flat stone list stops being navigable. Always pass
`chain`. Pass `set_as_head:true` only on stones meant to be the new canonical
chain-level version (not notes, reviews, or side orientation stones — those
annotate, they don't replace). After creating a stone, call
`cairnstone_link_stones` (or use `commit_v2`'s inline `edges` param) to
record what it actually relates to. Before starting work on a chain, call
`cairnstone_resume_chain(detail="start_here")` — not just `list_stones` — to
establish canonical HEAD identity and the cryptographic accepted-authority
root cheaply; expand to `compact` or `full` only when the task actually needs
more accepted path-head/edge detail.

## 6. Standard workflow

1. **Orient.** Call
   `cairnstone_resume_chain(chain="cairnstone-v6-project-memory", detail="start_here")`
   on V6/V7 runtime for the bounded canonical continuation card. Verify the
   returned chain HEAD + sparse-authority identity, then check **both canonical
   AC1 inbox planes for the current main-session model**: `<namespace>:chat`
   and `<namespace>:cairnstone-v6`. Call `cairnstone_get_inbox` on both before
   starting work that might overlap with someone else's. Inbox LOD5 is
   coordination metadata, not accepted project state; read only relevant
   unread messages instead of dumping archives into the main context. Expand
   to `detail="compact"` only when
   accepted path-head/HEAD-edge context is needed, and to `detail="full"`
   only for an explicit complete authority/edge dump. Then use
   `cairnstone_resolve_skills` and `cairnstone_get_skill` to load only the
   accepted skills needed for the current task, beginning with `core.orient`;
   do not preload the full catalog. When deterministic routing is genuinely
   ambiguous, `cairnstone_skill_agent` may advise among those accepted
   candidates, but its output never changes accepted-state authority. If live
   health advertises `start_here` or V7.7 Scope capabilities that the current
   client schema has not surfaced, report the connector-schema mismatch and
   refresh/reload the connector rather than pretending the capability is
   absent.
2. **Compress/stone.** Use `commit_v2` for new or updated files/notes,
   `create_github_file_stone`/`create_repo_stones` for bulk GitHub content.
3. **Flags (automatic, free).** Every stone gets per-ref flags at creation —
   cheap, noisy signals, not findings. Check lod5/lod4 first.
4. **Lint** JS/TS/JSX/TSX stones with `cairnstone_lint_stone` — real AST
   validation, not a guess.
5. **Review with judgment**, not by listing every flag. Trace where a
   flagged value is actually used downstream. Expect roughly a 4–5:1
   false-positive ratio on `hardcoded_secret`-style flags — triage is the
   point.
6. **Document.** When review surfaces something worth recording, persist it
   as its own stone and link it into the graph with the correct edge type.
   Title it for visibility (e.g. "START HERE: ...", "... COMPLETE").
7. **Fix** only with explicit go-ahead, and fix the real problem, not the
   symptom.
8. **Re-verify against the live system**, not just local validation:
   validate locally (`node --check` + the actual bundler, e.g. `esbuild`),
   push via the appropriate GitHub write tool, confirm the deploy workflow's
   actual trigger mechanism before assuming how to re-run it, read real job
   logs on failure (don't guess), and curl live endpoints after a successful
   deploy to confirm behavior actually changed.
9. **Re-stone the fixed file**, link it `supersedes` the pre-fix stone, set
   head, re-lint.
10. **If your session materially changed shared project state**, consider
    sending an AC1 correspondence message to relevant agent IDs — especially
    if concurrent work is plausible.

## 7. The wider AFO tool ecosystem

- **GitHub**: use deterministic GitHub search/call primitives for authoritative
  repo state, workflow status, and logs; use AI-assisted repo investigators as
  convenience layers, not as the only evidence. If an AI-assisted GitHub or
  repo-reader tool returns an implausible endpoint, missing path parameter, or
  `401 Bad credentials`, fall back to deterministic GitHub search/call and
  report the connector-specific failure instead of treating the repository as
  unavailable. Use a text-patch tool (dry-run first, then apply with an expected
  file SHA) for writes. Confirm `workflow_dispatch` support before assuming a
  workflow can be triggered that way — many are push-only.
- **Cloudflare**: search for the right endpoint/method rather than guessing
  paths. For D1 schema changes, `CREATE TABLE IF NOT EXISTS` via direct
  query is faster than waiting on a deploy pipeline and is idempotent —
  still commit a matching migration file for documentation. This account
  holds many sibling Workers with consistent per-repo D1/Vectorize naming;
  if a binding "was not found," check sibling repos' configs before
  guessing.
- **CairnStone V6** ties findings, decisions, and correspondence about all of
  the above together across sessions — use it so a future session never has
  to re-derive context from scratch, and never collides silently with a
  concurrent one.

## 8. MCP Twin — client tool-catalog cache workaround (Grok, Claude, ChatGPT)

Across Grok, Claude, and ChatGPT sessions we've repeatedly hit the same failure
mode: the Worker deploys new tools (confirmed via `cairnstone_health`), but an
already-connected AI client keeps calling `tools/list` against a *cached*
schema and never sees them. This is a client-side caching bug, not a
CairnStone problem — CairnStone itself stays a single D1+R2 backend the
entire time. The fix is a second HTTP path on the same Worker
(`/mcp-b`, added 2026-09-07 at commit `b9c3460b`) that is a byte-for-byte
alias of `/mcp` — same `handleMcp()`, same bindings, same tool catalog. A
client that won't refresh an existing connector's cache will still do a
fresh `tools/list` fetch against a URL it hasn't seen before.

**This is a transport workaround, never a second source of truth.** No
matter which path (`/mcp` or `/mcp-b`) mediates a call, the actor ID stays
the canonical work-plane one (`<namespace>:cairnstone-v6`, e.g.
`claude:cairnstone-v6`, `grok:cairnstone-v6`) — the path is not part of
identity, and project-memory content must never imply two vaults exist.

**Don't confuse this with `/mcp/core`.** `/mcp/core` intentionally exposes a
bounded subset for the V7.6.2a Deferred Tool Hydration experiment (see
Section 4). `/mcp-b` exposes the full legacy catalog, identically to `/mcp`.

Remediation differs by client — verify the client's actual connector model
before assuming the runbook below transfers directly:

- **Grok**: one connector slot maps to one server identity, and its
  `tools/list` is cached per that identity. Toggling the *same* connector
  off/on does **not** refresh it. Fix: register a second connector at the
  twin path, enable it, leave the stale one connected-but-idle (flip, don't
  delete). Proven live 2026-09-07, AC1 thread
  `cairnstone-conversation-2026-09-06b`, plan stone
  `project-memory/mcp-twin-catalog-hotswap-plan.md` (hash `d5bdd483...`).
- **Claude**: connectors are additive, not a single slot — each gets its own
  tool-name prefix, and more than one CairnStone connector can be enabled at
  once. Claude also refuses to register a second connector against an
  *identical* URL ("This URL is already installed"), so a genuinely
  different path is required just to add a twin at all — once added, there
  is no need to disable the original. If a known-deployed tool is still
  missing from every currently-attached CairnStone connector's tool list
  inside an existing conversation, the reliable fix is starting a **new**
  conversation with the desired connector enabled (fresh `tools/list` fetch
  at session start) rather than toggling within the same conversation.
  `/mcp-b` exists for the case where that alone isn't enough. Proven live
  2026-09-07. A generic 404 on a not-yet-deployed alias path can surface in
  Claude's UI as a misleading OAuth/sign-in registration error — don't
  chase auth config in that case; verify the route is actually live first
  (`curl` the endpoint) before assuming a credentials problem.
- **ChatGPT**: not yet directly tested against this specific pattern as of
  this writing. Assume an additive-connector model similar to Claude's until
  verified, and update this bullet once tested rather than assuming the
  Grok runbook transfers as-is.

**When to add another twin path:** only after a genuine tool-schema deploy,
and only once the client's ordinary refresh path (new conversation for
Claude; connector toggle where that's known to work) has already failed to
surface the new tool. Don't pre-emptively multiply alias paths — `/mcp` and
`/mcp-b` is the current standard; a third alias should be a deliberate,
documented decision, not a default reflex.

## 9. Defaults

- A tool succeeding (push OK, deploy `conclusion: success`) is not the same
  as the underlying problem being fixed. Verify actual live behavior.
- If you find an infrastructure problem unrelated to your task, say so
  explicitly rather than silently working around it.
- Heuristic flags are intentionally noisy — report the few findings that
  matter, not raw flag counts.
- Don't trust `created_at` ordering as a proxy for "which stone is current."
  Use HEAD (chain-level) and path HEAD (file-level) — that's precisely what
  they exist to make unambiguous.
- **Never assume you're the only session working this project.** Main sessions
  must check both canonical AC1 inbox planes — `<namespace>:chat` and
  `<namespace>:cairnstone-v6` — during startup. Compatibility aliases are
  supplemental only. This guide exists because the single-inbox assumption
  failed in real cross-model coordination.

## 10. First-turn checklist for a new chat here

1. Call `cairnstone_health` on the V6 connector. Confirm it's reachable and
   note the live tool count/version.
2. Call
   `cairnstone_resume_chain(chain="cairnstone-v6-project-memory", detail="start_here")`
   — not V5, and not the same-named `cairnstone-v6` runtime chain. Treat the
   returned card + authority root as the normal continuation surface; expand
   to `compact`/`full` only when required. If the server advertises
   `detail=start_here` but the connector schema does not expose `detail`, note
   the stale connector schema and use the available safe fallback until the
   connector is refreshed.
3. Call `cairnstone_get_inbox` for **both** canonical inboxes belonging to the
   current main-session model: `<namespace>:chat` and
   `<namespace>:cairnstone-v6`. Use the chat plane for conversation/
   coordination/design and the work plane for durable repo/engineering
   handoffs. Inspect compact inbox metadata first, then read only relevant
   unread messages. Do not substitute a `:cairnstone-v7` alias for the durable
   work inbox merely because the live runtime is V7.
4. Resolve the current task against the accepted `cairnstone-v6-skills` catalog. Load `core.orient` first, then only the specialized skills recommended for the task.
5. Apply Section 6's workflow in order — don't skip straight to "fix."
6. When you create or fix something, leave the graph in a state a future
   session can trust: correct chain, correct edge types, HEAD and path
   heads pointing at the right stones, and a correspondence message sent if
   the change is significant enough that a concurrent session should know
   about it.

---

*Last updated: 2026-09-07 (added Section 8, MCP Twin client tool-catalog
cache workaround; renumbered old Sections 8→9, 9→10).*

*Previously: 2026-09-06. V7.7.1a bounded START HERE orientation is production-live-accepted on runtime 0.5.27: normal continuation should use `cairnstone_resume_chain(..., detail="start_here")`, with `compact`/`full` as deliberate expansion modes. V7.7 vault catalog/scope/search primitives are live; Scope is retrieval/navigation context only and never synthetic global authority. Cross-chain grounded Q&A (`cairnstone_ask_scope`) remains planned for V7.7.2 and must not be assumed shipped. V6.10 remains the frozen V6 control-plane baseline; new agent-runtime architecture belongs in V7 unless an explicit correctness or security backport to V6 is required. If you update this document,
update it in place here and keep the "Last updated" line current — this
file is meant to be the single source of truth referenced by URL from every
provider's project instructions, not re-pasted and forked per provider.*
