import { Hono, type Context } from "hono";
import { PrincipalParseError, StoreConflictError, assertRegion, isScope, parseRegion, hasScope, parsePrincipal, type Auth, type PrincipalContext, type Region, type Scope, type Store } from "agentic-identity";
import { requirePrincipal, type RequirePrincipalOptions } from "agentic-identity/http";
import { D1_SCHEMA, createD1Store, type D1Like } from "agentic-identity/cloudflare";
import * as Y from "yjs";
import { CommentsError, type CommentsErrorCode } from "./errors.js";
import { ACCEPT_SCOPE } from "./suggestions.js";
import { stamp, type Actor } from "./principal.js";
import { CommentsService } from "./service.js";
import { TEXT_ROOT } from "./local-host.js";
import { exact, invalid } from "./validate.js";

export interface WorkerEnv {
  /** Where the data lives: "eu" or "us". It is a claim you make at deploy time, with no default. "unknown" needs `AGENTIC_COMMENTS_UNSAFE_REGION=1` too. */
  AGENTIC_COMMENTS_REGION?: string;
  /** Set to "1" to accept the region "unknown" under `wrangler dev`. Never set it in production. */
  AGENTIC_COMMENTS_UNSAFE_REGION?: string;
  /** D1 database: each document, with its threads, as a Yjs update. */
  DB?: D1Like;
  /**
   * JSON object: bearer token (32 to 512 bytes of A-Z a-z 0-9 _ -) to `kind:name` (the name uses A-Z a-z 0-9 . _ -), or to `{ "as": "kind:name", "scopes": ["comments:write"] }`.
   * Set it as a secret. A short token or a bad entry refuses the whole config.
   */
  AGENTIC_COMMENTS_TOKENS?: string;
}

/**
 * What a scope lets a principal do. The identity scope grammar has four levels, in this order:
 * `comments:read` reads, `comments:comment` also writes threads, replies, and suggestions,
 * `comments:write` also relocates and accepts or rejects, and `comments:admin` also lets an agent
 * accept or reject (the `comments:accept` right). A person with `comments:write` accepts with no admin scope.
 */
const READ: Scope = "comments:read";
const COMMENT: Scope = "comments:comment";
const WRITE: Scope = "comments:write";
const ADMIN: Scope = "comments:admin";
const DEFAULT_SCOPES: Scope[] = [COMMENT];

const MIN_TOKEN_BYTES = 32;
// The shape identity's bearer check accepts. A token outside it could load but never sign in.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{1,512}$/;
const warned = new Set<string>();

function refuse(reason: string): undefined {
  if (!warned.has(reason)) {
    warned.add(reason);
    console.error(`AGENTIC_COMMENTS_TOKENS is refused: ${reason}`); // never the token or its value
  }
  return undefined;
}

