import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, describe, expect, test } from "vitest";
import { FileStore, MAX_FILE, TEXT_ROOT } from "./local.js";

// Ways the CLI and the MCP server can fail, written before the tests. Each runs the real built program.
//  0. A lock timeout that is not a number makes a write wait for ever, or a lock it cannot read spins.
//  0b. A zero-filled file loads as empty and the next write erases it, or a save grows a file past what loads.
//  0c. Two processes clear one stale lock together, or run init together, and a write or a store is lost.
//  0d. A flag that does not apply to a command is dropped without a word.
//  0e. A write stops short on a full disk and a cut-off file replaces the store as if all went well.
//  0f. An MCP input error is plain text, a nested key is dropped, or a bad change is changed into a good one.
//  0g. A change of the wrong kind for its anchor waits until accept to fail. A quote error repeats document text.
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
    const late = cli(file, ["reply", made.id, "--body", "late"], "human:ada");
    expect([late.code, json(late).error.code]).toEqual([1, "THREAD_RESOLVED"]);
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


describe("the store under stress", () => {
  test("a lock timeout that is not a whole number is refused, and never waits for ever", () => {
    const file = fresh();
    writeFileSync(`${file}.lock`, String(process.pid));
    for (const value of ["abc", "5s", "", "-1", "1.5"]) {
      const run = spawnSync("node", [dist("cli.js"), "list"], { env: { ...env(file, "human:ada"), AGENTIC_COMMENTS_LOCK_TIMEOUT_MS: value }, encoding: "utf8", timeout: 5_000 });
      expect([run.status, JSON.parse(run.stderr).error.code]).toEqual([2, "USAGE"]);
    }
    const server = spawnSync("node", [dist("mcp-bin.js")], { env: { ...env(file, "human:ada"), AGENTIC_COMMENTS_LOCK_TIMEOUT_MS: "abc" }, encoding: "utf8", timeout: 5_000 });
    expect(server.status).toBe(1);
    expect(server.stderr).toContain("whole number");
  });

  test("a lock that cannot be read as a file fails fast and does not spin", () => {
    const file = fresh();
    mkdirSync(`${file}.lock`);
    const started = Date.now();
    const run = cli(file, ["comment", "--cell", "A1", "--body", "x"], "human:ada");
    expect([run.code, json(run).error.code]).toEqual([1, "STORE_LOCKED"]);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  test("a zero-filled or cut-off store is refused, and the next write does not erase it", () => {
    const file = fresh();
    const good = readFileSync(file);
    for (const bytes of [Buffer.alloc(200), good.subarray(0, good.length - 3), Buffer.concat([good, Buffer.from([1])])]) {
      writeFileSync(file, bytes);
      for (const args of [["list"], ["comment", "--cell", "A1", "--body", "x"]]) {
        const run = cli(file, args, "human:ada");
        expect([run.code, json(run).error.code]).toEqual([1, "STORE_CORRUPT"]);
      }
      expect(readFileSync(file).equals(bytes)).toBe(true);
    }
  });

  test("a save that would pass the size limit is refused and writes nothing, and so is a create", () => {
    const file = fresh();
    const before = readFileSync(file);
    const store = new FileStore(file);
    expect(() => store.write((ydoc) => ydoc.getText(TEXT_ROOT).insert(0, "x".repeat(MAX_FILE + 1)))).toThrow(/STORE_FULL|would pass/);
    expect(readFileSync(file).equals(before)).toBe(true);
    const big = join(dir, "big.ydoc");
    expect(() => new FileStore(big).create((ydoc) => ydoc.getText(TEXT_ROOT).insert(0, "x".repeat(MAX_FILE + 1)))).toThrow(/larger than/);
    expect(existsSync(big)).toBe(false);
    expect(json(cli(file, ["list"], "human:ada"))).toEqual([]);
  });

  test("six processes that meet one stale lock all write, and none is lost", async () => {
    const file = fresh();
    const made = json(cli(file, ["comment", "--cell", "A1", "--body", "start"], "human:ada"));
    writeFileSync(`${file}.lock`, "2147483646");
    const runs = await Promise.all(Array.from({ length: 6 }, (_, i) => cliAsync(file, ["reply", made.id, "--body", `reply ${i}`], "agent:bot")));
    expect(runs.map((r) => r.code)).toEqual(Array(6).fill(0));
    expect(json(cli(file, ["show", made.id], "human:ada")).messages).toHaveLength(7);
  });

  test("an empty lock is cleared once it is old", () => {
    const file = fresh();
    writeFileSync(`${file}.lock`, "");
    expect(json(cli(file, ["comment", "--cell", "A1", "--body", "x"], "human:ada")).error?.code).toBe("STORE_LOCKED");
    writeFileSync(`${file}.lock`, "");
    const old = new Date(Date.now() - 10_000);
    utimesSync(`${file}.lock`, old, old);
    expect(cli(file, ["comment", "--cell", "A1", "--body", "x"], "human:ada").code).toBe(0);
  });

  test("six inits at once make one store and refuse the rest", async () => {
    const file = join(dir, `race-${count++}.ydoc`);
    const runs = await Promise.all(Array.from({ length: 6 }, (_, i) => cliAsync(file, ["init", "--text", `seed ${i}`], "human:ada")));
    expect(runs.filter((r) => r.code === 0)).toHaveLength(1);
    expect(runs.filter((r) => r.code === 1).every((r) => JSON.parse(r.err).error.code === "STORE_EXISTS")).toBe(true);
  });

  test("a flag that does not apply is refused, and so are both seed flags and a stray id", () => {
    const file = fresh();
    for (const args of [["accept", "x", "--replace", "y"], ["list", "--body", "x"], ["list", "extra"], ["init", "--text", "a", "--text-file", "b"], ["comment", "--cell", "A1", "--body", "x", "--status", "open"], ["comment", "--text-quote", "a", "--occurrence", "0", "--body", "x"]]) {
      const run = cli(file, args, "human:ada");
      expect([run.code, json(run).error.code]).toEqual([2, "USAGE"]);
    }
  });

  test("an ambiguous quote gives a short error however many places match", () => {
    const file = fresh("a ".repeat(20_000));
    const run = cli(file, ["comment", "--text-quote", "a", "--body", "x"], "human:ada");
    expect(json(run).error.message.length).toBeLessThan(900);
    expect(json(run).error.message).toContain("20000 places");
  });
});

describe("the store under stress 2", () => {
  test("a write that hits a file size limit fails with STORE_FULL, leaves the store whole, and leaves no temp files", () => {
    const file = fresh();
    const made = json(cli(file, ["comment", "--cell", "A1", "--body", "first"], "human:ada"));
    const before = readFileSync(file);
    const limit = Math.ceil(before.length / 1024) + 1;
    const run = spawnSync("bash", ["-c", `ulimit -f ${limit}; exec node "$0" "$@"`, dist("cli.js"), "comment", "--cell", "B2", "--body", "y".repeat(9_000)], { env: env(file, "human:ada"), encoding: "utf8" });
    expect([run.status, JSON.parse(run.stderr).error.code]).toEqual([1, "STORE_FULL"]);
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(readdirSync(dir).filter((n) => n.startsWith(`${file.split("/").pop()}.tmp-`))).toEqual([]);
    expect(json(cli(file, ["show", made.id], "human:ada")).messages).toHaveLength(1);
  });

  test("a lock that is no longer ours is not removed when a write ends", () => {
    const file = fresh();
    const store = new FileStore(file, { lockTimeoutMs: 0 });
    store.write(() => {
      writeFileSync(`${file}.lock`, "999:someone-else");
    });
    expect(readFileSync(`${file}.lock`, "utf8")).toBe("999:someone-else");
  });

  test("a change of the wrong kind for its anchor is refused when it is suggested", () => {
    const file = fresh();
    for (const args of [["--text-quote", "hello", "--value", "1"], ["--cell", "A1", "--replace", "x"]]) {
      const run = cli(file, ["suggest", ...args], "agent:bot");
      expect([run.code, json(run).error.code]).toEqual([1, "INVALID_INPUT"]);
    }
    expect(json(cli(file, ["suggestions"], "human:ada"))).toEqual([]);
  });

  test("a repeated quote error gives offsets and counts, and no document text", () => {
    const file = fresh("secret one, secret two");
    const message = json(cli(file, ["comment", "--text-quote", "secret", "--body", "x"], "human:ada")).error.message;
    expect(message).toContain("offsets 0, 12");
    expect(message).not.toContain("one");
  });
});


describe("locks and paths", () => {
  test("a lock with this process id and another mark is cleared, and a live lock that is old is cleared", () => {
    const file = fresh();
    writeFileSync(`${file}.lock`, `${process.pid}:left-by-a-crashed-run`);
    expect(new FileStore(file, { lockTimeoutMs: 0 }).write(() => "ok")).toBe("ok");
    writeFileSync(`${file}.lock`, String(process.pid));
    const old = new Date(Date.now() - 120_000);
    utimesSync(`${file}.lock`, old, old);
    expect(cli(file, ["comment", "--cell", "A1", "--body", "x"], "human:ada").code).toBe(0);
  });

  test("a live lock that is new still blocks", () => {
    const file = fresh();
    writeFileSync(`${file}.lock`, `${process.pid}:${"a".repeat(8)}`);
    const run = cli(file, ["comment", "--cell", "A1", "--body", "x"], "human:ada");
    expect([run.code, json(run).error.code]).toEqual([1, "STORE_LOCKED"]);
  });

  test("a symlink as the store path is followed, and stays a symlink", () => {
    const file = fresh();
    const link = join(dir, `link-${count++}.ydoc`);
    symlinkSync(file, link);
    expect(json(cli(link, ["comment", "--cell", "A1", "--body", "via link"], "human:ada")).messages).toHaveLength(1);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(json(cli(file, ["list"], "human:ada"))).toHaveLength(1);
  });

  test("a full disk while a lock is written is STORE_FULL and leaves no lock", () => {
    const file = fresh();
    const run = spawnSync("bash", ["-c", `ulimit -f 0; exec node "$0" "$@"`, dist("cli.js"), "comment", "--cell", "B2", "--body", "y"], { env: env(file, "human:ada"), encoding: "utf8" });
    expect([run.status, JSON.parse(run.stderr).error.code]).toEqual([1, "STORE_FULL"]);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  test("the standalone MCP binary survives a file size limit", async () => {
    const file = fresh();
    const before = readFileSync(file);
    const limit = Math.ceil(before.length / 1024) + 1;
    const transport = new StdioClientTransport({ command: "bash", args: ["-c", `ulimit -f ${limit}; exec node "$0"`, dist("mcp-bin.js")], env: Object.fromEntries(Object.entries(env(file, "human:ada")).filter(([, v]) => v !== undefined)) as Record<string, string> });
    const client = new Client({ name: "test", version: "1" });
    await client.connect(transport);
    const r = (await client.callTool({ name: "add_comment", arguments: { anchor: { type: "cell", key: "A1" }, body: "z".repeat(9_000) } })) as { isError?: boolean; content: { text: string }[] };
    expect([r.isError, JSON.parse(r.content[0].text).error.code]).toEqual([true, "STORE_FULL"]);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    expect(readFileSync(file).equals(before)).toBe(true);
    await client.close();
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

  test("a message names the principal the operator set, and a tool call that names an author is refused", async () => {
    const client = await connect(fresh(), "agent_of_human:scribe");
    const claimed = (await client.callTool({ name: "add_comment", arguments: { anchor: { type: "cell", key: "A1" }, body: "hi", author: { kind: "human", name: "boss" } } })) as { isError?: boolean };
    expect(claimed.isError).toBe(true);
    const made = await call(client, "add_comment", { anchor: { type: "cell", key: "A1" }, body: "hi" });
    expect(made.value.messages[0].author).toEqual({ kind: "agent_of_human", name: "scribe" });
    const sneaky = (await client.callTool({ name: "reply_to_thread", arguments: { id: made.value.id, body: "again", author: "human:boss" } })) as { isError?: boolean };
    expect(sneaky.isError).toBe(true);
    expect((await call(client, "get_thread", { id: made.value.id })).value.messages).toHaveLength(1);
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

  test("a mutating action returns the same shape over both faces, and so does an error", async () => {
    const strip = (v: unknown): unknown =>
      JSON.parse(JSON.stringify(v, (key, value: unknown) => (key === "id" || key === "client" || key === "clock" || key === "at" || key === "statusAt" || key === "createdAt" || key === "decidedAt" ? "-" : value)));
    const a = fresh();
    const b = fresh();
    const client = await connect(b, "agent_of_human:scribe");
    const comment = json(cli(a, ["comment", "--cell", "A1", "--body", "hi @ada"], "agent_of_human:scribe"));
    const viaMcp = await call(client, "add_comment", { anchor: { type: "cell", key: "A1" }, body: "hi @ada" });
    expect(strip(viaMcp.value)).toEqual(strip(comment));
    const reply = json(cli(a, ["reply", comment.id, "--body", "more"], "agent_of_human:scribe"));
    expect(strip((await call(client, "reply_to_thread", { id: viaMcp.value.id, body: "more" })).value)).toEqual(strip(reply));
    const suggestion = json(cli(a, ["suggest", "--text-quote", "brave new", "--replace", "bold fresh", "--summary", "tone"], "agent_of_human:scribe"));
    const viaSuggest = await call(client, "suggest_change", { anchor: { type: "text", quote: "brave new" }, change: { replace: "bold fresh" }, summary: "tone" });
    expect(strip(viaSuggest.value)).toEqual(strip(suggestion));
    const missing = cli(a, ["resolve", "nope"], "human:ada");
    const viaError = await call(await connect(b, "human:ada"), "resolve_thread", { id: "nope" });
    expect(viaError.value.error.code).toBe(json(missing).error.code);
    await client.close();
  });


  test("an input error is JSON with a code, over the same codes as the CLI, and nested keys and mixed changes are refused", async () => {
    const client = await connect(fresh(), "agent:bot");
    const refuse = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      return { isError: r.isError, error: JSON.parse(r.content[0].text).error };
    };
    for (const [name, args] of [
      ["list_threads", { status: "bogus" }],
      ["list_threads", { author: { kind: "human", name: "boss" } }],
      ["add_comment", { anchor: { type: "cell", key: "k", author: "x" }, body: "hi" }],
      ["add_comment", { anchor: { type: "cell" }, body: "hi" }],
      ["suggest_change", { anchor: { type: "cell", key: "k" }, change: { value: 2, extra: 1 } }],
      ["suggest_change", { anchor: { type: "cell", key: "k" }, change: { replace: 5, value: 1 } }],
    ] as const) {
      const r = await refuse(name, args as Record<string, unknown>);
      expect([r.isError, r.error.code]).toEqual([true, "INVALID_INPUT"]);
    }
    expect((await call(client, "list_suggestions", {})).value).toEqual([]);
    await client.close();
  });

  test("it refuses to start with no principal", () => {
    const run = spawnSync("node", [dist("mcp-bin.js")], { env: env(fresh()), encoding: "utf8", timeout: 5_000 });
    expect(run.status).toBe(1);
    expect(JSON.parse(run.stderr).error.message).toContain("kind:name");
  });
});
