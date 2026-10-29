#!/usr/bin/env node
import { FileStore, lockTimeoutFrom } from "./file-store.js";
import { operatorActor } from "./operator.js";
import { startMcp } from "./mcp.js";

/** Start the server from the environment: AGENTIC_COMMENTS_FILE, AGENTIC_COMMENTS_AS, AGENTIC_COMMENTS_SCOPES. */
try {
  const env = process.env;
  await startMcp(new FileStore(env.AGENTIC_COMMENTS_FILE ?? "./comments.ydoc", { lockTimeoutMs: lockTimeoutFrom(env) }), operatorActor(env.AGENTIC_COMMENTS_AS, env.AGENTIC_COMMENTS_SCOPES));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
