import * as Y from "yjs";
import { describe, expect, test } from "vitest";
import { ACCEPT_SCOPE, Comments, CommentsError, stamp, Suggestions, textAnchor, textOf, type SuggestionHost, type TextAnchor } from "./index.js";

// Ways suggestions can fail, written before the tests:
//  1. An agent decides its own suggestion, or decides with no accept scope.
//  2. An unstamped or missing actor decides anything.
//  3. A refused decision still changes the text or the status.
//  4. Accept runs twice on one replica, or after a reject, or reject after accept.
//  5. apply throws, or returns a promise, and a half decision is kept.
//  6. A bad anchor, payload, summary, or extra key writes a suggestion.
//  7. Two replicas accept at once and the change lands twice.
//  8. Accept and reject at once leave the replicas with two different answers.
//  9. A document that holds two applications is read without settling them.
// 10. A revert that throws is lost, so the duplicate stays for good.
// 11. A peer writes a bad suggestion or a forged record and breaks listing or status.
// 12. A caller changes the stored payload through a value it got back.
// 13. A host with no way to undo a duplicate is accepted.
// 14. A junk or forged record from a peer wins settle and undoes a real accept.
// 15. A failure after apply edits the document leaves a half change, and a second accept doubles it.
// 16. A token that an agent holds decides the agent's own suggestion with no scope.
// 17. apply gets an anchor that no longer matches the document, or accepts the suggestion it is applying.

const ada = stamp({ kind: "human", name: "ada" });
const grace = stamp({ kind: "human", name: "grace" });
const bot = stamp({ kind: "agent_of_human", name: "scribe" });
const sameName = stamp({ kind: "agent", name: "scribe", scopes: [ACCEPT_SCOPE] });
const botWithScope = stamp({ kind: "agent_of_human", name: "scribe", scopes: [ACCEPT_SCOPE] });
const reviewer = stamp({ kind: "agent", name: "reviewer", scopes: [ACCEPT_SCOPE] });
const intern = stamp({ kind: "agent", name: "intern" });

let tick = 0;
const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));

const absolute = (json: object, ydoc: Y.Doc) => Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), ydoc);

/** A host that replaces a text range. A receipt names the inserted range, so a duplicate can be undone. */
function textHost(counter = { applies: 0 }): SuggestionHost {
  return {
    apply(change, ctx) {
      const { replacement } = change as { replacement?: unknown };
      if (typeof replacement !== "string") throw new Error("the change needs a replacement");
      const anchor = ctx.anchor as TextAnchor;
      const from = absolute(anchor.start, ctx.ydoc);
      const to = absolute(anchor.end, ctx.ydoc);
      if (!from || !to || !(from.type instanceof Y.Text) || textOf(from.type).slice(from.index, to.index) !== anchor.text) throw new Error("the anchored text changed");
      counter.applies++;
      const text = from.type;
      text.delete(from.index, to.index - from.index);
      text.insert(from.index, replacement);
      return {
        start: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, from.index, 0)),
        end: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, from.index + replacement.length, -1)),
      };
    },
    revert(receipt, ctx) {
      const { start, end } = receipt as { start: object; end: object };
      const from = absolute(start, ctx.ydoc);
      const to = absolute(end, ctx.ydoc);
      if (from && to && from.type === to.type && to.index > from.index && from.type instanceof Y.Text) from.type.delete(from.index, to.index - from.index);
    },
  };
}

const cellHost: SuggestionHost = {
  idempotent: true,
  apply(change, ctx) {
    ctx.ydoc.getMap("cells").set((ctx.anchor as { key: string }).key, (change as { value: unknown }).value);
    return null;
  },
};

function replica(host: SuggestionHost, source?: Y.Doc) {
  const ydoc = new Y.Doc();
  ydoc.getText("t");
  if (source) Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(source));
  else ydoc.getText("t").insert(0, "hello brave world");
  const comments = new Comments(ydoc, { now: clock });
  return { ydoc, comments, suggestions: new Suggestions(comments, host), text: () => ydoc.getText("t").toString() };
}

const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
};

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    if (error instanceof CommentsError) return error.code;
    throw error;
  }
  return undefined;
};

/** A pending suggestion on "brave", written by `author`. */
function suggest(r: ReturnType<typeof replica>, author = bot) {
  return r.suggestions.add({ anchor: textAnchor(r.ydoc.getText("t"), 6, 11), change: { replacement: "bold" }, summary: "word choice" }, author);
}

