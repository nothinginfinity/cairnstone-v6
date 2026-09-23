# V7.7.10k - Portable Response Profiles

Status: PLANNED / ROADMAP CANDIDATE; docs-only until review. No runtime deployment or accepted-state HEAD move in this proposal.
Parent roadmap: docs/ROADMAP_V7.md
Dependencies: V7.7.10i account and connection-principal authorization; V7.7.10j role-scoped Tool Belts; existing V6.9 versioned Skills and V7.0 Context Compiler.
Related UI consumer: V7.7.11h In-Chat CairnStone Console, extending V7.7.11g Safe Adaptive UI.

## Product thesis

The leading AI hosts own their native chat UI, reasoning, and model-specific features. CairnStone owns durable project state, accepted team instructions, portable response preferences, authorized tools, and reusable visual surface contracts. A team should define how it wants work presented once and use that preference across compatible accounts, models, apps, and projects without rebuilding the chat client.

A Response Profile is not an LLM weight fine-tune and is not an MCP URL, Tool Belt, agent role, full agent profile, UI renderer, or authority grant. It is an accepted, versioned presentation and deliverable policy that hosts can resolve and honor within their actual capabilities.

Illustrative first pilot: visual-comparison, patterned after the CairnStone-versus-T3 and response-profile explanations delivered natively in ChatGPT, including executive thesis, meaningful diagrams, evidenced product comparisons, clearly marked implementation state, and optional exportable PDF/Markdown artifacts.

## Core contract: cairnstone-response-profile-v1

An accepted profile artifact should include:
- profile_id; immutable version and content digest; accepted Git commit SHA and CairnStone path-HEAD Stone identity;
- owner_account_or_org_id and explicit share/visibility scope; project or workspace binding when applicable;
- description, triggers/task kinds, preferred length/depth, tone, section/layout preferences, visual semantics, citation/provenance rules, artifact preferences, accessibility and localization;
- safe example references and evaluation fixtures without storing private transcripts or reusable credentials in public artifacts;
- optional accepted skill IDs and versions; optional accepted Tool Belt reference as a *separate*, independently authorized capability constraint;
- optional surface_kind, trusted UI-catalog identity, and allowed display component preferences for V7.7.11g/11h;
- host capability requirements and portable fallbacks (text/Markdown, tables, chart/image where supported, downloadable artifact where supported, interactive MCP App only where supported);
- revision, deprecation, compatibility, change/review metadata.

Do not encode raw HTML/JS/CSS, arbitrary executable actions, tool authorizations, secrets, or resource-access credentials as profile instructions. A profile's presence cannot expand accepted Scope, grant object access, authorize a tool, promote evidence, change a model's system instructions, or force a host to render features it does not offer.

## Scope, identity and precedence

Resolve the effective presentation preference independently from operational permission. Required platform safety/accessibility rules and server-derived 10i account/tenant/connection identity are non-overridable; server-side object/Scope grants, broker classification, and Tool Belt ceilings remain independent.

For presentation defaults, use deterministic layering:
1. accepted organization/team mandatory constraints and explicitly assigned defaults;
2. project/workspace defaults within that organization;
3. permitted member/user preferences;
4. user task or turn-specific presentation request, insofar as it does not violate higher mandatory constraints.

An authorized project administrator can publish or assign a profile for the whole team; individual users can opt out or override where team policy permits. An agent or a copied prompt cannot impersonate the administrator or silently alter team defaults. A portable profile ID does not imply that separate provider accounts are the same security principal.

Cache only validated, accepted profile versions; clients must revalidate identity, sharing rights, revocation, and digest before applying them. The server performs tenant and grant checks rather than trusting a caller-supplied account ID or a profile's display name.

## Profile resolver and delivery

Working endpoint/tool: cairnstone_response_profile_resolve. Proposed input: actor's authenticated connection context, task kind, project/workspace/Scope selectors, optional explicit profile ID. Output: bounded cairnstone-response-profile-resolution-v1 with selected accepted profile ID/version/hash, provenance, effective instructions/preferences, allowed accepted skill references, authorized Scope identifiers, host compatibility hints, and fallback rules. The resolver is read-only, deterministic, race-safe against accepted-state changes, and returns no secrets.

