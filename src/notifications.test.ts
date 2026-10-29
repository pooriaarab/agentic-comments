import * as Y from "yjs";
import { describe, expect, test } from "vitest";
import { ACCEPT_SCOPE, Comments, Notifications, stamp, Suggestions, textAnchor, type CommentEvent, type SuggestionHost } from "./index.js";

// Ways the event stream can fail, written before the tests:
//  1. A change makes no event, or an event for a change that did not happen (a repeat resolve, a bad record).
//  2. The same change makes a different id on two replicas, or twice on one replica.
//  3. An event carries the text of a comment or a suggestion, or lacks who acted or whether a machine did.
//  4. A change from another replica is missed, or marked as local.
//  5. Old history is replayed when a notifier starts.
//  6. A listener that throws, or rejects, breaks the write, other listeners, or goes unseen.
//  7. A peer's malformed data makes an event, or a throw.
//  8. After unsubscribe or close, events still arrive.
// 10. One bad record in a batch hides the events for good records in the same batch.
// 11. A first load into an empty document replays old history, or a bad first message names the wrong actor.
// 12. A listener that writes, closes the stream, or an error handler that throws breaks the write.
//  9. A mention event names the wrong handle, or is lost for a thread's first message.

const ada = stamp({ kind: "human", name: "ada" });
const grace = stamp({ kind: "human", name: "grace" });
const bot = stamp({ kind: "agent_of_human", name: "scribe" });
const reviewer = stamp({ kind: "agent", name: "reviewer", scopes: [ACCEPT_SCOPE] });

let tick = 0;
const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));

const host: SuggestionHost = {
  apply(change, ctx) {
    ctx.ydoc.getMap("values").set("k", (change as { value: unknown }).value);
    return { r: 1 };
  },
  revert: () => undefined,
};

function replica(source?: Y.Doc, onError?: (error: unknown, source: "listener" | "data") => void) {
  const ydoc = new Y.Doc();
  ydoc.getText("t");
  if (source) Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(source));
  else ydoc.getText("t").insert(0, "hello brave world");
  const comments = new Comments(ydoc, { now: clock });
  const suggestions = new Suggestions(comments, host);
  const notifications = new Notifications(comments, suggestions, { onError });
  const events: CommentEvent[] = [];
  notifications.subscribe((e) => void events.push(e));
  return { ydoc, comments, suggestions, notifications, events, types: () => events.map((e) => e.type) };
}

const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
};

const cell = { type: "cell", key: "A1" } as const;

