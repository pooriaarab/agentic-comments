#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { CommentsError } from "./errors.js";
import { FileStore, lockTimeoutFrom } from "./file-store.js";
import { TEXT_ROOT } from "./local-host.js";
import { operatorActor } from "./operator.js";
import { CommentsService, type AnchorSpec } from "./service.js";
import { VERSION } from "./version.js";

class UsageError extends Error {}

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  env: Record<string, string | undefined>;
}

const FLAGS: Record<string, "value" | "many"> = {
  "--file": "value",
  "--as": "value",
  "--body": "value",
  "--mention": "many",
  "--text-quote": "value",
  "--occurrence": "value",
  "--cell": "value",
  "--slide": "value",
  "--canvas": "value",
  "--replace": "value",
  "--value": "value",
  "--summary": "value",
  "--status": "value",
  "--anchor-state": "value",
  "--mentioning": "value",
  "--text": "value",
  "--text-file": "value",
};

const SHARED = ["--file", "--as"];
const ANCHOR = ["--text-quote", "--occurrence", "--cell", "--slide", "--canvas"];
const ALLOWED: Record<string, string[]> = {
  init: ["--file", "--text", "--text-file"],
  list: [...SHARED, "--status", "--anchor-state", "--mentioning"],
  show: SHARED,
  comment: [...SHARED, ...ANCHOR, "--body", "--mention"],
  reply: [...SHARED, "--body", "--mention"],
  resolve: SHARED,
  reopen: SHARED,
  relocate: SHARED,
  suggestions: [...SHARED, "--status", "--anchor-state"],
  suggest: [...SHARED, ...ANCHOR, "--replace", "--value", "--summary"],
  accept: SHARED,
  reject: SHARED,
  mcp: SHARED,
};
const TAKES_ID = ["show", "reply", "resolve", "reopen", "relocate", "accept", "reject"];

const COMMANDS = ["init", "list", "show", "comment", "reply", "resolve", "reopen", "relocate", "suggestions", "suggest", "accept", "reject", "mcp"];

interface Parsed {
  command: string;
  id?: string;
  flags: Record<string, string>;
  many: Record<string, string[]>;
}

export function parseArgs(argv: string[]): Parsed {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") return { command: "help", flags: {}, many: {} };
  if (command === "--version" || command === "-V") return { command: "version", flags: {}, many: {} };
  if (!COMMANDS.includes(command)) throw new UsageError(`unknown command "${command}"`);
  const parsed: Parsed = { command, flags: {}, many: {} };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) {
      if (parsed.id !== undefined) throw new UsageError(`unexpected argument "${arg}"`);
      parsed.id = arg;
      continue;
    }
    const kind = FLAGS[arg];
    if (!kind) throw new UsageError(`unknown flag "${arg}"`);
    const value = rest[++i];
    if (value === undefined) throw new UsageError(`${arg} needs a value`);
    if (kind === "many") (parsed.many[arg] ??= []).push(value);
    else if (arg in parsed.flags) throw new UsageError(`${arg} was given twice`);
    else parsed.flags[arg] = value;
  }
  const used = [...Object.keys(parsed.flags), ...Object.keys(parsed.many)];
  const stray = used.find((f) => !ALLOWED[command].includes(f));
  if (stray) throw new UsageError(`${stray} does not apply to ${command}`);
  if (parsed.id !== undefined && !TAKES_ID.includes(command)) throw new UsageError(`${command} takes no id`);
  if (parsed.flags["--text"] !== undefined && parsed.flags["--text-file"] !== undefined) throw new UsageError("give only one of --text, --text-file");
  const occurrence = parsed.flags["--occurrence"];
  if (occurrence !== undefined && !/^[1-9]\d{0,8}$/.test(occurrence)) throw new UsageError("--occurrence must be a whole number, 1 or more");
  return parsed;
}

function anchorOf(p: Parsed): AnchorSpec {
  const given = (["--text-quote", "--cell", "--slide", "--canvas"] as const).filter((f) => p.flags[f] !== undefined);
  if (given.length !== 1) throw new UsageError("give exactly one of --text-quote, --cell, --slide, --canvas");
  const f = given[0];
  if (f === "--text-quote") {
    const occurrence = p.flags["--occurrence"];
    return { type: "text", quote: p.flags[f], ...(occurrence === undefined ? {} : { occurrence: Number(occurrence) }) };
  }
  return f === "--cell" ? { type: "cell", key: p.flags[f] } : { type: f === "--slide" ? "slide" : "canvas", elementId: p.flags[f] };
}

function changeOf(p: Parsed): unknown {
  const { "--replace": replace, "--value": value } = p.flags;
  if ((replace === undefined) === (value === undefined)) throw new UsageError("give exactly one of --replace, --value");
  if (replace !== undefined) return { replace };
  try {
    return { value: JSON.parse(value as string) };
  } catch {
    throw new UsageError("--value must be JSON");
  }
}

