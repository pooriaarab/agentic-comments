import * as Y from "yjs";
import { describe, expect, test } from "vitest";
import { Comments, CommentsError, stamp, Suggestions, textAnchor, type Anchor, type AnchorKind } from "./index.js";

// Ways anchor survival can fail, written before the code:
//  1. Deleted or edited content makes a thread unreadable, or makes a read throw.
//  2. An orphaned thread cannot take a reply, or is hidden from list.
//  3. Content that was only edited is reported as gone, or gone content as attached.
//  4. An edit before the range, from another replica, makes a live anchor look gone.
//  5. A delete on one replica and a reply on another lose the reply or disagree.
//  6. Relocate moves an anchor to a guess: no match, many matches, or a changed quote.
//  7. Relocate writes when nothing is wrong, or runs on an anchor it cannot move.
//  8. A host callback that throws or lies turns into a crash or a false "gone".
//  9. A suggestion on gone or edited content is accepted, or is not flagged.
// 10. An anchor that points into another document throws instead of being flagged.
// 11. Two replicas relocate at once and end with different anchors.

const ada = stamp({ kind: "human", name: "ada" });
const bot = stamp({ kind: "agent_of_human", name: "scribe" });

let tick = 0;
const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));

function replica(source?: Y.Doc, options: ConstructorParameters<typeof Comments>[1] = {}) {
  const ydoc = new Y.Doc();
  ydoc.getText("t");
  if (source) Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(source));
  else ydoc.getText("t").insert(0, "hello brave world");
  const comments = new Comments(ydoc, { now: clock, ...options });
  return { ydoc, comments, text: () => ydoc.getText("t") };
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

/** A thread on "brave". */
const start = (r: ReturnType<typeof replica>) => r.comments.add({ anchor: textAnchor(r.text(), 6, 11), body: "word choice?" }, ada);

describe("text anchors", () => {
  test("a new thread is attached", () => {
    const r = replica();
    expect(start(r).anchorState).toEqual({ state: "attached" });
  });

  test("an edit before the range, from another replica, keeps it attached", () => {
    const a = replica();
    const t = start(a);
    const b = replica(a.ydoc);
    b.text().insert(0, "XX ");
    b.text().delete(b.text().length - 5, 5);
    sync(a.ydoc, b.ydoc);
    expect(a.comments.get(t.id).anchorState).toEqual({ state: "attached" });
    expect(b.comments.get(t.id).anchorState).toEqual({ state: "attached" });
  });

  test("an edit inside the range is reported as edited, with the current text", () => {
    const r = replica();
    const t = start(r);
    r.text().delete(7, 2);
    expect(r.comments.get(t.id).anchorState).toEqual({ state: "edited", currentText: "bve" });
    r.text().insert(7, "ZZ");
    expect(r.comments.get(t.id).anchorState).toEqual({ state: "edited", currentText: "bZZve" });
  });

  test("deleted content orphans the thread, which stays readable, takes replies, and lists by state", () => {
    const r = replica();
    const t = start(r);
    r.text().delete(6, 5);
    const read = r.comments.get(t.id);
    expect(read.anchorState).toEqual({ state: "orphaned" });
    expect(read.messages.map((m) => m.body)).toEqual(["word choice?"]);
    expect(r.comments.reply(t.id, { body: "still here" }, bot).body).toBe("still here");
    expect(r.comments.list().map((x) => x.id)).toEqual([t.id]);
    expect(r.comments.list({ anchorState: "orphaned" }).map((x) => x.id)).toEqual([t.id]);
    expect(r.comments.list({ anchorState: "attached" })).toEqual([]);
    expect(r.comments.problems()).toEqual([]);
  });

  test("a delete on one replica and a reply on another both stay, and both replicas agree", () => {
    const a = replica();
    const t = start(a);
    const b = replica(a.ydoc);
    a.text().delete(6, 5);
    b.comments.reply(t.id, { body: "late reply" }, bot);
    sync(a.ydoc, b.ydoc);
    for (const r of [a, b]) {
      const read = r.comments.get(t.id);
      expect(read.anchorState).toEqual({ state: "orphaned" });
      expect(read.messages.map((m) => m.body)).toEqual(expect.arrayContaining(["word choice?", "late reply"]));
    }
    expect(b.comments.get(t.id)).toEqual(a.comments.get(t.id));
  });

  test("a removed rich text node orphans the thread", () => {
    const ydoc = new Y.Doc();
    const fragment = ydoc.getXmlFragment("doc");
    const paragraph = new Y.XmlElement("paragraph");
    const text = new Y.XmlText("hello brave world");
    paragraph.insert(0, [text]);
    fragment.insert(0, [paragraph]);
    const comments = new Comments(ydoc, { now: clock });
    const t = comments.add({ anchor: textAnchor(text, 6, 11), body: "x" }, ada);
    expect(t.anchorState).toEqual({ state: "attached" });
    fragment.delete(0, 1);
    expect(comments.get(t.id).anchorState).toEqual({ state: "orphaned" });
  });

  test("an anchor from another document is flagged, not thrown", () => {
    const a = replica();
    const t = start(a);
    const stored = a.ydoc.getMap<Y.Map<unknown>>("comments.threads").get(t.id)!;
    const other = new Y.Doc();
    other.getText("t").insert(0, "hello brave world");
    stored.set("anchor", textAnchor(other.getText("t"), 6, 11));
    expect(a.comments.get(t.id).anchorState).toEqual({ state: "orphaned" });
  });
});

