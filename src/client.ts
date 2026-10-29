// A typed client for the Worker HTTP API. It uses only fetch, URL, and AbortSignal, so it runs in
// browsers, Workers, and Node 22. It never retries: a retry of a comment, a reply, or an accept
// could apply twice. It never sends an author. The Worker stamps one from the token.
import type { AnchorSpec, ListFilter } from "./service.js";
import type { CommentsErrorCode } from "./errors.js";
import type { PrincipalKind } from "./principal.js";
import type { PersonSuggestions, Suggestion } from "./suggestions.js";
import type { Message, NewReply, PersonExport, Thread } from "./threads.js";

export type { AnchorSpec, ListFilter } from "./service.js";
export type { CommentsErrorCode } from "./errors.js";
export type { Message, NewReply, PersonExport, Thread } from "./threads.js";
export type { PersonSuggestions, Suggestion } from "./suggestions.js";
export type { PrincipalKind } from "./principal.js";

/** Codes the comment rules return, plus the ones the Worker and its auth return. */
export type ApiErrorCode =
  | CommentsErrorCode
  | "UNAUTHENTICATED"
  | "NOT_FOUND"
  | "INTERNAL"
  // The reply was not an API error body, for example from a proxy.
  | "UNKNOWN";

// Every ApiErrorCode must be a key here, so a new code fails the type check.
const CODES: Record<ApiErrorCode, true> = {
  INVALID_AUTHOR: true,
  INVALID_INPUT: true,
  INVALID_ANCHOR: true,
  NO_THREAD: true,
  NO_MESSAGE: true,
  THREAD_RESOLVED: true,
  CORRUPT: true,
  NO_SUGGESTION: true,
  FORBIDDEN: true,
  ALREADY_DECIDED: true,
  APPLY_FAILED: true,
  RELOCATE_FAILED: true,
  STORE_MISSING: true,
  STORE_EXISTS: true,
  STORE_CORRUPT: true,
  STORE_LOCKED: true,
  STORE_FULL: true,
  NO_DOCUMENT: true,
  DOCUMENT_EXISTS: true,
  CONFLICT: true,
  MISCONFIGURED: true,
  USAGE: true,
  UNAUTHENTICATED: true,
  NOT_FOUND: true,
  INTERNAL: true,
  UNKNOWN: true,
};
const isKnownCode = (v: unknown): v is ApiErrorCode => typeof v === "string" && Object.hasOwn(CODES, v);

/** Thrown for every reply that is not a success. `code` is the API error code and `status` is the HTTP status. */
export class CommentsApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(code: ApiErrorCode, status: number, message: string) {
    super(message);
    this.name = "CommentsApiError";
    this.code = code;
    this.status = status;
  }
}

export interface ClientOptions {
  /** The Worker origin, for example https://comments.example.com. The client adds /api/v1. */
  baseUrl: string;
  /** A bearer credential that the Worker's auth accepts. */
  token: string;
  fetch?: typeof fetch;
}

/**
 * Every method takes an optional signal. An aborted call rejects with the signal reason, not a
 * CommentsApiError. A write that was aborted after it was sent may still have applied: read the
 * thread before you try again.
 */
export interface CallOptions {
  signal?: AbortSignal;
}

export interface Me {
  kind: PrincipalKind;
  name: string;
  scopes: string[];
}

export type ThreadFilter = ListFilter;
export type SuggestionListFilter = Pick<ListFilter, "status" | "anchorState">;

/** What `exportPerson` returns: the messages and status changes of one person, and their suggestions. */
export type PersonData = PersonExport & { suggestions: PersonSuggestions };

/** What `erasePerson` changed in one document. */
export interface Erased {
  messages: number;
  statuses: number;
  edits: number;
  suggestions: number;
  decisions: number;
}