function need(p: Parsed): string {
  if (p.id === undefined) throw new UsageError(`${p.command} needs an id`);
  return p.id;
}

const HELP = `agentic-comments ${VERSION}
Comment threads and suggestions anchored to any content, from people and agents.

Usage: agentic-comments <command> [flags]

Setup:
  --file <path>     The store file. Or AGENTIC_COMMENTS_FILE. Default ./comments.ydoc.
  --as <kind:name>  Who acts. Or AGENTIC_COMMENTS_AS. Kinds: human, agent_of_human, agent_of_agent, agent, user_token.
  Scopes come only from AGENTIC_COMMENTS_SCOPES, a comma list such as comments:accept.

Commands:
  init [--text <t> | --text-file <p>]         Create the store.
  list [--status s] [--anchor-state s] [--mentioning h]   List threads.
  show <id>                                   Show one thread.
  comment <anchor> --body <t> [--mention h]   Start a thread.
  reply <id> --body <t> [--mention h]         Reply.
  resolve <id> | reopen <id> | relocate <id>
  suggestions [--status s] [--anchor-state s] List suggestions.
  suggest <anchor> (--replace <t> | --value <json>) [--summary <t>]
  accept <id> | reject <id>
  mcp                                         Start the MCP server on stdio.

An anchor is one of: --text-quote <q> [--occurrence n], --cell <key>, --slide <id>, --canvas <id>.
Every result is JSON. An error is JSON on stderr, and the exit code is 1. A usage error exits 2.`;

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let p: Parsed;
  try {
    p = parseArgs(argv);
  } catch (error) {
    io.err(JSON.stringify({ error: { code: "USAGE", message: (error as Error).message } }));
    return 2;
  }
  if (p.command === "help") return io.out(HELP), 0;
  if (p.command === "version") return io.out(VERSION), 0;
  try {
    const store = new FileStore(p.flags["--file"] ?? io.env.AGENTIC_COMMENTS_FILE ?? "./comments.ydoc", { lockTimeoutMs: lockTimeoutFrom(io.env) });
    if (p.command === "init") {
      const seed = p.flags["--text-file"] !== undefined ? readFileSync(p.flags["--text-file"], "utf8") : (p.flags["--text"] ?? "");
      store.create((ydoc) => ydoc.getText(TEXT_ROOT).insert(0, seed));
      io.out(JSON.stringify({ created: store.path }));
      return 0;
    }
    if (p.command === "mcp") {
      const { startMcp } = await import("./mcp.js");
      await startMcp(store, operatorActor(p.flags["--as"] ?? io.env.AGENTIC_COMMENTS_AS, io.env.AGENTIC_COMMENTS_SCOPES));
      return 0;
    }
    const service = new CommentsService(store, operatorActor(p.flags["--as"] ?? io.env.AGENTIC_COMMENTS_AS, io.env.AGENTIC_COMMENTS_SCOPES));
    const mentions = p.many["--mention"];
    const filter = { status: p.flags["--status"], anchorState: p.flags["--anchor-state"], mentioning: p.flags["--mentioning"] };
    const clean = Object.fromEntries(Object.entries(filter).filter(([, v]) => v !== undefined));
    const result =
      p.command === "list" ? service.threads(clean)
      : p.command === "show" ? service.thread(need(p))
      : p.command === "comment" ? service.comment({ anchor: anchorOf(p), body: p.flags["--body"], ...(mentions ? { mentions } : {}) })
      : p.command === "reply" ? service.reply(need(p), { body: p.flags["--body"], ...(mentions ? { mentions } : {}) })
      : p.command === "resolve" ? service.resolve(need(p))
      : p.command === "reopen" ? service.reopen(need(p))
      : p.command === "relocate" ? service.relocate(need(p))
      : p.command === "suggestions" ? service.suggestions(Object.fromEntries(Object.entries(clean).filter(([k]) => k !== "mentioning")))
      : p.command === "suggest" ? service.suggest({ anchor: anchorOf(p), change: changeOf(p), ...(p.flags["--summary"] === undefined ? {} : { summary: p.flags["--summary"] }) })
      : p.command === "accept" ? service.accept(need(p))
      : service.reject(need(p));
    io.out(JSON.stringify(result));
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(JSON.stringify({ error: { code: "USAGE", message: error.message } }));
      return 2;
    }
    if (error instanceof CommentsError) {
      io.err(JSON.stringify({ error: { code: error.code, message: error.message } }));
      return error.code === "USAGE" ? 2 : 1;
    }
    throw error;
  }
}

function isMainModule(): boolean {
  const invoked = process.argv[1];
  if (typeof invoked !== "string") return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(invoked)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runCli(process.argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l), env: process.env }).then(
    (code) => {
      // A running server (mcp) must keep its stdio handles, so exit only on failure.
      if (code !== 0) process.exit(code);
    },
    (error: unknown) => {
      console.error(JSON.stringify({ error: { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) } }));
      process.exit(1);
    },
  );
}
