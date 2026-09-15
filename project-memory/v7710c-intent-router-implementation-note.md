# V7.7.10c — Deterministic Intent Router (implementation note)

status: implemented_in_repo_not_live_verified
slice: V7.7.10c
accepted_state_authority: false
start_here_gate_10b: 10d5352767645ccba760ee65579d85dbc8469bbcf4bf8e6e9bd46ee16df5ab17
amendment_stone: eab0bdb8304f0d5439b659bdbedf2715fe4894a1d9958814f4db13a8de89b22f
runtime_baseline_before: 0.5.40
runtime_version: 0.5.41
baseline_tip: 1ac0f58c21b065aaf2a02a77aed495467baa030f

## What landed

- Pure deterministic Intent Router (`src/intent-router.js`) with schema `cairnstone-intent-route-v1`.
- Intents: `give-access`, `revoke-access`, `assign` (ask-to-work), `forward-with-note`, `none`.
- MCP `cairnstone_intent_route` + REST `POST /v1/intent/route`.
- Broker registry entry as **read** / `scoped_grant` (not automatic-read); count 86 → 87.
- Proposal args mirror live 10b validators (`additionalProperties: false`).
- Object refs via 10b `parseObjectRef`; actor aliases only when unambiguous against `known_actors`.
- Unit tests: `test/v7710c-intent-router.test.js`.
- Contract doc: `docs/V7_7_10C_DETERMINISTIC_INTENT_ROUTER.md`.
- Worker VERSION `0.5.41`.

## Explicit non-claims

- Router never calls LLM/providers, never writes D1, never moves HEADs.
- Matching an intent never executes `access_grant_create|revoke`, `task_run_propose`, or `forward_with_note`.
- Console UX (10e), dispatch (10d), DO/WS (10f) remain later slices.
- No route-audit persistence in 10c (keep pure).

## Residual risks

- Regex rule coverage is intentionally conservative; novel phrasings fall through to `none` (fail closed).
- Display-name aliasing depends on `known_actors` being supplied by Console/caller.
- Conflict detection is confidence-rank based; overlapping soft cues may still under-match rather than over-match.
