# Changelog

Versions follow semantic versioning. Before 1.0, a minor release can change the API.

## 0.8.5

### Changed

- Accept `agentic-identity` 0.9 and 0.10, and `agentic-design` 0.8 and 0.9, so hosts can install current releases together.

## 0.8.4

Patch. No change to the SDK, the HTTP API, or the MCP tools.

### Changed

- The `agentic-design` dependency is `^0.8.0`. It was `^0.5.0`, which does not accept 0.8.0. So the agentic-* packages could not install together (ERESOLVE). The panel uses only components and `--agd-*` tokens that 0.8.0 still exports, so the code needs no change.

## 0.8.3

### Changed

- The `agentic-identity` dependency is `^0.9.0`. It was `^0.8.0`. The package needs no code change. Below 1.0, `^0.9.0` does not accept 0.8.x, so a host that pins `agentic-identity@0.8.x` gets a second copy of it. Move the host's pin to `^0.9.0`. With two copies, a store conflict from the host's copy is not recognised. The Worker returns a server error instead of a 409 conflict, and the account erase throws the store's own error instead of a `CONFLICT` error.

## 0.8.2

Patch. No change to the SDK, the HTTP API, or the MCP tools.

### Fixed

- `agentic-comments-mcp --as kind:name` sets the principal, as the CLI does. It overrides `AGENTIC_COMMENTS_AS`. Before, the bin did not read `--as`, and its error said to pass it. A bare `--as` with no value, or a bad one, fails closed with `INVALID_AUTHOR`, exit 1 from the bin, even when `AGENTIC_COMMENTS_AS` is set. On 0.8.0, the bin ignored `--as`, so the same input started the server as the variable's principal. (The CLI exits 2 for a bare `--as`.) A repeated `--as`, or `--as=...`, exits 2 with a usage error.
- `agentic-comments-mcp --help` lists `--as`.

## 0.8.0

### Added