describe("who may decide", () => {
  test("an agent never decides its own suggestion, with or without the scope, whatever its kind", () => {
    const r = replica(textHost());
    const s = suggest(r);
    for (const actor of [bot, botWithScope, sameName]) {
      expect(code(() => r.suggestions.accept(s.id, actor))).toBe("FORBIDDEN");
      expect(code(() => r.suggestions.reject(s.id, actor))).toBe("FORBIDDEN");
    }
    expect(r.suggestions.get(s.id).status).toBe("pending");
    expect(r.text()).toBe("hello brave world");
  });

  test("an agent with no accept scope cannot decide another's suggestion", () => {
    const r = replica(textHost());
    const s = suggest(r);
    expect(code(() => r.suggestions.accept(s.id, intern))).toBe("FORBIDDEN");
    expect(code(() => r.suggestions.reject(s.id, intern))).toBe("FORBIDDEN");
    expect(r.text()).toBe("hello brave world");
  });

  test("an agent with the scope accepts another's suggestion, and its kind stays on the decision", () => {
    const r = replica(textHost());
    const s = suggest(r);
    const done = r.suggestions.accept(s.id, reviewer);
    expect(done.status).toBe("accepted");
    expect(done.decidedBy).toEqual({ kind: "agent", name: "reviewer" });
    expect(r.text()).toBe("hello bold world");
  });

  test("a person accepts an agent's suggestion, and withdraws their own", () => {
    const r = replica(textHost());
    expect(r.suggestions.accept(suggest(r).id, ada).decidedBy).toEqual({ kind: "human", name: "ada" });
    const own = r.suggestions.add({ anchor: textAnchor(r.ydoc.getText("t"), 0, 5), change: { replacement: "bye" } }, grace);
    expect(r.suggestions.reject(own.id, grace).status).toBe("rejected");
  });

  test("an unstamped or missing actor decides nothing and suggests nothing", () => {
    const r = replica(textHost());
    const s = suggest(r);
    const forged = { kind: "human", name: "ada", scopes: [] };
    for (const actor of [undefined, forged]) {
      expect(code(() => r.suggestions.accept(s.id, actor as never))).toBe("INVALID_AUTHOR");
      expect(code(() => r.suggestions.reject(s.id, actor as never))).toBe("INVALID_AUTHOR");
      expect(code(() => r.suggestions.add({ anchor: s.anchor, change: {} }, actor as never))).toBe("INVALID_AUTHOR");
    }
    expect(r.suggestions.list()).toHaveLength(1);
    expect(r.text()).toBe("hello brave world");
  });
});