describe("relocate", () => {
  test("a quote that comes back exactly once is found again", () => {
    const r = replica();
    const t = start(r);
    r.text().delete(6, 5);
    r.text().insert(6, "brave");
    expect(r.comments.get(t.id).anchorState).toEqual({ state: "orphaned" });
    const moved = r.comments.relocate(t.id, ada);
    expect(moved.anchorState).toEqual({ state: "attached" });
    expect(moved.messages).toHaveLength(1);
  });

  test("no match, many matches, and a changed quote are refused and write nothing", () => {
    const r = replica();
    const t = start(r);
    const before = JSON.stringify(r.comments.get(t.id).anchor);
    const unchanged = () => expect(JSON.stringify(r.comments.get(t.id).anchor)).toBe(before);
    r.text().delete(6, 5);
    expect(code(() => r.comments.relocate(t.id, ada))).toBe("RELOCATE_FAILED");
    unchanged();
    r.text().insert(6, "brave brave");
    expect(code(() => r.comments.relocate(t.id, ada))).toBe("RELOCATE_FAILED");
    unchanged();
    r.text().delete(6, 11);
    r.text().insert(6, "bold");
    expect(code(() => r.comments.relocate(t.id, ada))).toBe("RELOCATE_FAILED");
    unchanged();
  });

  test("an attached thread is not rewritten", () => {
    const r = replica();
    const t = start(r);
    const before = JSON.stringify(Y.encodeStateAsUpdate(r.ydoc));
    expect(r.comments.relocate(t.id, ada).anchorState).toEqual({ state: "attached" });
    expect(JSON.stringify(Y.encodeStateAsUpdate(r.ydoc))).toBe(before);
  });

  test("only a text anchor can move, only a stamped actor may ask, and a missing thread is refused", () => {
    const r = replica();
    const cell = r.comments.add({ anchor: { type: "cell", key: "A1" }, body: "x" }, ada);
    expect(code(() => r.comments.relocate(cell.id, ada))).toBe("INVALID_INPUT");
    const t = start(r);
    expect(code(() => r.comments.relocate(t.id, undefined as never))).toBe("INVALID_AUTHOR");
    expect(code(() => r.comments.relocate("missing", ada))).toBe("NO_THREAD");
  });

  test("two replicas that relocate at once end with the same anchor", () => {
    const a = replica();
    const t = start(a);
    a.text().delete(6, 5);
    a.text().insert(6, "brave");
    const b = replica(a.ydoc);
    a.comments.relocate(t.id, ada);
    b.comments.relocate(t.id, bot);
    sync(a.ydoc, b.ydoc);
    expect(b.comments.get(t.id)).toEqual(a.comments.get(t.id));
    expect(a.comments.get(t.id).anchorState).toEqual({ state: "attached" });
  });
});

