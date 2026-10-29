// The default auth of the Worker is agentic-identity: credentials and principals live in the Store.
//
// Failure cases, written before the code:
//  1. An unknown, revoked, or expired credential, or none at all, gets in.
//  2. A principal with no comments scope, or a scope of another app, gets in.
//  3. `comments:read` writes, or `comments:comment` creates a document.
//  4. The static list signs in without AGENTIC_COMMENTS_UNSAFE_STATIC_TOKENS=1, or a deploy that sets it by mistake runs silently.
//  5. The static list replaces the identity credentials instead of adding to them.
//  6. A store failure while the credential is read answers 401 instead of 5xx.
import { createMemoryStore, issueCredential, revokeCredential, type Store } from "agentic-identity";
import { beforeAll, describe, expect, test } from "vitest";
import { CommentsDocs, createApp } from "./worker.js";

const STATIC = `static-${"s".repeat(40)}`;
const store: Store = createMemoryStore({ region: "unknown" });
const app = createApp(new CommentsDocs(store));
const tokens: Record<string, string> = {};

beforeAll(async () => {
  const principals: Record<string, string | string[]>[] = [
    { id: "ada", kind: "human", scopes: ["comments:write"] },
    { id: "eve", kind: "human", scopes: ["comments:read"] },
    { id: "cleo", kind: "human", scopes: ["comments:comment"] },
    { id: "ned", kind: "human", scopes: ["docs:write"] },
    { id: "all", kind: "human", scopes: ["*:admin"] },
    { id: "helper", kind: "agent_of_human", parentId: "ada", scopes: ["comments:comment"] },
  ];
  for (const p of principals) {
    await store.transaction((tx) => tx.put("principals", p.id as string, p));
    tokens[p.id as string] = await store.transaction((tx) => issueCredential(tx, { principalId: p.id as string, kind: "api_key" }));
  }
  tokens.old = await store.transaction((tx) => issueCredential(tx, { principalId: "ada", kind: "api_key" }));
  await revokeCredential(store, tokens.old!, Date.now());
});

const call = (token: string | null, method: string, path: string, body?: unknown, env: Record<string, string> = {}) =>
  app.request(
    `/api/v1${path}`,
    { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) },
    env,
  );

describe("identity credentials are the default", () => {
  test("a credential signs in as its principal, and an agent keeps its kind", async () => {
    expect(await (await call(tokens.ada!, "GET", "/me")).json()).toMatchObject({ kind: "human", name: "ada" });
    expect(await (await call(tokens.helper!, "GET", "/me")).json()).toMatchObject({ kind: "agent_of_human", name: "helper" });
    expect((await call(tokens.ada!, "POST", "/docs", { id: "d1", text: "The quick brown fox" })).status).toBe(201);
    const thread = await (await call(tokens.helper!, "POST", "/docs/d1/threads", { anchor: { type: "text", quote: "quick" }, body: "Why?" })).json();
    expect(thread.messages[0].author).toEqual({ kind: "agent_of_human", name: "helper" });
    expect((await call(tokens["all"]!, "GET", "/docs/d1/threads")).status).toBe(200);
  });

  test("no token, an unknown token, and a revoked token are 401", async () => {
    for (const token of [null, "x".repeat(40), tokens.old!]) {
      const res = await call(token, "GET", "/docs/d1/threads");
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
      expect((await res.json()).error.code).toBe("UNAUTHENTICATED");
    }
  });

  test("the wrong scope is 403", async () => {
    // No comments scope: not even a read.
    for (const token of [tokens.ned!]) expect((await call(token, "GET", "/docs/d1/threads")).status).toBe(403);
    // comments:read cannot write.
    const write = await call(tokens.eve!, "POST", "/docs/d1/threads", { anchor: { type: "text", quote: "quick" }, body: "x" });
    expect([write.status, (await write.json()).error.code]).toEqual([403, "FORBIDDEN"]);
    // comments:comment cannot create a document or accept.
    expect((await call(tokens.cleo!, "POST", "/docs", { id: "d2" })).status).toBe(403);
    expect((await call(tokens.cleo!, "POST", "/docs/d1/threads/t/relocate")).status).toBe(403);
    expect((await call(tokens.eve!, "GET", "/docs/d1/threads")).status).toBe(200);
  });

  test("the static list does not sign in without the switch, and a set list answers 503", async () => {
    const env = { AGENTIC_COMMENTS_TOKENS: JSON.stringify({ [STATIC]: "human:ada" }) };
    const res = await call(STATIC, "GET", "/docs/d1/threads", undefined, env);
    expect([res.status, (await res.json()).error.code]).toEqual([503, "NOT_CONFIGURED"]);
    // With no list set, the token is unknown.
    expect((await call(STATIC, "GET", "/docs/d1/threads")).status).toBe(401);
  });

  test("with the switch the static list is tried after the identity credentials", async () => {
    const env = { AGENTIC_COMMENTS_TOKENS: JSON.stringify({ [STATIC]: "human:stat" }), AGENTIC_COMMENTS_UNSAFE_STATIC_TOKENS: "1" };
    expect(await (await call(STATIC, "GET", "/me", undefined, env)).json()).toMatchObject({ name: "stat" });
    expect(await (await call(tokens.ada!, "GET", "/me", undefined, env)).json()).toMatchObject({ name: "ada" });
    expect((await call("y".repeat(40), "GET", "/me", undefined, env)).status).toBe(401);
  });

  test("a store failure while the credential is read is a 5xx, never a 401", async () => {
    const broken: Store = { ...store, get: () => Promise.reject(new Error("down")) } as unknown as Store;
    const res = await createApp(new CommentsDocs(broken)).request("/api/v1/me", { headers: { authorization: `Bearer ${tokens.ada}` } });
    expect(res.status).toBe(503);
  });
});
