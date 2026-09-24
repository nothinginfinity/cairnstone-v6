# V7.7.10m -- Task-First Harness Registry / Runnable Setup Catalog

Status: PLANNED / ROADMAP CANDIDATE. Docs/product architecture only. No runtime deployment, marketplace settlement, or accepted roadmap path-HEAD movement is authorized by this document.

Parent roadmap: docs/ROADMAP_V7.md

Primary dependencies:
- V7.4 provider-neutral Agent Profiles;
- V7.7.10i account / tenant / connection-principal identity and authorization;
- V7.7.10j accepted Role-Scoped Tool Belts;
- V6.9 accepted Skills and Skill bundles, with V7.9 Capability Recipes as a later quality upgrade;
- V7.7.10k Portable Response Profiles;
- V7.0 Context Compiler, V7.1 model routing, V7.3 broker policy, and V7.7 execution receipts;
- V7.5 paid-agent contracts and V7.10 Economic Authority for any later paid/rental execution.

## Product thesis

CairnStone should expose a task-first discovery layer for complete, runnable AI setups rather than another prompt marketplace.

The user experience should be:

1. Search for an outcome such as "review this contract", "audit a pull request", "migrate SQL to dbt", or "review a paper with citations".
2. Compare proof-bearing Harness cards showing what each setup actually requires and how it performed.
3. Install/export the selected setup into a compatible ChatGPT, Claude, Grok, MCP, or CairnStone environment, or later run it through a bounded CairnStone sandbox.
4. Preserve the Harness identity, component versions, permissions, evidence, and receipts across compatible model/provider changes.

Working positioning:

> Search what you want an AI to do. See proof it works. Install the complete setup into the AI you already use.

The catalog is useful before CairnStone offers hosted compute or a marketplace. Paid/rented execution is an optional later layer, not an MVP dependency.

## What a Harness is

A Harness is a versioned composition manifest, working schema:

`cairnstone-harness-v1`

It should reference, not copy or replace, independently versioned CairnStone artifacts:

```text
Task definition
    +
Agent Profile
    +
Tool Belt
    +
Skill Pack
    +
Context / Scope policy
    +
Response Profile / output contract
    +
Model / host compatibility
    +
Evaluation fixtures + proof
    +
Budget / cost policy
    +
Authorization requirements
    +
Immutable provenance
    =
CairnStone Harness
```

A Harness may select or narrow components. It can never widen their authority.

### Minimum manifest identity

A first contract should include:
- harness_id, semantic version, immutable content digest, owner/publisher identity, visibility;
- human task title/description, task-intent tags, input/output contract;
- accepted Agent Profile reference and version;
- accepted Tool Belt reference and version;
- accepted Skill IDs/versions or Skill-bundle identity;
- accepted Response Profile reference when presentation policy is part of the deliverable;
- Context/Scope requirements and explicit data prerequisites;
- supported/tested model/provider/host matrix with tested-at timestamps;
- required capabilities and authorization classes;
- read/mutation/execution classification and Human Commit requirements;
- budget envelope: context, output, tool-call, runtime, and observed/declared cost fields;
- eval suite identity, fixture/result identities, evaluation receipts, and known failure cases;
- example input/output references, with privacy-safe fixtures rather than private transcripts;
- dependency vector and stale/superseded status;
- provenance: exact accepted Stones/path HEADs/Git commits for referenced artifacts where applicable.

A Harness manifest must not contain reusable credentials, raw OAuth tokens, arbitrary executable UI, private user data, or hidden capability grants.

## Product SKU classes

The registry should distinguish rather than blur:

1. Prompt / Context Pack -- system/context instructions, few-shots, output schema. Portable and useful, but lowest trust/moat by itself.
2. Tool Pack / MCP Setup -- selected connectors, Tool Belt, tool contracts, guardrails, and host configuration.
3. Full Harness -- Agent Profile + Tool Belt + Skills + context policy + output contract + evals + budgets + retries/loop/runtime assumptions + proof.

The primary paid/verified product should eventually be classes 2 and 3. Class 1 may remain a free or low-friction discovery/export surface.

## Task-first search

Search should optimize for user intent rather than only names or keywords.