describe("cells, slides, canvas, and custom kinds", () => {
  const cell: Anchor = { type: "cell", key: "A1" };

  test("with no host callback the state is unknown", () => {
    const r = replica();
    for (const anchor of [cell, { type: "slide", elementId: "e1" }, { type: "canvas", elementId: "c1" }] as Anchor[]) {
      expect(r.comments.add({ anchor, body: "x" }, ada).anchorState).toEqual({ state: "unknown" });
    }
  });

  test("the host answers for a cell, and a lie or a throw never crashes a read", () => {
    const answers: unknown[] = [true, false, "yes", undefined, null, 1];
    let at = 0;
    const r = replica(undefined, { exists: () => answers[at++ % answers.length] as never });
    const t = r.comments.add({ anchor: cell, body: "x" }, ada);
    at = 0;
    const states = answers.map(() => r.comments.get(t.id).anchorState.state);
    expect(states).toEqual(["attached", "orphaned", "unknown", "unknown", "unknown", "unknown"]);
    const broken = replica(undefined, { exists: () => { throw new Error("offline"); } });
    const b = broken.comments.add({ anchor: cell, body: "x" }, ada);
    expect(broken.comments.get(b.id).anchorState).toEqual({ state: "unknown" });
    expect(broken.comments.list()).toHaveLength(1);
  });

  test("the host callback sees the clean anchor and custom kinds use it too", () => {
    const seen: string[] = [];
    const pin: AnchorKind = { type: "pin", parse: (raw) => ({ type: "pin", id: String(raw.id) }) as never };
    const r = replica(undefined, { anchors: [pin], exists: (anchor) => { seen.push(anchor.type); return (anchor.type as string) !== "pin"; } });
    const t = r.comments.add({ anchor: { type: "pin", id: "p1" } as never, body: "x" }, ada);
    expect(r.comments.get(t.id).anchorState).toEqual({ state: "orphaned" });
    expect(seen).toContain("pin");
  });

  test("a host callback that is not a function is refused", () => {
    expect(() => new Comments(new Y.Doc(), { exists: 5 as never })).toThrow(CommentsError);
  });
});

describe("suggestions on content that changed", () => {
  test("an orphaned or edited anchor is flagged and cannot be accepted, and apply never runs", () => {
    let applies = 0;
    const r = replica();
    const suggestions = new Suggestions(r.comments, { idempotent: true, apply: () => { applies++; return null; } });
    const edited = suggestions.add({ anchor: textAnchor(r.text(), 6, 11), change: {} }, bot);
    const gone = suggestions.add({ anchor: textAnchor(r.text(), 0, 5), change: {} }, bot);
    r.text().delete(7, 2);
    r.text().delete(0, 5);
    expect(suggestions.get(edited.id).anchorState).toEqual({ state: "edited", currentText: "bve" });
    expect(suggestions.get(gone.id).anchorState).toEqual({ state: "orphaned" });
    for (const s of [edited, gone]) {
      expect(code(() => suggestions.accept(s.id, ada))).toBe("APPLY_FAILED");
      expect(suggestions.get(s.id).status).toBe("pending");
    }
    expect(applies).toBe(0);
    expect(suggestions.reject(gone.id, ada).status).toBe("rejected");
    expect(suggestions.list({ anchorState: "orphaned" }).map((s) => s.id)).toEqual([gone.id]);
  });

  test("a suggestion on a cell the host says is gone cannot be accepted", () => {
    let applies = 0;
    let there = true;
    const r = replica(undefined, { exists: () => there });
    const suggestions = new Suggestions(r.comments, { idempotent: true, apply: () => { applies++; return null; } });
    const s = suggestions.add({ anchor: { type: "cell", key: "A1" }, change: {} }, bot);
    there = false;
    expect(suggestions.get(s.id).anchorState).toEqual({ state: "orphaned" });
    expect(code(() => suggestions.accept(s.id, ada))).toBe("APPLY_FAILED");
    expect(applies).toBe(0);
    there = true;
    expect(suggestions.accept(s.id, ada).status).toBe("accepted");
    expect(applies).toBe(1);
  });
});