describe("events from one replica", () => {
  test("a thread, a reply, a resolve, and a reopen each make one event, in order, with the actor", () => {
    const r = replica();
    const t = r.comments.add({ anchor: cell, body: "start" }, ada);
    r.comments.reply(t.id, { body: "more" }, bot);
    r.comments.resolve(t.id, grace);
    r.comments.reopen(t.id, ada);
    expect(r.types()).toEqual(["thread.created", "message.added", "thread.resolved", "thread.reopened"]);
    expect(r.events.map((e) => e.actor)).toEqual([
      { kind: "human", name: "ada", machineMade: false },
      { kind: "agent_of_human", name: "scribe", machineMade: true },
      { kind: "human", name: "grace", machineMade: false },
      { kind: "human", name: "ada", machineMade: false },
    ]);
    expect(r.events.every((e) => e.threadId === t.id && e.anchorType === "cell" && e.source === "local")).toBe(true);
    expect(r.events[1].messageId).toBe(r.comments.get(t.id).messages[1].id);
    expect(new Set(r.events.map((e) => e.id)).size).toBe(4);
  });

  test("a repeat resolve, a repeat reopen, and a refused reply make no event", () => {
    const r = replica();
    const t = r.comments.add({ anchor: cell, body: "start" }, ada);
    r.comments.reopen(t.id, ada);
    r.comments.resolve(t.id, ada);
    r.comments.resolve(t.id, grace);
    expect(() => r.comments.reply(t.id, { body: "late" }, bot)).toThrow();
    expect(r.types()).toEqual(["thread.created", "thread.resolved"]);
  });

  test("a mention makes one event per handle, for the first message and for a reply", () => {
    const r = replica();
    const t = r.comments.add({ anchor: cell, body: "look @Grace and @scribe", mentions: ["ada"] }, ada);
    r.comments.reply(t.id, { body: "ping @grace" }, bot);
    const mentions = r.events.filter((e) => e.type === "mention");
    expect(mentions.map((e) => e.mention)).toEqual(["grace", "scribe", "ada", "grace"]);
    expect(mentions.every((e) => e.messageId !== undefined && e.threadId === t.id)).toBe(true);
    expect(r.types().slice(0, 2)).toEqual(["thread.created", "mention"]);
    expect(new Set(r.events.map((e) => e.id)).size).toBe(r.events.length);
  });

  test("events never carry the text of a comment or a suggestion", () => {
    const r = replica();
    const t = r.comments.add({ anchor: cell, body: "SECRET-BODY @grace" }, ada);
    r.comments.reply(t.id, { body: "SECRET-REPLY" }, bot);
    const s = r.suggestions.add({ anchor: textAnchor(r.ydoc.getText("t"), 6, 11), change: { value: "SECRET-CHANGE" }, summary: "SECRET-SUMMARY" }, bot);
    r.suggestions.accept(s.id, ada);
    const all = JSON.stringify(r.events);
    for (const secret of ["SECRET-BODY", "SECRET-REPLY", "SECRET-CHANGE", "SECRET-SUMMARY"]) expect(all).not.toContain(secret);
    expect(r.events.length).toBeGreaterThan(4);
  });

  test("suggestions make created, accepted, and rejected events with the decider", () => {
    const r = replica();
    const a = r.suggestions.add({ anchor: cell, change: { value: 1 } }, bot);
    const b = r.suggestions.add({ anchor: cell, change: { value: 2 } }, bot);
    r.suggestions.accept(a.id, reviewer);
    r.suggestions.reject(b.id, ada);
    r.suggestions.accept(a.id, ada);
    expect(r.types()).toEqual(["suggestion.created", "suggestion.created", "suggestion.accepted", "suggestion.rejected"]);
    expect(r.events[2]).toMatchObject({ suggestionId: a.id, actor: { kind: "agent", name: "reviewer", machineMade: true }, anchorType: "cell" });
    expect(r.events[3]).toMatchObject({ suggestionId: b.id, actor: { kind: "human", name: "ada", machineMade: false } });
  });

  test("history before the notifier starts makes no event", () => {
    const r = replica();
    r.comments.add({ anchor: cell, body: "old" }, ada);
    const late = new Notifications(r.comments, r.suggestions);
    const seen: CommentEvent[] = [];
    late.subscribe((e) => void seen.push(e));
    expect(seen).toEqual([]);
    r.comments.add({ anchor: cell, body: "new" }, ada);
    expect(seen.map((e) => e.type)).toEqual(["thread.created"]);
  });
});

