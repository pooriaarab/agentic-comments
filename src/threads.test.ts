import * as Y from "yjs";
import { describe, expect, test } from "vitest";
import { Actor, authorLabel, Comments, CommentsError, PRINCIPAL_KINDS, stamp, textAnchor, type Anchor } from "./index.js";

// Ways this model can fail, written before the code:
//  1. A caller claims an author, forges an actor, or edits one after stamping.
//  2. The stored author keeps scopes, loses its kind, or defaults to a person.
//  3. A body or a mention is empty, too long, or not text, and half-writes a thread.
//  4. An anchor has an unknown type, a bad shape, or extra keys that ride along.
//  5. A text anchor does not follow its text when another replica edits.
//  6. A missing or odd thread id reaches a prototype key or a wrong thread.
//  7. A reply lands on a resolved thread, or resolve is not idempotent.
//  8. Two replicas lose a reply, or disagree on order or status after a merge.
//  9. A hostile replica writes a malformed thread and breaks listing for all.

const ada = stamp({ kind: "human", name: "ada" });
const bot = stamp({ kind: "agent_of_human", name: "scribe" });
const cell: Anchor = { type: "cell", key: "Sheet1!B4" };

let tick = 0;
const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
const make = (doc = new Y.Doc()) => new Comments(doc, { now: clock });

function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
}

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    if (error instanceof CommentsError) return error.code;
    throw error;
  }
  return undefined;
};

describe("author stamping", () => {
  test("stamp refuses a missing kind, an unknown kind, and a bad name or scopes", () => {
    const bad: unknown[] = [
      null,
      "ada",
      { name: "ada" },
      { kind: "root", name: "ada" },
      { kind: "human" },
      { kind: "human", name: "  " },
      { kind: "human", name: 7 },
      { kind: "human", name: "ada", scopes: "comments:accept" },
      { kind: "human", name: "ada", scopes: [""] },
    ];
    for (const value of bad) expect(code(() => stamp(value as never))).toBe("INVALID_AUTHOR");
  });

  test("a missing or unstamped actor is refused, even with a valid shape", () => {
    const comments = make();
    expect(code(() => comments.add({ anchor: cell, body: "hi" }, undefined as never))).toBe("INVALID_AUTHOR");
    const forged = { kind: "human", name: "ada", scopes: [] };
    expect(code(() => comments.add({ anchor: cell, body: "hi" }, forged as never))).toBe("INVALID_AUTHOR");
    expect(comments.list()).toEqual([]);
  });

  test("a stamped actor cannot change after stamping", () => {
    expect(() => {
      (bot as { kind: string }).kind = "human";
    }).toThrow();
    expect(bot.kind).toBe("agent_of_human");
  });

  test("input that claims an author or any unknown key is refused", () => {
    const comments = make();
    const thread = comments.add({ anchor: cell, body: "hi" }, ada);
    const claim = { anchor: cell, body: "hi", author: { kind: "human", name: "boss" } };
    expect(code(() => comments.add(claim as never, bot))).toBe("INVALID_INPUT");
    expect(code(() => comments.reply(thread.id, { body: "x", author: { kind: "human", name: "boss" } } as never, bot))).toBe("INVALID_INPUT");
    expect(comments.list()).toHaveLength(1);
    expect(comments.get(thread.id).messages).toHaveLength(1);
  });

  test("the stored author keeps kind and name, drops scopes, and survives a round trip", () => {
    const scoped = stamp({ kind: "agent_of_human", name: "scribe", scopes: ["comments:accept"] });
    const doc = new Y.Doc();
    const thread = make(doc).add({ anchor: cell, body: "hi" }, scoped);
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, Y.encodeStateAsUpdate(doc));
    const author = make(fresh).get(thread.id).messages[0].author;
    expect(author).toEqual({ kind: "agent_of_human", name: "scribe" });
  });
});

