import * as Y from "yjs";
import { BUILT_IN_KINDS, textOf, type Anchor, type AnchorKind } from "./anchor.js";
import { CommentsError } from "./errors.js";
import { assertActor, readAuthor, type Actor, type Author } from "./principal.js";
import { ID, shown } from "./text.js";

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
  /**
   * The status change that won, and when. For a new thread, who opened it. Replicas that change the
   * status at once agree on one change. Yjs picks it by client id, not by time.
   */
  statusBy: Author;
  statusAt: string;
  messages: Message[];
  /** How many stored messages this read left out because they were not valid. `problems()` names them. */
  skipped: number;
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
/** A local reply stops here. Replicas that reply at once can go past it, so a read shows up to twice as many. */
const MAX_MESSAGES = 1_000;
const READ_LIMIT = 2 * MAX_MESSAGES;
const MAX_ANCHOR = 4_096;
const STATUSES = ["open", "resolved"];
const HANDLE = /^[\p{L}\p{N}](?:[\p{L}\p{N}_.-]{0,62}[\p{L}\p{N}])?$/u;
const MENTION = /(?<![\p{L}\p{N}_@.])@([\p{L}\p{N}][\p{L}\p{N}_.-]{0,63})/gu;

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

/** Handles match without case and without leading `@`. They are stored in this form. */
const handle = (value: string): string => value.replace(/^@+/, "").toLowerCase();

const validHandle = (value: unknown): value is string => typeof value === "string" && HANDLE.test(value) && handle(value) === value;

