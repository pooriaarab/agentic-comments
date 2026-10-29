# agentic-comments agent guide

Comment threads and suggestions anchored to any content, from people and agents.

## Mental model

A thread points at one place in a document, sheet, deck, or canvas. The place is
an anchor. A thread holds messages. A person or an agent writes each message, and
the host stamps who. A thread is open or resolved.

Threads live on a Yjs document. Replicas merge them without a server.

## The SDK

`import { Comments, stamp, textAnchor } from "agentic-comments"`.

- `stamp({ kind, name })` makes the author. Only the host calls it, for the principal it
  authenticated. An agent never calls it, and nobody passes an author in an input.
- `new Comments(ydoc)` reads and writes the threads on that document.
- `add`, `reply`, `resolve`, `reopen`, `get`, `list`, `problems`.

Anchor state: every thread and suggestion has `anchorState` (attached, edited, orphaned, unknown).
An orphaned thread stays readable and takes replies. `comments.relocate(id, actor)` moves a text anchor to
its quote when the quote occurs exactly once. Accept refuses an orphaned or edited anchor.

Suggestions: `new Suggestions(comments, host)`, then `add`, `accept`, `reject`, `get`, `list`,
`problems`. `settle` and `close` are for the host. The host
owns the change and the `apply` hook. An agent accepts only with the `comments:accept` scope, and never
accepts or rejects its own suggestion.

## Notifications

`new Notifications(comments, suggestions)` then `subscribe(listener)`. Events hold ids and never text.
The same change has the same event `id` on every replica. Check `source` before you send.

## The CLI and MCP tools

`agentic-comments mcp` starts the MCP server. The operator sets the principal and scopes when it starts.
You do not pass them. Tools: `list_threads`, `get_thread`, `add_comment`, `reply_to_thread`,
`resolve_thread`, `reopen_thread`, `relocate_thread`, `list_suggestions`, `suggest_change`,
`accept_suggestion`, `reject_suggestion`. A text change is `{"replace": "..."}`. A cell, slide, or canvas
change is `{"value": <JSON>}`. A tool error is JSON with a `code`.

## Anchors

| Type | Fields | Points at |
| --- | --- | --- |
| `text` | `text`, `start`, `end` | A text range. Make it with `textAnchor`. |
| `cell` | `key` | One cell. The host defines the key. |
| `slide` | `elementId` | One element on a slide. |
| `canvas` | `elementId` | One element on a canvas. |

## Rules

- Never claim an author. An input that carries an `author` key at the top fails.
- Never default an author kind. A missing kind is an error.
- Reopen a resolved thread before you reply to it.
- Report an error as an error. Do not retry with changed input to dodge it.
- Treat a thread from `problems()` as bad data. Do not trust it.