describe("bodies and mentions", () => {
  test("an empty, blank, non-text, or oversized body is refused and writes nothing", () => {
    const comments = make();
    for (const body of ["", "   ", 5, null, "x".repeat(10_001)]) {
      expect(code(() => comments.add({ anchor: cell, body: body as never }, ada))).toBe("INVALID_INPUT");
    }
    expect(comments.list()).toEqual([]);
    const thread = comments.add({ anchor: cell, body: "ok" }, ada);
    expect(code(() => comments.reply(thread.id, { body: " " }, ada))).toBe("INVALID_INPUT");
    expect(comments.get(thread.id).messages).toHaveLength(1);
  });

  test("mentions come from the body, ignore emails, and drop repeats", () => {
    const comments = make();
    const thread = comments.add({ anchor: cell, body: "@grace and @scribe, mail me@x.org. @grace again." }, ada);
    expect(thread.messages[0].mentions).toEqual(["grace", "scribe"]);
  });

  test("explicit mentions merge with parsed ones and must be valid", () => {
    const comments = make();
    const thread = comments.add({ anchor: cell, body: "hi @grace", mentions: ["@scribe", "grace"] }, ada);
    expect(thread.messages[0].mentions).toEqual(["grace", "scribe"]);
    for (const mentions of [[""], ["two words"], [3], "grace", Array.from({ length: 51 }, (_, i) => `u${i}`)]) {
      expect(code(() => comments.add({ anchor: cell, body: "hi", mentions: mentions as never }, ada))).toBe("INVALID_INPUT");
    }
    expect(comments.list()).toHaveLength(1);
  });

  test("list can find threads that mention a handle", () => {
    const comments = make();
    comments.add({ anchor: cell, body: "plain" }, ada);
    const hit = comments.add({ anchor: cell, body: "look @grace" }, ada);
    expect(comments.list({ mentioning: "grace" }).map((t) => t.id)).toEqual([hit.id]);
    comments.reply(hit.id, { body: "ack" }, bot);
    expect(comments.list({ mentioning: "nobody" })).toEqual([]);
  });
});

