import * as Y from "yjs";
import type { Author } from "./principal.js";
import type { Suggestions } from "./suggestions.js";
import type { Comments } from "./threads.js";

export type CommentEventType =
  | "thread.created"
  | "message.added"
  | "mention"
  | "thread.resolved"
  | "thread.reopened"
  | "suggestion.created"
  | "suggestion.accepted"
  | "suggestion.rejected";

/**
 * One change, in terms a notifier can route. It holds ids and never the text of a comment, a suggestion, or
 * a change, so a log or a queue that stores it holds no content. Fetch the content with the ids.
 */
export interface CommentEvent {
  /**
   * The same change has the same id on every replica, so a notifier can drop a repeat. A replica also drops
   * a repeat it has seen.
   */
  id: string;
  type: CommentEventType;
  /** When the change was made, as the data records it. */
  at: string;
  /** `local` when this replica made the change. `remote` when it came in from another replica. */
  source: "local" | "remote";
  /** Who made the change. `machineMade` is true for every kind but a signed-in person. */
  actor: Author & { machineMade: boolean };
  /** What kind of content the thread or suggestion points at: text, cell, slide, canvas, or a custom kind. */
  anchorType: string;
  threadId?: string;
  messageId?: string;
  suggestionId?: string;
  /** For a `mention` event: the handle that was named. */
  mention?: string;
}

export type CommentListener = (event: CommentEvent) => void | Promise<void>;

export interface NotificationsOptions {
  /** Called when a listener throws or rejects. Without it, errors go to `errors()`. */
  onError?: (error: unknown) => void;
}

const SEEN_LIMIT = 10_000;
const ERROR_LIMIT = 100;

const actorOf = (author: Author): CommentEvent["actor"] => ({ kind: author.kind, name: author.name, machineMade: author.kind !== "human" });

/**
 * An event stream for a notifier. It watches the thread and suggestion data, so it sees changes from other
 * replicas too, and marks each as local or remote. It starts at the moment you create it and replays no history.
 * Delivery is at least once with stable ids. A listener cannot break a write.
 */
export class Notifications {
  private readonly listeners = new Set<CommentListener>();
  private readonly seen = new Set<string>();
  private readonly failures: unknown[] = [];
  private readonly stops: (() => void)[] = [];

  constructor(
    private readonly comments: Comments,
    private readonly suggestions?: Suggestions,
    private readonly options: NotificationsOptions = {},
  ) {
    const threads = comments.threadsMap;
    const onThreads = (events: Y.YEvent<Y.AbstractType<unknown>>[], tr: Y.Transaction) => this.guard(() => this.threadEvents(events, tr.local));
    threads.observeDeep(onThreads);
    this.stops.push(() => threads.unobserveDeep(onThreads));
    if (suggestions) {
      const { suggestions: made, applied, rejected } = suggestions.maps;
      const onMade = (event: Y.YMapEvent<Y.Map<unknown>>, tr: Y.Transaction) => this.guard(() => this.created(event, tr.local));
      const onApplied = (event: Y.YMapEvent<unknown>, tr: Y.Transaction) => this.guard(() => this.decided(event, tr.local, "suggestion.accepted"));
      const onRejected = (event: Y.YMapEvent<unknown>, tr: Y.Transaction) => this.guard(() => this.decided(event, tr.local, "suggestion.rejected"));
      made.observe(onMade);
      applied.observe(onApplied);
      rejected.observe(onRejected);
      this.stops.push(() => made.unobserve(onMade), () => applied.unobserve(onApplied), () => rejected.unobserve(onRejected));
    }
  }

  /** Receive every event from now on. Returns a function that stops it. */
  subscribe(listener: CommentListener): () => void {
    if (typeof listener !== "function") throw new TypeError("a listener must be a function");
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** Stop watching the document and drop every listener. */
  close(): void {
    for (const stop of this.stops.splice(0)) stop();
    this.listeners.clear();
  }

  /** The most recent listener errors, when no `onError` was given. */
  errors(): unknown[] {
    return [...this.failures];
  }

  private fail(error: unknown): void {
    try {
      if (this.options.onError) this.options.onError(error);
      else if (this.failures.push(error) > ERROR_LIMIT) this.failures.shift();
    } catch {
      /* the error handler failed too */
    }
  }

  /** Data from a peer can be bad. A bad record makes no event, and never stops a write. */
  private guard(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.fail(error);
    }
  }

