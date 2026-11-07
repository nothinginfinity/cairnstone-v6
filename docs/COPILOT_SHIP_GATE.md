# Copilot + CairnStone Ship Gate — R1

Status: candidate / reviewable implementation (2026-11-07). Source: Grok AC1 `thread:ship-threshold-20261107`. Companion policy: `docs/AI_OPERATING_GUIDE.md`, ship-threshold section.

## Objective
Reduce iPhone review taps, main-chat context cost, and repetitive agent-review loops without changing Cursor Cloud Agent / Grok Bot branch ownership, accepted CairnStone authority, or deployment permissions.

## R1 operating rules
1. On a newly opened or newly ready-for-review pull request, the workflow looks at **filenames only** and classifies advisory risk. When at least one code file exists and risk is LOW/MEDIUM, request `copilot-pull-request-reviewer[bot]` once through GitHub's review-request API if no Copilot review is present or pending. Skip draft PRs. Documentation-only PRs and HIGH-risk PRs do not auto-request.
2. On later PR pushes, **do not re-request Copilot**. Re-review is a conscious decision for materially changed code, or an explicitly updated repository policy. This avoids review ping-pong and unnecessary usage.
3. Every opened/reopened/ready/synchronized PR generates a lightweight GitHub Actions **job summary** with head SHA, advisory risk, check-run and review statuses. This is a snapshot, not an immutable CairnStone stone, and it never claims live verification.
4. CI and security checks remain the primary deterministic signals. Copilot comments are advisory; a clean review alone is not a passing test, and a Copilot review is not a substitute for human authorization.
5. No auto-merge, preview deploy, production deploy, GitHub policy editing, Copilot code-fix agent assignment, or accepted CairnStone HEAD promotion is performed by this workflow.
6. If Copilot isn't available, GitHub responds with an error; the workflow records `unavailable/not requested` without blocking unrelated CI or opening another agent session. First-party Copilot entitlements/settings are outside this workflow.
7. HIGH risk is a **conservative path-based signal**, not a complete security review. Reviewers must also classify behavioral impact and privilege boundaries. Risk can only be upgraded by the owning agent or human, never downgraded based solely on filenames.

## Risk definitions
- LOW: documentation, formatting, tests or isolated UI.
- MEDIUM: ordinary code/API changes.
- HIGH: changed paths suggest auth, OAuth, credentials, secrets, payments, wallet/x402, outbound messages, production storage/migrations or deploy controls.

The workflow's classifier is intentionally bounded and may not capture semantic risk; use a human or owning agent assessment before release.

## Receipt interpretation
The action summary is **read-only evidence**: PR identity, SHA, filename-derived risk, current check runs, review counts, request outcome and suggested next action. A green check does not imply a preview URL exists. Manual CairnStone receipts may reference this Actions run and the exact PR head SHA when a milestone warrants durable storage.

## Rollout
- Stage R1 in this PR and check the diff; do not change GitHub organization rulesets or request automatic Copilot reviews across every repository.
- After merging R1, test with a fresh safe code PR, verify one Copilot request at most, and verify a synchronize event does not repeat it.
- If Copilot has already been assigned by a repository-level automation, the workflow skips the duplicate.
- Expand repo-by-repo only after owner acceptance and observed review availability/cost.
- If the repo later enables GitHub's native automatic Copilot reviews, disable this workflow's request step to prevent duplicate triggers. The receipt step can remain.

## Security
Uses `pull_request_target` **without any checkout**, execution of PR code or untrusted interpolated shell. Only repository metadata is read and the scoped GitHub review-request endpoint is written. GitHub token permissions: `contents:read`, `pull-requests:write`, `checks:read`. No secrets are passed to PR content. Fork PRs do not receive PR code execution.

## Existing integration points
Copilot instructions: `.github/copilot-instructions.md`; Actions workflow: `.github/workflows/copilot-ship-gate.yml`. The owning agent/human retains release authority.