describe("anchors", () => {
  test("a bad anchor is refused and writes nothing", () => {
    const comments = make();
    const text = new Y.Doc().getText("t");
    text.insert(0, "hello");
    const good = textAnchor(text, 0, 5);
    const bad: unknown[] = [
      undefined,
      null,
      "cell",
      [],
      { type: "table", key: "x" },
      { type: "cell" },
      { type: "cell", key: "" },
      { type: "cell", key: 4 },
      { type: "cell", key: Number.NaN },
      { type: "cell", key: "k".repeat(257) },
      { type: "slide", elementId: " " },
      { type: "canvas", elementId: null },
      { ...good, text: "" },
      { ...good, text: "t".repeat(2_001) },
      { ...good, start: {} },
      { ...good, start: { item: { client: -1, clock: 0 } } },
      { ...good, end: { item: { client: 1, clock: 1.5 } } },
      { ...good, end: { item: { client: 1, clock: 0 }, assoc: "x" } },
    ];
    for (const anchor of bad) expect(code(() => comments.add({ anchor: anchor as never, body: "hi" }, ada))).toBe("INVALID_ANCHOR");
    expect(comments.list()).toEqual([]);
  });

  test("extra keys on an anchor are not stored", () => {
    const comments = make();
    const thread = comments.add({ anchor: { type: "canvas", elementId: "shape-1", note: "smuggled" } as never, body: "hi" }, ada);
    expect(thread.anchor).toEqual({ type: "canvas", elementId: "shape-1" });
  });

  test("cell, slide, and canvas anchors round trip", () => {
    const comments = make();
    const anchors: Anchor[] = [cell, { type: "slide", elementId: "e9" }, { type: "canvas", elementId: "c3" }];
    for (const anchor of anchors) expect(comments.add({ anchor, body: "hi" }, ada).anchor).toEqual(anchor);
    expect(comments.list({ anchorType: "slide" })).toHaveLength(1);
  });

  test("a custom anchor kind works, and cannot replace a built-in kind", () => {
    const pin = {
      type: "map-pin",
      parse(raw: Record<string, unknown>) {
        if (typeof raw.lat !== "number" || typeof raw.lng !== "number") throw new Error("lat and lng must be numbers");
        return { type: "map-pin", lat: raw.lat, lng: raw.lng };
      },
    };
    const comments = new Comments(new Y.Doc(), { now: clock, anchors: [pin] });
    expect(comments.add({ anchor: { type: "map-pin", lat: 1, lng: 2 } as never, body: "here" }, ada).anchor).toEqual({ type: "map-pin", lat: 1, lng: 2 });
    expect(code(() => comments.add({ anchor: { type: "map-pin", lat: "1", lng: 2 } as never, body: "x" }, ada))).toBe("INVALID_ANCHOR");
    expect(() => new Comments(new Y.Doc(), { anchors: [{ ...pin, type: "cell" }] })).toThrow(CommentsError);
  });

  test("a text anchor needs a real range and keeps the quoted text", () => {
    const text = new Y.Doc().getText("t");
    text.insert(0, "hello brave world");
    expect(textAnchor(text, 6, 11).text).toBe("brave");
    for (const [from, to] of [[5, 5], [6, 3], [-1, 4], [0, 99], [0.5, 3]]) {
      expect(code(() => textAnchor(text, from, to))).toBe("INVALID_ANCHOR");
    }
  });

  test("a text anchor follows its text when another replica edits before it", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.getText("t").insert(0, "hello brave world");
    sync(a, b);
    const anchor = textAnchor(a.getText("t"), 6, 11);
    const thread = make(a).add({ anchor, body: "word choice?" }, ada);
    sync(a, b);
    b.getText("t").insert(0, "XX");
    sync(a, b);
    const stored = make(a).get(thread.id).anchor;
    if (stored.type !== "text") throw new Error("expected a text anchor");
    const from = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(stored.start), a);
    expect(from?.index).toBe(8);
  });
});

describe("thread lifecycle", () => {
  test("a missing or odd thread id finds nothing", () => {
    const comments = make();
    for (const id of ["nope", "", "__proto__", "constructor", 7, null]) {
      expect(code(() => comments.get(id as never))).toBe("NO_THREAD");
      expect(code(() => comments.reply(id as never, { body: "x" }, ada))).toBe("NO_THREAD");
      expect(code(() => comments.resolve(id as never, ada))).toBe("NO_THREAD");
      expect(code(() => comments.reopen(id as never, ada))).toBe("NO_THREAD");
    }
  });

  test("a reply to a resolved thread is refused until it is reopened", () => {
    const comments = make();
    const { id } = comments.add({ anchor: cell, body: "hi" }, ada);
    comments.resolve(id, ada);
    expect(code(() => comments.reply(id, { body: "late" }, bot))).toBe("THREAD_RESOLVED");
    comments.reopen(id, ada);
    comments.reply(id, { body: "now" }, bot);
    expect(comments.get(id).messages.map((m) => m.body)).toEqual(["hi", "now"]);
  });

  test("resolve and reopen are idempotent and keep the first decider", () => {
    const comments = make();
    const { id } = comments.add({ anchor: cell, body: "hi" }, ada);
    expect(comments.reopen(id, bot).statusBy.name).toBe("ada");
    const first = comments.resolve(id, ada);
    const again = comments.resolve(id, bot);
    expect(again).toEqual(first);
    expect(again.statusBy).toEqual({ kind: "human", name: "ada" });
    expect(comments.reopen(id, bot).status).toBe("open");
  });

  test("list filters by status and sorts by first message", () => {
    const comments = make();
    const one = comments.add({ anchor: cell, body: "one" }, ada);
    const two = comments.add({ anchor: cell, body: "two" }, bot);
    comments.resolve(one.id, ada);
    expect(comments.list().map((t) => t.id)).toEqual([one.id, two.id]);
    expect(comments.list({ status: "open" }).map((t) => t.id)).toEqual([two.id]);
    expect(comments.list({ status: "resolved" }).map((t) => t.id)).toEqual([one.id]);
  });
});

