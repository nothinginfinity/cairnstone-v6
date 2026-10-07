# Skill: Cross-app hop card

Use this skill when work should continue in another phone app or when the operator asks for a compact cross-app handoff.

## Output contract

1. Emit one fenced code block containing exactly one short copyable pointer line before any destination links.
2. Prefer a thread ID, full CairnStone Stone hash, or stable path as the pointer.
3. If the next app must read AC1 directly, name the exact `recipient_id` in the pointer.
4. Keep the pointer minimal. Never put secrets, credentials, bearer tokens, private keys, or a long prompt in the pointer or in a `q` parameter.
5. Percent-encode the pointer when placing it in a supported `q` query parameter.
6. Then emit tappable HTTPS destination links. Do not embed the destination app, do not create an iframe, and do not invent unsupported custom schemes.

## Destination links

- ChatGPT - community-prefill: `https://chatgpt.com/?q=<encoded-pointer>`
- Claude Code - query-prefill: `https://claude.ai/code/new?q=<encoded-pointer>`
- Claude chat - open only: `https://claude.ai/new`
- Grok app/web - community-prefill: `https://grok.com/?q=<encoded-pointer>` (may auto-submit)
- X Grok - open only: `https://x.com/i/grok`
- Perplexity - community-prefill: `https://www.perplexity.ai/search?q=<encoded-pointer>`
- Perplexity Space - when an exact Space ID is already known: `https://www.perplexity.ai/spaces/<id>`
- Cursor - open only: `https://cursor.com/agents`
- GitHub - open only: `https://github.com/nothinginfinity`

A custom scheme may exist outside chat, but do not substitute an invented or untappable scheme for the HTTPS link. In particular, do not invent `grok://` or `cursor://`.

## Operator instruction

After the links, tell the operator to long-press the pointer to copy it, tap the destination link, and paste only if the destination composer is empty.

This skill formats a handoff surface only. It grants no execution, mutation, repository-write, or accepted-state authority.
