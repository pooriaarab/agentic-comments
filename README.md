# agentic-comments

[![npm version](https://img.shields.io/npm/v/agentic-comments)](https://www.npmjs.com/package/agentic-comments)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-comments) · [Source](https://github.com/pooriaarab/agentic-comments) · [Support](https://github.com/pooriaarab/agentic-comments/issues)

Comment threads and suggestions anchored to any content, from people and agents.

> Status: scaffold. This repository holds the starter code only. It is not on npm
> yet, and none of the features below work yet.

## Planned features

- Threads anchored to text ranges, cells, slides, or canvas elements.
- Mentions, resolve, and reopen.
- Suggested edits that a person accepts or rejects.
- Every comment keeps its author kind, so agent comments are labeled.
- Works on Yjs documents, so comments sync in real time.
- An agent can never accept its own suggestion.

## Surfaces

One package gives you each way in:

- **Library and SDK**: `import { ... } from "agentic-comments"`.
- **CLI**: `npx agentic-comments --help`.
- **MCP server**: `npx agentic-comments mcp`, for Claude Code and other MCP clients.
- **HTTP API**: a Cloudflare Worker you deploy to your own account.
- **Web UI**: a small app served by the same Worker.

## Develop

```sh
npm ci
npm run build && npm run typecheck && npm test
```

## License

MIT.