function mentionsOf(text: string, explicit: unknown): string[] {
  const found = [...text.matchAll(MENTION)].map((m) => handle(m[1].replace(/[._-]+$/, "")));
  let listed: string[] = [];
  if (explicit !== undefined) {
    const snapshot: unknown[] = Array.isArray(explicit) ? Array.from(explicit) : [];
    const ok = Array.isArray(explicit) && snapshot.length <= MAX_MENTIONS && snapshot.every((m) => typeof m === "string" && HANDLE.test(handle(m)));
    if (!ok) invalid(`mentions must be a list of up to ${MAX_MENTIONS} handles of letters, digits, and . _ -`);
    listed = (snapshot as string[]).map(handle);
  }
  const all = [...new Set([...found, ...listed])];
  if (all.length > MAX_MENTIONS) invalid(`a message can mention up to ${MAX_MENTIONS} handles`);
  return all;
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const validDate = (value: unknown): value is string => typeof value === "string" && ISO_TIME.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;

/** A copy that shares nothing with the original, so a caller cannot change what Yjs holds. */
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Comment threads on a Yjs document. Replies and status merge across replicas. */
export class Comments {
  private readonly kinds = new Map<string, AnchorKind>();
  private readonly now: () => Date;

  /** Every replica of a document must register the same custom anchor kinds. Others read those threads as malformed. */
  constructor(
    private readonly ydoc: Y.Doc,
    options: CommentsOptions = {},
  ) {
    if (typeof options !== "object" || options === null || (options.now !== undefined && typeof options.now !== "function") || (options.anchors !== undefined && !Array.isArray(options.anchors))) {
      invalid("options must be an object with an optional now function and an optional anchors list");
    }
    this.now = options.now ?? (() => new Date());
    for (const kind of [...BUILT_IN_KINDS, ...(options.anchors ?? [])]) {
      if (typeof kind?.type !== "string" || kind.type === "" || typeof kind.parse !== "function" || this.kinds.has(kind.type)) {
        throw new CommentsError("INVALID_ANCHOR", `the anchor type "${String(kind?.type)}" is empty, has no parse, or is already defined`);
      }
      this.kinds.set(kind.type, kind);
    }
  }

  private get map(): Y.Map<Fields> {
    return this.ydoc.getMap<Fields>(THREADS);
  }

  private time(): string {
    const at = this.now();
    const text = at instanceof Date && !Number.isNaN(at.getTime()) ? at.toISOString() : "";
    if (!ISO_TIME.test(text)) invalid("the clock must return a date between the years 0000 and 9999");
    return text;
  }

  private parseAnchor(raw: unknown): Anchor {
    const type = (raw as { type?: unknown } | null)?.type;
    const kind = typeof raw === "object" && raw !== null && !Array.isArray(raw) && typeof type === "string" ? this.kinds.get(type) : undefined;
    if (!kind) throw new CommentsError("INVALID_ANCHOR", `an anchor needs a type: ${[...this.kinds.keys()].join(", ")}`);
    try {
      const parsed = copy(kind.parse(copy(raw) as Record<string, unknown>));
      if (JSON.stringify(parsed).length > MAX_ANCHOR) throw new Error(`an anchor holds up to ${MAX_ANCHOR} characters of JSON`);
      if (parsed?.type !== kind.type) throw new Error(`the "${kind.type}" kind must return an anchor of its own type`);
      return parsed as Anchor;
    } catch (error) {
      if (error instanceof CommentsError) throw error;
      throw new CommentsError("INVALID_ANCHOR", error instanceof Error ? error.message : String(error));
    }
  }

  /** A text anchor must name text in this document, in order, and match its quote. */
  private checkInDocument(anchor: Anchor): void {
    if (anchor.type !== "text") return;
    const at = (json: object) => {
      try {
        return Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), this.ydoc);
      } catch {
        return null;
      }
    };
    const from = at(anchor.start);
    const to = at(anchor.end);
    const unit = from?.type;
    if (!(unit instanceof Y.Text) || !from || !to || to.type !== unit || to.index <= from.index || textOf(unit).slice(from.index, to.index) !== anchor.text) {
      throw new CommentsError("INVALID_ANCHOR", "a text anchor must name text in this document, in order, matching its quoted text");
    }
  }

  /** Build a message, and refuse it unless a read would show it back. Nothing is written yet. */
  private message(text: string, explicit: unknown, actor: Actor): Message {
    const message: Message = {
      id: globalThis.crypto.randomUUID(),
      at: this.time(),
      author: { kind: actor.kind, name: actor.name },
      body: text,
      mentions: mentionsOf(text, explicit),
    };
    try {
      return this.readMessage(copy(message));
    } catch (error) {
      return invalid(`the message cannot be stored: ${(error as Error).message}`);
    }
  }

  private readMessage(raw: unknown): Message {
    const m = (raw ?? {}) as Record<string, unknown>;
    const author = readAuthor(m.author);
    if (typeof m.id !== "string" || !ID.test(m.id) || !validDate(m.at) || !author || typeof m.body !== "string" || m.body.trim() === "" || m.body.length > MAX_BODY) {
      throw new Error("a message has no id, ISO time, valid author, or body");
    }
    if (!Array.isArray(m.mentions) || m.mentions.length > MAX_MENTIONS || !m.mentions.every(validHandle)) throw new Error("a message has bad mentions");
    return { id: m.id, at: m.at, author, body: m.body, mentions: [...(m.mentions as string[])] };
  }

  /** A thread with a bad anchor or status is malformed. A bad message is skipped and named in `issues`. */
  private read(id: string, fields: unknown): { thread: Thread; issues: string[] } {
    try {
      if (!ID.test(id)) throw new Error("the thread id is not short and plain");
      if (!(fields instanceof Y.Map)) throw new Error("the thread is not a map");
      const state = (fields.get("state") ?? {}) as Record<string, unknown>;
      const by = readAuthor(state.by);
      if (!STATUSES.includes(state.status as string) || !by || !validDate(state.at)) throw new Error("the thread status is not valid");
      const list = fields.get("messages");
      if (!(list instanceof Y.Array)) throw new Error("the thread has no message list");
      const messages: Message[] = [];
      const issues: string[] = [];
      const raw = list.toArray().slice(0, READ_LIMIT);
      if (list.length > READ_LIMIT) issues.push(`${list.length - READ_LIMIT} messages past the read limit are not shown`);
      const counts = new Map<unknown, number>();
      for (const m of raw) counts.set((m as { id?: unknown } | null)?.id, (counts.get((m as { id?: unknown } | null)?.id) ?? 0) + 1);
      raw.forEach((entry, index) => {
        try {
          const message = this.readMessage(entry);
          if (counts.get(message.id)! > 1) throw new Error("a message id repeats");
          messages.push(message);
        } catch (error) {
          issues.push(`message ${index} skipped: ${(error as Error).message}`);
        }
      });
      if (messages.length === 0) throw new Error("the thread has no valid message");
      const thread: Thread = { id, anchor: this.parseAnchor(fields.get("anchor")), status: state.status as Thread["status"], statusBy: by, statusAt: state.at, messages, skipped: issues.filter((i) => i.startsWith("message ")).length };
      return { thread, issues };
    } catch (error) {
      throw new CommentsError("CORRUPT", `thread ${shown(id)} is malformed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private fields(id: unknown): { id: string; fields: Fields } {
    if (typeof id !== "string" || !ID.test(id) || !this.map.has(id)) throw new CommentsError("NO_THREAD", `no thread with id ${shown(id)}`);
    return { id, fields: this.map.get(id) as Fields };
  }

  /** Start a thread with its first message. The anchor and body are checked before anything is written. */
  add(input: NewThread, actor: Actor): Thread {
    const who = assertActor(actor);
    const given = exact(input, ["anchor", "body", "mentions"], "a new thread");
    const anchor = this.parseAnchor(given.anchor);
    this.checkInDocument(anchor);
    const first = this.message(body(given.body), given.mentions, who);
    const id = globalThis.crypto.randomUUID();
    this.ydoc.transact(() => {
      const fields: Fields = new Y.Map();
      this.map.set(id, fields);
      fields.set("anchor", anchor);
      fields.set("state", { status: "open", by: copy(first.author), at: first.at });
      const messages = new Y.Array<Message>();
      fields.set("messages", messages);
      messages.push([copy(first)]);
    });
    return this.get(id);
  }

  /**
   * Add a message. The resolved check runs on this replica only. A reply and a resolve made at once
   * on two replicas both stay, and the merged thread is resolved with the reply in it.
   */
  reply(threadId: string, input: NewReply, actor: Actor): Message {
    const who = assertActor(actor);
    const given = exact(input, ["body", "mentions"], "a reply");
    const { id, fields } = this.fields(threadId);
    const text = body(given.body);
    const { thread } = this.read(id, fields);
    if (thread.status === "resolved") throw new CommentsError("THREAD_RESOLVED", `thread ${shown(id)} is resolved; reopen it to reply`);
    if (thread.messages.length >= MAX_MESSAGES) invalid(`thread ${shown(id)} shows ${MAX_MESSAGES} messages and takes no more`);
    const list = fields.get("messages") as Y.Array<Message>;
    const message = this.message(text, given.mentions, who);
    list.push([copy(message)]);
    return message;
  }

  private setStatus(threadId: string, status: Thread["status"], actor: Actor): Thread {
    const who = assertActor(actor);
    const { id, fields } = this.fields(threadId);
    const { thread } = this.read(id, fields);
    if (thread.status === status) return thread;
    fields.set("state", { status, by: { kind: who.kind, name: who.name }, at: this.time() });
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
    return this.read(id, fields).thread;
  }

  /** Threads in the order they were started. A malformed thread is skipped; `problems()` names it. */
  list(filter: ThreadFilter = {}): Thread[] {
    const given = exact(filter, ["status", "anchorType", "mentioning"], "a filter");
    if (given.status !== undefined && !STATUSES.includes(given.status as string)) invalid(`status must be ${STATUSES.join(" or ")}`);
    if (given.anchorType !== undefined && typeof given.anchorType !== "string") invalid("anchorType must be text");
    if (given.mentioning !== undefined && typeof given.mentioning !== "string") invalid("mentioning must be text");
    const wanted = given.mentioning === undefined ? undefined : handle(given.mentioning as string);
    return this.readAll()
      .threads.filter((t) => given.status === undefined || t.status === given.status)
      .filter((t) => given.anchorType === undefined || t.anchor.type === given.anchorType)
      .filter((t) => wanted === undefined || t.messages.some((m) => m.mentions.includes(wanted)))
      .sort((a, b) => Date.parse(a.messages[0].at) - Date.parse(b.messages[0].at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Threads or messages that could not be read, for example from a replica that wrote bad data. */
  problems(): { id: string; reason: string }[] {
    return this.readAll().problems;
  }

  private readAll(): { threads: Thread[]; problems: { id: string; reason: string }[] } {
    const threads: Thread[] = [];
    const problems: { id: string; reason: string }[] = [];
    for (const [id, fields] of this.map.entries()) {
      try {
        const { thread, issues } = this.read(id, fields);
        threads.push(thread);
        for (const reason of issues) problems.push({ id: id.slice(0, 64), reason });
      } catch (error) {
        problems.push({ id: id.slice(0, 64), reason: (error as Error).message });
      }
    }
    return { threads, problems };
  }
}
