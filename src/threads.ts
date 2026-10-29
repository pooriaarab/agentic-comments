import * as Y from "yjs";
import { BUILT_IN_KINDS, MAX_ANCHOR, onlyOccurrence, textAnchor, textOf, textRange, textState, type Anchor, type AnchorKind, type AnchorState } from "./anchor.js";
import { CommentsError } from "./errors.js";
import { assertActor, ERASED_NAME, readAuthor, type Actor, type Author } from "./principal.js";
import { BODY_FORBIDDEN, ID, safeId, safeText, shown, VARIATION } from "./text.js";
import { copy, exact, invalid, ISO_TIME, strictCopy, validDate } from "./validate.js";

export interface Message {
  id: string;
  at: string;
  author: Author;
  body: string;
  /** Handles named in the body or listed on the input, without the `@`. */
  mentions: string[];
  /** Set when the message was edited. A message that was never edited has none. */
  editedAt?: string;
  editedBy?: Author;
  /** True for a message that `erasePerson` replaced with a tombstone. */
  erased?: true;
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
  /** Whether the anchored content is still there. A thread whose content is gone stays readable. */
  anchorState: AnchorState;
  /** How many stored entries this read did not show: invalid ones, repeated ids, and valid ones past the read limit. `problems()` names them. */
  skipped: number;
}

export interface CommentsOptions {
  now?: () => Date;
  /** More anchor types. A type that is already built in is refused. */
  anchors?: AnchorKind[];
  /**
   * Tell whether the content a cell, slide, canvas, or custom anchor points at still exists. Return `true`
   * or `false`. Any other answer, or a throw, means unknown. Text anchors do not need it.
   */
  exists?: (anchor: Anchor) => boolean | undefined;
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

export interface EditMessage {
  body: string;
  mentions?: string[];
}

/** What the store holds about one person in one document. It lists only that person's own words and acts. */
export interface PersonExport {
  person: string;
  exportedAt: string;
  threads: {
    threadId: string;
    anchor: Anchor;
    messages: Message[];
    /** Set when this person made the status change that stands now. */
    statusChange?: { status: Thread["status"]; at: string; by: Author };
  }[];
  /** Messages by other people that this person edited. */
  edits: { threadId: string; messageId: string; at: string }[];
  /** Stored entries with this person's name that the export cannot show. Not 0 means the export is not complete. */
  unread: number;
}

export interface ThreadFilter {
  status?: Thread["status"];
  anchorType?: string;
  /** A handle, with or without the `@`. */
  mentioning?: string;
  anchorState?: AnchorState["state"];
}

/** A scope that lets a principal edit, delete, export, or erase what another person wrote. A host gives it to an owner or admin. */
export const MODERATE_SCOPE = "comments:moderate";
/** What an erased message shows in place of its body. The author shows `ERASED_NAME`. */
export const ERASED_BODY = "[erased]";
export { ERASED_NAME };
const THREADS = "comments.threads";
const MAX_BODY = 10_000;
const MAX_MENTIONS = 50;
/**
 * A local reply stops here. Replicas that reply at once can go past it. A read shows the first READ_LIMIT
 * valid messages and reports the rest. A read still scans every stored entry.
 */
const MAX_MESSAGES = 1_000;
const READ_LIMIT = 2 * MAX_MESSAGES;
const STATUSES = ["open", "resolved"];
const ANCHOR_STATES = ["attached", "edited", "orphaned", "unknown"];
const HANDLE = /^[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}_.-]{0,62}[\p{L}\p{N}\p{M}])?$/u;
const MENTION = /(?<![\p{L}\p{N}_@.])@([\p{L}\p{N}][\p{L}\p{N}\p{M}_.-]*)(?![\p{L}\p{N}\p{M}_.-]|\/)/gu;

type Fields = Y.Map<unknown>;

function body(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_BODY || BODY_FORBIDDEN.test(value)) {
    invalid(`a body must be text of 1 to ${MAX_BODY} characters, with no control, invisible, or direction characters`);
  }
  return value as string;
}

/** Handles are lowercased, lose any leading `@`, and use one Unicode form. They are stored in this form. */
const handle = (value: string): string => value.normalize("NFC").replace(/^@+/, "").toLowerCase().normalize("NFC");