function same(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function contextOf(entry: unknown): PrincipalContext | undefined {
  const object = typeof entry === "object" && entry !== null && !Array.isArray(entry) ? (entry as { as?: unknown; scopes?: unknown }) : undefined;
  const who = typeof entry === "string" ? entry : object?.as;
  const cut = typeof who === "string" ? who.indexOf(":") : -1;
  if (typeof who !== "string" || cut < 1 || cut === who.length - 1) return undefined;
  let kind: PrincipalContext["kind"];
  let name: string;
  try {
    ({ kind, id: name } = parsePrincipal({ kind: who.slice(0, cut), id: who.slice(cut + 1) }));
  } catch {
    return undefined;
  }
  const given = object?.scopes;
  if (given !== undefined && !(Array.isArray(given) && given.every(isScope))) return undefined;
  try {
    stamp({ kind, name }); // the name must pass the same check an author does
  } catch {
    return undefined;
  }
  return { principalId: name, kind, chain: [{ id: name, kind }], scopes: (given as Scope[] | undefined) ?? [...DEFAULT_SCOPES] };
}

/**
 * An `Auth` over a table of bearer tokens. One bad entry (a token under 32 bytes, a value that is not a valid principal)
 * refuses the whole table, so a typo never leaves a weak token live. The compare visits every entry.
 */
export function createTokenAuth(raw: string | undefined): Auth {
  let table: Map<string, PrincipalContext> | undefined;
  try {
    const parsed: unknown = JSON.parse(raw ?? "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { authenticate: async () => (refuse("not a JSON object"), null) };
    table = new Map();
    for (const [token, entry] of Object.entries(parsed)) {
      const context = contextOf(entry);
      if (new TextEncoder().encode(token).length < MIN_TOKEN_BYTES) throw new Error(`a token is shorter than ${MIN_TOKEN_BYTES} bytes`);
      if (!TOKEN_SHAPE.test(token)) throw new Error("a token holds a character outside A-Z a-z 0-9 _ - or is over 512 bytes");
      if (!context) throw new Error("an entry is not a valid kind:name or { as, scopes }");
      table.set(token, context);
    }
  } catch (error) {
    table = undefined;
    refuse(error instanceof SyntaxError ? "not valid JSON" : (error as Error).message);
  }
  const known = table;
  return {
    async authenticate(request) {
      const bearer = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
      if (bearer === undefined || !known) return null;
      let found: PrincipalContext | null = null;
      for (const [token, context] of known) if (same(token, bearer)) found = context;
      return found;
    },
  };
}

/** The actor for a request. Only the host makes it, from the principal the Auth port returned. */
function actorOf(context: PrincipalContext): Actor {
  const scopes = hasScope(context.scopes, ADMIN) ? [ACCEPT_SCOPE] : [];
  return stamp({ kind: context.kind, name: context.principalId, scopes });
}

const DOCS = "comments_docs";
const DOC_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** A D1 row holds up to 1 MB. The state is stored as base64, so keep well under that. */
const MAX_STATE = 600_000;
const MAX_BODY = 256 * 1024;

const toBase64 = (bytes: Uint8Array): string => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};
const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));

/** The documents, on the `Store` port. Each write loads the document, runs the change, and saves in one transaction. */
export class CommentsDocs {
  constructor(private readonly store: Store) {}

  private id(id: string): string {
    if (!DOC_ID.test(id)) invalid(`invalid document id "${id}": use 1 to 64 of a-z, 0-9, "-" and "_"`);
    return id;
  }

  private load(row: { state?: unknown } | null, id: string): Y.Doc {
    if (row === null) throw new CommentsError("NO_DOCUMENT", `no document with id "${id}"`);
    const ydoc = new Y.Doc();
    try {
      if (typeof row.state !== "string") throw new Error("no state");
      Y.applyUpdate(ydoc, fromBase64(row.state));
    } catch {
      throw new CommentsError("CORRUPT", `document "${id}" is damaged`);
    }
    return ydoc;
  }

  private open(ydoc: Y.Doc, actor: Actor): CommentsService {
    const fixed = { read: <T>(fn: (d: Y.Doc) => T) => fn(ydoc), write: <T>(fn: (d: Y.Doc) => T) => fn(ydoc) };
    return new CommentsService(fixed, actor);
  }

  async create(id: string, text: string, actor: Actor): Promise<void> {
    this.id(id);
    const ydoc = new Y.Doc();
    ydoc.getText(TEXT_ROOT).insert(0, text);
    const state = Y.encodeStateAsUpdate(ydoc);
    if (state.length > MAX_STATE) throw new CommentsError("STORE_FULL", `the text is too large for one document (${MAX_STATE} bytes of state)`);
    await this.store.transaction(async (tx) => {
      if ((await tx.get(DOCS, id)) !== null) throw new CommentsError("DOCUMENT_EXISTS", `document "${id}" already exists`);
      await tx.put(DOCS, id, { state: toBase64(state), createdBy: { kind: actor.kind, name: actor.name }, createdAt: Date.now() });
    });
  }

  async read<T>(id: string, actor: Actor, run: (service: CommentsService) => T): Promise<T> {
    return run(this.open(this.load(await this.store.get(DOCS, this.id(id)), id), actor));
  }

  async write<T>(id: string, actor: Actor, run: (service: CommentsService) => T): Promise<T> {
    this.id(id);
    return this.store.transaction(async (tx) => {
      const row = (await tx.get(DOCS, id)) as { state?: unknown; createdBy?: unknown; createdAt?: unknown } | null;
      const ydoc = this.load(row, id);
      const result = run(this.open(ydoc, actor));
      const state = Y.encodeStateAsUpdate(ydoc);
      if (state.length > MAX_STATE) throw new CommentsError("STORE_FULL", `document "${id}" would pass ${MAX_STATE} bytes of state`);
      await tx.put(DOCS, id, { state: toBase64(state), createdBy: (row?.createdBy ?? null) as never, createdAt: (row?.createdAt ?? null) as never });
      return result;
    });
  }
}

