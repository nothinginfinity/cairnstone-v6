# V7.7.10h.5a — Optional Jev Workers AI binding

Status: **IN REVIEW on PR #56 / not live.** Do not deploy while V7.7.10i.1c DCR window is open (START HERE `a2973276`).

This addendum updates `docs/V7_7_10H_SEMANTIC_CAPABILITY_GATEWAY.md` and `docs/ROADMAP_V7.md` for the optional Jev transport. It does not change 10h.5 cross-host acceptance scope.

## Transports

`ask_jev` / `scoreWithJev`:

1. `http` — `env.JEV_URL` (+ optional `JEV_TOKEN`) override. Request `{kind,task,candidates[]}` → `{selected_id,confidence}`.
2. `binding` — when `JEV_URL` is unset and `env.AI.run` exists: `env.AI.run("typesafe/jev", { state, questions.selected type=choice })`. Map `answers.selected.choice` → `selected_id`.

Model: Cloudflare Workers AI `typesafe/jev` (third-party, zero data retention, 32k context, about $0.042 / 1M input tokens, $0 output). Docs: https://developers.cloudflare.com/ai/models/typesafe/jev/

## Receipts

Successful and fallback Jev decisions record:

- `scorer_source=jev`
- `scorer_transport=http|binding`

Missing URL and missing `AI.run` still yields `jev_not_configured`. Invented IDs are rejected by `cairnstone-decision-v1`. Jev is never required for CairnStone correctness.
