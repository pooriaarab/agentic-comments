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

Suggest a change with `suggestions.add({ anchor, change, summary }, actor)`. Accept needs a person or
the `comments:accept` scope. You never accept or reject your own suggestion.

The CLI and the MCP server are not built yet.

## Rules

- The host stamps the author. Never call `stamp()` yourself, and never pass an author in an input.
- Reopen a resolved thread before you reply.
- Report refusals and errors as failures.