describe("events across replicas", () => {
  test("a change from another replica makes the same events with the same ids, marked remote", () => {
    const a = replica();
    const b = replica(a.ydoc);
    const t = a.comments.add({ anchor: cell, body: "start @grace" }, ada);
    a.comments.reply(t.id, { body: "more" }, bot);
    a.comments.resolve(t.id, ada);
    sync(a.ydoc, b.ydoc);
    expect(b.types().sort()).toEqual(a.types().sort());
    expect(b.events.map((e) => e.id).sort()).toEqual(a.events.map((e) => e.id).sort());
    expect(a.events.every((e) => e.source === "local")).toBe(true);
    expect(b.events.every((e) => e.source === "remote")).toBe(true);
  });

  test("suggestion events from another replica are marked remote and carry the same ids", () => {
    const a = replica();
    const b = replica(a.ydoc);
    const s = a.suggestions.add({ anchor: cell, change: { value: 1 } }, bot);
    a.suggestions.accept(s.id, ada);
    const t = a.suggestions.add({ anchor: cell, change: { value: 2 } }, bot);
    a.suggestions.reject(t.id, grace);
    sync(a.ydoc, b.ydoc);
    expect(b.types().sort()).toEqual(a.types().sort());
    expect(b.events.every((e) => e.source === "remote")).toBe(true);
    expect(a.events.every((e) => e.source === "local")).toBe(true);
    expect(b.events.map((e) => e.id).sort()).toEqual(a.events.map((e) => e.id).sort());
  });

  test("two resolves at once give each replica one resolved event, even when the other replica's change wins", () => {
    const a = replica();
    const t = a.comments.add({ anchor: cell, body: "start" }, ada);
    const b = replica(a.ydoc);
    a.events.length = 0;
    a.comments.resolve(t.id, ada);
    b.comments.resolve(t.id, grace);
    sync(a.ydoc, b.ydoc);
    sync(a.ydoc, b.ydoc);
    expect(a.types()).toEqual(["thread.resolved"]);
    expect(b.types()).toEqual(["thread.resolved"]);
  });

  test("replies made at once give each replica both events once, and a repeat sync gives none", () => {
    const a = replica();
    const t = a.comments.add({ anchor: cell, body: "start" }, ada);
    const b = replica(a.ydoc);
    a.events.length = 0;
    a.comments.reply(t.id, { body: "from a" }, ada);
    b.comments.reply(t.id, { body: "from b" }, bot);
    sync(a.ydoc, b.ydoc);
    expect(a.types()).toEqual(["message.added", "message.added"]);
    expect(b.types()).toEqual(["message.added", "message.added"]);
    expect(a.events.map((e) => e.id).sort()).toEqual(b.events.map((e) => e.id).sort());
    sync(a.ydoc, b.ydoc);
    expect(a.events).toHaveLength(2);
    expect(b.events).toHaveLength(2);
  });

  test("two replicas that accept at once give each replica one accepted event, with one id", () => {
    const a = replica();
    const s = a.suggestions.add({ anchor: cell, change: { value: 1 } }, bot);
    const b = replica(a.ydoc);
    a.events.length = 0;
    a.suggestions.accept(s.id, ada);
    b.suggestions.accept(s.id, grace);
    sync(a.ydoc, b.ydoc);
    for (const r of [a, b]) expect(r.events.filter((e) => e.type === "suggestion.accepted")).toHaveLength(1);
    expect(a.events.find((e) => e.type === "suggestion.accepted")!.id).toBe(b.events.find((e) => e.type === "suggestion.accepted")!.id);
  });

  test("an accept that beats a reject at once gives no rejected event after the merge", () => {
    const a = replica();
    const s = a.suggestions.add({ anchor: cell, change: { value: 1 } }, bot);
    const b = replica(a.ydoc);
    a.events.length = 0;
    a.suggestions.accept(s.id, ada);
    b.suggestions.reject(s.id, grace);
    sync(a.ydoc, b.ydoc);
    expect(a.events.map((e) => e.type)).toEqual(["suggestion.accepted"]);
    expect(b.events.map((e) => e.type)).toEqual(["suggestion.rejected", "suggestion.accepted"]);
  });
});

describe("listeners", () => {
  test("a listener that throws, or rejects, breaks neither the write nor the other listeners, and is reported", async () => {
    const errors: unknown[] = [];
    const r = replica(undefined, (e) => void errors.push(e));
    const seen: string[] = [];
    r.notifications.subscribe(() => {
      throw new Error("notifier is down");
    });
    r.notifications.subscribe(async () => {
      throw new Error("async notifier is down");
    });
    r.notifications.subscribe((e) => void seen.push(e.type));
    const t = r.comments.add({ anchor: cell, body: "x" }, ada);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(r.comments.get(t.id).messages).toHaveLength(1);
    expect(seen).toEqual(["thread.created"]);
    expect(errors.map((e) => (e as Error).message).sort()).toEqual(["async notifier is down", "notifier is down"]);
  });

  test("unsubscribe and close stop the events", () => {
    const r = replica();
    const seen: string[] = [];
    const stop = r.notifications.subscribe((e) => void seen.push(e.type));
    r.comments.add({ anchor: cell, body: "one" }, ada);
    stop();
    r.comments.add({ anchor: cell, body: "two" }, ada);
    expect(seen).toEqual(["thread.created"]);
    r.notifications.close();
    r.comments.add({ anchor: cell, body: "three" }, ada);
    expect(r.events).toHaveLength(1 + 1);
  });

  test("a listener that is not a function is refused", () => {
    const r = replica();
    expect(() => r.notifications.subscribe(5 as never)).toThrow();
  });
});

