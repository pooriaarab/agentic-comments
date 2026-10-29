---
name: agentic-comments
description: Comment threads and suggestions anchored to any content, from people and agents. Keywords: comments,threads,mentions,suggestions,annotations,collaboration,agents,yjs,mcp.
---

# agentic-comments

Comment threads and suggestions anchored to any content, from people and agents.

## Use the SDK

```ts
import { Comments, stamp, textAnchor } from "agentic-comments";

const comments = new Comments(ydoc);
const me = stamp({ kind: "agent_of_human", name: "scribe" });
const thread = comments.add({ anchor: { type: "cell", key: "Sheet1!B4" }, body: "Check this total." }, me);
comments.reply(thread.id, { body: "Fixed." }, me);
```

The CLI and the MCP server are not built yet.

## Rules

- The host stamps the author. Never pass one in an input.
- Reopen a resolved thread before you reply.
- Report refusals and errors as failures.