describe("one replica", () => {
  test("accept applies once, and a second accept by anyone allowed changes nothing", () => {
    const counter = { applies: 0 };
    const r = replica(textHost(counter));
    const s = suggest(r);
    const first = r.suggestions.accept(s.id, ada);
    const second = r.suggestions.accept(s.id, grace);
    expect(counter.applies).toBe(1);
    expect(second).toEqual(first);
    expect(r.text()).toBe("hello bold world");
  });

  test("a decision cannot be reversed, and a repeat reject changes nothing", () => {
    const r = replica(textHost());
    const a = suggest(r);
    r.suggestions.accept(a.id, ada);
    expect(code(() => r.suggestions.reject(a.id, ada))).toBe("ALREADY_DECIDED");
    const b = r.suggestions.add({ anchor: textAnchor(r.ydoc.getText("t"), 0, 5), change: { replacement: "bye" } }, bot);
    const first = r.suggestions.reject(b.id, ada);
    expect(r.suggestions.reject(b.id, grace)).toEqual(first);
    expect(code(() => r.suggestions.accept(b.id, ada))).toBe("ALREADY_DECIDED");
    expect(r.text()).toBe("hello bold world");
  });

  test("when apply throws, the suggestion stays pending and the text is untouched", () => {
    const r = replica(textHost());
    const s = suggest(r);
    r.ydoc.getText("t").delete(6, 5);
    r.ydoc.getText("t").insert(6, "quick");
    expect(code(() => r.suggestions.accept(s.id, ada))).toBe("APPLY_FAILED");
    expect(r.suggestions.get(s.id).status).toBe("pending");
    expect(r.text()).toBe("hello quick world");
  });

  test("an apply that returns a promise is refused as a failure", () => {
    const r = replica({ idempotent: true, apply: async () => null });
    const s = suggest(r);
    expect(code(() => r.suggestions.accept(s.id, ada))).toBe("APPLY_FAILED");
    expect(r.suggestions.get(s.id).status).toBe("pending");
  });

  test("a bad input writes nothing", () => {
    const r = replica(textHost());
    const anchor = textAnchor(r.ydoc.getText("t"), 6, 11);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const bad: Record<string, unknown>[] = [
      { anchor, change: { replacement: "x" }, author: { kind: "human", name: "boss" } },
      { anchor: { type: "cell" }, change: {} },
      { anchor, change: undefined },
      { anchor, change: Number.NaN },
      { anchor, change: { n: Number.POSITIVE_INFINITY } },
      { anchor, change: () => 1 },
      { anchor, change: cycle },
      { anchor, change: "x".repeat(70_000) },
      { anchor, change: {}, summary: "" },
      { anchor, change: {}, summary: "a‮b" },
      { anchor, change: {}, summary: "s".repeat(1_001) },
    ];
    for (const input of bad) expect(["INVALID_INPUT", "INVALID_ANCHOR"]).toContain(code(() => r.suggestions.add(input as never, bot)));
    const strict = replica({ ...cellHost, parse: (c) => { if (typeof (c as { value?: unknown }).value !== "number") throw new Error("a number is needed"); return c; } });
    expect(code(() => strict.suggestions.add({ anchor: { type: "cell", key: "A1" }, change: { value: "no" } }, bot))).toBe("INVALID_INPUT");
    expect(r.suggestions.list()).toEqual([]);
    expect(strict.suggestions.list()).toEqual([]);
  });

  test("a caller cannot change the stored change through a value it got back", () => {
    const r = replica(textHost());
    const s = suggest(r);
    (s.change as { replacement: string }).replacement = "evil";
    expect((r.suggestions.get(s.id).change as { replacement: string }).replacement).toBe("bold");
    expect(r.suggestions.accept(s.id, ada).status).toBe("accepted");
    expect(r.text()).toBe("hello bold world");
  });

  test("a host with no revert and no idempotent flag is refused", () => {
    const r = replica(textHost());
    expect(() => new Suggestions(r.comments, { apply: () => null })).toThrow(CommentsError);
    expect(() => new Suggestions(r.comments, {} as never)).toThrow(CommentsError);
  });

  test("list filters by status and an unknown status is refused", () => {
    const r = replica(textHost());
    const s = suggest(r);
    expect(r.suggestions.list({ status: "pending" })).toHaveLength(1);
    r.suggestions.accept(s.id, ada);
    expect(r.suggestions.list({ status: "pending" })).toEqual([]);
    expect(r.suggestions.list({ status: "accepted" })).toHaveLength(1);
    expect(code(() => r.suggestions.list({ status: "done" as never }))).toBe("INVALID_INPUT");
    expect(code(() => r.suggestions.get("missing"))).toBe("NO_SUGGESTION");
  });
});