export interface CommentsClient {
  me(options?: CallOptions): Promise<Me>;
  createDocument(input: { id: string; text?: string }, options?: CallOptions): Promise<{ id: string }>;
  getDocument(docId: string, options?: CallOptions): Promise<{ id: string; text: string }>;
  listThreads(docId: string, filter?: ThreadFilter, options?: CallOptions): Promise<Thread[]>;
  getThread(docId: string, threadId: string, options?: CallOptions): Promise<Thread>;
  addThread(docId: string, input: { anchor: AnchorSpec; body: string; mentions?: string[] }, options?: CallOptions): Promise<Thread>;
  reply(docId: string, threadId: string, input: NewReply, options?: CallOptions): Promise<Message>;
  resolve(docId: string, threadId: string, options?: CallOptions): Promise<Thread>;
  reopen(docId: string, threadId: string, options?: CallOptions): Promise<Thread>;
  relocate(docId: string, threadId: string, options?: CallOptions): Promise<Thread>;
  editMessage(docId: string, threadId: string, messageId: string, input: { body: string; mentions?: string[] }, options?: CallOptions): Promise<Message>;
  deleteMessage(docId: string, threadId: string, messageId: string, options?: CallOptions): Promise<{ threadId: string; messageId: string }>;
  deleteThread(docId: string, threadId: string, options?: CallOptions): Promise<{ threadId: string }>;
  exportPerson(docId: string, person: string, options?: CallOptions): Promise<PersonData>;
  erasePerson(docId: string, person: string, options?: CallOptions): Promise<Erased>;
  listSuggestions(docId: string, filter?: SuggestionListFilter, options?: CallOptions): Promise<Suggestion[]>;
  suggest(docId: string, input: { anchor: AnchorSpec; change: unknown; summary?: string }, options?: CallOptions): Promise<Suggestion>;
  accept(docId: string, suggestionId: string, options?: CallOptions): Promise<Suggestion>;
  reject(docId: string, suggestionId: string, options?: CallOptions): Promise<Suggestion>;
}

// A success reply must have the expected shape, or the call fails. A proxy or a wrong baseUrl can
// answer 200 with any body.
type Shape = "me" | "created" | "document" | "thread" | "threads" | "message" | "suggestion" | "suggestions" | "deletedMessage" | "deletedThread" | "person" | "erased";

// A local list keeps agentic-identity out of the client bundle. The Record type fails the build if a kind is added.
const KINDS: Record<PrincipalKind, true> = { human: true, agent_of_human: true, agent_of_agent: true, agent: true, user_token: true };
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown) => typeof v === "string";
// One thread in an export. It reads SHAPES.message at call time, so it can sit above SHAPES.
const personThread = (v: unknown) =>
  isObject(v) && isString(v.threadId) && isObject(v.anchor) && Array.isArray(v.messages) && v.messages.every(SHAPES.message) &&
  (v.statusChange === undefined || isObject(v.statusChange));
const SHAPES: Record<Shape, (v: unknown) => boolean> = {
  me: (v) => isObject(v) && (typeof v.kind === "string" && Object.hasOwn(KINDS, v.kind)) && isString(v.name) && Array.isArray(v.scopes),
  created: (v) => isObject(v) && isString(v.id),
  document: (v) => isObject(v) && isString(v.id) && isString(v.text),
  thread: (v) => isObject(v) && isString(v.id) && isObject(v.anchor) && (v.status === "open" || v.status === "resolved") && Array.isArray(v.messages),
  threads: (v) => Array.isArray(v) && v.every(SHAPES.thread),
  message: (v) => isObject(v) && isString(v.id) && isString(v.body) && isObject(v.author),
  suggestion: (v) => isObject(v) && isString(v.id) && isObject(v.anchor) && isString(v.status) && isObject(v.author),
  suggestions: (v) => Array.isArray(v) && v.every(SHAPES.suggestion),
  deletedMessage: (v) => isObject(v) && isString(v.threadId) && isString(v.messageId),
  deletedThread: (v) => isObject(v) && isString(v.threadId),
  person: (v) =>
    isObject(v) && isString(v.person) && isString(v.exportedAt) && Array.isArray(v.threads) && v.threads.every(personThread) &&
    Array.isArray(v.edits) && v.edits.every((e) => isObject(e) && isString(e.threadId) && isString(e.messageId) && isString(e.at)) && typeof v.unread === "number" &&
    isObject(v.suggestions) && Array.isArray(v.suggestions.authored) && v.suggestions.authored.every(SHAPES.suggestion) &&
    Array.isArray(v.suggestions.decided) && v.suggestions.decided.every((d) => isObject(d) && isString(d.id) && (d.status === "accepted" || d.status === "rejected") && isString(d.at)) &&
    typeof v.suggestions.unread === "number",
  erased: (v) => isObject(v) && ["messages", "statuses", "edits", "suggestions", "decisions"].every((k) => typeof v[k] === "number"),
};