const STATUS: Partial<Record<CommentsErrorCode, number>> = {
  INVALID_AUTHOR: 400,
  INVALID_INPUT: 400,
  INVALID_ANCHOR: 400,
  NO_THREAD: 404,
  NO_MESSAGE: 404,
  NO_SUGGESTION: 404,
  NO_DOCUMENT: 404,
  THREAD_RESOLVED: 409,
  ALREADY_DECIDED: 409,
  DOCUMENT_EXISTS: 409,
  CONFLICT: 409,
  APPLY_FAILED: 409,
  RELOCATE_FAILED: 409,
  FORBIDDEN: 403,
  STORE_FULL: 413,
  CORRUPT: 500,
  MISCONFIGURED: 500,
};

const fail = (code: string, message: string, status: number) => Response.json({ error: { code, message } }, { status });

/** The docs, or a function that makes them from the Worker bindings. */
export type DocsSource = CommentsDocs | ((env: WorkerEnv) => Promise<CommentsDocs>);

export interface AppOptions {
  /** The credential check. The default reads `AGENTIC_COMMENTS_TOKENS`. Pass any `Auth` from agentic-identity to replace it. */
  auth?: Auth | ((env: WorkerEnv) => Auth);
  /** Origins that may send a write with a session cookie. A bearer token needs none. Passed to `requirePrincipal`. */
  origins?: RequirePrincipalOptions["origins"];
}

type AppEnv = { Bindings: WorkerEnv; Variables: { context: PrincipalContext } };