describe("replicas that decide at once", () => {
  const pair = () => {
    const a = replica(textHost());
    const s = suggest(a);
    const b = replica(textHost(), a.ydoc);
    return { a, b, id: s.id };
  };

  test("two accepts make one edit on both replicas, and both name the same decider", () => {
    const { a, b, id } = pair();
    a.suggestions.accept(id, ada);
    b.suggestions.accept(id, grace);
    expect([a.text(), b.text()]).toEqual(["hello bold world", "hello bold world"]);
    sync(a.ydoc, b.ydoc);
    expect(a.text()).toBe("hello bold world");
    expect(b.text()).toBe("hello bold world");
    expect(a.suggestions.get(id)).toEqual(b.suggestions.get(id));
    expect(a.suggestions.get(id).status).toBe("accepted");
    expect(a.ydoc.getMap("comments.suggestion-applied").size).toBe(1);
  });

  test("three accepts make one edit on every replica", () => {
    const { a, b, id } = pair();
    const c = replica(textHost(), a.ydoc);
    for (const [r, who] of [[a, ada], [b, grace], [c, reviewer]] as const) r.suggestions.accept(id, who);
    sync(a.ydoc, b.ydoc);
    sync(b.ydoc, c.ydoc);
    sync(a.ydoc, c.ydoc);
    sync(a.ydoc, b.ydoc);
    expect([a.text(), b.text(), c.text()]).toEqual(["hello bold world", "hello bold world", "hello bold world"]);
    expect(b.suggestions.get(id)).toEqual(a.suggestions.get(id));
    expect(c.suggestions.get(id)).toEqual(a.suggestions.get(id));
  });

  test("an accept beats a reject made at the same time, on both replicas", () => {
    const { a, b, id } = pair();
    a.suggestions.accept(id, ada);
    b.suggestions.reject(id, grace);
    sync(a.ydoc, b.ydoc);
    expect(a.suggestions.get(id).status).toBe("accepted");
    expect(b.suggestions.get(id)).toEqual(a.suggestions.get(id));
    expect(b.text()).toBe("hello bold world");
  });

  test("two rejects end with one decider on both replicas", () => {
    const { a, b, id } = pair();
    a.suggestions.reject(id, ada);
    b.suggestions.reject(id, grace);
    sync(a.ydoc, b.ydoc);
    expect(a.suggestions.get(id).status).toBe("rejected");
    expect(b.suggestions.get(id)).toEqual(a.suggestions.get(id));
    expect(a.text()).toBe("hello brave world");
  });

  test("an idempotent host needs no revert", () => {
    const a = replica(cellHost);
    const s = a.suggestions.add({ anchor: { type: "cell", key: "A1" }, change: { value: 7 } }, bot);
    const b = replica(cellHost, a.ydoc);
    a.suggestions.accept(s.id, ada);
    b.suggestions.accept(s.id, grace);
    sync(a.ydoc, b.ydoc);
    expect(a.ydoc.getMap("cells").get("A1")).toBe(7);
    expect(a.ydoc.getMap("comments.suggestion-applied").size).toBe(1);
    expect(b.suggestions.get(s.id)).toEqual(a.suggestions.get(s.id));
  });

  test("a document loaded with two applications settles them when it opens", () => {
    const { a, b, id } = pair();
    a.suggestions.accept(id, ada);
    b.suggestions.accept(id, grace);
    const merged = new Y.Doc();
    merged.getText("t");
    Y.applyUpdate(merged, Y.encodeStateAsUpdate(a.ydoc));
    Y.applyUpdate(merged, Y.encodeStateAsUpdate(b.ydoc));
    expect(merged.getText("t").toString()).toBe("hello boldbold world");
    const opened = replica(textHost(), merged);
    expect(opened.text()).toBe("hello bold world");
    expect(opened.ydoc.getMap("comments.suggestion-applied").size).toBe(1);
  });

  test("a revert that throws keeps its record and is tried again at the next merge", () => {
    const base = textHost();
    let broken = true;
    const flaky: SuggestionHost = {
      ...base,
      revert(receipt, ctx) {
        if (broken) throw new Error("storage is offline");
        base.revert!(receipt, ctx);
      },
    };
    const a = replica(flaky);
    const s = suggest(a);
    const b = replica(flaky, a.ydoc);
    a.suggestions.accept(s.id, ada);
    b.suggestions.accept(s.id, grace);
    sync(a.ydoc, b.ydoc);
    expect(a.ydoc.getMap("comments.suggestion-applied").size).toBe(2);
    expect(a.suggestions.problems().some((p) => p.reason.includes("could not be reverted"))).toBe(true);
    broken = false;
    a.suggestions.settle();
    b.suggestions.settle();
    sync(a.ydoc, b.ydoc);
    expect(a.ydoc.getMap("comments.suggestion-applied").size).toBe(1);
    expect(a.text()).toBe("hello bold world");
    expect(b.text()).toBe("hello bold world");
  });
});

describe("data from a peer", () => {
  test("a malformed suggestion is skipped and named, and a forged record is not counted", () => {
    const r = replica(textHost());
    const good = suggest(r);
    const evil = new Y.Map<unknown>();
    r.ydoc.getMap<Y.Map<unknown>>("comments.suggestions").set("evil", evil);
    evil.set("author", { kind: "root", name: "x" });
    r.ydoc.getMap("comments.suggestion-applied").set(`${good.id}:1`, { by: { kind: "human" }, at: "yesterday", receipt: null });
    r.ydoc.getMap("comments.suggestion-rejected").set(`${good.id}:2`, { by: { name: "no-kind" }, at: "2026-01-01T00:00:00.000Z" });
    expect(r.suggestions.list().map((s) => s.id)).toEqual([good.id]);
    expect(r.suggestions.get(good.id).status).toBe("pending");
    expect(r.suggestions.problems().map((p) => p.id)).toEqual(["evil"]);
    expect(code(() => r.suggestions.get("evil"))).toBe("CORRUPT");
  });
});

