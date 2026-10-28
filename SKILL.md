---
name: agentic-comments
description: Comment threads and suggestions anchored to any content, from people and agents. Keywords: comments,threads,mentions,suggestions,annotations,collaboration,agents,yjs,mcp.
---

# agentic-comments

Comment threads and suggestions anchored to any content, from people and agents.

## Use the SDK

```js
import { summarizeText, dispatchText } from "agentic-comments";

summarizeText("some text");
await dispatchText("some text", { dryRun: true });
```

## Use the CLI

```sh
agentic-comments summary --text "some text"
agentic-comments dispatch --text "some text" --dry-run
```

## Use the MCP server

Start the server with `agentic-comments mcp`. Call `summarize_text`
for stats, `dispatch_text` for routes, `get_cost_report` for costs.

## Rules

- Preview each route with dry run first.
- Report guard denials and adapter errors as failures.
- Read the cost report at the end.