export function createClient(options: ClientOptions): CommentsClient {
  if (typeof options.baseUrl !== "string" || options.baseUrl === "") throw new TypeError("createClient needs a baseUrl");
  if (typeof options.token !== "string" || options.token === "") throw new TypeError("createClient needs a token");
  let origin: URL;
  try {
    origin = new URL(options.baseUrl);
  } catch {
    throw new TypeError("baseUrl must be an absolute URL");
  }
  if (origin.protocol !== "https:" && origin.protocol !== "http:") throw new TypeError("baseUrl must be an http or https URL");
  if (origin.search !== "" || origin.hash !== "" || origin.username !== "" || origin.password !== "") {
    throw new TypeError("baseUrl must have no query, hash, or credentials");
  }
  const root = `${origin.origin}${origin.pathname.replace(/\/+$/, "")}/api/v1`;
  const token = options.token;
  // Read at call time so a test can swap the global. A custom fetch is called as a plain function, with no `this`.
  const send = (input: string, init: RequestInit) => {
    const run = options.fetch ?? globalThis.fetch;
    return run(input, init);
  };
  // A segment of "", ".", or ".." is dropped or resolved by the URL parser, so the call would go to
  // another route. Refuse it, with its encoded forms.
  const seg = (value: string): string => {
    if (typeof value !== "string" || /^(?:\.|%2e){0,2}$/i.test(value)) throw new TypeError("an id must be a non-empty string that is not . or ..");
    return encodeURIComponent(value);
  };
  const query = (filter: object | undefined): string => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filter ?? {})) if (value !== undefined) params.set(key, String(value));
    const text = params.toString();
    return text === "" ? "" : `?${text}`;
  };

  async function call<T>(method: string, path: string, body: unknown, callOptions: CallOptions | undefined, shape: Shape): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await send(`${root}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: callOptions?.signal,
      // Never follow a redirect: it would send a write to another host.
      redirect: "manual",
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text === "" ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const error = (parsed as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
      const code = isKnownCode(error?.code) ? error.code : "UNKNOWN";
      const message = typeof error?.message === "string" ? error.message : `HTTP ${response.status}`;
      throw new CommentsApiError(code, response.status, message);
    }
    if (!SHAPES[shape](parsed)) throw new CommentsApiError("UNKNOWN", response.status, `the reply is not a ${shape}`);
    return parsed as T;
  }

  const doc = (id: string) => `/docs/${seg(id)}`;
  const thread = (id: string, threadId: string) => `${doc(id)}/threads/${seg(threadId)}`;
  const suggestion = (id: string, suggestionId: string) => `${doc(id)}/suggestions/${seg(suggestionId)}`;

  const methods: CommentsClient = {
    me: (o) => call("GET", "/me", undefined, o, "me"),
    createDocument: (input, o) => call("POST", "/docs", input, o, "created"),
    getDocument: (id, o) => call("GET", doc(id), undefined, o, "document"),
    listThreads: (id, filter, o) => call("GET", `${doc(id)}/threads${query(filter)}`, undefined, o, "threads"),
    getThread: (id, threadId, o) => call("GET", thread(id, threadId), undefined, o, "thread"),
    addThread: (id, input, o) => call("POST", `${doc(id)}/threads`, input, o, "thread"),
    reply: (id, threadId, input, o) => call("POST", `${thread(id, threadId)}/replies`, input, o, "message"),
    resolve: (id, threadId, o) => call("POST", `${thread(id, threadId)}/resolve`, undefined, o, "thread"),
    reopen: (id, threadId, o) => call("POST", `${thread(id, threadId)}/reopen`, undefined, o, "thread"),
    relocate: (id, threadId, o) => call("POST", `${thread(id, threadId)}/relocate`, undefined, o, "thread"),
    editMessage: (id, threadId, messageId, input, o) => call("PATCH", `${thread(id, threadId)}/messages/${seg(messageId)}`, input, o, "message"),
    deleteMessage: (id, threadId, messageId, o) => call("DELETE", `${thread(id, threadId)}/messages/${seg(messageId)}`, undefined, o, "deletedMessage"),
    deleteThread: (id, threadId, o) => call("DELETE", thread(id, threadId), undefined, o, "deletedThread"),
    exportPerson: (id, person, o) => call("GET", `${doc(id)}/people/${seg(person)}/export`, undefined, o, "person"),
    erasePerson: (id, person, o) => call("DELETE", `${doc(id)}/people/${seg(person)}`, undefined, o, "erased"),
    listSuggestions: (id, filter, o) => call("GET", `${doc(id)}/suggestions${query(filter)}`, undefined, o, "suggestions"),
    suggest: (id, input, o) => call("POST", `${doc(id)}/suggestions`, input, o, "suggestion"),
    accept: (id, suggestionId, o) => call("POST", `${suggestion(id, suggestionId)}/accept`, undefined, o, "suggestion"),
    reject: (id, suggestionId, o) => call("POST", `${suggestion(id, suggestionId)}/reject`, undefined, o, "suggestion"),
  };

  // A refused id throws inside a method, before any request. Every method returns a promise, so the
  // caller sees a rejection, not a throw.
  return Object.fromEntries(
    Object.entries(methods).map(([name, method]) => [name, async (...args: unknown[]) => (method as (...a: unknown[]) => Promise<unknown>)(...args)]),
  ) as unknown as CommentsClient;
}
