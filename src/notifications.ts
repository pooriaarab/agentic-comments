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
   * a repeat it has seen, within its last `seenLimit` ids. Two accepts at once give one id with the actor of
   * whichever replica you hear first, and the winner can differ. A host clock coarser than the rate of status
   * changes can give two status events one id.
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
  /**
   * Called when a listener throws or rejects (`source` is `listener`), or when a change in the data cannot
   * be read (`source` is `data`). Without it, errors go to `errors()`.
   */
  onError?: (error: unknown, source: "listener" | "data") => void;
  /** Drop every event until `unmute()`. Create the stream muted, and unmute after the first load, so old history is not sent. */
  muted?: boolean;
  /** How many event ids to remember so a repeat is dropped. A whole number, 1 or more. Default 10,000. */
  seenLimit?: number;
}

const DEFAULT_SEEN = 10_000;
const ERROR_LIMIT = 100;

const actorOf = (author: Author): CommentEvent["actor"] => ({ kind: author.kind, name: author.name, machineMade: author.kind !== "human" });

type Source = CommentEvent["source"];
interface Mentioning {
  id: string;
  at: string;
  author: Author;
  mentions: string[];
}
interface Pointing {
  id: string;
  anchor: { type: string };
}

/**
 * An event stream for a notifier. It watches the thread and suggestion data, so it sees changes from other
 * replicas too, and marks each as local or remote. It replays nothing it saw before it was created, but a first
 * load into an empty document looks like new changes: create it muted and call `unmute()` after that load.
 * Delivery is at least once with stable ids. A listener cannot break a write. A message past the read limit
 * of a thread makes no event.
 */
export class Notifications {
  private readonly listeners = new Set<CommentListener>();
  private readonly seen = new Set<string>();
  private readonly failures: { source: "listener" | "data"; error: unknown }[] = [];
  private readonly stops: (() => void)[] = [];
  private readonly queue: CommentEvent[] = [];
  private flushing = false;
  private readonly seenLimit: number;
  private muted: boolean;

