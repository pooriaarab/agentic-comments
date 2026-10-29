import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, describe, expect, test } from "vitest";
import { FileStore, TEXT_ROOT } from "./local.js";

// Ways the CLI and the MCP server can fail, written before the tests. Each runs the real built program.
//  1. A call acts with no principal, a bad kind, or an author or scope the caller picked.
//  2. init overwrites a store, or another command invents a store that is not there.
//  3. Two processes write at once and one write is lost.
//  4. A lock left by a live process is stolen, or one left by a dead process blocks for good.
//  5. A damaged store file is read as empty, or overwritten.
//  6. An agent accepts with no scope, or its own suggestion, through either face.
//  7. An accept runs twice, or a repeat accept changes the text again.
//  8. An ambiguous or missing quote anchors to a guess.
//  9. A tool takes an author, or a tool input changes who a message names.
// 10. The two faces return different shapes for the same action.

const dist = (file: string) => join(process.cwd(), "dist", file);
const dir = mkdtempSync(join(tmpdir(), "agentic-comments-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let count = 0;
const fresh = (text = "hello brave world, brave new world") => {
  const file = join(dir, `store-${count++}.ydoc`);
  const made = cli(file, ["init", "--text", text], "human:ada");
  expect(made.code).toBe(0);
  return file;
};

interface Run {
  code: number | null;
  out: string;
  err: string;
}

function env(file: string, as?: string, scopes?: string): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env, AGENTIC_COMMENTS_FILE: file, AGENTIC_COMMENTS_LOCK_TIMEOUT_MS: "400" };
  delete base.AGENTIC_COMMENTS_AS;
  delete base.AGENTIC_COMMENTS_SCOPES;
  if (as) base.AGENTIC_COMMENTS_AS = as;
  if (scopes) base.AGENTIC_COMMENTS_SCOPES = scopes;
  return base;
}