/** The JSON body, or INVALID_INPUT. A body past the cap is refused before it is read whole. */
async function body(c: Context): Promise<Record<string, unknown>> {
  if (Number(c.req.header("content-length") ?? 0) > MAX_BODY) invalid(`the body is over ${MAX_BODY} bytes`);
  const text = await c.req.text();
  if (text.length > MAX_BODY) invalid(`the body is over ${MAX_BODY} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) invalid("the body must be a JSON object");
  return parsed as Record<string, unknown>;
}

export function createApp(source: DocsSource, options: AppOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const docsOf = (c: Context<AppEnv>) => (typeof source === "function" ? source(c.env ?? {}) : Promise.resolve(source));

  app.use("*", async (c, next) => {
    await next();
    c.header("x-content-type-options", "nosniff");
  });
  app.get("/health", (c) => c.json({ ok: true, pack: "agentic-comments" }));
  app.use("/api/v1/*", async (c, next) => {
    const auth = typeof options.auth === "function" ? options.auth(c.env ?? {}) : (options.auth ?? createTokenAuth(c.env?.AGENTIC_COMMENTS_TOKENS));
    const context = await requirePrincipal(c.req.raw, auth, { origins: options.origins });
    if (context instanceof Response) {
      if (context.status === 401) return Response.json({ error: { code: "UNAUTHENTICATED", message: "send a valid bearer token" } }, { status: 401, headers: { "www-authenticate": "Bearer" } });
      if (context.status === 403) return fail("FORBIDDEN", "this credential may not do this", 403);
      return fail("INTERNAL", "the credential check is unavailable", context.status);
    }
    c.set("context", context);
    await next();
  });
  // Who the token stands for. A client reads its author kind here, so it never claims one.
  app.get("/api/v1/me", (c) => {
    const { principalId, kind, scopes } = c.get("context");
    return c.json({ kind, name: principalId, scopes });
  });

  /** Run one action. `need` is the least scope that may do it. */
  const act = <T>(c: Context<AppEnv>, need: Scope, write: boolean, run: (service: CommentsService) => T | Promise<T>) =>
    (async () => {
      const context = c.get("context");
      if (!hasScope(context.scopes, need)) throw new CommentsError("FORBIDDEN", `this token needs the ${need} scope`);
      const docs = await docsOf(c);
      const actor = actorOf(context);
      const id = c.req.param("doc") ?? "";
      return c.json(await (write ? docs.write(id, actor, run) : docs.read(id, actor, run)));
    })();

  const doc = "/api/v1/docs/:doc";
  app.post("/api/v1/docs", async (c) => {
    const given = exact(await body(c), ["id", "text"], "a document");
    if (typeof given.id !== "string") invalid("a document needs an id");
    if (given.text !== undefined && typeof given.text !== "string") invalid("text must be a string");
    const context = c.get("context");
    if (!hasScope(context.scopes, WRITE)) throw new CommentsError("FORBIDDEN", `this token needs the ${WRITE} scope`);
    await (await docsOf(c)).create(given.id as string, (given.text as string | undefined) ?? "", actorOf(context));
    return c.json({ id: given.id }, 201);
  });
  app.get(doc, (c) => act(c, READ, false, (s) => ({ id: c.req.param("doc"), text: s.text() })));
  app.get(`${doc}/threads`, (c) => act(c, READ, false, (s) => s.threads(c.req.query())));
  app.get(`${doc}/threads/:id`, (c) => act(c, READ, false, (s) => s.thread(c.req.param("id"))));
  app.post(`${doc}/threads`, async (c) => {
    const input = await body(c);
    return act(c, COMMENT, true, (s) => s.comment(input as never));
  });
  app.post(`${doc}/threads/:id/replies`, async (c) => {
    const input = await body(c);
    return act(c, COMMENT, true, (s) => s.reply(c.req.param("id"), input as never));
  });
  for (const action of ["resolve", "reopen"] as const) {
    app.post(`${doc}/threads/:id/${action}`, (c) => act(c, COMMENT, true, (s) => s[action](c.req.param("id"))));
  }
  app.post(`${doc}/threads/:id/relocate`, (c) => act(c, WRITE, true, (s) => s.relocate(c.req.param("id"))));
  app.get(`${doc}/suggestions`, (c) => act(c, READ, false, (s) => s.suggestions(c.req.query())));
  app.post(`${doc}/suggestions`, async (c) => {
    const input = await body(c);
    return act(c, COMMENT, true, (s) => s.suggest(input as never));
  });
  for (const action of ["accept", "reject"] as const) {
    app.post(`${doc}/suggestions/:id/${action}`, (c) => act(c, WRITE, true, (s) => s[action](c.req.param("id"))));
  }

  app.notFound(() => fail("NOT_FOUND", "no such route", 404));
  app.onError((error) => {
    if (error instanceof CommentsError) return fail(error.code, error.message, STATUS[error.code] ?? 400);
    // The store ran the change again until it gave up. A retry by the client can succeed.
    if (error instanceof StoreConflictError) return fail("CONFLICT", "the document kept changing; try again", 409);
    console.error(error instanceof Error ? error.name : "error");
    return fail("INTERNAL", "the server could not finish the request", 500);
  });
  return app;
}

const schemas = new WeakMap<object, Promise<unknown>>();

/** The region claim, or a MISCONFIGURED error. */
export function regionOf(env: WorkerEnv): Region {
  let region;
  try {
    region = parseRegion(env.AGENTIC_COMMENTS_REGION);
  } catch {
    throw new CommentsError("MISCONFIGURED", 'set AGENTIC_COMMENTS_REGION to "eu" or "us" ("unknown" only for local development)');
  }
  if (region === "unknown" && env.AGENTIC_COMMENTS_UNSAFE_REGION !== "1") {
    throw new CommentsError("MISCONFIGURED", 'the region "unknown" turns the residency check off; set AGENTIC_COMMENTS_UNSAFE_REGION=1 to accept that for local development');
  }
  return region;
}

/** The documents over D1. */
export async function docsFor(env: WorkerEnv): Promise<CommentsDocs> {
  if (!env.DB) throw new CommentsError("MISCONFIGURED", "bind a D1 database as DB");
  const region = regionOf(env);
  const db = env.DB;
  let ready = schemas.get(db);
  if (!ready) {
    ready = db.prepare(D1_SCHEMA).run().catch((error: unknown) => {
      schemas.delete(db);
      throw error;
    });
    schemas.set(db, ready);
  }
  await ready;
  const store = createD1Store(db, { region });
  assertRegion(region, store);
  return new CommentsDocs(store);
}

const app = createApp(docsFor);
export default { fetch: (request: Request, env: WorkerEnv, ctx: unknown) => app.fetch(request, env, ctx as never) };
