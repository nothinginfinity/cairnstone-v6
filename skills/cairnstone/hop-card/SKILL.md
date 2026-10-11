# Skill: Cross-app hop card

Use this skill when work should continue in another app, including automatic user-facing handoffs following confirmed cross-LLM AC1 messages or assignments. Do not wait for an explicit hop-card request.

## Automatic activation

- After a confirmed successful outgoing `cairnstone_send_message`, `cairnstone_dispatch_handoff`, or `cairnstone_forward_with_note` addressed to another LLM, include a Hop Card in the same operator-facing response. This includes informational AC1 messages and assigned work; do not require the operator to say "hop card".
- If multiple LLM recipients are confirmed, render one compact card per recipient or a grouped Hop Bar. Use the actual per-recipient `recipient_id` and recorded `message_id`, `thread_id`, and Stone hash when available. Never invent a missing ID.
- For a `task_run_propose` or other not-yet-dispatched assignment, show a *proposed / not dispatched* continuation card if useful. Do not label it delivered. Show a delivery card only when a real dispatch or AC1 receipt supports that state.
- If an AC1 call fails, has not been invoked, or its delivery outcome is unknown, do **not** claim sent or delivered. Only offer a draft/pending pointer when clearly labeled.
- The agent emits an interactive-facing card when it has an operator-facing response. Automatic persistent card creation from backend AC1 events belongs to the Hop Bar runtime, not this prompt skill. Neither a card nor a pointer executes an assignment.

## Output contract

1. Emit one fenced code block containing exactly one short, copyable AC1 pointer line per card, before its destination link. Keep it bounded and include exact recipient/message/thread/Stone identifiers only when available.
2. Prefer a thread ID, full CairnStone Stone hash, or stable path as the pointer.
3. If the next app must read AC1 directly, name the exact `recipient_id` in the pointer.
4. Keep the pointer minimal. Never put secrets, credentials, bearer tokens, private keys, or a long prompt in the pointer or in a `q` parameter.
5. Percent-encode the pointer when placing it in a supported `q` query parameter.
6. Then emit a tappable HTTPS link appropriate to the recipient. Provide separate **Copy pointer** and **Open destination** affordances if the client supports actions; otherwise use the fenced pointer and a normal link. Do not iframe apps or invent unsupported custom schemes.
7. Label the actual state: *sent*, *queued*, *delivered*, or *proposed* only when supported by a receipt or proposal. A successful send request is not proof of a read, execution, or task completion.
8. Never imply a precise project/chat hop until that destination is owner-tested in the specific client. Otherwise label it **open + paste** or **app-home**. Preserve the originating context pointer for a return hop when available.

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

This skill formats navigation only. It never sends AC1 on its own, executes an assignment, approves dispatch, grants access, mutates a repository, or changes accepted-state authority. Keep credentials, private content, and BYOK secrets out of pointers and query strings.