describe("records and edits that go wrong", () => {
  const marker = (text: string): SuggestionHost => ({
    idempotent: true,
    apply(_change, ctx) {
      ctx.ydoc.getText("t").insert(0, text);
      return null;
    },
  });
  const cellAnchor = { type: "cell", key: "A1" } as const;

  test("a junk record from a peer cannot win settle or undo a real accept", () => {
    const a = replica(textHost());
    const s = suggest(a);
    a.suggestions.accept(s.id, ada);
    const applied = a.ydoc.getMap("comments.suggestion-applied");
    const real = applied.size;
    for (const junk of [{}, null, { by: { kind: "human", name: "x" }, at: "2026-01-01T00:00:00.000Z", receipt: Number.NaN }, { by: { kind: "human", name: "x" }, at: "2026-01-01T00:00:00.000Z", receipt: "r".repeat(20_000) }]) {
      applied.set(`${s.id}:0`, junk);
      a.suggestions.settle();
      expect(a.text()).toBe("hello bold world");
      expect(a.suggestions.get(s.id).status).toBe("accepted");
      expect(a.suggestions.get(s.id).decidedBy).toEqual({ kind: "human", name: "ada" });
    }
    applied.set("no-such-suggestion:0", { by: { kind: "human", name: "x" }, at: "2026-01-01T00:00:00.000Z", receipt: null });
    a.suggestions.settle();
    expect(applied.size).toBe(real + 2);
    expect(a.text()).toBe("hello bold world");
  });

  test("a record from a decider who decided their own work is not counted", () => {
    const r = replica(textHost());
    const s = suggest(r);
    r.ydoc.getMap("comments.suggestion-applied").set(`${s.id}:1`, { by: { kind: "agent", name: "scribe" }, at: "2026-01-01T00:00:00.000Z", receipt: null });
    expect(r.suggestions.get(s.id).status).toBe("pending");
  });

  test("when apply edits and then returns a bad receipt, the decision is recorded and a second accept does not double the edit", () => {
    const r = replica({ ...marker("X"), apply: (_c, ctx) => { ctx.ydoc.getText("t").insert(0, "X"); return { bad: Number.NaN }; } });
    const s = r.suggestions.add({ anchor: cellAnchor, change: {} }, bot);
    expect(r.suggestions.accept(s.id, ada).status).toBe("accepted");
    r.suggestions.accept(s.id, grace);
    expect(r.text()).toBe("Xhello brave world");
    expect(r.suggestions.problems().some((p) => p.reason.includes("apply failed after it edited"))).toBe(true);
  });

  test("when apply edits and then throws, the decision is recorded and the edit lands once", () => {
    const r = replica({ idempotent: true, apply: (_c, ctx) => { ctx.ydoc.getText("t").insert(0, "X"); throw new Error("late failure"); } });
    const s = r.suggestions.add({ anchor: cellAnchor, change: {} }, bot);
    expect(r.suggestions.accept(s.id, ada).status).toBe("accepted");
    r.suggestions.accept(s.id, grace);
    expect(r.text()).toBe("Xhello brave world");
  });

  test("an async apply that edits before it returns is recorded", () => {
    const edits = replica({ idempotent: true, apply: (async (_c: unknown, ctx: { ydoc: Y.Doc }) => { ctx.ydoc.getText("t").insert(0, "X"); }) as never });
    const s = edits.suggestions.add({ anchor: cellAnchor, change: {} }, bot);
    expect(edits.suggestions.accept(s.id, ada).status).toBe("accepted");
    expect(edits.text()).toBe("Xhello brave world");
  });

  test("a bad clock fails before apply runs", () => {
    const counter = { applies: 0 };
    const ydoc = new Y.Doc();
    ydoc.getText("t").insert(0, "hello");
    let broken = false;
    const comments = new Comments(ydoc, { now: () => (broken ? new Date(Number.NaN) : new Date()) });
    const suggestions = new Suggestions(comments, { idempotent: true, apply: () => { counter.applies++; return null; } });
    const s = suggestions.add({ anchor: cellAnchor, change: {} }, bot);
    broken = true;
    expect(code(() => suggestions.accept(s.id, ada))).toBe("INVALID_INPUT");
    expect(counter.applies).toBe(0);
  });

  test("a token needs the accept scope, and an agent that holds one cannot decide its own suggestion", () => {
    const r = replica(textHost());
    const noScope = stamp({ kind: "user_token", name: "ada" });
    const ownToken = stamp({ kind: "user_token", name: "scribe", scopes: [ACCEPT_SCOPE] });
    const withScope = stamp({ kind: "user_token", name: "ada", scopes: [ACCEPT_SCOPE] });
    const byAgent = suggest(r, bot);
    expect(code(() => r.suggestions.accept(byAgent.id, noScope))).toBe("FORBIDDEN");
    expect(code(() => r.suggestions.accept(byAgent.id, ownToken))).toBe("FORBIDDEN");
    expect(code(() => r.suggestions.reject(byAgent.id, ownToken))).toBe("FORBIDDEN");
    expect(r.suggestions.accept(byAgent.id, withScope).decidedBy).toEqual({ kind: "user_token", name: "ada" });
  });

  test("a signed-in person may decide their own suggestion, and a token for them needs the scope", () => {
    const r = replica(textHost());
    const s = r.suggestions.add({ anchor: textAnchor(r.ydoc.getText("t"), 6, 11), change: { replacement: "bold" } }, ada);
    expect(code(() => r.suggestions.accept(s.id, stamp({ kind: "user_token", name: "ada" })))).toBe("FORBIDDEN");
    expect(r.suggestions.accept(s.id, stamp({ kind: "user_token", name: "ada", scopes: [ACCEPT_SCOPE] })).status).toBe("accepted");
  });

  test("apply never sees an anchor that no longer matches the document, even for a host that does not check", () => {
    const counter = { applies: 0 };
    const r = replica({ idempotent: true, apply: () => { counter.applies++; return null; } });
    const s = r.suggestions.add({ anchor: textAnchor(r.ydoc.getText("t"), 6, 11), change: {} }, bot);
    const stored = r.ydoc.getMap<Y.Map<unknown>>("comments.suggestions").get(s.id)!;
    stored.set("anchor", { ...(stored.get("anchor") as object), text: "world" });
    expect(code(() => r.suggestions.accept(s.id, ada))).toBe("APPLY_FAILED");
    expect(counter.applies).toBe(0);
    expect(r.suggestions.get(s.id).status).toBe("pending");
  });

  test("apply cannot accept the suggestion it is applying", () => {
    const holder: { suggestions?: Suggestions; id?: string; tried: boolean } = { tried: false };
    const r = replica({
      idempotent: true,
      apply: () => {
        if (!holder.tried) {
          holder.tried = true;
          holder.suggestions!.accept(holder.id!, ada);
        }
        return null;
      },
    });
    holder.suggestions = r.suggestions;
    const s = r.suggestions.add({ anchor: cellAnchor, change: {} }, bot);
    holder.id = s.id;
    expect(code(() => r.suggestions.accept(s.id, ada))).toBe("APPLY_FAILED");
    expect(r.suggestions.get(s.id).status).toBe("pending");
  });
});

