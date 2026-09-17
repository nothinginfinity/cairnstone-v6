# V7.7.11e — Guided Mode / Conversational Cursor + Simple Stone Workflows

Status: **PLANNED / NEAR-TERM UX INTEGRATION**
Parent milestone: **V7.7.11 — Mobile Home Surface / Installable PWA Dashboard**
Activation: **foundation hooks may land during ongoing Console UX testing; full Guided Mode activation follows V7.7.10 acceptance**
Reference implementation: `nothinginfinity/infinite-long-press` @ `04d14ac80637ff794868b393a235597a4e788564`

## Product thesis

CairnStone should remain powerful without requiring a new user to understand the entire Console before completing a useful task.

Guided Mode turns Chat into an in-product navigation layer. A user states a goal in normal language; CairnStone compiles a bounded walkthrough over semantic Console targets; a floating guide cursor/highlight shows what to use next; long-press opens contextual Chat attached to the current target and workflow step so the user can ask why, change an actor, skip a step, or re-plan the remaining path.

The interaction rule is intentionally simple:

- **tap / normal UI action** — operate the software normally;
- **long press** — ask CairnStone about the exact thing or current guide step;
- **Guide Mode** — highlights the next semantic target and waits for observable UI state rather than blindly clicking;
- **human commit remains dominant** — consequential actions still stop at the existing proposal/authorization boundary.

This is not remote-control screen automation. The guide reasons over explicit semantic UI metadata and current CairnStone state.

## Why V7.7.11

This belongs with the mobile/PWA milestone rather than being inserted into the already-moving V7.7.10 implementation:

1. it is mobile-first and directly improves iPhone Console usability;
2. it can reuse V7.7.10 Conversation Sessions, intent routing, typed attachments, and proposal-card boundaries instead of inventing a second chat/control plane;
3. it can begin safely as thin Console instrumentation during UI/UX testing without changing runtime authority;
4. the installed PWA/Home Surface becomes a natural entry point for “show me how to…” workflows;
5. it lets CairnStone preserve professional-software depth while reducing the amount of information a user must hold in memory.

V7.7.10 should finish on its existing contract. Guided Mode consumes it.

## Infinite Long Press reference

The existing `nothinginfinity/infinite-long-press` PWA proves a useful mobile interaction primitive:

- long press is the deliberate depth/context gesture;
- reversible navigation lets the user surface back out;
- depth is stateful rather than a one-shot tooltip;
- Chat can open with the current depth layer as context.

CairnStone should adapt the interaction concept, not copy screen coordinates or make the demo repository a runtime dependency.

The immutable reference commit is:

`04d14ac80637ff794868b393a235597a4e788564`

The initial CairnStone implementation should preserve the feel of a deliberate long press while testing timing/haptics/accessibility on real iPhones.

## Semantic UI anchor contract

Walkthroughs must target stable semantic controls, never raw pixels.

Illustrative Console markup:

```html
data-cairn-target="nav.work"
data-cairn-target="work.code-session"
data-cairn-target="code-session.give-access"
data-cairn-target="actor-selector"
data-cairn-target="authorize.commit"
```

Each registered target should expose bounded metadata sufficient for deterministic guidance, for example:

```text
target_id
surface
object_type / object_id when applicable
action_class: read | navigation | proposal | mutation | execution
availability / disabled reason
required state
next observable state
accessibility label
compatibility/version identity
```

The Console owns placement and rendering. The workflow owns semantic intent.

If a target is missing, stale, hidden, or incompatible, Guided Mode pauses and explains/re-plans. It must never fall back to blind coordinate clicking.

## `cairnstone-simple-stone-v1`

A **Simple Stone** is a portable declarative human workflow, not accepted project truth and not execution authority.

Minimum shape:

```text
simple_stone_id
title / goal
version / compatibility
author / provenance
required scope or surface state
steps[]
  step_id
  target_id
  intent
  explanation
  completion predicate
  optional skip predicate
  branches / substitutions
  risk class
guards
expected terminal state
```

A Simple Stone may describe “how to accomplish X” while leaving current actor, repository, Code Session, Scope, or other parameters unresolved until a Guide Session binds them.

A saved workflow must never persist raw mailbox/workspace capability bearers, provider credentials, secrets, or one-time authorization material.

## Guide Session

A temporary Guide Session binds:

