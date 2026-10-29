// End to end: the real Worker under `wrangler dev` (workerd), with state kept on disk across a restart.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

const freePort = () =>
  new Promise<number>((done) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => done(port));
    });
  });

const ADA = `ada-${"a".repeat(40)}`;
const BOT = `bot-${"b".repeat(40)}`;
const BOSS = `boss-${"c".repeat(40)}`;
const TOKENS = { [ADA]: { as: "human:ada", scopes: ["comments:write"] }, [BOT]: "agent_of_human:scribe", [BOSS]: { as: "agent_of_human:boss", scopes: ["comments:admin"] } };

const dir = mkdtempSync(join(tmpdir(), "agentic-comments-worker-"));
const running: ChildProcess[] = [];
afterAll(() => {
  for (const child of running) if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
  rmSync(dir, { recursive: true, force: true });
});

async function start(vars: Record<string, string>): Promise<{ base: string; stop: () => Promise<void> }> {
  const config = join(dir, "wrangler.jsonc");
  writeFileSync(config, JSON.stringify({ name: "comments-e2e", main: resolve("src/worker.ts"), compatibility_date: "2026-01-01", compatibility_flags: ["nodejs_compat"], d1_databases: [{ binding: "DB", database_name: "comments-e2e", database_id: "00000000-0000-0000-0000-000000000000" }], vars }));
  const [port, inspector] = [await freePort(), await freePort()];
  const base = `http://127.0.0.1:${port}`;
  // Its own process group: workerd children outlive a kill of wrangler alone.
  const child = spawn(resolve("node_modules/.bin/wrangler"), ["dev", "--config", config, "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspector), "--local", "--persist-to", join(dir, "state")], {
    cwd: dir,
    detached: true,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.push(child);
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) => (output += chunk));
  for (let i = 0; i < 120; i++) {
    if ((await fetch(`${base}/health`).catch(() => undefined))?.ok) {
      return {
        base,
        stop: async () => {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
          await new Promise((r) => setTimeout(r, 500));
        },
      };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev did not start:\n${output.slice(-1500)}`);
}

const api = (base: string, token: string | null, method: string, path: string, body?: unknown) =>
  fetch(`${base}/api/v1${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: (await r.json()) as any }));

describe("the Worker under wrangler dev", () => {
  test("threads and suggestions survive a restart, no auth is 401, and an agent cannot decide its own suggestion", async () => {
    const vars = { AGENTIC_COMMENTS_TOKENS: JSON.stringify(TOKENS), AGENTIC_COMMENTS_UNSAFE_STATIC_TOKENS: "1", AGENTIC_COMMENTS_REGION: "unknown", AGENTIC_COMMENTS_UNSAFE_REGION: "1" };
    let server = await start(vars);
    expect((await api(server.base, null, "GET", "/docs/d1/threads")).status).toBe(401);
    expect((await api(server.base, "x".repeat(40), "GET", "/docs/d1/threads")).status).toBe(401);
    expect((await api(server.base, ADA, "POST", "/docs", { id: "d1", text: "The quick brown fox" })).status).toBe(201);
    const thread = await api(server.base, BOT, "POST", "/docs/d1/threads", { anchor: { type: "text", quote: "quick" }, body: "Why quick?" });
    expect(thread.status).toBe(200);
    expect(thread.json.messages[0].author).toEqual({ kind: "agent_of_human", name: "scribe" });
    const own = await api(server.base, BOSS, "POST", "/docs/d1/suggestions", { anchor: { type: "text", quote: "brown" }, change: { replace: "red" } });
    expect((await api(server.base, BOSS, "POST", `/docs/d1/suggestions/${own.json.id}/accept`)).json.error.code).toBe("FORBIDDEN");
    await server.stop();

    server = await start(vars);
    expect((await api(server.base, null, "GET", "/docs/d1/threads")).status).toBe(401);
    const threads = await api(server.base, ADA, "GET", "/docs/d1/threads");
    expect(threads.json.map((t: any) => t.id)).toEqual([thread.json.id]);
    expect((await api(server.base, ADA, "POST", `/docs/d1/suggestions/${own.json.id}/accept`)).json.status).toBe("accepted");
    expect((await api(server.base, ADA, "GET", "/docs/d1")).json.text).toBe("The quick red fox");
    await server.stop();
  }, 180_000);

  test("without a region claim the API refuses to run", async () => {
    const server = await start({ AGENTIC_COMMENTS_TOKENS: JSON.stringify(TOKENS), AGENTIC_COMMENTS_UNSAFE_STATIC_TOKENS: "1" });
    const res = await api(server.base, ADA, "GET", "/docs/d1/threads");
    expect([res.status, res.json.error.code]).toEqual([500, "MISCONFIGURED"]);
    await server.stop();
  }, 90_000);
});