The existing Context Compiler should be the integration point. Progressive loading selects the smallest relevant accepted skill/profile set, not the entire catalog. A host adapter transforms the resolved abstract profile into supported native content and tool requests; it does not promise exact pixel parity across ChatGPT, Claude, Grok, or other hosts.

Host-specific adapters can detect or declare capabilities such as:
- native Markdown, lists/tables, diagrams and rich media;
- chart, file creation, attachment and citation support;
- MCP Apps / interactive widgets (where available and enabled);
- mobile vs desktop layout, touch input, refresh/state behavior;
- authentication and consent affordances.

Unsupported or disabled features degrade to a clearly explained text/Markdown answer or normal authenticated Console deep link. No fabricated citations, fake downloads, inert UI controls, or claim that all hosts display identical components.

## Relationship to Skills, Tool Belts, and UI surfaces

Skill = reusable approved workflow/behavior.
Tool Belt = versioned accepted capability projection, narrowing effective operational authority.
Response Profile = user/team-desired presentation and deliverable contract.
UI Surface = validated display tree over trusted components and state bindings.
Host renderer = ChatGPT/Claude/native chat, MCP App, Console/PWA, export/print renderer.
Accepted Stones and paths remain the source of project truth; a profile or widget cannot become a competing authority.

Never couple a visual choice to an unintended mutation. If a profile requests an approval card, the existing proposal / Human Commit / broker path must still separately authorize the action.

## Implementation plan

V7.7.10k.0 - freeze versioned contract, policy/override semantics, profile-vs-agent-profile distinctions, identity/threat model and portability matrix.
V7.7.10k.1 - accepted catalog + manifest-last Git/CairnStone path-HEAD workflow and linter; first visual-comparison pilot with examples and evaluation fixtures.
V7.7.10k.2 - account/tenant/principal-aware deterministic resolver; bounded Context Compiler and Skill Pack projection; stale-version and revocation protection.
V7.7.10k.3 - native-first host adapter for ChatGPT, then Claude; test another independent host where MCP and render capability permits; support honest text fallback.
V7.7.10k.4 - Console team/project/member preference controls with preview, publish, assignment, permission-aware overrides and rollback. Reuse 10i identity; avoid separate profile auth DB.
V7.7.10k.5 - connect trusted 11g UI-surface identity to profile semantics; make 11h embedded Console an optional output surface, not the default for every request.
V7.7.10k.6 - cross-host acceptance and quality/cost evaluation on identical accepted evidence.

## Acceptance

- same accepted profile and evidence yields semantically equivalent, appropriately native responses across at least ChatGPT and Claude where supported;
- profile version/content hash, effective layer precedence, actor, accepted evidence/Scope snapshot and renderer capability report are inspectable;
- a team can publish a default; another member can retrieve it from a separately authorized connection; an unrelated account cannot;
- profile revocation/supersession and client cache mismatch fail closed without permission widening;
- one profile drives native text/rich output and a compatible export; optional interactive app remains host-gated;
- inaccessible host features have functional plain-text or existing Console fallback;
- citations remain verifiable, generated files actually exist, and no render request creates fabricated completion or fake authorization;
- an untrusted instruction in a referenced example cannot override policy, authority, or the user's current request;
- measured quality, host variance, context cost, token use, and usability are reported; not assumed from one strong output.

## First demonstration

From a mobile ChatGPT conversation, ask for a grounded project comparison with the accepted visual-comparison profile. Render an appropriate rich native response, export a real file, then open an equivalent conversation in Claude and resolve the same accepted profile and project evidence. Verify attribution, semantic consistency and honest renderer differences. After 11h is implemented, open a read-only CairnStone in-chat project card from the same context.

This planning document does not authorize runtime work, account-bound rollout, UI deployment, repository merge, or movement of accepted CairnStone HEADs.