  private emit(event: CommentEvent): void {
    if (this.seen.has(event.id)) return;
    this.seen.add(event.id);
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value as string);
    for (const listener of [...this.listeners]) {
      try {
        const result = listener(event);
        if (typeof (result as Promise<void> | undefined)?.then === "function") (result as Promise<void>).catch((error: unknown) => this.fail(error));
      } catch (error) {
        this.fail(error);
      }
    }
  }

  private threadEvents(events: Y.YEvent<Y.AbstractType<unknown>>[], local: boolean): void {
    const source = local ? "local" : "remote";
    const threads = this.comments.threadsMap;
    for (const event of events) {
      const path = event.path;
      if (event.target === threads) {
        for (const [id, change] of (event as Y.YMapEvent<unknown>).keys) if (change.action === "add") this.threadCreated(id, source);
      } else if (path.length === 1 && event.target instanceof Y.Map) {
        const change = (event as Y.YMapEvent<unknown>).keys.get("state");
        if (change) this.statusChanged(String(path[0]), change.oldValue, source);
      } else if (path.length === 2 && path[1] === "messages" && event.target instanceof Y.Array) {
        for (const item of (event as Y.YArrayEvent<unknown>).changes.added) {
          for (const raw of item.content.getContent()) this.messageAdded(String(path[0]), (raw as { id?: unknown } | null)?.id, source);
        }
      }
    }
  }

  private mentions(thread: { id: string; anchor: { type: string } }, message: { id: string; at: string; author: Author; mentions: string[] }, source: CommentEvent["source"]): void {
    for (const handle of message.mentions) {
      this.emit({ id: `mention:${message.id}:${handle}`, type: "mention", at: message.at, source, actor: actorOf(message.author), anchorType: thread.anchor.type, threadId: thread.id, messageId: message.id, mention: handle });
    }
  }

  private threadCreated(id: string, source: CommentEvent["source"]): void {
    const thread = this.comments.get(id);
    const first = thread.messages[0];
    this.emit({ id: `thread.created:${id}`, type: "thread.created", at: first.at, source, actor: actorOf(first.author), anchorType: thread.anchor.type, threadId: id, messageId: first.id });
    this.mentions(thread, first, source);
    // A thread can arrive from another replica with its replies and its status already in it.
    for (const message of thread.messages.slice(1)) this.messageEvent(thread, message, source);
    if (thread.status === "resolved") this.statusEvent(thread, source);
  }

  private messageEvent(thread: { id: string; anchor: { type: string } }, message: { id: string; at: string; author: Author; mentions: string[] }, source: CommentEvent["source"]): void {
    this.emit({ id: `message.added:${thread.id}:${message.id}`, type: "message.added", at: message.at, source, actor: actorOf(message.author), anchorType: thread.anchor.type, threadId: thread.id, messageId: message.id });
    this.mentions(thread, message, source);
  }

  private messageAdded(threadId: string, messageId: unknown, source: CommentEvent["source"]): void {
    const thread = this.comments.get(threadId);
    const message = thread.messages.find((m) => m.id === messageId);
    if (message) this.messageEvent(thread, message, source);
  }

  private statusEvent(thread: { id: string; anchor: { type: string }; status: string; statusAt: string; statusBy: Author }, source: CommentEvent["source"]): void {
    const type = thread.status === "resolved" ? "thread.resolved" : "thread.reopened";
    this.emit({ id: `${type}:${thread.id}:${thread.statusAt}:${thread.statusBy.kind}:${thread.statusBy.name}`, type, at: thread.statusAt, source, actor: actorOf(thread.statusBy), anchorType: thread.anchor.type, threadId: thread.id });
  }

  private statusChanged(threadId: string, before: unknown, source: CommentEvent["source"]): void {
    const thread = this.comments.get(threadId);
    if ((before as { status?: unknown } | null)?.status !== thread.status) this.statusEvent(thread, source);
  }

  private created(event: Y.YMapEvent<Y.Map<unknown>>, local: boolean): void {
    for (const [id, change] of event.keys) {
      if (change.action !== "add") continue;
      const s = this.suggestions!.get(id);
      this.emit({ id: `suggestion.created:${id}`, type: "suggestion.created", at: s.createdAt, source: local ? "local" : "remote", actor: actorOf(s.author), anchorType: s.anchor.type, suggestionId: id });
    }
  }

  private decided(event: Y.YMapEvent<unknown>, local: boolean, type: "suggestion.accepted" | "suggestion.rejected"): void {
    for (const [key, change] of event.keys) {
      if (change.action === "delete") continue;
      const id = key.slice(0, key.lastIndexOf(":"));
      try {
        const s = this.suggestions!.get(id);
        if (s.status !== (type === "suggestion.accepted" ? "accepted" : "rejected") || !s.decidedBy || !s.decidedAt) continue;
        this.emit({ id: `${type}:${id}`, type, at: s.decidedAt, source: local ? "local" : "remote", actor: actorOf(s.decidedBy), anchorType: s.anchor.type, suggestionId: id });
      } catch {
        /* a record for a suggestion that is not there, or is bad, is not an event */
      }
    }
  }
}
