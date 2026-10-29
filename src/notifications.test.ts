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

function replica(source?: Y.Doc, onError?: (error: unknown) => void) {
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