describe("two replicas", () => {
  const pair = () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const first = make(a).add({ anchor: cell, body: "start" }, ada);
    sync(a, b);
    return { a, b, ca: make(a), cb: make(b), id: first.id };
  };

  test("threads made on each side both survive", () => {
    const { a, b, ca, cb } = pair();
    ca.add({ anchor: { type: "canvas", elementId: "x" }, body: "from a" }, ada);
    cb.add({ anchor: { type: "slide", elementId: "y" }, body: "from b" }, bot);
    sync(a, b);
    expect(ca.list()).toHaveLength(3);
    expect(cb.list().map((t) => t.id)).toEqual(ca.list().map((t) => t.id));
  });

  test("concurrent replies are all kept, in one order, with their author kinds", () => {
    const { a, b, ca, cb, id } = pair();
    ca.reply(id, { body: "reply a" }, ada);
    cb.reply(id, { body: "reply b" }, bot);
    sync(a, b);
    const seen = ca.get(id).messages.map((m) => `${m.author.kind}:${m.body}`);
    expect(seen).toHaveLength(3);
    expect(seen).toContain("agent_of_human:reply b");
    expect(cb.get(id).messages).toEqual(ca.get(id).messages);
  });

  test("resolve against reopen ends in the same state on both", () => {
    const { a, b, ca, cb, id } = pair();
    ca.resolve(id, ada);
    sync(a, b);
    ca.reopen(id, ada);
    cb.resolve(id, bot);
    cb.reopen(id, bot);
    cb.resolve(id, bot);
    sync(a, b);
    expect(cb.get(id)).toEqual(ca.get(id));
  });

  test("two resolves at once end with one resolver on both", () => {
    const { a, b, ca, cb, id } = pair();
    ca.resolve(id, ada);
    cb.resolve(id, bot);
    sync(a, b);
    expect(cb.get(id).statusBy).toEqual(ca.get(id).statusBy);
    expect(ca.get(id).status).toBe("resolved");
  });

  test("a malformed thread from a hostile replica is skipped and reported", () => {
    const { a, ca, id } = pair();
    const threads = a.getMap<Y.Map<unknown>>("comments.threads");
    const evil = new Y.Map<unknown>();
    threads.set("evil", evil);
    evil.set("anchor", cell);
    evil.set("state", { status: "open", by: { kind: "root", name: "x" }, at: "2026-01-01T00:00:00.000Z" });
    const messages = new Y.Array<unknown>();
    evil.set("messages", messages);
    messages.push([{ id: "m", at: "2026-01-01T00:00:00.000Z", author: { name: "no-kind" }, body: "hi", mentions: [] }]);
    expect(ca.list().map((t) => t.id)).toEqual([id]);
    expect(ca.problems().map((p) => p.id)).toEqual(["evil"]);
    expect(code(() => ca.get("evil"))).toBe("CORRUPT");
  });
});

