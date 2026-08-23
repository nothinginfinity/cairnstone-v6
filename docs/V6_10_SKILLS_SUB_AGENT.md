# V6.10 — Skills Sub-Agent

Status: **implemented and live accepted** on CairnStone V6 runtime `0.4.8`.

V6.10 adds `cairnstone_skill_agent` as an advisory ambiguity layer above the existing deterministic, accepted-state skill resolver. It does not create a second skill authority.

## Authority model

The ordering is fixed:

1. `cairnstone_resolve_skills` reads the accepted `cairnstone-v6-skills` manifest/path-HEAD state and produces deterministic candidates.
2. The Skills Sub-Agent may rank or explain only those candidates.
3. Any selected skill body is still loaded through the accepted path-HEAD / immutable-Git boundary (`cairnstone_get_skill` or `cairnstone_get_skill_bundle`).

The model cannot:

- expand the deterministic candidate set;
- select an unaccepted skill ID;
- choose a skill version, Git commit, manifest HEAD, or path HEAD;
- treat mutable Git `main` as authority;
- execute tools;
- grant mutation authority.

The tool response makes those limits explicit with `execution_authority:false` and `mutation_authority:false`.

## Routing modes

`cairnstone_skill_agent` supports three modes:

- `auto` — default. Use deterministic routing when the leading candidate is clear; call Workers AI only when deterministic scores are close.
- `deterministic` — never call AI. Return the deterministic baseline directly.
- `model` — force advisory model ranking when at least two accepted deterministic candidates exist. This is primarily useful for testing and deliberate ambiguity resolution.

The current ambiguity policy bypasses AI for a single candidate, for a score gap of at least 8, or for a strong top candidate with score at least 16 and gap at least 5. Otherwise the candidate set is treated as ambiguous.

## Model boundary

The advisory model is currently:

`@cf/meta/llama-3.3-70b-instruct-fp8-fast`

Only compact accepted catalog metadata and deterministic candidates are supplied. Candidate metadata is explicitly treated as untrusted data, not instructions.

The model must return JSON containing selected candidate IDs, confidence, and optional rationale. The runtime validates every selected ID against the deterministic candidate set before returning a model-assisted result.

## Fail-closed behavior

The tool returns the deterministic baseline when any advisory condition is unsafe or unavailable, including:

- missing `env.AI` binding;
- provider/model exception;
- empty or invalid model JSON;
- empty model selection;
- invented or out-of-candidate skill ID;
- accepted catalog metadata unavailable;
- accepted manifest HEAD changes between deterministic resolution and model metadata loading.

That last check prevents one request from mixing candidates from one accepted catalog generation with metadata from another.

## Regression coverage

`test/skill-agent.test.js` proves:

- a clear deterministic winner makes zero AI calls;
- ambiguous routing can invoke the model;
- model selections are limited to accepted deterministic candidates;
- invented IDs fail closed to deterministic routing;
- a manifest-HEAD race fails closed before the model call;
- model/provider failure preserves deterministic routing;
- missing AI binding preserves deterministic routing;
- execution and mutation authority remain false.

`src/skill-agent.js` is included in the repository's mandatory `npm run check` syntax gate.

## Live acceptance

`.github/workflows/deploy-cloudflare.yml` exposes `run_v610_acceptance`.

The live gate requires all of the following after deploy:

1. `/health` reports runtime `0.4.8` and advertises `cairnstone_skill_agent`.
2. Direct MCP `tools/list` includes `cairnstone_skill_agent`.
3. A deterministic-mode routing call succeeds without model assistance and reports no execution/mutation authority.
4. A forced ambiguous routing call succeeds with `selection_source:"model_assisted"`.
5. Every model-assisted recommendation is present in the deterministic accepted candidate set.
6. The response states the model cannot expand the candidate set or select unaccepted skills, and execution/mutation authority are false.

V6.10 first passed this production acceptance in GitHub Actions run `32671324609` at commit `f2fed3d84523c1f545958dbcf738a8d4f1c54ed2`.

## Operational rule

Use the deterministic resolver normally. Use `cairnstone_skill_agent` when real ambiguity justifies model assistance; do not use it as an excuse to call an LLM for every task. Accepted CairnStone manifest/path-HEAD state remains the authority before, during, and after V6.10.