describe("data from a peer", () => {
  test("a malformed thread, message, or record makes no event and no throw", () => {
    const r = replica();
    const t = r.comments.add({ anchor: cell, body: "real" }, ada);
    r.events.length = 0;
    const threads = r.ydoc.getMap<Y.Map<unknown>>("comments.threads");
    const evil = new Y.Map<unknown>();
    threads.set("evil", evil);
    (threads.get(t.id)!.get("messages") as Y.Array<unknown>).push([{ id: "m-evil", at: "yesterday", author: { name: "no-kind" }, body: "x", mentions: [] }]);
    r.ydoc.getMap("comments.suggestion-applied").set("nothing:1", { junk: true });
    r.ydoc.getMap("comments.suggestion-rejected").set("nothing:2", null);
    expect(r.events).toEqual([]);
  });
});

describe("batches, loads, and re-entry", () => {
  const evilThread = (doc: Y.Doc, key: string, messages: unknown[]) => {
    const fields = new Y.Map<unknown>();
    doc.getMap<Y.Map<unknown>>("comments.threads").set(key, fields);
    fields.set("anchor", cell);
    fields.set("state", { status: "open", by: { kind: "human", name: "eve" }, at: "2026-01-01T00:00:00.000Z" });
    const list = new Y.Array<unknown>();
    fields.set("messages", list);
    list.push(messages);
  };
  const at = "2026-01-01T00:00:00.000Z";

  test("a bad thread in the same transaction does not hide the events for a good one", () => {
    const source = new Y.Doc();
    const made = new Comments(source, { now: clock });
    source.transact(() => {
      source.getMap<Y.Map<unknown>>("comments.threads").set("a-empty", new Y.Map());
      made.add({ anchor: cell, body: "hello @grace" }, ada);
      source.getMap<Y.Map<unknown>>("comments.threads").set("z-empty", new Y.Map());
    });
    const r = replica();
    r.events.length = 0;
    Y.applyUpdate(r.ydoc, Y.encodeStateAsUpdate(source));
    expect(r.types()).toEqual(["thread.created", "mention"]);
    expect(r.notifications.errors().length).toBeGreaterThan(0);
  });

  test("several messages added at once on one thread each make an event, and one bad one does not hide the rest", () => {
    const a = replica();
    const t = a.comments.add({ anchor: cell, body: "start" }, ada);
    const b = replica(a.ydoc);
    b.events.length = 0;
    a.ydoc.transact(() => {
      for (const body of ["one", "two"]) a.comments.reply(t.id, { body }, bot);
      (a.ydoc.getMap<Y.Map<unknown>>("comments.threads").get(t.id)!.get("messages") as Y.Array<unknown>).push([{ id: "m-bad", at, author: { name: "x" }, body: "x", mentions: [] }]);
      a.comments.reply(t.id, { body: "three" }, ada);
    });
    sync(a.ydoc, b.ydoc);
    expect(b.types()).toEqual(["message.added", "message.added", "message.added"]);
  });

  test("a notifier that is muted drops the first load, and later changes make events", () => {
    const a = replica();
    a.comments.add({ anchor: cell, body: "old @grace" }, ada);
    const ydoc = new Y.Doc();
    ydoc.getText("t");
    const comments = new Comments(ydoc, { now: clock });
    const notifications = new Notifications(comments, new Suggestions(comments, host), { muted: true });
    const seen: string[] = [];
    notifications.subscribe((e) => void seen.push(e.type));
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(a.ydoc));
    expect(seen).toEqual([]);
    notifications.unmute();
    comments.add({ anchor: cell, body: "new" }, grace);
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(a.ydoc));
    expect(seen).toEqual(["thread.created"]);
  });

  test("a notifier that is not muted reports the first load as remote events", () => {
    const a = replica();
    a.comments.add({ anchor: cell, body: "old" }, ada);
    const b = replica();
    b.events.length = 0;
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
    expect(b.types()).toEqual(["thread.created"]);
    expect(b.events[0].source).toBe("remote");
  });

  test("a bad first message makes no thread.created event that names someone else", () => {
    const r = replica();
    r.events.length = 0;
    r.ydoc.transact(() => evilThread(r.ydoc, "evil", [
      { id: "m1", at, author: { name: "no-kind" }, body: "x", mentions: [] },
      { id: "m2", at, author: { kind: "human", name: "ada" }, body: "reply", mentions: [] },
    ]));
    expect(r.types()).not.toContain("thread.created");
    expect(r.events.every((e) => e.type !== "thread.created" || e.messageId !== "m2")).toBe(true);
    expect(r.notifications.errors().length).toBeGreaterThan(0);
  });

  test("an error handler that throws, a listener that writes, and a listener that closes the stream do not break the write", () => {
    const r = replica(undefined, () => {
      throw new Error("the handler failed too");
    });
    r.notifications.subscribe(() => {
      throw new Error("down");
    });
    const t = r.comments.add({ anchor: cell, body: "x" }, ada);
    expect(r.comments.get(t.id).messages).toHaveLength(1);
    const w = replica();
    let wrote = false;
    w.notifications.subscribe((e) => {
      if (e.type === "thread.created" && !wrote) {
        wrote = true;
        w.comments.reply(e.threadId!, { body: "auto reply" }, bot);
      }
    });
    const made = w.comments.add({ anchor: cell, body: "start" }, ada);
    expect(w.comments.get(made.id).messages).toHaveLength(2);
    expect(w.types().filter((x) => x === "message.added")).toHaveLength(1);
    const c = replica();
    c.notifications.subscribe(() => c.notifications.close());
    c.comments.add({ anchor: cell, body: "x" }, ada);
    c.comments.add({ anchor: cell, body: "y" }, ada);
    expect(c.events).toHaveLength(1);
  });

  test("errors tell a listener failure from bad data", () => {
    const seen: string[] = [];
    const r = replica(undefined, (_e, source) => void seen.push(source));
    r.notifications.subscribe(() => {
      throw new Error("down");
    });
    r.comments.add({ anchor: cell, body: "x" }, ada);
    r.ydoc.getMap<Y.Map<unknown>>("comments.threads").set("bad", new Y.Map());
    expect(seen).toEqual(["listener", "data"]);
  });

  test("the window of remembered ids can be set: a repeat inside it is dropped and one outside it comes back", () => {
    const r = replica();
    expect(() => new Notifications(r.comments, r.suggestions, { seenLimit: 0 })).toThrow();
    const small = new Notifications(r.comments, r.suggestions, { seenLimit: 2 });
    const seen: string[] = [];
    small.subscribe((e) => void seen.push(e.id));
    const ids = ["a", "b", "c"].map((body) => r.comments.add({ anchor: cell, body }, ada).id);
    expect(seen).toHaveLength(3);
    const threads = r.ydoc.getMap<Y.Map<unknown>>("comments.threads");
    const readd = (id: string) => {
      const raw = threads.get(id)!.toJSON() as { anchor: unknown; state: unknown; messages: unknown[] };
      threads.delete(id);
      r.ydoc.transact(() => {
        const fields = new Y.Map<unknown>();
        threads.set(id, fields);
        fields.set("anchor", raw.anchor);
        fields.set("state", raw.state);
        const list = new Y.Array<unknown>();
        fields.set("messages", list);
        list.push(raw.messages);
      });
    };
    readd(ids[2]);
    expect(seen).toHaveLength(3);
    readd(ids[0]);
    expect(seen).toHaveLength(4);
  });

  test("errors() keeps at most 100 entries", () => {
    const r = replica();
    const threads = r.ydoc.getMap<Y.Map<unknown>>("comments.threads");
    for (let i = 0; i < 150; i++) threads.set(`bad-${i}`, new Y.Map());
    expect(r.notifications.errors().length).toBe(100);
  });

  test("a status write over a missing or bad old state is not a reopen", () => {
    const r = replica();
    const t = r.comments.add({ anchor: cell, body: "hi" }, ada);
    r.events.length = 0;
    const fields = r.ydoc.getMap<Y.Map<unknown>>("comments.threads").get(t.id)!;
    fields.set("state", null);
    fields.set("state", { status: "open", by: { kind: "human", name: "eve" }, at: "2026-01-01T00:00:00.000Z" });
    fields.set("state", { status: "resolved", by: { kind: "human", name: "eve" }, at: "2026-01-01T00:00:01.000Z" });
    fields.set("state", { status: "open", by: { kind: "human", name: "eve" }, at: "2026-01-01T00:00:02.000Z" });
    expect(r.types()).toEqual(["thread.resolved", "thread.reopened"]);
  });

  test("a mention copied into another thread is a new event, and a listener that closes the stream stops the later listeners", () => {
    const r = replica();
    const one = r.comments.add({ anchor: cell, body: "hi @grace" }, ada);
    const two = r.comments.add({ anchor: cell, body: "other" }, ada);
    r.events.length = 0;
    const copy = { ...(r.comments.get(one.id).messages[0] as object), id: (r.comments.get(one.id).messages[0] as { id: string }).id };
    (r.ydoc.getMap<Y.Map<unknown>>("comments.threads").get(two.id)!.get("messages") as Y.Array<unknown>).push([copy]);
    expect(r.events.filter((e) => e.type === "mention").map((e) => e.threadId)).toEqual([two.id]);
    const c = replica();
    const later: string[] = [];
    c.notifications.subscribe(() => c.notifications.close());
    c.notifications.subscribe((e) => void later.push(e.type));
    c.comments.add({ anchor: cell, body: "x" }, ada);
    expect(later).toEqual([]);
  });

  test("a bad decision record is reported as a data error", () => {
    const r = replica();
    r.ydoc.getMap("comments.suggestion-applied").set("no-such:1", { junk: true });
    expect(r.notifications.errors().some((e) => e.source === "data")).toBe(true);
  });

  test("a bad record in a decision map makes no event, even after a restart", () => {
    const a = replica();
    const s = a.suggestions.add({ anchor: cell, change: { value: 1 } }, bot);
    a.suggestions.accept(s.id, ada);
    const fresh = new Notifications(a.comments, a.suggestions);
    const seen: string[] = [];
    fresh.subscribe((e) => void seen.push(e.type));
    a.ydoc.getMap("comments.suggestion-applied").set(`${s.id}:42`, "garbage");
    a.ydoc.getMap("comments.suggestion-applied").set(`${s.id}:43`, { by: { kind: "human" }, at: "yesterday" });
    const t = a.suggestions.add({ anchor: cell, change: { value: 2 } }, bot);
    a.suggestions.reject(t.id, ada);
    a.ydoc.getMap("comments.suggestion-rejected").set(`${t.id}:44`, null);
    expect(seen).toEqual(["suggestion.created", "suggestion.rejected"]);
  });

  test("a thread whose map arrived empty and got its messages later is created then", () => {
    const r = replica();
    const threads = r.ydoc.getMap<Y.Map<unknown>>("comments.threads");
    const fields = new Y.Map<unknown>();
    threads.set("t1", fields);
    r.events.length = 0;
    r.ydoc.transact(() => {
      fields.set("anchor", cell);
      fields.set("state", { status: "open", by: { kind: "human", name: "eve" }, at: "2026-01-01T00:00:00.000Z" });
      const list = new Y.Array<unknown>();
      fields.set("messages", list);
      list.push([{ id: "m1", at: "2026-01-01T00:00:00.000Z", author: { kind: "human", name: "eve" }, body: "hi", mentions: ["bob"] }]);
    });
    expect(r.types()).toEqual(["thread.created", "mention"]);
  });

  test("a decision that arrives before its suggestion still makes an accepted event", () => {
    const a = replica();
    const s = a.suggestions.add({ anchor: cell, change: { value: 1 } }, bot);
    const c = replica();
    c.events.length = 0;
    c.ydoc.getMap("comments.suggestion-applied").set(`${s.id}:7`, { by: { kind: "human", name: "ada" }, at: "2026-01-01T00:00:00.000Z", receipt: { r: 1 } });
    Y.applyUpdate(c.ydoc, Y.encodeStateAsUpdate(a.ydoc));
    expect(c.types()).toEqual(["suggestion.created", "suggestion.accepted"]);
  });

  test("a listener that returns a thenable with only then has its real error reported", async () => {
    const errors: unknown[] = [];
    const r = replica(undefined, (e) => void errors.push(e));
    r.notifications.subscribe((() => ({ then: (_ok: unknown, bad: (e: unknown) => void) => bad(new Error("real failure")) })) as never);
    r.comments.add({ anchor: cell, body: "x" }, ada);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(errors.map((e) => (e as Error).message)).toEqual(["real failure"]);
  });
});