function cli(file: string, args: string[], as?: string, scopes?: string): Run {
  const r = spawnSync("node", [dist("cli.js"), ...args], { env: env(file, as, scopes), encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const json = (run: Run) => JSON.parse(run.code === 0 ? run.out : run.err);

function cliAsync(file: string, args: string[], as: string): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn("node", [dist("cli.js"), ...args], { env: env(file, as) });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stderr.on("data", (d: Buffer) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

describe("the command line", () => {
  test("a call with no principal, a bad kind, or a picked author or scope is refused", () => {
    const file = fresh();
    expect(json(cli(file, ["list"])).error.code).toBe("INVALID_AUTHOR");
    expect(json(cli(file, ["list"], "root:eve")).error.code).toBe("INVALID_AUTHOR");
    expect(json(cli(file, ["list"], "human")).error.code).toBe("INVALID_AUTHOR");
    const picked = cli(file, ["comment", "--cell", "A1", "--body", "x", "--author", "human:boss"], "agent:bot");
    expect([picked.code, json(picked).error.code]).toEqual([2, "USAGE"]);
    const scope = cli(file, ["accept", "x", "--scope", "comments:accept"], "agent:bot");
    expect([scope.code, json(scope).error.code]).toEqual([2, "USAGE"]);
    expect(json(cli(file, ["list"], "human:ada"))).toEqual([]);
  });

  test("init refuses to overwrite, and other commands refuse a missing store", () => {
    const file = fresh();
    expect(json(cli(file, ["init"], "human:ada")).error.code).toBe("STORE_EXISTS");
    expect(json(cli(join(dir, "missing.ydoc"), ["list"], "human:ada")).error.code).toBe("STORE_MISSING");
  });

  test("a thread goes from comment to reply to resolve to reopen, and each message keeps its kind", () => {
    const file = fresh();
    const made = json(cli(file, ["comment", "--text-quote", "brave", "--occurrence", "2", "--body", "check @grace", "--mention", "scribe"], "human:ada"));
    expect(made.anchor.type).toBe("text");
    expect(made.messages[0].mentions).toEqual(["grace", "scribe"]);
    const reply = json(cli(file, ["reply", made.id, "--body", "done"], "agent_of_human:scribe"));
    expect(reply.author).toEqual({ kind: "agent_of_human", name: "scribe" });
    expect(json(cli(file, ["resolve", made.id], "human:ada")).status).toBe("resolved");
    expect(json(cli(file, ["reply", made.id, "--body", "late"], "human:ada")).error?.code ?? cli(file, ["reply", made.id, "--body", "late"], "human:ada").code).toBeTruthy();
    expect(json(cli(file, ["reopen", made.id], "human:ada")).status).toBe("open");
    const shown = json(cli(file, ["show", made.id], "human:ada"));
    expect(shown.messages.map((m: { author: { kind: string } }) => m.author.kind)).toEqual(["human", "agent_of_human"]);
    expect(json(cli(file, ["list", "--status", "open", "--mentioning", "grace"], "human:ada"))).toHaveLength(1);
  });

  test("eight processes that reply at once lose nothing", async () => {
    const file = fresh();
    const made = json(cli(file, ["comment", "--cell", "A1", "--body", "start"], "human:ada"));
    const runs = await Promise.all(Array.from({ length: 8 }, (_, i) => cliAsync(file, ["reply", made.id, "--body", `reply ${i}`], "agent:bot")));
    expect(runs.map((r) => r.code)).toEqual(Array(8).fill(0));
    const messages = json(cli(file, ["show", made.id], "human:ada")).messages.map((m: { body: string }) => m.body);
    expect(messages).toHaveLength(9);
    expect(new Set(messages).size).toBe(9);
  });

  test("a lock held by a live process blocks, and a lock left by a dead one is cleared", () => {
    const file = fresh();
    writeFileSync(`${file}.lock`, String(process.pid));
    const blocked = cli(file, ["comment", "--cell", "A1", "--body", "x"], "human:ada");
    expect([blocked.code, json(blocked).error.code]).toEqual([1, "STORE_LOCKED"]);
    expect(json(cli(file, ["list"], "human:ada"))).toEqual([]);
    writeFileSync(`${file}.lock`, "2147483646");
    expect(cli(file, ["comment", "--cell", "A1", "--body", "x"], "human:ada").code).toBe(0);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  test("a damaged store is refused and left as it was", () => {
    const file = fresh();
    writeFileSync(file, "this is not a document");
    const before = readFileSync(file);
    for (const args of [["list"], ["comment", "--cell", "A1", "--body", "x"]]) {
      const run = cli(file, args, "human:ada");
      expect([run.code, json(run).error.code]).toEqual([1, "STORE_CORRUPT"]);
    }
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  test("suggest and accept change the text once, and only a person or an agent with the scope may accept", () => {
    const file = fresh();
    const made = json(cli(file, ["suggest", "--text-quote", "brave new", "--replace", "bold fresh", "--summary", "tone"], "agent_of_human:scribe"));
    expect(made.status).toBe("pending");
    for (const [as, scopes] of [["agent:reviewer", undefined], ["agent_of_human:scribe", "comments:accept"], ["agent:scribe", "comments:accept"]] as const) {
      const refused = cli(file, ["accept", made.id], as, scopes);
      expect([refused.code, json(refused).error.code]).toEqual([1, "FORBIDDEN"]);
    }
    expect(json(cli(file, ["accept", made.id], "agent:reviewer", "comments:accept")).status).toBe("accepted");
    const again = json(cli(file, ["accept", made.id], "human:ada"));
    expect(again.status).toBe("accepted");
    expect(again.decidedBy).toEqual({ kind: "agent", name: "reviewer" });
    expect(new FileStore(file).read((ydoc) => ydoc.getText(TEXT_ROOT).toString())).toBe("hello brave world, bold fresh world");
    expect(json(cli(file, ["suggestions", "--status", "accepted"], "human:ada"))).toHaveLength(1);
  });

  test("a value suggestion on a cell is accepted by a person", () => {
    const file = fresh();
    const made = json(cli(file, ["suggest", "--cell", "B2", "--value", "{\"n\":7}"], "agent:bot"));
    expect(json(cli(file, ["reject", made.id], "agent:bot")).error.code).toBe("FORBIDDEN");
    expect(json(cli(file, ["accept", made.id], "human:ada")).status).toBe("accepted");
    expect(json(cli(file, ["suggest", "--cell", "B2", "--value", "{nope"], "agent:bot")).error.code).toBe("USAGE");
  });

  test("an ambiguous quote and a missing quote are refused, and an occurrence picks one", () => {
    const file = fresh();
    const many = cli(file, ["comment", "--text-quote", "brave", "--body", "x"], "human:ada");
    expect([many.code, json(many).error.code]).toEqual([1, "INVALID_ANCHOR"]);
    expect(json(many).error.message).toContain("2 places");
    expect(json(cli(file, ["comment", "--text-quote", "absent", "--body", "x"], "human:ada")).error.code).toBe("INVALID_ANCHOR");
    expect(json(cli(file, ["comment", "--text-quote", "brave", "--occurrence", "3", "--body", "x"], "human:ada")).error.code).toBe("INVALID_ANCHOR");
    expect(json(cli(file, ["comment", "--text-quote", "brave", "--occurrence", "1", "--body", "x"], "human:ada")).anchorState).toEqual({ state: "attached" });
  });

  test("content that is deleted orphans the thread, which stays listed and can relocate", () => {
    const file = fresh("hello brave world");
    const made = json(cli(file, ["comment", "--text-quote", "brave", "--body", "x"], "human:ada"));
    new FileStore(file).write((ydoc) => {
      const text = ydoc.getText(TEXT_ROOT);
      text.delete(6, 5);
      text.insert(6, "brave");
    });
    expect(json(cli(file, ["list", "--anchor-state", "orphaned"], "human:ada")).map((t: { id: string }) => t.id)).toEqual([made.id]);
    expect(json(cli(file, ["relocate", made.id], "agent:bot")).anchorState).toEqual({ state: "attached" });
  });

  test("help, version, and unknown commands behave", () => {
    const file = fresh();
    expect(cli(file, ["--help"]).out).toContain("Usage:");
    expect(cli(file, ["--version"]).out.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(cli(file, ["fly"]).code).toBe(2);
  });
});

describe("the MCP server", () => {
  async function connect(file: string, as: string, scopes?: string): Promise<Client> {
    const transport = new StdioClientTransport({ command: "node", args: [dist("mcp-bin.js")], env: Object.fromEntries(Object.entries(env(file, as, scopes)).filter(([, v]) => v !== undefined)) as Record<string, string> });
    const client = new Client({ name: "test", version: "1" });
    await client.connect(transport);
    return client;
  }
  const call = async (client: Client, name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { isError: r.isError === true, value: JSON.parse(r.content[0].text) };
  };

  test("it lists the tools, and none takes an author, a scope, or a principal", async () => {
    const client = await connect(fresh(), "agent:bot");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["accept_suggestion", "add_comment", "get_thread", "list_suggestions", "list_threads", "reject_suggestion", "relocate_thread", "reopen_thread", "reply_to_thread", "resolve_thread", "suggest_change"].sort(),
    );
    for (const tool of tools) expect(JSON.stringify(tool.inputSchema)).not.toMatch(/author|scope|principal|kind/i);
    await client.close();
  });

  test("a message names the principal the operator set, whatever the tool input says", async () => {
    const client = await connect(fresh(), "agent_of_human:scribe");
    const made = await call(client, "add_comment", { anchor: { type: "cell", key: "A1" }, body: "hi", author: { kind: "human", name: "boss" } });
    expect(made.isError).toBe(false);
    expect(made.value.messages[0].author).toEqual({ kind: "agent_of_human", name: "scribe" });
    const reply = await call(client, "reply_to_thread", { id: made.value.id, body: "again", author: "human:boss" });
    expect(reply.value.author).toEqual({ kind: "agent_of_human", name: "scribe" });
    await client.close();
  });

  test("an agent cannot accept without the scope, or its own suggestion, and a person's accept lands", async () => {
    const file = fresh();
    const agent = await connect(file, "agent_of_human:scribe");
    const made = await call(agent, "suggest_change", { anchor: { type: "text", quote: "brave new" }, change: { replace: "bold fresh" } });
    expect(made.isError).toBe(false);
    const refused = await call(agent, "accept_suggestion", { id: made.value.id });
    expect([refused.isError, refused.value.error.code]).toEqual([true, "FORBIDDEN"]);
    const scoped = await connect(file, "agent_of_human:scribe", "comments:accept");
    expect((await call(scoped, "accept_suggestion", { id: made.value.id })).value.error.code).toBe("FORBIDDEN");
    const person = await connect(file, "human:ada");
    expect((await call(person, "accept_suggestion", { id: made.value.id })).value.status).toBe("accepted");
    expect(new FileStore(file).read((ydoc) => ydoc.getText(TEXT_ROOT).toString())).toBe("hello brave world, bold fresh world");
    for (const c of [agent, scoped, person]) await c.close();
  });

  test("both faces return the same shape for the same action", async () => {
    const file = fresh();
    const viaCli = json(cli(file, ["comment", "--cell", "A1", "--body", "same"], "agent:bot"));
    const client = await connect(file, "agent:bot");
    const viaMcp = await call(client, "get_thread", { id: viaCli.id });
    expect(viaMcp.value).toEqual(viaCli);
    expect((await call(client, "list_threads", {})).value).toEqual(json(cli(file, ["list"], "agent:bot")));
    expect((await call(client, "get_thread", { id: "nope" })).value.error.code).toBe("NO_THREAD");
    await client.close();
  });

  test("it refuses to start with no principal", () => {
    const run = spawnSync("node", [dist("mcp-bin.js")], { env: env(fresh()), encoding: "utf8", timeout: 5_000 });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("kind:name");
  });
});
