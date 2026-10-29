import { createMemoryStore, StoreConflictError, type Auth } from "agentic-identity";
import { describe, expect, test, vi } from "vitest";
import { CommentsDocs, createApp, createTokenAuth } from "./worker.js";

const ADA = `ada-${"a".repeat(40)}`;
const BOT = `bot-${"b".repeat(40)}`;
const BOSS = `boss-${"c".repeat(40)}`;
const SEER = `seer-${"d".repeat(40)}`;
const TOKENS = JSON.stringify({
  [ADA]: { as: "human:ada", scopes: ["comments:write"] },
  [BOT]: "agent_of_human:scribe",
  [BOSS]: { as: "agent_of_human:boss", scopes: ["comments:admin"] },
  [SEER]: { as: "agent:seer", scopes: ["comments:read"] },
});

function setup() {
  const app = createApp(new CommentsDocs(createMemoryStore({ region: "unknown" })));
  const call = async (token: string | null, method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await app.request(`/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, { AGENTIC_COMMENTS_TOKENS: TOKENS });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { call };
}

async function seeded() {
  const s = setup();
  expect((await s.call(ADA, "POST", "/docs", { id: "d1", text: "The quick brown fox" })).status).toBe(201);
  return s;
}

describe("auth", () => {
  test("no token, a wrong token, and a malformed header are 401", async () => {
    const { call } = setup();
    for (const token of [null, "x".repeat(40), ""]) expect((await call(token, "GET", "/docs/d1/threads")).status).toBe(401);
    expect((await call(null, "GET", "/me")).json.error.code).toBe("UNAUTHENTICATED");
  });

  test("one short token or bad entry refuses the whole table", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const table of [{ short: "human:ada", [ADA]: "human:ada" }, { [ADA]: "ada" }, { [ADA]: "robot:ada" }, { [ADA]: "human:ada@example.com" }, { [`${"a".repeat(31)}+`]: "human:ada" }, { [ADA]: { as: "human:ada", scopes: ["comments:accept"] } }, [], "nope"]) {
      const auth = createTokenAuth(typeof table === "string" ? table : JSON.stringify(table));
      expect(await auth.authenticate(new Request("https://x/", { headers: { authorization: `Bearer ${ADA}` } }))).toBeNull();
    }
    quiet.mockRestore();
  });

  test("a custom Auth that throws is refused with the API error shape", async () => {
    const auth: Auth = { authenticate: async () => { throw new Error("store down"); } };
    const app = createApp(new CommentsDocs(createMemoryStore({ region: "unknown" })), { auth });
    const res = await app.request("/api/v1/me", { headers: { authorization: `Bearer ${ADA}` } });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect((await res.json()).error.code).toBe("INTERNAL");
  });

  test("a custom Auth port replaces the token table", async () => {
    const auth: Auth = { authenticate: async () => ({ principalId: "kim", kind: "human", chain: [{ id: "kim", kind: "human" }], scopes: ["comments:write"] }) };
    const app = createApp(new CommentsDocs(createMemoryStore({ region: "unknown" })), { auth });
    const res = await app.request("/api/v1/me");
    expect(await res.json()).toEqual({ kind: "human", name: "kim", scopes: ["comments:write"] });
  });

  test("the author comes from the token, and an author in the body is refused", async () => {
    const { call } = await seeded();
    const made = await call(BOT, "POST", "/docs/d1/threads", { anchor: { type: "text", quote: "quick" }, body: "Why quick?" });
    expect(made.status).toBe(200);
    expect(made.json.messages[0].author).toEqual({ kind: "agent_of_human", name: "scribe" });
    for (const input of [{ author: { kind: "human", name: "ada" } }, { author: "human:ada" }]) {
      const bad = await call(BOT, "POST", "/docs/d1/threads", { anchor: { type: "text", quote: "quick" }, body: "x", ...input });
      expect([bad.status, bad.json.error.code]).toEqual([400, "INVALID_INPUT"]);
    }
  });
});

describe("rights", () => {
  test("a read token reads and cannot write; a comment token cannot create documents", async () => {
    const { call } = await seeded();
    expect((await call(SEER, "GET", "/docs/d1/threads")).status).toBe(200);
    expect((await call(SEER, "POST", "/docs/d1/threads", { anchor: { type: "cell", key: "A1" }, body: "x" })).status).toBe(403);
    expect((await call(BOT, "POST", "/docs", { id: "d2" })).status).toBe(403);
  });

  test("an agent cannot accept without admin, and no agent accepts its own suggestion", async () => {
    const { call } = await seeded();
    const own = await call(BOSS, "POST", "/docs/d1/suggestions", { anchor: { type: "text", quote: "quick" }, change: { replace: "slow" } });
    expect(own.status).toBe(200);
    const theirs = await call(BOT, "POST", "/docs/d1/suggestions", { anchor: { type: "text", quote: "brown" }, change: { replace: "red" } });
    // the bot has only comments:comment, so it cannot accept anything
    expect((await call(BOT, "POST", `/docs/d1/suggestions/${theirs.json.id}/accept`)).status).toBe(403);
    // the admin agent cannot accept or reject its own
    for (const verb of ["accept", "reject"]) expect((await call(BOSS, "POST", `/docs/d1/suggestions/${own.json.id}/${verb}`)).json.error.code).toBe("FORBIDDEN");
    // the admin agent can accept another agent's
    expect((await call(BOSS, "POST", `/docs/d1/suggestions/${theirs.json.id}/accept`)).json.status).toBe("accepted");
    expect((await call(ADA, "GET", "/docs/d1")).json.text).toBe("The quick red fox");
    // a person accepts the agent's suggestion
    expect((await call(ADA, "POST", `/docs/d1/suggestions/${own.json.id}/accept`)).json.status).toBe("accepted");
    expect((await call(ADA, "GET", "/docs/d1")).json.text).toBe("The slow red fox");
    expect((await call(ADA, "POST", `/docs/d1/suggestions/${own.json.id}/reject`)).status).toBe(409);
  });
});

describe("threads", () => {
  test("add, reply, resolve, reopen, relocate, and list by status", async () => {
    const { call } = await seeded();
    const t = (await call(ADA, "POST", "/docs/d1/threads", { anchor: { type: "text", quote: "fox" }, body: "Which fox?" })).json;
    expect((await call(BOT, "POST", `/docs/d1/threads/${t.id}/replies`, { body: "This one." })).json.author).toEqual({ kind: "agent_of_human", name: "scribe" });
    expect((await call(ADA, "POST", `/docs/d1/threads/${t.id}/resolve`)).json.status).toBe("resolved");
    const closed = await call(BOT, "POST", `/docs/d1/threads/${t.id}/replies`, { body: "late" });
    expect([closed.status, closed.json.error.code]).toEqual([409, "THREAD_RESOLVED"]);
    expect((await call(ADA, "GET", "/docs/d1/threads?status=open")).json).toEqual([]);
    expect((await call(ADA, "POST", `/docs/d1/threads/${t.id}/reopen`)).json.status).toBe("open");
    expect((await call(ADA, "GET", `/docs/d1/threads/${t.id}`)).json.messages).toHaveLength(2);
    expect((await call(BOT, "POST", `/docs/d1/threads/${t.id}/relocate`)).status).toBe(403);
    expect((await call(ADA, "POST", `/docs/d1/threads/${t.id}/relocate`)).status).toBe(200);
  });

  test("two writes at once both land", async () => {
    const { call } = await seeded();
    const all = await Promise.all(Array.from({ length: 6 }, (_, i) => call(ADA, "POST", "/docs/d1/threads", { anchor: { type: "cell", key: `A${i}` }, body: `n${i}` })));
    expect(all.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect((await call(ADA, "GET", "/docs/d1/threads")).json).toHaveLength(6);
  });

  test("a store that keeps conflicting is 409 CONFLICT, not a 500", async () => {
    const store = createMemoryStore({ region: "unknown" });
    const app = createApp(new CommentsDocs(store));
    const env = { AGENTIC_COMMENTS_TOKENS: TOKENS };
    const headers = { authorization: `Bearer ${ADA}`, "content-type": "application/json" };
    await app.request("/api/v1/docs", { method: "POST", headers, body: JSON.stringify({ id: "d1", text: "abc" }) }, env);
    store.transaction = async () => {
      throw new StoreConflictError();
    };
    const res = await app.request("/api/v1/docs/d1/threads", { method: "POST", headers, body: JSON.stringify({ anchor: { type: "cell", key: "A1" }, body: "x" }) }, env);
    expect([res.status, ((await res.json()) as any).error.code]).toEqual([409, "CONFLICT"]);
  });

  test("errors are JSON with a code and the right status", async () => {
    const { call } = await seeded();
    const cases: [string, string, unknown, number, string][] = [
      ["GET", "/docs/nope/threads", undefined, 404, "NO_DOCUMENT"],
      ["GET", "/docs/d1/threads/zzz", undefined, 404, "NO_THREAD"],
      ["GET", "/docs/BAD ID/threads", undefined, 400, "INVALID_INPUT"],
      ["POST", "/docs", { id: "d1" }, 409, "DOCUMENT_EXISTS"],
      ["GET", "/docs/d1/threads?color=red", undefined, 400, "INVALID_INPUT"],
      ["POST", "/docs/d1/threads", { anchor: { type: "text", quote: "absent" }, body: "x" }, 400, "INVALID_ANCHOR"],
      ["POST", "/docs/d1/threads", "[]", 400, "INVALID_INPUT"],
    ];
    for (const [method, path, body, status, code] of cases) {
      const r = await call(ADA, method, path, body);
      expect([r.status, r.json.error.code]).toEqual([status, code]);
    }
    expect((await call(ADA, "GET", "/nothing")).status).toBe(404);
  });
});
