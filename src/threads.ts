import * as Y from "yjs";
import { BUILT_IN_KINDS, type Anchor, type AnchorKind } from "./anchor.js";
import { CommentsError } from "./errors.js";
import { assertActor, readAuthor, type Actor, type Author } from "./principal.js";

export interface Message {
  id: string;
  at: string;
  author: Author;
  body: string;
  /** Handles named in the body or listed on the input, without the `@`. */
  mentions: string[];
}

export interface Thread {
  id: string;
  anchor: Anchor;
  status: "open" | "resolved";
  /** Who last changed the status, and when. For a new thread, the person who opened it. */
  statusBy: Author;
  statusAt: string;
  messages: Message[];
}

export interface CommentsOptions {
  now?: () => Date;
  /** More anchor types. A type that is already built in is refused. */
  anchors?: AnchorKind[];
}

export interface NewThread {
  anchor: Anchor;
  body: string;
  mentions?: string[];
}

export interface NewReply {
  body: string;
  mentions?: string[];
}

export interface ThreadFilter {
  status?: Thread["status"];
  anchorType?: string;
  /** A handle, with or without the `@`. */
  mentioning?: string;
}

const THREADS = "comments.threads";
const MAX_BODY = 10_000;
const MAX_MENTIONS = 50;
const MAX_HANDLE = 128;
const STATUSES = ["open", "resolved"];
const MENTION = /(?<![\w@.])@([A-Za-z0-9][A-Za-z0-9_.-]{0,63})/g;

type Fields = Y.Map<unknown>;

const invalid = (message: string): never => {
  throw new CommentsError("INVALID_INPUT", message);
};

function exact(input: unknown, allowed: string[], what: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return invalid(`${what} must be an object`);
  const extra = Object.keys(input).filter((k) => !allowed.includes(k));
  if (extra.length > 0) invalid(`${what} does not accept ${extra.join(", ")}`);
  return input as Record<string, unknown>;
}

function body(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_BODY) invalid(`a body must be text of 1 to ${MAX_BODY} characters`);
  return value as string;
}

const handle = (value: string): string => (value.startsWith("@") ? value.slice(1) : value);

function mentionsOf(text: string, explicit: unknown): string[] {
  const found = [...text.matchAll(MENTION)].map((m) => m[1].replace(/[._-]+$/, ""));
  let listed: string[] = [];
  if (explicit !== undefined) {
    const ok = Array.isArray(explicit) && explicit.length <= MAX_MENTIONS && explicit.every((m) => typeof m === "string" && /^\S{1,128}$/.test(handle(m)) && handle(m).length <= MAX_HANDLE);
    if (!ok) invalid(`mentions must be a list of up to ${MAX_MENTIONS} handles with no spaces`);
    listed = (explicit as string[]).map(handle);
  }
  return [...new Set([...found, ...listed])];
}

const validDate = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));

/** Comment threads on a Yjs document. Replies and status merge across replicas. */
export class Comments {
  private readonly kinds = new Map<string, AnchorKind>();
  private readonly now: () => Date;

  constructor(
    private readonly ydoc: Y.Doc,
    options: CommentsOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    for (const kind of [...BUILT_IN_KINDS, ...(options.anchors ?? [])]) {
      if (typeof kind.type !== "string" || kind.type === "" || this.kinds.has(kind.type)) {
        throw new CommentsError("INVALID_ANCHOR", `the anchor type "${kind.type}" is empty or already defined`);
      }
      this.kinds.set(kind.type, kind);
    }
  }

  private get map(): Y.Map<Fields> {
    return this.ydoc.getMap<Fields>(THREADS);
  }

  private parseAnchor(raw: unknown): Anchor {
    const type = (raw as { type?: unknown } | null)?.type;
    const kind = typeof raw === "object" && raw !== null && !Array.isArray(raw) && typeof type === "string" ? this.kinds.get(type) : undefined;
    if (!kind) throw new CommentsError("INVALID_ANCHOR", `an anchor needs a type: ${[...this.kinds.keys()].join(", ")}`);
    try {
      return kind.parse(raw as Record<string, unknown>) as Anchor;
    } catch (error) {
      if (error instanceof CommentsError) throw error;
      throw new CommentsError("INVALID_ANCHOR", error instanceof Error ? error.message : String(error));
    }
  }

  private message(text: string, explicit: unknown, actor: Actor): Message {
    return {
      id: globalThis.crypto.randomUUID(),
      at: this.now().toISOString(),
      author: { kind: actor.kind, name: actor.name },
      body: text,
      mentions: mentionsOf(text, explicit),
    };
  }

