---
name: agentic-comments
description: Comment threads and suggestions anchored to any content, from people and agents. Keywords: comments,threads,mentions,suggestions,annotations,collaboration,agents,yjs.
---

# agentic-comments

Comment threads and suggestions anchored to any content, from people and agents.

## Use the SDK

The host gives you an `Actor` that names you. Pass it to each call.

```ts
import { Comments } from "agentic-comments";

const comments = new Comments(ydoc);
const thread = comments.add({ anchor: { type: "cell", key: "Sheet1!B4" }, body: "Check this total." }, actor);
comments.reply(thread.id, { body: "Fixed." }, actor);
```

Check `thread.anchorState`. An `orphaned` thread has lost its content. Read it, reply, or call
`comments.relocate(id, actor)`. Do not treat it as bad data.

Suggest a change with `suggestions.add({ anchor, change, summary }, actor)`. Accept needs a person or
the `comments:accept` scope. You never accept or reject your own suggestion.

Change your own words with `edit_message`, `delete_message`, and `delete_thread`. Another person's messages need the
`comments:moderate` scope. `export_person` and `erase_person` read or tombstone what one person wrote (your own, or
anyone's with that scope). Check `unread` in an export.

Over MCP, call `list_threads`, `add_comment`, `reply_to_thread`, `resolve_thread`, `suggest_change`,
`accept_suggestion`, `reject_suggestion`, and the tools above. You never pass an author or a scope.

## Rules

- The host stamps the author. Never call `stamp()` yourself, and never pass an author in an input.
- Reopen a resolved thread before you reply.
- Report refusals and errors as failures.
