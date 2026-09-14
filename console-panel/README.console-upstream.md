# CairnStone V7 Console

A thin, provider-neutral browser client for the live CairnStone V7 runtime.

## V7.7.7f Persistent Code Mode

The **Code** tab is an operator surface for one durable Code Session (not a single model chat):

- loads `cairnstone_code_session_console_view` with `code_session_id`, `actor_id`, and a workspace capability entered into a password field (kept only in `sessionStorage`, never stoned);
- shows project, lifecycle, current task, actors, tests, and working-tree summary from the worker aggregation;
- **Invite Agent** switches to the existing **Invite** tab and prefills workspace + continuation prompt — minting still uses the V7.7.6 trusted-human invite flow (`POST /v1/workspace-invites` / Mint & Send); no second ticket format;
- **Send Message** uses ordinary AC1 `cairnstone_send_message` with the continuation prompt;
- **Checkpoints** / **View Work** call existing list/tree APIs;
- **Propose / Merge** confirms, then calls only `cairnstone_workspace_propose_accept` (Console grants no new merge/deploy authority).

## V7.7.3 scope workspace

V7.7.3 turns the previous single-Chain Console into a shared multi-repository / multi-chain workspace while preserving CairnStone authority boundaries.

- one global **Scope** control resolves the existing `cairnstone-scope-v1` selectors (`single_chain`, `repo`, `multi`, `vault`);
- the catalog comes from `cairnstone_vault_catalog`; the resolved authority snapshot comes from `cairnstone_resolve_scope`;
- list selection supports searchable repository grouping, child chains, explicit multi-select, recents, and `All CairnStone`;
- Chat uses the existing single-chain `cairnstone_delegate` path for one-chain Scope and `cairnstone_ask_scope` for multi/repo/vault grounded Q&A;
- Evidence renders the exact resolved Scope identity plus citation/coverage evidence returned by the runtime;
- Stones uses single-chain listing when narrowed to one chain and `cairnstone_find_scope` for cross-Scope search;
- Handoff association is explicit: the human chooses one exact participating chain because AC1 handoffs carry one chain field;
- Inbox and Activity are deliberately **not** auto-filtered by Scope because compact correspondence listing metadata does not expose a trustworthy chain association;
- Bird’s Eye / Universe is a full-screen spatial projection of the same Scope selectors, with search-to-focus, repository/chain semantic LOD, explicit multi-select, and a list fallback;
- spatial position, proximity, clustering, size, and animation are presentation only. They are never authority and never create graph edges;
- repository grouping shown in the projection comes from catalog provenance;
- no synthetic global HEAD is created. Every participating chain retains its own canonical chain HEAD and accepted path HEADs.

The console remains dependency-free and requires no WebGL. The Universe projection uses ordinary DOM/CSS so a usable list fallback is always present.

## Existing trusted-human boundary

The V7.3.3 authorization surface remains intact:

- delegated models receive zero execution/mutation authority;
- pending mutation requests are reviewed in **Authorize**;
- approval/denial uses REST-only operator endpoints deliberately absent from the MCP tool catalog;
- the operator bearer is entered by the human and kept only in browser `sessionStorage`;
- approval binds to the immutable request Stone, exact argument digest, and concurrency guard;
- execution accepts no replacement mutation arguments.

Default runtime: `https://cairnstone-v6.jaredtechfit.workers.dev/mcp`

The browser talks to the MCP endpoint directly over JSON-RPC.

## Run locally

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## Operator setup

Set a strong Worker secret named `CAIRNSTONE_OPERATOR_TOKEN` on `cairnstone-v6`. Do **not** put it in this repository or any model prompt. The human operator enters it in the Authorize tab for the browser session only.

## Authority model

The Console is a client, not a source of accepted state. Scope is navigation/retrieval context only. CairnStone chain/path HEADs remain canonical authority. AC1 handoff messages are immutable correspondence artifacts and transport intent only.

The optional GitHub inbox mirror is transport-only. The browser sends only the target owner/repo/branch/path prefix to CairnStone; GitHub credentials remain server-side in the runtime. A mirror artifact records its AC1 stone hash and explicitly carries zero execution, mutation, external-mirror, or accepted-state authority.
