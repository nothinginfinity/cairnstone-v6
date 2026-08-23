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
V6 chain and check the AC1 inbox before starting work (Section 8), and use
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
  chain.** One deterministic call: canonical chain HEAD (never inferred from
  timestamps), its GitHub provenance, every accepted path HEAD, every graph
  edge touching HEAD. Read-only.
- `cairnstone_manifest_v2` — token-efficient chain manifest.
  `detail=summary` (~500B, counts + heads only), `detail=compact` (default,
  short-hash nodes + edges as `from>to:type` strings), `detail=full`.
  `since=<ISO date>` for delta pickup.
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
  what you want (by `ref_id`, or by `stone_hash + path + line_start`).

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
- **Actor ID format:** `namespace:identifier`, e.g. `claude:cairnstone-v6`,
  `chatgpt:cairnstone-v6`. No central registry — any well-formed ID works,
  but use consistent, recognizable IDs so other sessions can find you.

### Version-controlled skills (V6.9 — progressive capability loading)
- **Canonical skills chain:** `cairnstone-v6-skills`. GitHub files under `skills/` are the editable source; CairnStone `(chain,path)` HEADs are the acceptance authority.
- `cairnstone_list_skills(chain?)` — read the compact accepted catalog without loading full skill bodies.
- `cairnstone_resolve_skills(task, available_tools?, loaded_skills?, max_skills?)` — deterministic metadata/trigger resolver. Use it after orientation to select the smallest relevant skill set. It recommends skills but grants no execution authority.
- `cairnstone_get_skill(skill_id, chain?)` — load one accepted full skill body. The selected path HEAD must point at a GitHub-backed stone with an immutable 40-hex commit SHA; mutable `main` is never treated as the active skill version.
- `cairnstone_get_skill_bundle(skill_ids[], chain?)` — **V6.9.1 distribution boundary.** Compiles selected accepted skills into a provenance-bearing downstream bundle with `manifest_head`, `skill_id`, `skill_version`, `stone_hash`, immutable `commit_sha`, and content identity. Every body is still selected by CairnStone path HEAD; the bundle does not create a second authority.
- **Downstream-consumer rule (V6.9.1):** another MCP may cache a validated accepted bundle for availability/performance, but cache storage is never authority. A consumer must prefer live CairnStone accepted state, may fall back only to its last-known validated accepted bundle, and must never fall back to arbitrary mutable Git or an older mutable skill document.
- **Draft-skill rule:** consumer-local `upsert_skill`-style operations may be retained for `draft` / `experimental` / `staging` data, but they must not silently replace a canonically accepted skill ID. Production changes go Git → CairnStone acceptance → accepted bundle → consumer cache.
- **Progressive-loading rule:** start with the boot skill (`core.orient`), then resolve/load specialized skills only as the task requires. Do not preload the whole catalog merely because it exists. This is designed to remain cheap with 50+ skills.
- A future Skills Sub-Agent may help resolve ambiguous tasks, but it must sit above this deterministic accepted-state layer and must never choose an unaccepted skill version as authority.

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

## 5. The relationship graph — use it, don't skip it

As the vault grows, a flat stone list stops being navigable. Always pass
`chain`. Pass `set_as_head:true` only on stones meant to be the new canonical
chain-level version (not notes, reviews, or side orientation stones — those
annotate, they don't replace). After creating a stone, call
`cairnstone_link_stones` (or use `commit_v2`'s inline `edges` param) to
record what it actually relates to. Before starting work on a chain, call
`cairnstone_resume_chain` — not just `list_stones` — since it gives HEAD +
every path head + every edge touching HEAD in one deterministic call.

## 6. Standard workflow

1. **Orient.** `cairnstone_resume_chain(chain="cairnstone-v6-project-memory")`
   on V6. Check the AC1 inbox for your own actor ID and for other known
   agent IDs before starting work that might overlap with someone else's.
   Then use `cairnstone_resolve_skills` and `cairnstone_get_skill` to load only the accepted skills needed for the current task, beginning with `core.orient`; do not preload the full catalog.
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

- **GitHub**: use a generic read tool for repo state/workflow status/logs;
  use a text-patch tool (dry-run first, then apply with an expected file
  SHA) for writes. Confirm `workflow_dispatch` support before assuming a
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

## 8. Defaults

- A tool succeeding (push OK, deploy `conclusion: success`) is not the same
  as the underlying problem being fixed. Verify actual live behavior.
- If you find an infrastructure problem unrelated to your task, say so
  explicitly rather than silently working around it.
- Heuristic flags are intentionally noisy — report the few findings that
  matter, not raw flag counts.
- Don't trust `created_at` ordering as a proxy for "which stone is current."
  Use HEAD (chain-level) and path HEAD (file-level) — that's precisely what
  they exist to make unambiguous.
- **Never assume you're the only session working this project.** Check the
  AC1 inbox. This guide exists because that assumption failed once already.

## 9. First-turn checklist for a new chat here

1. Call `cairnstone_health` on the V6 connector. Confirm it's reachable and
   note the live tool count/version.
2. Call `cairnstone_resume_chain(chain="cairnstone-v6-project-memory")` on
   V6 — not V5, and not the same-named `cairnstone-v6` runtime chain.
3. Call `cairnstone_get_inbox` for your own actor ID and check for recent
   messages from other agent IDs (e.g. `chatgpt:cairnstone-v6` if you're
   Claude, or vice versa) that might indicate concurrent or very recent work.
4. Resolve the current task against the accepted `cairnstone-v6-skills` catalog. Load `core.orient` first, then only the specialized skills recommended for the task.
5. Apply Section 6's workflow in order — don't skip straight to "fix."
6. When you create or fix something, leave the graph in a state a future
   session can trust: correct chain, correct edge types, HEAD and path
   heads pointing at the right stones, and a correspondence message sent if
   the change is significant enough that a concurrent session should know
   about it.

---

*Last updated: 2026-08-23, with V6.9.1 canonical skill distribution and the first external consumer (AFO GitHub API MCP) added after V6.9 progressive skills and the Claude/ChatGPT concurrent-session
coordination incident described in Section 2. If you update this document,
update it in place here and keep the "Last updated" line current — this
file is meant to be the single source of truth referenced by URL from every
provider's project instructions, not re-pasted and forked per provider.*
