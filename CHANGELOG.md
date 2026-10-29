# Changelog

Versions follow semantic versioning. Before 1.0, a minor release can change the API.

## 0.2.0

### Added

- A CLI, `agentic-comments`, over a local store file. Its commands are `init`, `list`, `show`, `comment`,
  `reply`, `resolve`, `reopen`, `relocate`, `suggestions`, `suggest`, `accept`, `reject`, `mcp`, `help`, and
  `version`. Store commands return JSON. `help` and `version` print plain text.
- An MCP server, started with `agentic-comments mcp` or the `agentic-comments-mcp` binary. Its tools are
  `list_threads`, `get_thread`, `add_comment`, `reply_to_thread`, `resolve_thread`, `reopen_thread`,
  `relocate_thread`, `list_suggestions`, `suggest_change`, `accept_suggestion`, and `reject_suggestion`. The operator sets the
  principal and the scopes when the server starts.
- A notification stream: `new Notifications(comments, suggestions)` with `subscribe(listener)`. Events hold
  ids and never text. The same change has the same event `id` on every replica.

### Changed

- **Breaking:** `yjs` is a peer dependency now, not a regular dependency. Install `yjs` next to this
  package, and use the same copy that your app uses. The package checks the Yjs types of your document, so
  it needs that copy.

### Fixed

- `prepack` builds `dist` before a pack. A clean `npm pack` or `npm publish` no longer ships missing or
  stale output.

## 0.1.0

The first release. Threads, suggestions, and anchor survival, as a library.