```text
Simple Stone
+ Conversation Session
+ current Console surface
+ current Scope / selected objects
+ current workflow step
+ observed completion state
```

The guide cursor/highlight follows that state.

Long-pressing the guide cursor or an instrumented target opens contextual Chat with bounded structured context such as:

```text
surface
target_id
object_type / object_id
simple_stone_id
step_id
current Scope identity
available safe alternatives
```

Examples:

- “Why do I need Give Access here?”
- “Use Claude instead of Grok.”
- “Skip this if the agent already has access.”
- “What will happen if I approve this?”
- “Show me the safer path.”

Chat may recompile the remaining walkthrough, but changing the walkthrough never widens authority.

## Operating modes

Initial modes are deliberately separated:

### Guide
Highlights, scrolls, explains, waits, and observes. No consequential action is executed by the guide.

### Assist
May prepare selections/forms or navigate read-only surfaces where existing policy allows, but consequential actions still require the normal visible human proposal/commit boundary.

### Automate
Deferred. Any future automation must use existing CairnStone capability/tool policy and authorization contracts; Simple Stone membership alone can never grant execution.

The first accepted slice is **Guide-first**.

## Initial MVP

Instrument a small stable set of high-value Console targets first:

- Chat;
- Work;
- Inbox / thread reader;
- Scope;
- Code Session;
- Give Access / Assign;
- Checkpoints;
- Evidence / provenance;
- Authorize / proposal commit;
- Home / Full Console transition.

Ship a small official workflow set:

1. **Continue a Code Session**
2. **Give an agent access to a Code Session**
3. **Check and respond to an Inbox thread**
4. **Inspect why a CairnStone answer is trusted**
5. **Prepare a guarded change/proposal**

After successful completion, offer **Save as Simple Stone** for private reuse.

## V7.7.11f — Simple Stone Library / portability

This is a follow-on, not a blocker for Guided Mode MVP.

Start with a private user library:

- save / rename / version / duplicate;
- inspect declared targets and risk classes;
- compatibility checks against the current Console anchor registry;
- import/export with provenance;
- replay only after target/guard validation.

Later, after schema safety and compatibility are proven, add sharing/publishing. A marketplace or paid distribution layer is explicitly deferred; if pursued, it should expose declared capabilities/compatibility and may compose with existing x402/payment infrastructure rather than embedding payment semantics into the workflow format.

## Authority and safety invariants

- Guided Mode is a Console/client projection, not an authority root.
- Running, saving, or sharing a Simple Stone does not move chain/path HEADs.
- A workflow cannot mint, widen, transfer, or bypass an actor capability.
- No raw capability bearer, API key, provider credential, or secret is stored in Simple Stones or guide history.
- Read/navigation guidance may be automatic where current policy already permits it.
- Durable communication, task dispatch, accepted-state changes, mutation, execution, deploy, merge, or other consequential actions retain their existing proposal/authorization rules.
- The guide cursor must visually distinguish explanation/navigation from a human-commit action.
- Missing/stale UI targets fail closed into explanation/re-plan.

## Mobile acceptance

V7.7.11e is accepted only when real iPhone testing proves:

- Guide Mode works in Safari and the installed CairnStone PWA;
- overlays respect safe areas and do not introduce horizontal overflow;
- the guide can scroll/focus a semantic target without stealing the underlying control's normal behavior;
- long press reliably opens step/target-contextual Chat and can be cancelled without accidental activation;
- guide state survives ordinary Console navigation within the same Conversation/Guide Session;
- “why?”, substitution, skip, and re-plan flows preserve the current workflow state;
- a missing or renamed anchor produces a recoverable compatibility state, never a blind click;
- consequential steps still stop at the existing human proposal/authorization boundary;
- merely running a guide causes zero accepted-state mutation;
- Simple Stones contain no reusable secrets or capability bearers;
- at least the five official MVP workflows complete end-to-end on mobile.

## Integration rule

Do **not** pause or rewrite active V7.7.10 work to implement this.

During ongoing Console UI/UX changes, it is allowed and encouraged to add stable semantic anchors to controls that are already being touched, provided those anchors are inert when Guided Mode is off. This makes the Console progressively guide-ready at very low regression risk.

Full Guided Mode UI/runtime behavior begins after V7.7.10 acceptance and is carried as V7.7.11e, alongside the mobile/PWA work.
