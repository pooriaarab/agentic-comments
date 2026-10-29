// The client against the real Worker handler: every request goes through createApp, with real auth and a real store.
import { createMemoryStore } from "agentic-identity";
import { describe, expect, test } from "vitest";
import { CommentsApiError, createClient, type CommentsClient } from "./client.js";
import { CommentsDocs, createApp } from "./worker.js";

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
  const seen: { url: string; init: RequestInit }[] = [];
  const handler = ((input: string, init: RequestInit) => {
    seen.push({ url: input, init });
    return Promise.resolve(app.request(input, init, { AGENTIC_COMMENTS_TOKENS: TOKENS, AGENTIC_COMMENTS_UNSAFE_STATIC_TOKENS: "1" }));
  }) as unknown as typeof fetch;
  const as = (token: string): CommentsClient => createClient({ baseUrl: "https://comments.test", token, fetch: handler });
  return { as, seen, handler };
}

async function refusal(promise: Promise<unknown>): Promise<CommentsApiError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CommentsApiError);
  return error as CommentsApiError;
}

describe("createClient against the Worker handler", () => {
  test("walks every route", async () => {
    const { as } = setup();
    const ada = as(ADA);
    const bot = as(BOT);
    const boss = as(BOSS);

    expect(await ada.me()).toEqual({ kind: "human", name: "ada", scopes: ["comments:write"] });
    expect(await ada.createDocument({ id: "d1", text: "The quick brown fox" })).toEqual({ id: "d1" });
    expect(await ada.getDocument("d1")).toEqual({ id: "d1", text: "The quick brown fox" });

    const thread = await ada.addThread("d1", { anchor: { type: "text", quote: "fox" }, body: "Which fox?" });
    expect(thread.messages[0]?.author).toEqual({ kind: "human", name: "ada" });
    const reply = await bot.reply("d1", thread.id, { body: "This one.", mentions: ["ada"] });
    expect(reply.author).toEqual({ kind: "agent_of_human", name: "scribe" });
    expect(reply.mentions).toEqual(["ada"]);
    expect((await ada.getThread("d1", thread.id)).messages).toHaveLength(2);

    expect((await ada.resolve("d1", thread.id)).status).toBe("resolved");
    expect(await ada.listThreads("d1", { status: "open" })).toEqual([]);
    expect(await ada.listThreads("d1", { status: "resolved" })).toHaveLength(1);
    expect((await ada.reopen("d1", thread.id)).status).toBe("open");
    expect((await ada.relocate("d1", thread.id)).id).toBe(thread.id);
    expect(await ada.listThreads("d1", { mentioning: "ada" })).toHaveLength(1);
    expect(await ada.listThreads("d1")).toHaveLength(1);

    const first = await bot.suggest("d1", { anchor: { type: "text", quote: "quick" }, change: { replace: "slow" }, summary: "Tone" });
    expect(first).toMatchObject({ status: "pending", summary: "Tone", author: { kind: "agent_of_human", name: "scribe" } });
    const second = await bot.suggest("d1", { anchor: { type: "text", quote: "brown" }, change: { replace: "red" } });
    expect(await ada.listSuggestions("d1", { status: "pending" })).toHaveLength(2);
    expect((await ada.accept("d1", first.id)).status).toBe("accepted");
    expect((await ada.reject("d1", second.id)).status).toBe("rejected");
    expect(await ada.listSuggestions("d1", { status: "pending" })).toEqual([]);
    expect(await ada.listSuggestions("d1")).toHaveLength(2);

    const own = await boss.suggest("d1", { anchor: { type: "cell", key: "A1" }, change: { value: 1 } });
    expect((await refusal(boss.accept("d1", own.id))).code).toBe("FORBIDDEN");
  });

  test("an error carries the API code and the HTTP status", async () => {
    const { as } = setup();
    const ada = as(ADA);
    await ada.createDocument({ id: "d1", text: "abc" });
    const cases: [() => Promise<unknown>, number, string][] = [
      [() => as("x".repeat(40)).me(), 401, "UNAUTHENTICATED"],
      [() => ada.getDocument("nope"), 404, "NO_DOCUMENT"],
      [() => ada.getThread("d1", "zzz"), 404, "NO_THREAD"],
      [() => ada.createDocument({ id: "d1" }), 409, "DOCUMENT_EXISTS"],
      [() => ada.addThread("d1", { anchor: { type: "text", quote: "absent" }, body: "x" }), 400, "INVALID_ANCHOR"],
      [() => ada.getDocument("BAD ID"), 400, "INVALID_INPUT"],
      [() => as(SEER).addThread("d1", { anchor: { type: "cell", key: "A1" }, body: "x" }), 403, "FORBIDDEN"],
      [() => as(BOT).createDocument({ id: "d2" }), 403, "FORBIDDEN"],
    ];
    for (const [call, status, code] of cases) {
      const error = await refusal(call());
      expect([error.status, error.code]).toEqual([status, code]);
    }
    const thread = await ada.addThread("d1", { anchor: { type: "cell", key: "A1" }, body: "x" });
    await ada.resolve("d1", thread.id);
    expect((await refusal(as(BOT).reply("d1", thread.id, { body: "late" }))).code).toBe("THREAD_RESOLVED");
  });

  test("the client never sends an author, and the Worker refuses one in the input", async () => {
    const { as, seen } = setup();
    const ada = as(ADA);
    await ada.createDocument({ id: "d1", text: "abc" });
    await ada.addThread("d1", { anchor: { type: "text", quote: "abc" }, body: "x" });
    for (const { init } of seen) expect(String(init.body ?? "")).not.toContain("author");
    const bad = { anchor: { type: "text", quote: "abc" }, body: "x", author: { kind: "human", name: "eve" } } as never;
    expect((await refusal(ada.addThread("d1", bad))).code).toBe("INVALID_INPUT");
  });

  test("an id is encoded, and a dot segment is refused before any request", async () => {
    const { as, seen } = setup();
    const ada = as(ADA);
    for (const id of ["", ".", "..", "%2e%2E"]) await expect(ada.getDocument(id)).rejects.toThrow(TypeError);
    await expect(ada.getThread("d1", "a/b")).rejects.toMatchObject({ code: "NO_DOCUMENT" });
    expect(seen.map((s) => s.url)).toEqual(["https://comments.test/api/v1/docs/d1/threads/a%2Fb"]);
  });

  test("a reply that is not the expected shape fails as UNKNOWN", async () => {
    const proxy = (body: string, status = 200) => createClient({ baseUrl: "https://c.test/base/", token: ADA, fetch: (async () => new Response(body, { status })) as typeof fetch });
    const wrong = await refusal(proxy("<html>").getThread("d1", "t"));
    expect([wrong.code, wrong.status]).toEqual(["UNKNOWN", 200]);
    expect((await refusal(proxy("[1]").listThreads("d1"))).code).toBe("UNKNOWN");
    const gateway = await refusal(proxy("bad gateway", 502).me());
    expect([gateway.code, gateway.status, gateway.message]).toEqual(["UNKNOWN", 502, "HTTP 502"]);
    const unlisted = await refusal(proxy(JSON.stringify({ error: { code: "WEIRD", message: "m" } }), 400).me());
    expect([unlisted.code, unlisted.message]).toEqual(["UNKNOWN", "m"]);
  });

  test("the base URL keeps its path, and a bad option is refused", async () => {
    const urls: string[] = [];
    const client = createClient({ baseUrl: "https://c.test/base/", token: ADA, fetch: (async (u: string) => (urls.push(u), new Response("{}", { status: 500 }))) as never });
    await refusal(client.me());
    expect(urls).toEqual(["https://c.test/base/api/v1/me"]);
    for (const baseUrl of ["", "nope", "ftp://x.test", "https://x.test/?a=1", "https://x.test/#h", "https://u:p@x.test"]) {
      expect(() => createClient({ baseUrl, token: ADA })).toThrow(TypeError);
    }
    expect(() => createClient({ baseUrl: "https://x.test", token: "" })).toThrow(TypeError);
  });

  test("a custom fetch runs with no this, never retries, and never follows a redirect", async () => {
    const calls: { self: unknown; init: RequestInit }[] = [];
    const plain = function (this: unknown, _input: string, init: RequestInit) {
      calls.push({ self: this, init });
      return Promise.resolve(new Response(JSON.stringify({ error: { code: "CONFLICT", message: "try again" } }), { status: 409 }));
    };
    const client = createClient({ baseUrl: "https://c.test", token: ADA, fetch: plain as never });
    expect((await refusal(client.createDocument({ id: "d1" }))).code).toBe("CONFLICT");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.self).toBeUndefined();
    expect(calls[0]?.init.redirect).toBe("manual");
  });

  test("a me reply with an unknown kind fails as UNKNOWN", async () => {
    const odd = createClient({ baseUrl: "https://c.test", token: ADA, fetch: (async () => Response.json({ kind: "robot", name: "r", scopes: [] })) as never });
    expect((await refusal(odd.me())).code).toBe("UNKNOWN");
  });

  test("an aborted call rejects with the signal reason", async () => {
    const { as } = setup();
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const slow = createClient({ baseUrl: "https://c.test", token: ADA, fetch: ((_u: string, init: RequestInit) => (init.signal?.aborted ? Promise.reject(init.signal.reason) : Promise.resolve(new Response("{}")))) as never });
    await expect(slow.me({ signal: controller.signal })).rejects.toThrow("stop");
    expect(await as(ADA).me({ signal: new AbortController().signal })).toMatchObject({ name: "ada" });
  });
});