Candidate facets:
- task / desired outcome;
- domain and input type;
- host/model/provider compatibility;
- required MCP/tool dependencies;
- read-only vs mutation/execution requirements;
- Human Commit requirement;
- BYOK eligibility;
- context/cost/runtime envelope;
- eval score or pass/fail evidence;
- last-tested / dependency-freshness state;
- publisher/verification status;
- known limitations;
- optional price only when a trusted pricing authority exists.

Ranking must not equate popularity with truth. Verification/freshness and task fit should be visible separately from usage or community signals.

## Proof-bearing Harness card

Every verified listing should make proof inspectable.

A card should be able to show:
- exact Harness version and component dependency vector;
- supported/tested hosts and models;
- representative input -> output examples;
- eval suite/result identity and last verified date;
- known failures and unsupported cases;
- observed token/context/tool/runtime/cost telemetry where safely measurable;
- execution/evaluation receipt references;
- provenance for the Tool Belt, Skills, Profile, and output policy;
- a capability "nutrition label":
  - data read;
  - external network reach;
  - mutation capability;
  - execution/sandbox capability;
  - financial/payment capability;
  - Human Commit requirements;
  - secret handling expectations.

"Verified" must mean a specific accepted verification contract, not a seller-supplied badge.

## Trust and safety boundary

The Harness Registry is not an authority system.

Effective authority remains the intersection of authenticated account/connection identity, object/Scope grants, Tool Belt ceilings, broker policy, live tool contract integrity, runtime/session state, and any required Human Commit.

Hard rules:
- installing a Harness grants nothing by itself;
- a listing URL, manifest ID, purchase, or payment grants no tool/object authority;
- copied prompts cannot impersonate account/admin identity;
- tool contracts and authorization classes are re-resolved at install/run time;
- stale or changed dependencies are surfaced, not silently substituted;
- mutations/execution remain separately authorized;
- hosted trials run in a bounded sandbox and cannot silently send secrets to a publisher;
- BYOK secrets remain in the trusted credential plane, never in the listing/manifest;
- examples/evals must be resilient to prompt injection and cannot override system/broker rules.

## Versioning, freshness, and dependency invalidation

A Harness is only meaningful relative to its component vector.

When an accepted Skill, Tool Belt, Agent Profile, Response Profile, tool schema, or critical model compatibility claim changes, the registry should be able to mark affected Harness versions:
- current;
- needs-retest;
- degraded;
- superseded;
- incompatible.

Do not silently rewrite an old Harness version to point at newer components. Publish a new version or a new verification result.

A model/provider release does not automatically invalidate a Harness, but any claim of compatibility must carry the tested model identity and date/eval evidence.

## Distribution and install/export

The first distribution layer should avoid requiring a hosted CairnStone agent cloud.

Supported outputs should evolve toward:
- accepted prompt/context export where useful;
- accepted Skill bundle;
- Tool Belt / MCP configuration projection;
- Response Profile reference;
- host-specific setup instructions/adapters for ChatGPT, Claude, Grok, and ordinary MCP clients;
- CairnStone account install/save for later reuse.

Host adapters should degrade honestly. A Harness may be portable semantically without being pixel- or UI-identical across hosts.

## BYOK and hosted trial path

After registry/search/install is useful, add a bounded trial runner:

```text
selected Harness
    ->
resolve exact accepted dependency vector
    ->
authenticate user / grants
    ->
compile context
    ->
route model with BYOK or accepted billing mode
    ->
hydrate only Harness-permitted tools
    ->
sandbox/broker execution
    ->
result + receipts + cost/eval telemetry
```

Initial hosted trials should prefer read-only or sandbox-contained Harnesses. Mutation-capable Harnesses must preserve existing Human Commit and broker boundaries.

## Paid/rental marketplace path

Do not build a separate marketplace payment authority.

Future paid execution should reuse:
- V7.5 paid-agent service/job identity;
- V7.10 rail-neutral economic authority;
- x402 as one payment adapter where appropriate;
- Work Receipts and idempotent/replay-safe job identity;
- publisher/payee verification and explicit platform policy.

Possible later commercial modes:
- subscription access to advanced registry/search/saved Harnesses;
- verified creator listings;
- one-time paid Harness unlocks;
- BYOK execution with creator/platform licensing;
- hosted per-run or rented-session execution;
- paid organization/private Harness registries.