const okHandle = (value: string): boolean => HANDLE.test(value) && !VARIATION.test(value);

const validHandle = (value: unknown): value is string => typeof value === "string" && okHandle(value) && handle(value) === value;

function mentionsOf(text: string, explicit: unknown): string[] {
  const prose = text.replace(/`[^`]*`/g, " ");
  const found = [...prose.matchAll(MENTION)].map((m) => {
    const name = m[1].replace(/[._-]+$/, "");
    if (!okHandle(handle(name))) invalid(`"@${name.slice(0, 20)}" is not a valid handle: use up to 64 characters`);
    return handle(name);
  });
  let listed: string[] = [];
  if (explicit !== undefined) {
    const snapshot: unknown[] = Array.isArray(explicit) ? Array.from(explicit) : [];
    const ok = Array.isArray(explicit) && snapshot.length <= MAX_MENTIONS && snapshot.every((m) => typeof m === "string" && okHandle(handle(m)));
    if (!ok) invalid(`mentions must be a list of up to ${MAX_MENTIONS} handles of letters, digits, and . _ -`);
    listed = (snapshot as string[]).map(handle);
  }
  const all = [...new Set([...found, ...listed])];
  if (all.length > MAX_MENTIONS) invalid(`a message can mention up to ${MAX_MENTIONS} handles`);
  return all;
}

/** Comment threads on a Yjs document. Replies and status merge across replicas. */
export class Comments {
  private readonly kinds = new Map<string, AnchorKind>();
  private readonly now: () => Date;
  private readonly exists?: (anchor: Anchor) => boolean | undefined;

  /** Every replica of a document must register the same custom anchor kinds. Others read those threads as malformed. */
  constructor(
    readonly ydoc: Y.Doc,
    options: CommentsOptions = {},
  ) {
    if (typeof options !== "object" || options === null || (options.now !== undefined && typeof options.now !== "function") || (options.anchors !== undefined && !Array.isArray(options.anchors)) || (options.exists !== undefined && typeof options.exists !== "function")) {
      invalid("options must be an object with an optional now function, anchors list, and exists function");
    }
    this.now = options.now ?? (() => new Date());
    this.exists = options.exists;
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

  /** The Yjs map that holds the threads. `Notifications` watches it. */
  get threadsMap(): Y.Map<Y.Map<unknown>> {
    return this.map;
  }

  /** The clock, as an ISO time. Used by `Suggestions`. */
  time(): string {
    const at = this.now();
    const text = at instanceof Date && !Number.isNaN(at.getTime()) ? at.toISOString() : "";
    if (!ISO_TIME.test(text)) invalid("the clock must return a date between the years 0000 and 9999");
    return text;
  }

  /** Whether the content under an anchor is still there. This never throws. */
  anchorState(anchor: Anchor): AnchorState {
    if (anchor.type === "text") return textState(anchor, this.ydoc);
    if (!this.exists) return { state: "unknown" };
    try {
      const answer = this.exists(anchor);
      return answer === true ? { state: "attached" } : answer === false ? { state: "orphaned" } : { state: "unknown" };
    } catch {
      return { state: "unknown" };
    }
  }

  /** Read an anchor from stored data. This does not check the document. */
  parseAnchor(raw: unknown): Anchor {
    const type = (raw as { type?: unknown } | null)?.type;
    const kind = typeof raw === "object" && raw !== null && !Array.isArray(raw) && typeof type === "string" ? this.kinds.get(type) : undefined;
    if (!kind) throw new CommentsError("INVALID_ANCHOR", `an anchor needs a type: ${[...this.kinds.keys()].join(", ")}`);
    try {
      const parsed = copy(kind.parse(strictCopy(raw) as Record<string, unknown>));
      if (JSON.stringify(parsed).length > MAX_ANCHOR) throw new Error(`an anchor holds up to ${MAX_ANCHOR} characters of JSON`);
      if (parsed?.type !== kind.type) throw new Error(`the "${kind.type}" kind must return an anchor of its own type`);
      return parsed as Anchor;
    } catch (error) {
      if (error instanceof CommentsError) throw error;
      throw new CommentsError("INVALID_ANCHOR", error instanceof Error ? error.message : String(error));
    }
  }

  /** Parse an anchor from input and check it against this document. Throws `INVALID_ANCHOR` when it fails. */
  checkAnchor(raw: unknown): Anchor {
    const anchor = this.parseAnchor(raw);
    if (JSON.stringify(this.parseAnchor(anchor)) !== JSON.stringify(anchor)) {
      throw new CommentsError("INVALID_ANCHOR", "an anchor kind must parse its own output to the same anchor");
    }
    this.checkInDocument(anchor);
    return anchor;
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
    if (typeof m.id !== "string" || !ID.test(m.id) || !validDate(m.at) || !author || typeof m.body !== "string" || m.body.trim() === "" || m.body.length > MAX_BODY || BODY_FORBIDDEN.test(m.body)) {
      throw new Error("a message has no id, ISO time, valid author, or body");
    }
    if (!Array.isArray(m.mentions) || m.mentions.length > MAX_MENTIONS || !m.mentions.every(validHandle)) throw new Error("a message has bad mentions");
    const editor = m.editedBy === undefined ? undefined : readAuthor(m.editedBy);
    if ((m.editedAt === undefined) !== (m.editedBy === undefined) || (m.editedAt !== undefined && !validDate(m.editedAt)) || (m.editedBy !== undefined && !editor)) {
      throw new Error("a message has a bad edit stamp");
    }
    if (m.erased !== undefined && (m.erased !== true || m.body !== ERASED_BODY || author.name !== ERASED_NAME || m.mentions.length > 0)) throw new Error("a message has a bad erased flag");
    return {
      id: m.id,
      at: m.at,
      author,
      body: m.body,
      mentions: [...(m.mentions as string[])],
      ...(editor ? { editedAt: m.editedAt as string, editedBy: editor } : {}),
      ...(m.erased ? { erased: true as const } : {}),
    };
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
      const raw = list.toArray();
      const counts = new Map<unknown, number>();
      for (const m of raw) counts.set((m as { id?: unknown } | null)?.id, (counts.get((m as { id?: unknown } | null)?.id) ?? 0) + 1);
      const parsed = raw.map((entry) => {
        try {
          return { message: this.readMessage(entry) };
        } catch (error) {
          return { error: error as Error };
        }
      });
      const copies = (id: string) => parsed.flatMap((p) => (p.message?.id === id ? [p.message] : []));
      let past = 0;
      let superseded = 0;
      parsed.forEach((entry, index) => {
        try {
          if (entry.error) throw entry.error;
          const message = entry.message;
          if (counts.get(message.id)! > 1) {
            // Replicas that edit one message at once leave a copy each. Edited copies resolve to one: an erased copy, then the latest edit.
            const same = copies(message.id);
            const names = new Set(same.filter((c) => !c.erased).map((c) => c.author.name));
            const agree = same.every((c) => c.editedAt !== undefined && c.at === message.at && c.author.kind === message.author.kind) && names.size <= 1;
            if (same.length !== counts.get(message.id) || !agree) throw new Error("a message id repeats");
            const rank = (c: Message) => `${c.erased ? 1 : 0}${c.editedAt}${JSON.stringify(c)}`;
            const best = same.reduce((a, b) => (rank(b) > rank(a) ? b : a));
            if (best !== message) {
              superseded++;
              return;
            }
          }
          if (messages.length >= READ_LIMIT) past++;
          else messages.push(message);
        } catch (error) {
          issues.push(`message ${index} skipped: ${safeText((error as Error).message)}`);
        }
      });
      if (past > 0) issues.push(`${past} valid messages past the read limit are not shown`);
      if (messages.length === 0) throw new Error("the thread has no valid message");
      const anchor = this.parseAnchor(fields.get("anchor"));
      const thread: Thread = { id, anchor, anchorState: this.anchorState(anchor), status: state.status as Thread["status"], statusBy: by, statusAt: state.at, messages, skipped: raw.length - messages.length - superseded };
      return { thread, issues };
    } catch (error) {
      throw new CommentsError("CORRUPT", `thread ${shown(id)} is malformed: ${safeText(error instanceof Error ? error.message : error)}`);
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
    const anchor = this.checkAnchor(given.anchor);
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

  /**
   * Move a text anchor whose range is gone or edited to its quote, when the quote occurs exactly once in
   * the same text. There is no fuzzy match. Throws `RELOCATE_FAILED` when it cannot say where. An attached
   * thread is returned as it is.
   */
  relocate(threadId: string, actor: Actor): Thread {
    assertActor(actor);
    const { id, fields } = this.fields(threadId);
    const { thread } = this.read(id, fields);
    const anchor = thread.anchor;
    if (anchor.type !== "text") return invalid("only a text anchor can be relocated");
    if (thread.anchorState.state === "attached") return thread;
    const range = textRange(anchor, this.ydoc);
    const at = range ? onlyOccurrence(range.type, anchor.text) : undefined;
    if (!range || at === undefined) {
      throw new CommentsError("RELOCATE_FAILED", `the quoted text does not occur exactly once, so thread ${shown(id)} cannot be moved`);
    }
    fields.set("anchor", textAnchor(range.type, at, at + anchor.text.length));
    return this.get(id);
  }

  resolve(threadId: string, actor: Actor): Thread {
    return this.setStatus(threadId, "resolved", actor);
  }

  reopen(threadId: string, actor: Actor): Thread {
    return this.setStatus(threadId, "open", actor);
  }

  /** A principal may change what it wrote. A principal with the moderate scope may change what anyone wrote. A tombstone is nobody's. */
  private mayChange(who: Actor, message: Message): boolean {
    return who.scopes.includes(MODERATE_SCOPE) || (!message.erased && who.kind === message.author.kind && who.name === message.author.name);
  }

  private forbid(who: Actor, what: string): never {
    throw new CommentsError("FORBIDDEN", `${who.kind}:${shown(who.name)} cannot ${what}: only its author, or a principal with the ${MODERATE_SCOPE} scope, can`);
  }

  /** Replace every stored copy of a message with `next`, or remove it when `next` is undefined. */
  private rewrite(fields: Fields, messageId: string, next: Message | undefined): void {
    const list = fields.get("messages") as Y.Array<Message>;
    const at = list.toArray().flatMap((m, i) => ((m as { id?: unknown } | null)?.id === messageId ? [i] : []));
    this.ydoc.transact(() => {
      for (const i of [...at].reverse()) list.delete(i, 1);
      if (next) list.insert(at[0], [copy(next)]);
    });
  }

  private find(threadId: string, messageId: unknown): { id: string; fields: Fields; thread: Thread; message: Message } {
    const { id, fields } = this.fields(threadId);
    const { thread } = this.read(id, fields);
    const message = thread.messages.find((m) => m.id === messageId);
    if (!message) throw new CommentsError("NO_MESSAGE", `thread ${shown(id)} has no message with id ${shown(messageId)}`);
    return { id, fields, thread, message };
  }

  /** Change the body of a message. Its author and time stay, and it records who edited it and when. */
  editMessage(threadId: string, messageId: string, input: EditMessage, actor: Actor): Message {
    const who = assertActor(actor);
    const given = exact(input, ["body", "mentions"], "an edit");
    const text = body(given.body);
    const { id, fields, thread, message } = this.find(threadId, messageId);
    if (message.erased) throw new CommentsError("FORBIDDEN", "an erased message cannot be edited");
    if (!this.mayChange(who, message)) this.forbid(who, "edit this message");
    if (thread.status === "resolved") throw new CommentsError("THREAD_RESOLVED", `thread ${shown(id)} is resolved; reopen it to edit`);
    const next = this.readEdited(message, text, given.mentions, who);
    this.rewrite(fields, message.id, next);
    return this.find(id, message.id).message;
  }

  private readEdited(message: Message, text: string, explicit: unknown, who: Actor): Message {
    const edited = { ...message, body: text, mentions: mentionsOf(text, explicit), editedAt: this.time(), editedBy: { kind: who.kind, name: who.name } };
    try {
      return this.readMessage(copy(edited));
    } catch (error) {
      return invalid(`the message cannot be stored: ${(error as Error).message}`);
    }
  }

  /**
   * Remove one message. The last message of a thread stays: delete the thread instead. Replicas that delete
   * two messages at once can leave a thread with none. A moderator can still delete that thread.
   */
  deleteMessage(threadId: string, messageId: string, actor: Actor): { threadId: string; messageId: string } {
    const who = assertActor(actor);
    const { id, fields, thread, message } = this.find(threadId, messageId);
    if (!this.mayChange(who, message)) this.forbid(who, "delete this message");
    if (thread.messages.length === 1) invalid(`thread ${shown(id)} has only this message; delete the thread instead`);
    this.rewrite(fields, message.id, undefined);
    return { threadId: id, messageId: message.id };
  }

  /**
   * Remove a thread and all its messages. Its author may do it when every message is theirs. Once someone
   * else replied, a message is erased, or a stored message cannot be read, it needs the moderate scope. A
   * moderator can also remove a thread that cannot be read at all.
   */
  deleteThread(threadId: string, actor: Actor): { threadId: string } {
    const who = assertActor(actor);
    const { id, fields } = this.fields(threadId);
    if (!who.scopes.includes(MODERATE_SCOPE)) {
      const { thread } = this.read(id, fields);
      if (thread.skipped > 0 || !thread.messages.every((m) => this.mayChange(who, m))) this.forbid(who, "delete this thread");
    }
    this.map.delete(id);
    return { threadId: id };
  }

  /**
   * Check who an export or erase is for, and that the actor may. A person may act on their own data: the same
   * kind and name. A principal with the moderate scope may act on anyone's, and then every kind with that name is
   * included. Returns the name and a test for an author. Used by `Suggestions`.
   */
  checkPerson(person: unknown, actor: Actor): { name: string; match: (author: Author) => boolean } {
    const who = assertActor(actor);
    if (typeof person !== "string" || person === "" || person !== person.trim() || person.length > 128) invalid("a person is a name of 1 to 128 characters");
    if (person === ERASED_NAME) invalid("a tombstone is not a person");
    const moderator = who.scopes.includes(MODERATE_SCOPE);
    if (who.name !== person && !moderator) {
      throw new CommentsError("FORBIDDEN", `${who.kind}:${shown(who.name)} cannot read or erase the data of another person without the ${MODERATE_SCOPE} scope`);
    }
    return { name: person as string, match: (a) => a.name === person && (moderator || a.kind === who.kind) };
  }

  /** The raw stored messages and status record, for the code that must see data a read hides. */
  private stored(): { id: string; fields: Fields; list: Y.Array<unknown> }[] {
    return [...this.map.entries()].flatMap(([id, fields]) => (fields instanceof Y.Map && fields.get("messages") instanceof Y.Array ? [{ id, fields, list: fields.get("messages") as Y.Array<unknown> }] : []));
  }

  /**
   * What a person wrote in this document: their messages, the status change of theirs that stands, and the
   * edits they made to other people's messages. `unread` counts stored entries with their name that this read
   * cannot show: a bad message, a thread that cannot be read, a message past the read limit, or a copy that
   * lost a merge. When it is not 0 the export is not complete. A person may export their own data.
   */
  exportPerson(person: string, actor: Actor): PersonExport {
    const { name, match } = this.checkPerson(person, actor);
    const threads: PersonExport["threads"] = [];
    const edits: PersonExport["edits"] = [];
    let shownCount = 0;
    for (const thread of this.list()) {
      const messages = thread.messages.filter((m) => match(m.author));
      shownCount += messages.length;
      const status = match(thread.statusBy);
      if (status) shownCount++;
      for (const m of thread.messages) if (m.editedBy && match(m.editedBy) && !match(m.author)) edits.push({ threadId: thread.id, messageId: m.id, at: m.editedAt as string });
      if (messages.length === 0 && !status) continue;
      threads.push({
        threadId: thread.id,
        anchor: copy(thread.anchor),
        messages: copy(messages),
        ...(status ? { statusChange: { status: thread.status, at: thread.statusAt, by: copy(thread.statusBy) } } : {}),
      });
    }
    // Count every stored place that erase would rewrite, and subtract what this export shows.
    let found = 0;
    const named = (value: unknown) => {
      const author = readAuthor(value);
      return author !== undefined && match(author);
    };
    for (const { fields, list } of this.stored()) {
      for (const raw of list.toArray() as ({ author?: unknown; editedBy?: unknown } | null)[]) if (named(raw?.author) || named(raw?.editedBy)) found++;
      if (named((fields.get("state") as { by?: unknown } | undefined)?.by)) found++;
    }
    return { person: name, exportedAt: this.time(), threads, edits, unread: Math.max(0, found - shownCount - edits.length) };
  }

  /**
   * Replace every message a person wrote with a tombstone: the body becomes "[erased]", the author name
   * becomes "erased", and the mentions go. The author kind stays, so machine-made work stays marked. Thread
   * shape, order, and times stay. A status change of theirs, and their name as the editor of another person's
   * message, get the tombstone name. It works on the stored entries, so it reaches a bad message, a message past
   * the read limit, a thread that cannot be read, and every copy that a merge hid. Names inside other people's
   * messages are not touched. Returns how many messages, status changes, and edit stamps it erased.
   */
  erasePerson(person: string, actor: Actor): { messages: number; statuses: number; edits: number } {
    const { match } = this.checkPerson(person, actor);
    const tomb = (a: Author): Author => ({ kind: a.kind, name: ERASED_NAME });
    const out = { messages: 0, statuses: 0, edits: 0 };
    this.ydoc.transact(() => {
      for (const { fields, list } of this.stored()) {
        const entries = list.toArray();
        for (let i = entries.length - 1; i >= 0; i--) {
          const raw = entries[i] as Record<string, unknown> | null;
          if (typeof raw !== "object" || raw === null) continue;
          const author = readAuthor(raw.author);
          const editor = readAuthor(raw.editedBy);
          let next: Record<string, unknown> | undefined;
          if (author && match(author)) {
            const id = typeof raw.id === "string" && ID.test(raw.id) ? raw.id : globalThis.crypto.randomUUID();
            const at = validDate(raw.at) ? raw.at : this.time();
            next = { id, at, author: tomb(author), body: ERASED_BODY, mentions: [], editedAt: this.time(), editedBy: tomb(author), erased: true };
            out.messages++;
          } else if (editor && match(editor)) {
            next = { ...raw, editedBy: tomb(editor) };
            out.edits++;
          }
          if (!next) continue;
          list.delete(i, 1);
          list.insert(i, [next as unknown as Message]);
        }
        const state = fields.get("state") as { status?: unknown; by?: unknown; at?: unknown } | undefined;
        const by = readAuthor(state?.by);
        if (state && by && match(by)) {
          fields.set("state", { ...state, by: tomb(by) });
          out.statuses++;
        }
      }
    });
    return out;
  }

  get(threadId: string): Thread {
    const { id, fields } = this.fields(threadId);
    return this.read(id, fields).thread;
  }

  /** Threads in the order they were started. A malformed thread is skipped; `problems()` names it. */
  list(filter: ThreadFilter = {}): Thread[] {
    const given = exact(filter, ["status", "anchorType", "mentioning", "anchorState"], "a filter");
    if (given.status !== undefined && !STATUSES.includes(given.status as string)) invalid(`status must be ${STATUSES.join(" or ")}`);
    if (given.anchorType !== undefined && typeof given.anchorType !== "string") invalid("anchorType must be text");
    if (given.mentioning !== undefined && typeof given.mentioning !== "string") invalid("mentioning must be text");
    if (given.anchorState !== undefined && !ANCHOR_STATES.includes(given.anchorState as string)) invalid(`anchorState must be ${ANCHOR_STATES.join(", ")}`);
    const wanted = given.mentioning === undefined ? undefined : handle(given.mentioning as string);
    return this.readAll()
      .threads.filter((t) => given.status === undefined || t.status === given.status)
      .filter((t) => given.anchorType === undefined || t.anchor.type === given.anchorType)
      .filter((t) => given.anchorState === undefined || t.anchorState.state === given.anchorState)
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
        for (const reason of issues) problems.push({ id: safeId(id), reason });
      } catch (error) {
        problems.push({ id: safeId(id), reason: (error as Error).message });
      }
    }
    return { threads, problems };
  }
}