  constructor(
    private readonly comments: Comments,
    private readonly suggestions?: Suggestions,
    private readonly options: NotificationsOptions = {},
  ) {
    this.seenLimit = options.seenLimit ?? DEFAULT_SEEN;
    if (!Number.isSafeInteger(this.seenLimit) || this.seenLimit < 1) throw new TypeError("seenLimit must be a whole number, 1 or more");
    this.muted = options.muted === true;
    // Events wait until every Yjs transaction is done, so a listener that writes starts a clean transaction.
    const flush = () => this.flush();
    comments.ydoc.on("afterAllTransactions", flush);
    this.stops.push(() => comments.ydoc.off("afterAllTransactions", flush));
    const threads = comments.threadsMap;
    const onThreads = (events: Y.YEvent<Y.AbstractType<unknown>>[], tr: Y.Transaction) => this.threadEvents(events, tr.local ? "local" : "remote");
    threads.observeDeep(onThreads);
    this.stops.push(() => threads.unobserveDeep(onThreads));
    if (suggestions) {
      const { suggestions: made, applied, rejected } = suggestions.maps;
      const onMade = (event: Y.YMapEvent<Y.Map<unknown>>, tr: Y.Transaction) => this.created(event, tr.local ? "local" : "remote");
      const onApplied = (event: Y.YMapEvent<unknown>, tr: Y.Transaction) => this.decided(event, tr.local ? "local" : "remote", "suggestion.accepted");
      const onRejected = (event: Y.YMapEvent<unknown>, tr: Y.Transaction) => this.decided(event, tr.local ? "local" : "remote", "suggestion.rejected");
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

  /** Start sending events, for a stream created with `muted: true`. */
  unmute(): void {
    this.muted = false;
  }

  /** Stop watching the document and drop every listener. */
  close(): void {
    for (const stop of this.stops.splice(0)) stop();
    this.listeners.clear();
    this.queue.length = 0;
  }

  /** The most recent errors, when no `onError` was given. */
  errors(): { source: "listener" | "data"; error: unknown }[] {
    return [...this.failures];
  }

  private fail(error: unknown, source: "listener" | "data"): void {
    try {
      if (this.options.onError) this.options.onError(error, source);
      else if (this.failures.push({ source, error }) > ERROR_LIMIT) this.failures.shift();
    } catch {
      /* the error handler failed too */
    }
  }

  /** Data from a peer can be bad. A bad record makes no event, and never stops a write or the records after it. */
  private guard(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.fail(error, "data");
    }
  }

  private emit(event: CommentEvent): void {
    if (this.seen.has(event.id)) return;
    this.seen.add(event.id);
    if (this.seen.size > this.seenLimit) this.seen.delete(this.seen.values().next().value as string);
    if (!this.muted) this.queue.push(event);
  }

  private flush(): void {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (let event = this.queue.shift(); event; event = this.queue.shift()) {
        for (const listener of [...this.listeners]) {
          try {
            const result = listener(event);
            if (typeof (result as Promise<void> | undefined)?.then === "function") (result as Promise<void>).catch((error: unknown) => this.fail(error, "listener"));
          } catch (error) {
            this.fail(error, "listener");
          }
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private threadEvents(events: Y.YEvent<Y.AbstractType<unknown>>[], source: Source): void {
    const threads = this.comments.threadsMap;
    for (const event of events) {
      this.guard(() => {
        const path = event.path;
        if (event.target === threads) {
          for (const [id, change] of (event as Y.YMapEvent<unknown>).keys) if (change.action === "add") this.guard(() => this.threadCreated(id, source));
        } else if (path.length === 1 && event.target instanceof Y.Map) {
          const change = (event as Y.YMapEvent<unknown>).keys.get("state");
          if (change) this.statusChanged(String(path[0]), change.oldValue, source);
        } else if (path.length === 2 && path[1] === "messages" && event.target instanceof Y.Array) {
          const ids = new Set<unknown>();
          for (const item of (event as Y.YArrayEvent<unknown>).changes.added) for (const raw of item.content.getContent()) ids.add((raw as { id?: unknown } | null)?.id);
          this.messagesAdded(String(path[0]), ids, source);
        }
      });
    }
  }

  private mentions(thread: Pointing, message: Mentioning, source: Source): void {
    for (const handle of message.mentions) {
      this.emit({ id: `mention:${message.id}:${handle}`, type: "mention", at: message.at, source, actor: actorOf(message.author), anchorType: thread.anchor.type, threadId: thread.id, messageId: message.id, mention: handle });
    }
  }

  private messageEvent(thread: Pointing, message: Mentioning, source: Source): void {
    this.emit({ id: `message.added:${thread.id}:${message.id}`, type: "message.added", at: message.at, source, actor: actorOf(message.author), anchorType: thread.anchor.type, threadId: thread.id, messageId: message.id });
    this.mentions(thread, message, source);
  }

  private statusEvent(thread: Pointing & { status: string; statusAt: string; statusBy: Author }, source: Source): void {
    const type = thread.status === "resolved" ? "thread.resolved" : "thread.reopened";
    this.emit({ id: `${type}:${thread.id}:${thread.statusAt}:${thread.statusBy.kind}:${thread.statusBy.name}`, type, at: thread.statusAt, source, actor: actorOf(thread.statusBy), anchorType: thread.anchor.type, threadId: thread.id });
  }

  private threadCreated(id: string, source: Source): void {
    const thread = this.comments.get(id);
    const stored = this.comments.threadsMap.get(id)?.get("messages");
    const firstId = stored instanceof Y.Array ? (stored.get(0) as { id?: unknown } | undefined)?.id : undefined;
    const first = thread.messages.find((m) => m.id === firstId);
    // When the stored first message is not valid, the first valid one is a reply, not the start.
    if (first) {
      this.emit({ id: `thread.created:${id}`, type: "thread.created", at: first.at, source, actor: actorOf(first.author), anchorType: thread.anchor.type, threadId: id, messageId: first.id });
      this.mentions(thread, first, source);
    } else {
      this.fail(new Error(`thread ${JSON.stringify(id.slice(0, 64))} has no valid first message, so it makes no thread.created event`), "data");
    }
    // A thread can arrive from another replica with its replies and its status already in it.
    for (const message of thread.messages) if (message !== first) this.messageEvent(thread, message, source);
    if (thread.status === "resolved") this.statusEvent(thread, source);
  }

  private messagesAdded(threadId: string, ids: Set<unknown>, source: Source): void {
    const thread = this.comments.get(threadId);
    for (const message of thread.messages) if (ids.has(message.id)) this.messageEvent(thread, message, source);
  }

  private statusChanged(threadId: string, before: unknown, source: Source): void {
    const thread = this.comments.get(threadId);
    if ((before as { status?: unknown } | null)?.status !== thread.status) this.statusEvent(thread, source);
  }

  private created(event: Y.YMapEvent<Y.Map<unknown>>, source: Source): void {
    for (const [id, change] of event.keys) {
      if (change.action !== "add") continue;
      this.guard(() => {
        const s = this.suggestions!.get(id);
        this.emit({ id: `suggestion.created:${id}`, type: "suggestion.created", at: s.createdAt, source, actor: actorOf(s.author), anchorType: s.anchor.type, suggestionId: id });
      });
    }
  }

  private decided(event: Y.YMapEvent<unknown>, source: Source, type: "suggestion.accepted" | "suggestion.rejected"): void {
    for (const [key, change] of event.keys) {
      if (change.action === "delete") continue;
      const id = key.slice(0, key.lastIndexOf(":"));
      try {
        const s = this.suggestions!.get(id);
        if (s.status !== (type === "suggestion.accepted" ? "accepted" : "rejected") || !s.decidedBy || !s.decidedAt) continue;
        this.emit({ id: `${type}:${id}`, type, at: s.decidedAt, source, actor: actorOf(s.decidedBy), anchorType: s.anchor.type, suggestionId: id });
      } catch {
        /* a record for a suggestion that is not there, or is bad, is not an event */
      }
    }
  }
}