The first product should validate search -> proof -> install/use conversion before adding compute/refund/abuse complexity.

## Implementation slices

### V7.7.10m.0 -- Contract + threat model
Freeze `cairnstone-harness-v1`, dependency identity, authority exclusions, privacy rules, verification vocabulary, stale-state semantics, and host compatibility claims.

### V7.7.10m.1 -- Curated registry + task search
Implement a bounded registry/index over accepted Harness manifests. Seed a small, high-quality reference set spanning multiple domains before scaling. Search by task language and capabilities.

### V7.7.10m.2 -- Proof / eval / freshness layer
Add verification jobs or accepted evaluation artifacts, proof-bearing cards, example I/O, known-failure metadata, compatibility matrix, cost/context telemetry, dependency invalidation, and capability nutrition labels.

### V7.7.10m.3 -- Portable install/export
Support save/install into a CairnStone account plus honest host-specific exports/adapters. Prove at least two independent AI hosts can consume one Harness identity without changing its accepted component vector.

### V7.7.10m.4 -- Sandboxed BYOK trial runner
Run eligible Harnesses through a bounded sandbox using the existing Context Compiler/router/broker/receipt architecture. Start read-only. Secrets stay outside manifests and seller-controlled infrastructure.

### V7.7.10m.5 -- Verified creator submissions
Add publisher identity, draft -> review -> verified publication lifecycle, moderation/abuse handling, version supersession, dependency alerts, and revocation/deprecation.

### V7.7.10m.6 -- Optional commercial execution
Only after V7.5/V7.10 economic-authority gates: paid/rental execution, x402/payment adapter integration where useful, Work Receipts, refunds/failures/replay handling, and measured marketplace economics.

## Lean launch target

Do not start with an agent cloud.

The first credible launch can be:
- task-first search;
- a curated verified catalog;
- 2-3 representative outputs per Harness;
- explicit permissions/tool requirements;
- exact versions/provenance;
- exports/install guidance;
- saved Harnesses and verified listings.

Expand toward 200-500 high-quality Harnesses only after the ingest/verification/update pipeline can keep claims fresh. Catalog size without proof is not the goal.

## Acceptance gates

10m should not be called accepted until:
- Harness manifests resolve only accepted/versioned dependencies and fail closed on missing/revoked/incompatible dependencies;
- install/purchase/listing possession grants zero authority;
- at least one read-only Harness runs reproducibly across two independent model/host routes with the same Harness/dependency identities;
- eval/proof results are inspectable and tied to immutable receipt/provenance identities;
- changing a dependency marks the affected Harness stale or requiring retest rather than silently mutating it;
- permissions and Human Commit requirements are accurately disclosed and enforced independently of listing text;
- BYOK credentials never enter a public/private Harness manifest or creator-controlled payload;
- unsupported host features degrade honestly;
- a user can search by task, inspect proof, and install/use a Harness without understanding CairnStone internals;
- any paid path uses accepted economic authority rather than registry-local balances or seller-defined settlement truth.

## First demonstration

Create a verified "GitHub PR Security Review" Harness that is read-only:
- Agent Profile: security reviewer;
- Tool Belt: GitHub/repository read-only;
- Skills: PR review + dependency/security inspection;
- Response Profile: grounded security report;
- Scope: one user-authorized repository/PR;
- eval fixtures: several safe public test PRs;
- proof: cross-provider outputs, citations, dependency vector, receipts, runtime/cost observations, known limitations.

From ChatGPT, search the Harness Registry for "review this PR for security problems", inspect the card, install/run it with user authorization, then resolve the same Harness in Claude and verify the same accepted component identities with honest host-specific rendering differences.

## Non-goals for the first slice

- no claim that prompts alone are defensible IP;
- no unrestricted third-party code execution;
- no automatic secret delegation to creators;
- no marketplace-specific wallet/payment authority;
- no popularity-based "best agent" truth claim;
- no silent auto-upgrade of Harness dependencies;
- no requirement that all AI hosts expose identical MCP/App capabilities;
- no interruption of current 10i identity/auth or 10l Messages acceptance priorities.

This planning document authorizes roadmap/product design only. Runtime implementation, public creator onboarding, hosted execution, payment settlement, production deploys, or accepted roadmap path-HEAD movement require their existing review and authorization gates.