describe("lifecycle methods", () => {
  test("edit, delete, export, and erase go to the right routes and return typed data", async () => {
    const { as, seen } = setup();
    const ada = as(ADA);
    const bot = as(BOT);
    await ada.createDocument({ id: "d1", text: "abc" });
    const thread = await ada.addThread("d1", { anchor: { type: "cell", key: "A1" }, body: "ada here" });
    const reply = await bot.reply("d1", thread.id, { body: "bot here" });
    const edited = await ada.editMessage("d1", thread.id, thread.messages[0].id, { body: "ada fixed" });
    expect([edited.body, edited.editedBy?.name]).toEqual(["ada fixed", "ada"]);
    expect((await refusal(bot.editMessage("d1", thread.id, thread.messages[0].id, { body: "x" }))).code).toBe("FORBIDDEN");
    const data = await ada.exportPerson("d1", "ada");
    expect([data.person, data.threads[0].messages[0].body, data.suggestions]).toEqual(["ada", "ada fixed", { authored: [], decided: [], unread: 0 }]);
    expect(await ada.erasePerson("d1", "ada")).toEqual({ messages: 1, statuses: 1, edits: 0, suggestions: 0, decisions: 0 });
    expect(await bot.deleteMessage("d1", thread.id, reply.id)).toEqual({ threadId: thread.id, messageId: reply.id });
    expect(await as(BOSS).deleteThread("d1", thread.id)).toEqual({ threadId: thread.id });
    expect((await refusal(ada.getThread("d1", thread.id))).code).toBe("NO_THREAD");
    const methods = seen.map((s) => `${s.init.method} ${new URL(s.url).pathname.replace(thread.id, "T").replace(reply.id, "R").replace(thread.messages[0].id, "M")}`);
    expect(methods).toContain("PATCH /api/v1/docs/d1/threads/T/messages/M");
    expect(methods).toContain("DELETE /api/v1/docs/d1/people/ada");
    expect(methods).toContain("GET /api/v1/docs/d1/people/ada/export");
  });

  test("a person or message id that would change the route is refused before any request", async () => {
    const { as, seen } = setup();
    await expect(as(ADA).exportPerson("d1", "..")).rejects.toThrow(TypeError);
    await expect(as(ADA).deleteMessage("d1", "t", "")).rejects.toThrow(TypeError);
    expect(seen).toHaveLength(0);
  });
});