- `agentic-comments/account` exports `commentsAccount`, the account plug-in. `exportAccount(subject, deps)` returns the messages, status changes, edits, suggestions, and decisions of one subject over the documents the host passes, as JSON records. `eraseAccount(subject, deps)` tombstones them and returns counts. A second erase counts 0, except `unread`, which counts the worker rows it cannot read. The package keeps no grants or audit rows. A host that runs the HTTP worker passes `worker` (the worker's `CommentsDocs`) to cover every stored document and the creator kept on each row.

## 0.7.0

### Added

- `agentic-comments/ui`: a React comments panel (`CommentsPanel`) with a thread list, quote, reply box, resolve and reopen, an agent or person mark on every message, and Accept and Reject buttons for suggestions. An agent never gets either button for its own suggestion. `mayDecide` and `holds` export the same rule. The styles are in `agentic-comments/ui.css`. `react` and `react-dom` are optional peer dependencies. The package depends on `agentic-design` `^0.5.0`.
- A demo page for the panel on the demo Worker, and browser tests (`npm run test:ui`) with an axe check for WCAG 2.2 AA at desktop and 390px.

## 0.6.1

### Fixed

- `agentic-comments mcp --help`, `-h`, `--version`, `-V`, and `-v` print and exit 0 before the server starts. They used to exit 2. The `agentic-comments-mcp` bin answers `-V` too. It used to start the server.
- The MCP server names `AGENTIC_COMMENTS_AS` in its startup error when no principal is set.
- The `zod` dependency moves from zod 3 to `^4.6.7`. Zod below 4.6.6 can exhaust memory on oversized constrained collections (GHSA-mrhx-c7xc-m3w5). The MCP tool schemas use zod 4.
- The publish workflow runs one publish at a time per ref, so two runs cannot both publish the same version.

### Changed

- The `agentic-identity` dependency is `^0.8.0`, the current release. Below 1.0, `^0.8.0` does not accept 0.7.x, so a host that pins `agentic-identity@0.7.x` gets a second copy of it. The exported names are the same in both releases. A host that passes its own `Store` should upgrade to `^0.8.0`, so that the conflict check recognizes its errors.
- `zod` is not part of the public API. Its move from zod 3 to 4 changes no exported type.

## 0.6.0

### Added

- Edit, delete, export, and erase for comments. The same calls exist in every surface.
  - `Comments`: `editMessage`, `deleteMessage`, `deleteThread`, `exportPerson`, and `erasePerson`. `Suggestions`: `exportPerson` and `erasePerson`.
    An edit sets `editedAt` and `editedBy`. An erase replaces a person's words with `[erased]` and keeps the thread shape.
  - The `comments:moderate` right lets a principal change or erase what another person wrote. Without that right, a principal can edit or delete only its own messages.
  - Exports: `ERASED_BODY`, `ERASED_NAME`, `MODERATE_SCOPE`, and the `EditMessage` and `PersonExport` types.
  - CLI: `edit-message`, `delete-message`, `delete-thread`, `export-person`, and `erase-person`.
  - MCP: `edit_message`, `delete_message`, `delete_thread`, `export_person`, and `erase_person`.
  - Worker: `PATCH` and `DELETE` on a message, `DELETE` on a thread, `GET` on `people/:name/export`, and `DELETE` on `people/:name`.
  - `agentic-comments/client`: the same five calls, with a typed result for each.
- The error code `NO_MESSAGE`.

### Changed

- **Breaking:** the principal name `erased` is kept for erased authors. `Actor` refuses it with `INVALID_AUTHOR`, and 0.5.1 accepted it.
  To migrate: rename a principal named `erased` before you upgrade.
- **Breaking:** the Worker signs in with `agentic-identity` by default. Credentials and principals are read from the `Store`
  of the documents with `createStoreAuth`. Any comments scope signs in, and each route checks the scope it needs: no valid
  credential is `401`, too few scopes is `403`, and a store failure is `503`.
- **Breaking:** `AGENTIC_COMMENTS_TOKENS` is now an explicit dev fallback. It is read only with
  `AGENTIC_COMMENTS_UNSAFE_STATIC_TOKENS=1`, and it is tried after the identity credentials. A Worker that sets the list
  without the switch answers `503 NOT_CONFIGURED`. To migrate: issue identity credentials (`issueCredential`), or set the
  switch for a dev setup. `createApp` with your own `auth` is not affected.
- `CommentsDocs` exposes its `store`. The `agentic-identity` dependency is now `^0.7.0`.

## 0.5.1

### Changed

- **Breaking:** a token or a principal name that 0.5.0 accepted can now be refused. A token in `AGENTIC_COMMENTS_TOKENS`
  is 32 to 512 bytes, from A-Z a-z 0-9 `_` `-`, so a base64 token with `+` or `/` is refused. A principal name starts with
  A-Z a-z 0-9 `_` `-`, then uses A-Z a-z 0-9 `.` `_` `-`, and is at most 128 characters. A name such as `ada@example.com` is refused.
  One bad token or name refuses the whole token table, and every `/api/v1` request then gets `401`. The CLI and the MCP server
  refuse a principal name outside this grammar. Check your tokens and names before you upgrade.
- **Breaking:** the `Authorization` header is checked before your `Auth` runs. A header that is not `Bearer` followed by
  1 to 512 bytes of A-Z a-z 0-9 `_` `-` gets `401`. This applies to a custom `Auth` too, so a JWT, which contains `.`, is refused.
- **Breaking:** a write (any method except `GET`, `HEAD`, and `OPTIONS`) that your `Auth` accepts with no `Authorization`
  header gets `403`, unless its `Origin` is listed in the new `origins` option of `createApp`. The default lists no origins.
  A host that signs writes with a session cookie must pass `origins`. Before, the Worker did not check the origin.
- **Breaking:** a custom `Auth` that throws now returns `503`, not `500`, with the code `INTERNAL`. Alerts keyed on `500` must change.
- The auth and principal code now uses `agentic-identity` 0.6. The Worker resolves the caller with `requirePrincipal` from
  `agentic-identity/http`. The token table and the operator principal both go through `parsePrincipal`.

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
