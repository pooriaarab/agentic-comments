#!/usr/bin/env node
import { CommentsError } from "./errors.js";
import { FileStore, lockTimeoutFrom } from "./file-store.js";
import { operatorActor } from "./operator.js";
import { startMcp } from "./mcp.js";
import { VERSION } from "./version.js";

const MCP_HELP = `agentic-comments-mcp ${VERSION}

Start the MCP server on stdio. Set the principal and scopes in the environment, or pass --as:

  --as kind:name                          The principal. Overrides AGENTIC_COMMENTS_AS.
  AGENTIC_COMMENTS_AS=kind:name           Required unless --as is set. For example agent_of_human:scribe.
  AGENTIC_COMMENTS_SCOPES=a,b             Optional. A comma list, such as comments:accept.
  AGENTIC_COMMENTS_FILE=./comments.ydoc   The store file. The default is ./comments.ydoc.
  AGENTIC_COMMENTS_LOCK_TIMEOUT_MS=5000   How long a write waits for another process.

Usage: agentic-comments-mcp [--as kind:name] [--help | --version]`;

const args = process.argv.slice(2);
// A value right after `--as` is a principal, never a flag, so `--as -h` does not print help.
const flags = args.filter((arg, i) => args[i - 1] !== "--as");
if (flags.includes("--help") || flags.includes("-h")) {
  console.log(MCP_HELP);
} else if (flags.includes("--version") || flags.includes("-V") || flags.includes("-v")) {
  console.log(VERSION);
} else {
  // `--as` is one flag with a separate value, as in the CLI. A repeated `--as`, or `--as=...`, is refused, never guessed.
  const asFlags = args.filter((arg) => arg === "--as" || arg.startsWith("--as="));
  if (asFlags.length > 1 || (asFlags[0] !== undefined && asFlags[0] !== "--as")) {
    console.error(JSON.stringify({ error: { code: "USAGE", message: "give --as once, as --as kind:name" } }));
    process.exit(2);
  }
  /** Start the server from the environment: AGENTIC_COMMENTS_FILE, AGENTIC_COMMENTS_AS, AGENTIC_COMMENTS_SCOPES. `--as` overrides AGENTIC_COMMENTS_AS, as in the CLI. */
  try {
    const env = process.env;
    const asAt = args.indexOf("--as");
    // A bare `--as` with no value is refused by name, and never falls back to the variable.
    if (asAt !== -1 && args[asAt + 1] === undefined) throw new CommentsError("INVALID_AUTHOR", "--as needs a value, as --as kind:name");
    const as = asAt === -1 ? env.AGENTIC_COMMENTS_AS : args[asAt + 1];
    await startMcp(new FileStore(env.AGENTIC_COMMENTS_FILE ?? "./comments.ydoc", { lockTimeoutMs: lockTimeoutFrom(env) }), operatorActor(as, env.AGENTIC_COMMENTS_SCOPES));
  } catch (error) {
    console.error(JSON.stringify({ error: { code: (error as { code?: string }).code ?? "INTERNAL", message: error instanceof Error ? error.message : String(error) } }));
    process.exit(1);
  }
}