  private readMessage(raw: unknown): Message {
    const m = (raw ?? {}) as Record<string, unknown>;
    const author = readAuthor(m.author);
    if (typeof m.id !== "string" || !validDate(m.at) || !author || typeof m.body !== "string" || m.body.trim() === "" || m.body.length > MAX_BODY) {
      throw new Error("a message has no id, time, valid author, or body");
    }
    if (!Array.isArray(m.mentions) || m.mentions.some((x) => typeof x !== "string")) throw new Error("a message has bad mentions");
    return { id: m.id, at: m.at, author, body: m.body, mentions: [...(m.mentions as string[])] };
  }

  private read(id: string, fields: unknown): Thread {
    try {
      if (!(fields instanceof Y.Map)) throw new Error("the thread is not a map");
      const state = (fields.get("state") ?? {}) as Record<string, unknown>;
      const by = readAuthor(state.by);
      if (!STATUSES.includes(state.status as string) || !by || !validDate(state.at)) throw new Error("the thread status is not valid");
      const list = fields.get("messages");
      if (!(list instanceof Y.Array) || list.length === 0) throw new Error("the thread has no messages");
      return {
        id,
        anchor: this.parseAnchor(fields.get("anchor")),
        status: state.status as Thread["status"],
        statusBy: by,
        statusAt: state.at,
        messages: list.toArray().map((m) => this.readMessage(m)),
      };
    } catch (error) {
      throw new CommentsError("CORRUPT", `thread "${id}" is malformed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private fields(id: unknown): { id: string; fields: Fields } {
    if (typeof id !== "string" || id === "" || !this.map.has(id)) throw new CommentsError("NO_THREAD", `no thread with id "${String(id)}"`);
    return { id, fields: this.map.get(id) as Fields };
  }

  /** Start a thread with its first message. The anchor and body are checked before anything is written. */
  add(input: NewThread, actor: Actor): Thread {
    const who = assertActor(actor);
    const given = exact(input, ["anchor", "body", "mentions"], "a new thread");
    const anchor = this.parseAnchor(given.anchor);
    const first = this.message(body(given.body), given.mentions, who);
    const id = globalThis.crypto.randomUUID();
    this.ydoc.transact(() => {
      const fields: Fields = new Y.Map();
      this.map.set(id, fields);
      fields.set("anchor", anchor);
      fields.set("state", { status: "open", by: first.author, at: first.at });
      const messages = new Y.Array<Message>();
      fields.set("messages", messages);
      messages.push([first]);
    });
    return this.get(id);
  }

  reply(threadId: string, input: NewReply, actor: Actor): Message {
    const who = assertActor(actor);
    const given = exact(input, ["body", "mentions"], "a reply");
    const { id, fields } = this.fields(threadId);
    const text = body(given.body);
    if (this.read(id, fields).status === "resolved") {
      throw new CommentsError("THREAD_RESOLVED", `thread "${id}" is resolved; reopen it to reply`);
    }
    const message = this.message(text, given.mentions, who);
    (fields.get("messages") as Y.Array<Message>).push([message]);
    return message;
  }

  private setStatus(threadId: string, status: Thread["status"], actor: Actor): Thread {
    const who = assertActor(actor);
    const { id, fields } = this.fields(threadId);
    const current = this.read(id, fields);
    if (current.status === status) return current;
    fields.set("state", { status, by: { kind: who.kind, name: who.name }, at: this.now().toISOString() });
    return this.get(id);
  }

  resolve(threadId: string, actor: Actor): Thread {
    return this.setStatus(threadId, "resolved", actor);
  }

  reopen(threadId: string, actor: Actor): Thread {
    return this.setStatus(threadId, "open", actor);
  }

  get(threadId: string): Thread {
    const { id, fields } = this.fields(threadId);
    return this.read(id, fields);
  }

  /** Threads in the order they were started. A malformed thread is skipped; `problems()` names it. */
  list(filter: ThreadFilter = {}): Thread[] {
    if (filter.status !== undefined && !STATUSES.includes(filter.status)) invalid(`status must be ${STATUSES.join(" or ")}`);
    const wanted = filter.mentioning === undefined ? undefined : handle(filter.mentioning);
    return this.readAll()
      .threads.filter((t) => filter.status === undefined || t.status === filter.status)
      .filter((t) => filter.anchorType === undefined || t.anchor.type === filter.anchorType)
      .filter((t) => wanted === undefined || t.messages.some((m) => m.mentions.includes(wanted)))
      .sort((a, b) => a.messages[0].at.localeCompare(b.messages[0].at) || a.id.localeCompare(b.id));
  }

  /** Threads that could not be read, for example from a replica that wrote bad data. */
  problems(): { id: string; reason: string }[] {
    return this.readAll().problems;
  }

  private readAll(): { threads: Thread[]; problems: { id: string; reason: string }[] } {
    const threads: Thread[] = [];
    const problems: { id: string; reason: string }[] = [];
    for (const [id, fields] of this.map.entries()) {
      try {
        threads.push(this.read(id, fields));
      } catch (error) {
        problems.push({ id, reason: (error as Error).message });
      }
    }
    return { threads, problems };
  }
}