describe("review findings", () => {
  const ISO = "2026-01-01T00:00:00.000Z";
  const rawMessage = (over: Record<string, unknown> = {}) => ({ id: "m-raw", at: ISO, author: { kind: "human", name: "eve" }, body: "raw", mentions: [], ...over });
  const rawMessages = (doc: Y.Doc, id: string) => doc.getMap<Y.Map<unknown>>("comments.threads").get(id)!.get("messages") as Y.Array<unknown>;

  test("a caller cannot change a stored message through the value it got back", () => {
    const doc = new Y.Doc();
    const comments = make(doc);
    const { id } = comments.add({ anchor: cell, body: "hi" }, ada);
    const reply = comments.reply(id, { body: "x" }, bot);
    reply.author.kind = "human";
    reply.author.name = "alice";
    expect(comments.get(id).messages[1].author).toEqual({ kind: "agent_of_human", name: "scribe" });
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, Y.encodeStateAsUpdate(doc));
    expect(make(fresh).get(id).messages[1].author).toEqual({ kind: "agent_of_human", name: "scribe" });
  });

  test("the status record does not share an object with the first message", () => {
    const comments = make();
    const thread = comments.add({ anchor: cell, body: "hi" }, bot);
    thread.messages[0].author.kind = "human";
    expect(comments.get(thread.id).statusBy.kind).toBe("agent_of_human");
  });

  test("an actor built through the constructor is refused", () => {
    const forged = new (Actor as unknown as new (k: string, n: string, s: string[]) => Actor)("admin", "", []);
    const comments = make();
    const { id } = comments.add({ anchor: cell, body: "hi" }, ada);
    expect(code(() => comments.reply(id, { body: "y" }, forged))).toBe("INVALID_AUTHOR");
    expect(comments.get(id).messages).toHaveLength(1);
  });

  test("stamp reads its input once, so a getter cannot swap the kind", () => {
    let reads = 0;
    const input = {
      get kind() {
        return reads++ === 0 ? "human" : "bogus";
      },
      name: "n",
    };
    expect(stamp(input as never).kind).toBe("human");
  });

  test("one bad message is skipped and reported, and the good ones stay", () => {
    const doc = new Y.Doc();
    const comments = make(doc);
    const { id } = comments.add({ anchor: cell, body: "hi" }, ada);
    rawMessages(doc, id).push([rawMessage({ author: { name: "no-kind" } })]);
    expect(comments.get(id).messages.map((m) => m.body)).toEqual(["hi"]);
    expect(comments.list().map((t) => t.id)).toEqual([id]);
    expect(comments.problems().map((p) => p.id)).toEqual([id]);
    comments.reply(id, { body: "still works" }, bot);
    expect(comments.get(id).messages).toHaveLength(2);
  });

  test("a thread with no good message is skipped", () => {
    const doc = new Y.Doc();
    const comments = make(doc);
    const { id } = comments.add({ anchor: cell, body: "hi" }, ada);
    const list = rawMessages(doc, id);
    list.delete(0, 1);
    list.push([rawMessage({ at: "1" })]);
    expect(comments.list()).toEqual([]);
    expect(code(() => comments.get(id))).toBe("CORRUPT");
  });

  test("stored messages with a loose time, an empty or repeated id, or bad mentions are skipped", () => {
    const doc = new Y.Doc();
    const comments = make(doc);
    const { id } = comments.add({ anchor: cell, body: "hi" }, ada);
    const first = comments.get(id).messages[0];
    rawMessages(doc, id).push([
      rawMessage({ at: "1" }),
      rawMessage({ at: "Tue" }),
      rawMessage({ id: "" }),
      rawMessage({ id: first.id }),
      rawMessage({ mentions: ["two words"] }),
      rawMessage({ mentions: Array.from({ length: 51 }, (_, i) => `u${i}`) }),
    ]);
    expect(comments.get(id).messages).toHaveLength(1);
    expect(comments.problems()).toHaveLength(6);
  });

  test("a thread key that get refuses is not listed", () => {
    const doc = new Y.Doc();
    const comments = make(doc);
    comments.add({ anchor: cell, body: "hi" }, ada);
    const evil = new Y.Map<unknown>();
    doc.getMap<Y.Map<unknown>>("comments.threads").set("", evil);
    expect(comments.list()).toHaveLength(1);
    expect(comments.problems().map((p) => p.id)).toEqual([""]);
  });

  test("a body with more than 50 mentions is refused", () => {
    const body = Array.from({ length: 51 }, (_, i) => `@u${i}`).join(" ");
    expect(code(() => make().add({ anchor: cell, body }, ada))).toBe("INVALID_INPUT");
  });

  test("handles match the same way on write and on search", () => {
    const comments = make();
    const thread = comments.add({ anchor: cell, body: "hi @Bob", mentions: ["@@Eve"] }, ada);
    expect(thread.messages[0].mentions).toEqual(["bob", "eve"]);
    expect(comments.list({ mentioning: "BOB" })).toHaveLength(1);
    expect(comments.list({ mentioning: "@@eve" })).toHaveLength(1);
  });

  test("a custom kind cannot return another type or share its result with the caller", () => {
    const liar = { type: "pin", parse: () => ({ type: "text" }) };
    const alias = { type: "alias", parse: (raw: Record<string, unknown>) => raw as { type: string } };
    const comments = new Comments(new Y.Doc(), { now: clock, anchors: [liar, alias] });
    expect(code(() => comments.add({ anchor: { type: "pin" } as never, body: "x" }, ada))).toBe("INVALID_ANCHOR");
    const given = { type: "alias", n: 1 };
    const thread = comments.add({ anchor: given as never, body: "x" }, ada);
    given.n = 2;
    expect((comments.get(thread.id).anchor as unknown as { n: number }).n).toBe(1);
  });

  test("a text range must use two item positions", () => {
    const text = new Y.Doc().getText("t");
    text.insert(0, "hello");
    const good = textAnchor(text, 0, 5);
    const comments = make();
    for (const anchor of [
      { ...good, start: { tname: "a" }, end: { tname: "b" } },
      { ...good, start: { tname: "a" } },
      { ...good, end: { type: { client: 1, clock: 0 } } },
    ]) {
      expect(code(() => comments.add({ anchor: anchor as never, body: "x" }, ada))).toBe("INVALID_ANCHOR");
    }
  });

  test("bad options and filters fail with a CommentsError", () => {
    const comments = make();
    expect(code(() => comments.list(null as never))).toBe("INVALID_INPUT");
    expect(code(() => comments.list({ mentioning: 5 as never }))).toBe("INVALID_INPUT");
    expect(code(() => comments.list({ anchorType: 5 as never }))).toBe("INVALID_INPUT");
    const broken = new Comments(new Y.Doc(), { now: () => new Date(Number.NaN) });
    expect(code(() => broken.add({ anchor: cell, body: "x" }, ada))).toBe("INVALID_INPUT");
  });
});

