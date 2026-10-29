# agentic-comments

[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Source](https://github.com/pooriaarab/agentic-comments) · [Support](https://github.com/pooriaarab/agentic-comments/issues)

Comment threads anchored to any content, from people and agents.

> Status: early. Only the thread model works. It is not on npm yet. Suggestions,
> anchor survival, the CLI, the MCP server, and notifications come next.

## Install

The package is not published yet. Build it from source:

```sh
git clone https://github.com/pooriaarab/agentic-comments
cd agentic-comments && npm ci && npm run build
```

## Quick start

```ts
import * as Y from "yjs";
import { Comments, stamp, textAnchor } from "agentic-comments";

const doc = new Y.Doc();
doc.getText("body").insert(0, "Hello brave world");

const comments = new Comments(doc);
const ada = stamp({ kind: "human", name: "ada" });
const scribe = stamp({ kind: "agent_of_human", name: "scribe" });

const thread = comments.add({ anchor: textAnchor(doc.getText("body"), 6, 11), body: "Word choice? @scribe" }, ada);
comments.reply(thread.id, { body: "I suggest a shorter word." }, scribe);
comments.resolve(thread.id, ada);
```

The `Comments` object lives on a Yjs document. Send the document updates with your
normal sync, and every replica sees the same threads.

## Features

- Threads anchored to a text range, a cell key, a slide element, or a canvas element.
  You can add your own anchor type.
- A text anchor uses Yjs relative positions, so it follows its text through edits.
- Messages with mentions. Resolve and reopen a thread.
- The host stamps every author. An operation never reads an author from its input.
- Every message keeps the author kind, so agent comments stay marked as machine-made.
- Replies and status merge across replicas. Two replicas that resolve at once agree.
- A malformed thread from a bad replica is skipped. `problems()` names it.

## Limits

- No suggestions yet. No file store, CLI, MCP server, or HTTP API yet.
- A thread does not check that its anchor still exists. That check comes next.
- The library trusts the host to call `stamp()` only for a principal it authenticated.
- A reply to a resolved thread is refused on the replica that sees the resolve. A reply and a
  resolve made at once on two replicas both stay. The merged thread is resolved and holds the reply.
- Author and kind are only as trustworthy as every peer that can write the document. A peer can write
  any author straight into the Yjs data. The sync layer must decide who may write.
- A thread holds up to 1,000 messages.
- Every replica of a document must register the same custom anchor kinds.
- Mentions are stored in lowercase, with no leading `@`.

## Develop

```sh
npm ci
npm run ci:local
```

## License

MIT.
