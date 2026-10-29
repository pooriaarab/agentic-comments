# agentic-comments

[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Source](https://github.com/pooriaarab/agentic-comments) · [Support](https://github.com/pooriaarab/agentic-comments/issues)

Comment threads and suggestions anchored to any content, from people and agents.

> Status: early. Threads, suggestions, anchor survival, a CLI, and an MCP server work. It is not on npm
> yet. Notifications come next.

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
- Suggestions: a change your app proposes. A person, or an agent with the accept scope, accepts it.
  An agent never accepts or rejects its own. Two replicas that accept at once apply it once.
- The host stamps every author. An operation never reads an author from its input.
- Every message keeps the author kind, so agent comments stay marked as machine-made.
- Replies and status merge across replicas. Two replicas that resolve at once agree.
- A malformed thread from a bad replica is skipped. A bad message is left out, and `skipped` on the
  thread counts those. `problems()` names them.

## When the content changes

Every thread and suggestion has an `anchorState`:

| State | Meaning |
| --- | --- |
| `attached` | The content is there, as it was. |
| `edited` | A text range is there, with other text. `currentText` shows it. |
| `orphaned` | The content is gone. The thread stays readable and takes replies. |
| `unknown` | Nothing can tell. A cell, slide, canvas, or custom anchor has no host answer. |

- A text anchor follows its text through edits by any replica. Deleting the whole range orphans it.
- For other anchors, pass `exists(anchor)` to `new Comments`. Return `true` or `false`. Any other answer,
  or a throw, means `unknown`.
- `list({ anchorState: "orphaned" })` finds threads to review.
- `relocate(threadId, actor)` moves a text anchor to its quote when the quote occurs exactly once in the
  same text. It never guesses. It throws `RELOCATE_FAILED` for no match or many.
- Accept refuses a suggestion whose anchor is orphaned or edited. The suggestion stays pending, and a
  person can reject it.
- `currentText` is document text. It can hold any character, so a UI should treat it as untrusted.

## Suggestions

Your app owns the change. This package stores it as JSON, tracks the decision, and calls your `apply`.

```ts
import { ACCEPT_SCOPE, Suggestions } from "agentic-comments";

const suggestions = new Suggestions(comments, {
  apply(change, { anchor, by, ydoc }) {
    // Edit ydoc here. Throw before you edit when the change cannot apply.
    return { /* a receipt, JSON that lets revert undo this edit */ };
  },
  revert(receipt, { ydoc }) {
    // Undo a duplicate edit. Every replica runs this at once, so use an edit that merges to one result.
    // Throw before you change anything.
  },
});

const s = suggestions.add({ anchor, change: { replacement: "bold" }, summary: "Word choice" }, scribe);
suggestions.accept(s.id, ada);
```

- A signed-in person (`human`) accepts or rejects. Every other kind, including `user_token`, needs the
  `comments:accept` scope, and never decides a suggestion it wrote. Names match exactly, in Unicode NFC form (a name in another form is refused), and two
  principals that are not signed-in people with the same name count as one, whatever their kinds.
- Accept checks that a text anchor still matches the document, then runs the edit and writes the
  record in one step. If `apply` throws before it edits, the suggestion stays pending. If it edits and
  then fails, the decision is recorded without a receipt, and `problems()` reports it. A host that cannot undo a double apply must say `idempotent: true`.
- Every replica of a document must use the same host mode: the same `revert`, or the same `idempotent`
  flag. A mix can leave a duplicate edit in the document.
- `problems()` entries about an edit that failed after it landed, or a duplicate with no receipt, live in
  memory on the replica that saw them. Other replicas and a reload do not show them.
- A decision by an agent with the accept scope is final for everyone, including people.
- An accept on a replica that has not yet seen a reject wins, even when a person made the reject long before.
  The window is any time the replicas were apart. An agent with the scope can override a person this way.
  A host that wants the person to win can accept only while its replica is in sync.
- Two replicas that accept before they meet each apply the edit. After the merge, the application of
  the lowest client id stays and `revert` undoes each other one. An accept and a reject at once end as
  accepted.
- A receipt is stored data. A peer that can write comment data can choose one, and can rewrite the
  `anchor` to match. Check the receipt in `revert` before you use it. The sync layer's write control is
  the real protection. A record with no receipt (an `apply` that edited and
  then failed) always stays, and the other application is undone. If two records have none, the extra
  edit cannot be undone. `problems()` reports it. With `idempotent: true`, a duplicate is never undone.
- `apply` and `revert` must be synchronous, and must edit only the Yjs document. `accept` cannot run
  inside another Yjs transaction, so not inside an observer or an `apply`.
- A peer that can write the document can write a decision record. Records with a bad author, time, or
  receipt, or from a decider who wrote the suggestion as an agent, are not counted. A well-formed forged
  record is, and it can win settle, so every replica undoes the real edit. The sync layer must decide who
  may write.

## CLI and MCP server

Both run on a local store: one file that holds a Yjs document. The text is in the `text` root, and
non-text values are in the `values` map. A file starts with a magic mark and a hash, so a damaged or zero-filled file is refused and not read as empty. A write
takes a lock file, saves with a rename, and runs again if the file changed meanwhile, so parallel processes
on one machine lose nothing. A full disk or a file size limit fails the write and leaves the old file. A lock left by a dead process, or by this process under another mark, is cleared. So is an empty lock older
than two seconds and any lock older than a minute. The store is for one
machine. It cannot check a lock held in another container or on another machine. A save that
would pass 50 MB is refused.

The package is not published yet. After `npm run build`, run `node dist/cli.js` where these examples say
`npx agentic-comments`.

```sh
export AGENTIC_COMMENTS_FILE=./comments.ydoc
export AGENTIC_COMMENTS_AS=human:ada          # kind:name. The operator sets this.
npx agentic-comments init --text "Hello brave world"
npx agentic-comments comment --text-quote brave --body "Word choice? @scribe"
npx agentic-comments list --status open
AGENTIC_COMMENTS_AS=agent_of_human:scribe npx agentic-comments suggest --text-quote brave --replace bold
npx agentic-comments accept <id>
```

- Commands: `init`, `list`, `show`, `comment`, `reply`, `resolve`, `reopen`, `relocate`, `suggestions`,
  `suggest`, `accept`, `reject`, `mcp`. Run `agentic-comments --help` for flags.
- Every result is JSON. An error is JSON on stderr with a `code`, and the exit code is 1. A usage error
  exits 2.
- The principal comes from `--as` or `AGENTIC_COMMENTS_AS`. Scopes come only from
  `AGENTIC_COMMENTS_SCOPES`, a comma list such as `comments:accept`. No flag takes a scope or an author,
  and a flag that does not apply to a command is refused. `AGENTIC_COMMENTS_LOCK_TIMEOUT_MS` sets the wait
  for a lock, in whole milliseconds.
- `npx agentic-comments mcp` (or the `agentic-comments-mcp` binary, which reads the same environment) starts
  the MCP server on stdio. The operator fixes the principal and the
  scopes when the server starts. No tool takes an author or a scope. A call with any key a tool does not list is refused, so an agent
  cannot pick its own kind or rights. Tools: `list_threads`, `get_thread`, `add_comment`, `reply_to_thread`, `resolve_thread`,
  `reopen_thread`, `relocate_thread`, `list_suggestions`, `suggest_change`, `accept_suggestion`,
  `reject_suggestion`.
- A text change is `{"replace": "new text"}`. A change for a cell, slide, or canvas anchor is
  `{"value": <JSON>}`.
- From code: `import { FileStore, CommentsService, operatorActor } from "agentic-comments/local"`.

## Author kinds

| Kind | Meaning | Label |
| --- | --- | --- |
| `human` | A person signed in. | person |
| `user_token` | A person, through a token an agent holds. | person via agent |
| `agent_of_human` | An agent that acts for a person. | agent |
| `agent_of_agent` | An agent that acts for another agent. | agent |
| `agent` | An agent with its own identity. | agent |

## Limits

- No HTTP API yet. The file store is for one machine. It is not a sync server.
- `add` checks that a text anchor points into this document and matches its quote.
- The library trusts the host to call `stamp()` only for a principal it authenticated.
- A reply to a resolved thread is refused on the replica that sees the resolve. A reply and a
  resolve made at once on two replicas both stay. The merged thread is resolved and holds the reply.
- Author and kind are only as trustworthy as every peer that can write the document. A peer can write
  any author straight into the Yjs data. The sync layer must decide who may write.
- `relocate` and `exists` never touch a thread whose anchor is attached. `exists` runs for every thread
  on every read, so keep it fast.
- A local reply stops at 1,000 messages. Replicas that reply at once can pass that. A read shows the first
  2,000 valid messages. `skipped` and `problems()` report the rest.
- If several processes clear one stale lock at the same moment, two writes can very rarely overlap. The
  save check catches almost every such case. A symlink as the store path is followed. A filesystem with no
  hard links makes `init` use a check and a rename, which can race.
- The CLI trusts its caller: a process that can set `AGENTIC_COMMENTS_AS` and `AGENTIC_COMMENTS_SCOPES` can
  act as anyone. Give an agent the MCP server, where the operator fixes both. Do not give it a shell with
  the store file and the CLI.
- Every replica of a document must register the same custom anchor kinds.
- A repeated message id hides every copy. A peer that appends a copy of a thread's only message makes
  the thread unreadable.
- The quoted text of a text anchor is not checked when a thread is read. A peer can store any text there.
  `textAnchor` refuses a quote whose JSON form passes 4,096 characters. Quotes with many newlines or
  quotation marks hit that before 2,000 characters.
- The first visible message decides when a thread started, so a peer that inserts an older message at
  the front moves the thread in `list()`.
- A read scans every stored entry. A peer that writes millions of junk entries slows every read.
- A body mentions anyone named as `@handle`. Put `@` text in backticks to avoid that. Any two backticks in a body pair up, so a loose backtick
  can hide a real mention that sits between two of them. A scoped
  package name such as `@scope/pkg` is not a mention.
- Mentions are stored in lowercase, with no leading `@`. A handle holds up to 64 letters, digits, marks,
  and `. _ -`. A longer handle in a body is refused.

## Develop

```sh
npm ci
npm run ci:local
```

## License

MIT.