describe("lifecycle reply shapes", () => {
  test("a 200 reply with a partial shape fails as UNKNOWN", async () => {
    const reply = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const as = (body: unknown) => createClient({ baseUrl: "https://comments.test", token: ADA, fetch: reply(body) });
    expect((await refusal(as({ person: "ada", threads: [], suggestions: { authored: [] } }).exportPerson("d1", "ada"))).code).toBe("UNKNOWN");
    expect((await refusal(as({ messages: 1 }).erasePerson("d1", "ada"))).code).toBe("UNKNOWN");
    expect((await refusal(as({ ok: true }).deleteThread("d1", "t"))).code).toBe("UNKNOWN");
    expect((await refusal(as({ threadId: "t" }).deleteMessage("d1", "t", "m"))).code).toBe("UNKNOWN");
    expect((await refusal(as({ person: "ada", exportedAt: 1, threads: [], edits: [], unread: 0, suggestions: { authored: [], decided: [], unread: 0 } }).exportPerson("d1", "ada"))).code).toBe("UNKNOWN");
    const partial = { person: "ada", exportedAt: "x", threads: [], edits: [], unread: 0, suggestions: { authored: [], decided: [], unread: 0 } };
    expect((await refusal(as({ ...partial, threads: [{}] }).exportPerson("d1", "ada"))).code).toBe("UNKNOWN");
    expect((await refusal(as({ ...partial, edits: [null] }).exportPerson("d1", "ada"))).code).toBe("UNKNOWN");
    const bare = { id: "m", at: "x", body: "b", mentions: [], author: {} };
    expect((await refusal(as({ ...partial, threads: [{ threadId: "t", anchor: {}, messages: [bare], statusChange: undefined }] }).exportPerson("d1", "ada"))).code).toBe("UNKNOWN");
    expect((await refusal(as({ id: "m", body: "x", author: { kind: "human", name: "ada" } }).editMessage("d1", "t", "m", { body: "x" }))).code).toBe("UNKNOWN");
    expect((await refusal(as({ id: "t", anchor: {}, status: "open", messages: [{}] }).getThread("d1", "t"))).code).toBe("UNKNOWN");
    expect((await refusal(as({ id: "t", anchor: {}, anchorState: { state: "attached" }, status: "open", messages: [], skipped: 0 }).getThread("d1", "t"))).code).toBe("UNKNOWN");
    expect((await refusal(as({ ...partial, threads: [{ threadId: "t", anchor: {}, messages: [], statusChange: {} }] }).exportPerson("d1", "ada"))).code).toBe("UNKNOWN");
    expect((await refusal(as({ ...partial, suggestions: { authored: [1], decided: [], unread: 0 } }).exportPerson("d1", "ada"))).code).toBe("UNKNOWN");
    expect((await refusal(as({ ...partial, suggestions: { authored: [], decided: [{ id: "s", status: "pending", at: "x" }], unread: 0 } }).exportPerson("d1", "ada"))).code).toBe("UNKNOWN");
  });
});
