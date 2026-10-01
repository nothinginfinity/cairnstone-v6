# 2026-10-01 — Roadmap decision: host-native mini-stones + governed X action adapters

Status: **ACCEPTED ROADMAP DIRECTION / IMPLEMENTATION NOT YET STARTED**

Two related but separate product directions are accepted:

1. **V7.7.11h — Host-Native Plugin / App Surfaces + Mini-Stone Workflow Products**
   - Thin host-native surfaces for ChatGPT-style in-conversation app/plugin discovery.
   - Mini-stones are constrained normal Stones, not a second storage system.
   - First public cohort: Meeting Notes Compressor, Decision Log, Handoff Pack.
   - Workflow Playbook follows; Plugin Idea Scout is primarily an internal growth/experiment tool.
   - Host ranking/recommendation affects distribution only, never authority or persistence.

2. **V7.7.10k — X Action Connectors / Governed Social Operator**
   - Reuse X's official API/MCP primitives where practical.
   - CairnStone owns stable semantics, identity binding, minimum-capability projection, draft/confirm policy, idempotency, cursors, receipts, and cross-model state.
   - First build groups: bookmark/read-later and post/reply/quote/thread drafting; publishing is confirmation-gated and idempotent.
   - Later: lists, engagement radar, analytics, DMs, search-to-action.

Shared principle:

> Host connectors distribute and act; CairnStone persists, constrains, proves, and carries continuity across models.

These ideas complement V7.11 CairnStone Content but should not be collapsed into it. V7.11 is the creative/media runtime; V7.7.11h is host-native workflow distribution; V7.7.10k is governed social action.

Source AC1 Stones:
- plugin/mini-stone idea: `2953150bdf5e0e2cb34c4a5aa5a194b784a39c3705c3eb680059f6bec37333dd`
- X connector brief: `5d3173eca5fe69c6b60d6f7fe348a09c339b7bfdfd41f1b16806db4a6cba40fc`

Next build recommendation:

1. freeze `cairnstone-mini-stone-v1` and X connector contracts;
2. build Meeting Notes + Decision Log + Handoff Pack as one shared mini-stone service surface;
3. build X bookmark/read-later adapter as the safest authenticated X pilot;
4. add draft-only post/reply tools;
5. add confirmed publish after identity/idempotency acceptance.
