# Changelog

Versions follow semantic versioning. Before 1.0, a minor release can change the API.

## 0.5.1

### Changed

- **Breaking:** a token or a principal name that 0.5.0 accepted can now be refused. A token in `AGENTIC_COMMENTS_TOKENS`
  is 32 to 512 bytes, from A-Z a-z 0-9 `_` `-`, so a base64 token with `+` or `/` is refused. A principal name starts with
  A-Z a-z 0-9 `_` `-`, then uses A-Z a-z 0-9 `.` `_` `-`, and is at most 128 characters. A name such as `ada@example.com` is refused.
  One bad token or name refuses the whole token table, and every `/api/v1` request then gets `401`. The CLI and the MCP server
  refuse a principal name outside this grammar. Check your tokens and names before you upgrade.
- **Breaking:** the `Authorization` header is checked before your `Auth` runs. A header that is not `Bearer` followed by a token
  of the shape above gets `401`. This applies to a custom `Auth` too, so a JWT, which contains `.`, is refused.
- **Breaking:** a write (`POST`, `PUT`, `PATCH`, `DELETE`) that your `Auth` accepts with no `Authorization` header gets `403`,
  unless its `Origin` is listed in the new `origins` option of `createApp`. The default lists no origins. A host that signs
  writes with a session cookie must pass `origins`. Before, the Worker did not check the origin.
- The auth and principal code now uses `agentic-identity` 0.6. The Worker resolves the caller with `requirePrincipal` from
  `agentic-identity/http`. The token table and the operator principal both go through `parsePrincipal`.
- A custom `Auth` that throws returns a `5xx` status with the API error shape and the code `INTERNAL`.

### Removed

- The Worker's own kind check. The Worker and the operator code now parse `kind:name` with `parsePrincipal` from `agentic-identity`.

## 0.5.0

### Added

- `agentic-comments/client`: a typed fetch client for every Worker route under `/api/v1`. `createClient({ baseUrl, token })`
  returns methods for documents, threads, replies, resolve, reopen, relocate, and suggestions. It never sends an author.
  A failed call throws `CommentsApiError` with the API `code` and the HTTP `status`. It uses only `fetch`, so it runs in
  browsers, Workers, and Node.

## 0.4.0

### Added

- `agentic-comments/anchor`: anchors for plain text that need no Yjs and no framework. `createAnchor(text, from, to)`
  keeps the quote and the text around it. `resolveAnchor(anchor, newText, edits?, originalLength?)` finds the range again: it maps
  the range through the edits, then falls back to the quote and its context. It returns `attached`, `edited`, or
  `orphaned`. `mapPosition` and `mapRange` move offsets through a list of edits.

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

### Changed

- **Breaking:** the package requires Node.js 22 or later. Before, it required Node.js 20.

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
