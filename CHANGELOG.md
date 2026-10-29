# Changelog

Versions follow semantic versioning. Before 1.0, a minor release can change the API.

## 0.3.0

### Added

- An HTTP API as a Cloudflare Worker, in the `agentic-comments/worker` export. Routes under `/api/v1` cover
  documents, threads, replies, resolve, reopen, relocate, and suggestions with accept and reject. Documents
  live in D1 through the `Store` port of `agentic-identity`. Callers come from its `Auth` port: a token table
  in `AGENTIC_COMMENTS_TOKENS` by default, or any `Auth` you pass to `createApp`. A request with no valid
  token gets `401`. The host stamps the author, and a body with an `author` key fails with `400`. An agent
  needs the `comments:admin` scope to accept or reject, and never decides its own suggestion. The Worker
  needs `AGENTIC_COMMENTS_REGION`; without it every document route fails with `500 MISCONFIGURED`.
- The error codes `NO_DOCUMENT`, `DOCUMENT_EXISTS`, `CONFLICT`, and `MISCONFIGURED`.
- `hono` and `agentic-identity` are now dependencies of the package.

### Fixed

- `agentic-comments-mcp --help` prints help and exits 0. It also answers `--version`. Before, both ended in an
  `INVALID_AUTHOR` error and exit 1.

## 0.2.0

### Added

- A CLI, `agentic-comments`, over a local store file. Its commands are `init`, `list`, `show`, `comment`,
  `reply`, `resolve`, `reopen`, `relocate`, `suggestions`, `suggest`, `accept`, `reject`, `mcp`, `help`, and
  `version`. Every command except `help`, `version`, and `mcp` prints JSON. `mcp` starts the server.
- An MCP server, started with `agentic-comments mcp` or the `agentic-comments-mcp` binary. Its tools are
  `list_threads`, `get_thread`, `add_comment`, `reply_to_thread`, `resolve_thread`, `reopen_thread`,
  `relocate_thread`, `list_suggestions`, `suggest_change`, `accept_suggestion`, and `reject_suggestion`.
  The operator sets the principal and the scopes when the server starts.
- A notification stream: `new Notifications(comments, suggestions)` with `subscribe(listener)`. Events hold
  ids and never text. The same change has the same event `id` on every replica.
- A `./local` export with the file store and the local host that the CLI and MCP server use.

### Changed

- **Breaking:** `yjs` is now a peer dependency. Before, it was a regular dependency. Install `yjs` next to
  this package, and use the same copy that your app uses. The package checks the Yjs types of your
  document, so it needs that copy.
- `SuggestionHost.parse` gets a second argument, `{ anchor }`. An existing `parse` that takes one argument
  still works.
- `CommentsErrorCode` has new values: `STORE_MISSING`, `STORE_EXISTS`, `STORE_CORRUPT`, `STORE_LOCKED`,
  `STORE_FULL`, and `USAGE`. If you check the code with an exhaustive `switch`, add these cases.

### Fixed

- `prepack` builds `dist` before a pack. A clean `npm pack` or `npm publish` no longer ships missing or
  stale output.

## 0.1.0

The first release. Threads, suggestions, and anchor survival, as a library.