describe("peer records, outer transactions, and contexts", () => {
  const cellAnchor = { type: "cell", key: "A1" } as const;

  test("keys that spell a client id another way are not counted, and never reach revert", () => {
    const reverted: unknown[] = [];
    const r = replica({ idempotent: false, apply: () => null, revert: (receipt) => void reverted.push(receipt) });
    const s = r.suggestions.add({ anchor: cellAnchor, change: {} }, bot);
    const applied = r.ydoc.getMap("comments.suggestion-applied");
    const record = { by: { kind: "human", name: "mallory" }, at: "2026-01-01T00:00:00.000Z", receipt: { evil: true } };
    for (const tail of ["", "0x0", " 0", "9e15", "05", "4294967296", "-1", "1.5"]) applied.set(`${s.id}:${tail}`, record);
    r.suggestions.settle();
    expect(r.suggestions.get(s.id).status).toBe("pending");
    expect(reverted).toEqual([]);
  });

  test("a well-formed record from a peer is counted, so the sync layer must decide who may write", () => {
    const r = replica(textHost());
    const s = suggest(r);
    r.ydoc.getMap("comments.suggestion-applied").set(`${s.id}:1`, { by: { kind: "human", name: "mallory" }, at: "2026-01-01T00:00:00.000Z", receipt: null });
    expect(r.suggestions.get(s.id).decidedBy).toEqual({ kind: "human", name: "mallory" });
  });

  test("accept inside another transaction is refused, and writes nothing", () => {
    const r = replica(textHost());
    const s = suggest(r);
    let result: string | undefined;
    r.ydoc.transact(() => {
      r.ydoc.getMap("other").set("k", 1);
      result = code(() => r.suggestions.accept(s.id, ada));
    });
    expect(result).toBe("APPLY_FAILED");
    expect(r.suggestions.get(s.id).status).toBe("pending");
    expect(r.text()).toBe("hello brave world");
  });

  test("a record with no receipt never loses, so its edit is not left in twice", () => {
    const hostFor = (fail: boolean): SuggestionHost => ({
      apply(_change, ctx) {
        const text = ctx.ydoc.getText("t");
        text.insert(0, "X");
        if (fail) throw new Error("late failure");
        return {
          start: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, 0, 0)),
          end: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, 1, -1)),
        };
      },
      revert(receipt, ctx) {
        const { start, end } = receipt as { start: object; end: object };
        const from = absolute(start, ctx.ydoc);
        const to = absolute(end, ctx.ydoc);
        if (from && to && from.type instanceof Y.Text && to.index > from.index) from.type.delete(from.index, to.index - from.index);
      },
    });
    for (const failingFirst of [true, false]) {
      const a = replica(hostFor(failingFirst));
      const s = a.suggestions.add({ anchor: cellAnchor, change: {} }, bot);
      const b = replica(hostFor(!failingFirst), a.ydoc);
      a.suggestions.accept(s.id, ada);
      b.suggestions.accept(s.id, grace);
      sync(a.ydoc, b.ydoc);
      expect(a.text()).toBe("Xhello brave world");
      expect(b.text()).toBe("Xhello brave world");
      expect(b.suggestions.get(s.id)).toEqual(a.suggestions.get(s.id));
    }
  });

  test("revert learns the anchor, the author, and who made the application it undoes", () => {
    const seen: { anchor: string; author: string; by: string }[] = [];
    const base = textHost();
    const spy: SuggestionHost = { ...base, revert: (receipt, ctx) => { seen.push({ anchor: ctx.anchor.type, author: ctx.author.name, by: `${ctx.by.kind}:${ctx.by.name}` }); base.revert!(receipt, ctx); } };
    const a = replica(spy);
    const s = suggest(a);
    const b = replica(spy, a.ydoc);
    a.suggestions.accept(s.id, ada);
    b.suggestions.accept(s.id, grace);
    sync(a.ydoc, b.ydoc);
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen.map((x) => `${x.anchor}|${x.author}`))).toEqual(new Set(["text|scribe"]));
    expect(seen.every((x) => x.by === "human:ada" || x.by === "human:grace")).toBe(true);
  });

  test("apply cannot change who decided, because its copy of the decider is frozen", () => {
    const r = replica({ idempotent: true, apply: (_c, ctx) => { try { (ctx.by as { kind: string }).kind = "human"; } catch { /* frozen */ } return null; } });
    const s = r.suggestions.add({ anchor: cellAnchor, change: {} }, bot);
    expect(r.suggestions.accept(s.id, reviewer).decidedBy).toEqual({ kind: "agent", name: "reviewer" });
  });

  test("settle runs when the suggestion arrives after its application records", () => {
    const reverted: number[] = [];
    const host: SuggestionHost = { apply: () => null, revert: () => void reverted.push(1) };
    const source = replica(host);
    const s = source.suggestions.add({ anchor: cellAnchor, change: {} }, bot);
    const target = new Y.Doc();
    const comments = new Comments(target, { now: clock });
    const suggestions = new Suggestions(comments, host);
    const record = { by: { kind: "human", name: "ada" }, at: "2026-01-01T00:00:00.000Z", receipt: null };
    target.getMap("comments.suggestion-applied").set(`${s.id}:1`, record);
    target.getMap("comments.suggestion-applied").set(`${s.id}:2`, record);
    expect(reverted).toEqual([]);
    Y.applyUpdate(target, Y.encodeStateAsUpdate(source.ydoc));
    expect(reverted).toEqual([1]);
    expect(suggestions.get(s.id).status).toBe("accepted");
  });
});
