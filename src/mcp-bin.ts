#!/usr/bin/env node
import { FileStore, lockTimeoutFrom } from "./file-store.js";
import { operatorActor } from "./operator.js";
import { startMcp } from "./mcp.js";
import { VERSION } from "./version.js";

const MCP_HELP = `agentic-comments-mcp ${VERSION}

Start the MCP server on stdio. Set the principal and scopes in the environment:

  AGENTIC_COMMENTS_AS=kind:name           Required. For example agent_of_human:scribe.
  AGENTIC_COMMENTS_SCOPES=a,b             Optional. A comma list, such as comments:accept.
  AGENTIC_COMMENTS_FILE=./comments.ydoc   The store file. The default is ./comments.ydoc.
  AGENTIC_COMMENTS_LOCK_TIMEOUT_MS=5000   How long a write waits for another process.

Usage: agentic-comments-mcp [--help | --version]`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(MCP_HELP);
} else if (args.includes("--version") || args.includes("-V") || args.includes("-v")) {
  console.log(VERSION);
} else {
  /** Start the server from the environment: AGENTIC_COMMENTS_FILE, AGENTIC_COMMENTS_AS, AGENTIC_COMMENTS_SCOPES. */
  try {
    const env = process.env;
    await startMcp(new FileStore(env.AGENTIC_COMMENTS_FILE ?? "./comments.ydoc", { lockTimeoutMs: lockTimeoutFrom(env) }), operatorActor(env.AGENTIC_COMMENTS_AS, env.AGENTIC_COMMENTS_SCOPES));
  } catch (error) {
    console.error(JSON.stringify({ error: { code: (error as { code?: string }).code ?? "INTERNAL", message: error instanceof Error ? error.message : String(error) } }));
    process.exit(1);
  }
}