describe("second review findings", () => {
  const ISO = "2026-01-01T00:00:00.000Z";
  const itemAnchor = () => {
    const text = new Y.Doc().getText("t");
    text.insert(0, "hello");
    return textAnchor(text, 0, 5);
  };

  test("a clock that gives a year past 9999 writes nothing", () => {
    const doc = new Y.Doc();
    const far = new Comments(doc, { now: () => new Date("+010000-01-01T00:00:00Z") });
    expect(code(() => far.add({ anchor: cell, body: "x" }, ada))).toBe("INVALID_INPUT");
    expect(make(doc).list()).toEqual([]);
    expect(make(doc).problems()).toEqual([]);
  });

  test("a reply that meets a resolve on another replica stays, and the thread is resolved on both", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const { id } = make(a).add({ anchor: cell, body: "start" }, ada);
    sync(a, b);
    make(a).resolve(id, ada);
    make(b).reply(id, { body: "late" }, bot);
    sync(a, b);
    for (const doc of [a, b]) {
      const thread = make(doc).get(id);
      expect(thread.status).toBe("resolved");
      expect(thread.messages.map((m) => m.body)).toEqual(expect.arrayContaining(["start", "late"]));
    }
  });

  test("stored mentions must be in the stored form", () => {
    const doc = new Y.Doc();
    const comments = make(doc);
    const { id } = comments.add({ anchor: cell, body: "hi" }, ada);
    (doc.getMap<Y.Map<unknown>>("comments.threads").get(id)!.get("messages") as Y.Array<unknown>).push([
      { id: "m1", at: ISO, author: { kind: "human", name: "eve" }, body: "x", mentions: ["Bob"] },
      { id: "m2", at: ISO, author: { kind: "human", name: "eve" }, body: "x", mentions: ["@bob"] },
    ]);
    expect(comments.get(id).messages).toHaveLength(1);
    expect(comments.problems()).toHaveLength(2);
  });

  test("threads sort by time, then by id, whatever the time format", () => {
    const doc = new Y.Doc();
    const comments = make(doc);
    const threads = doc.getMap<Y.Map<unknown>>("comments.threads");
    const raw = (id: string, at: string) => {
      const fields = new Y.Map<unknown>();
      threads.set(id, fields);
      fields.set("anchor", cell);
      fields.set("state", { status: "open", by: { kind: "human", name: "eve" }, at });
      const list = new Y.Array<unknown>();
      fields.set("messages", list);
      list.push([{ id: `m-${id}`, at, author: { kind: "human", name: "eve" }, body: "x", mentions: [] }]);
    };
    raw("late", "2026-01-01T00:00:00.500Z");
    raw("early", "2026-01-01T00:00:00Z");
    raw("tie-b", "2026-01-01T00:00:01.000Z");
    raw("tie-a", "2026-01-01T00:00:01Z");
    expect(comments.list().map((t) => t.id)).toEqual(["early", "late", "tie-a", "tie-b"]);
  });

  test("a text range uses item positions only, with a plain assoc", () => {
    const good = itemAnchor();
    const comments = make();
    for (const anchor of [
      { ...good, start: { ...good.start, tname: "a" } },
      { ...good, end: { ...good.end, type: { client: 9, clock: 9 } } },
      { ...good, end: { ...good.end, assoc: 99 } },
      { ...good, start: { ...good.start, assoc: -5 } },
    ]) {
      expect(code(() => comments.add({ anchor: anchor as never, body: "x" }, ada))).toBe("INVALID_ANCHOR");
    }
  });

  test("author names with edge spaces, control characters, or invisible characters are refused", () => {
    for (const name of [" ada", "ada ", "ada\n", "a\u200Bda", "ad\u0000a", "ada\u202E"]) {
      expect(code(() => stamp({ kind: "human", name }))).toBe("INVALID_AUTHOR");
    }
  });

  test("no agent kind is labeled a person", () => {
    const labels = Object.fromEntries(PRINCIPAL_KINDS.map((kind) => [kind, authorLabel({ kind, name: "n" })]));
    expect(labels).toEqual({ human: "person", user_token: "person via agent", agent_of_human: "agent", agent_of_agent: "agent", agent: "agent" });
  });

  test("a handle keeps its non-ASCII letters", () => {
    const thread = make().add({ anchor: cell, body: "ping @José and @Zoë." }, ada);
    expect(thread.messages[0].mentions).toEqual(["josé", "zoë"]);
  });

  test("a thread over the message cap is refused on write and malformed on read", () => {
    const doc = new Y.Doc();
    const comments = make(doc);
    const { id } = comments.add({ anchor: cell, body: "hi" }, ada);
    const list = doc.getMap<Y.Map<unknown>>("comments.threads").get(id)!.get("messages") as Y.Array<unknown>;
    list.push(Array.from({ length: 999 }, (_, i) => ({ id: `m${i}`, at: ISO, author: { kind: "human", name: "eve" }, body: "x", mentions: [] })));
    expect(code(() => comments.reply(id, { body: "one too many" }, bot))).toBe("INVALID_INPUT");
    list.push([{ id: "extra", at: ISO, author: { kind: "human", name: "eve" }, body: "x", mentions: [] }]);
    expect(code(() => comments.get(id))).toBe("CORRUPT");
  });
});
