import { describe, expect, it } from "vitest";
import { createAnchor, mapPosition, mapRange, resolveAnchor, type Edit } from "./anchoring.js";

const apply = (text: string, edits: Edit[]) => edits.reduce((t, e) => t.slice(0, e.from) + e.insert + t.slice(e.to), text);
const resolve = (text: string, from: number, to: number, edits: Edit[]) => resolveAnchor(createAnchor(text, from, to), apply(text, edits), edits, text.length);

describe("createAnchor", () => {
  it("keeps quote and context", () => {
    const a = createAnchor("Hello brave world", 6, 11);
    expect(a).toMatchObject({ quote: "brave", prefix: "Hello ", suffix: " world", from: 6, to: 11 });
  });
  it("refuses bad ranges", () => {
    for (const [f, t] of [[3, 3], [5, 2], [-1, 2], [0, 99], [1.5, 3], [NaN, 2]]) expect(() => createAnchor("hello", f!, t!)).toThrow(RangeError);
  });
  it("refuses a range that cuts a surrogate pair", () => {
    expect(() => createAnchor("a😀b", 2, 3)).toThrow(RangeError);
    expect(() => createAnchor("a😀b", 1, 2)).toThrow(RangeError);
    expect(createAnchor("a😀b", 1, 3).quote).toBe("😀");
  });
  it("never cuts a pair in the context", () => {
    const text = "😀".repeat(40) + "X" + "😀".repeat(40);
    const a = createAnchor(text, 80, 81);
    expect(a.prefix).toBe("😀".repeat(16));
    expect(a.suffix).toBe("😀".repeat(16));
  });
  it("refuses a quote that is too long", () => {
    expect(() => createAnchor("a".repeat(3000), 0, 2500)).toThrow(RangeError);
  });
});

describe("mapPosition and mapRange", () => {
  it("shifts after an insert before the range", () => {
    expect(mapRange({ from: 6, to: 11 }, [{ from: 0, to: 0, insert: "Oh, " }])).toEqual({ from: 10, to: 15 });
  });
  it("leaves the range when an edit is after it", () => {
    expect(mapRange({ from: 6, to: 11 }, [{ from: 12, to: 12, insert: "zzz" }])).toEqual({ from: 6, to: 11 });
  });
  it("keeps an insert at either edge outside", () => {
    expect(mapRange({ from: 2, to: 4 }, [{ from: 2, to: 2, insert: "ab" }])).toEqual({ from: 4, to: 6 });
    expect(mapRange({ from: 2, to: 4 }, [{ from: 4, to: 4, insert: "ab" }])).toEqual({ from: 2, to: 4 });
  });
  it("grows with an insert inside", () => {
    expect(mapRange({ from: 2, to: 6 }, [{ from: 4, to: 4, insert: "xx" }])).toEqual({ from: 2, to: 8 });
  });
  it("shrinks with a partial delete", () => {
    expect(mapRange({ from: 2, to: 6 }, [{ from: 0, to: 3, insert: "" }])).toEqual({ from: 0, to: 3 });
    expect(mapRange({ from: 2, to: 6 }, [{ from: 5, to: 9, insert: "" }])).toEqual({ from: 2, to: 5 });
  });
  it("returns null when the range is deleted, and the new text when it is replaced", () => {
    expect(mapRange({ from: 2, to: 6 }, [{ from: 1, to: 7, insert: "" }])).toBeNull();
    expect(mapRange({ from: 2, to: 6 }, [{ from: 2, to: 6, insert: "new" }])).toEqual({ from: 2, to: 5 });
    expect(mapRange({ from: 2, to: 6 }, [{ from: 0, to: 10, insert: "new" }])).toBeNull();
  });
  it("applies edits one after another", () => {
    const edits = [{ from: 0, to: 0, insert: "ab" }, { from: 0, to: 1, insert: "" }];
    expect(mapRange({ from: 2, to: 4 }, edits)).toEqual({ from: 3, to: 5 });
    expect(mapPosition(5, [{ from: 0, to: 2, insert: "" }, { from: 0, to: 0, insert: "zzzz" }])).toBe(7);
  });
  it("throws on an edit outside the text", () => {
    expect(() => mapPosition(1, [{ from: 5, to: 4, insert: "" }])).toThrow(RangeError);
    expect(() => mapPosition(1, [{ from: 0, to: 9, insert: "" }], 1, 4)).toThrow(RangeError);
  });
});

describe("resolveAnchor", () => {
  const text = "Hello brave world";
  it("attaches by mapping", () => {
    expect(resolve(text, 6, 11, [{ from: 0, to: 0, insert: "Oh, " }])).toEqual({ state: "attached", from: 10, to: 15, method: "mapped" });
  });
  it("tries the old offsets with no edits", () => {
    expect(resolveAnchor(createAnchor(text, 6, 11), text)).toMatchObject({ state: "attached", method: "mapped" });
  });
  it("orphans a deleted range", () => {
    expect(resolve(text, 6, 11, [{ from: 5, to: 12, insert: "" }])).toEqual({ state: "orphaned" });
  });
  it("reports edited text in the range", () => {
    expect(resolve(text, 6, 11, [{ from: 8, to: 9, insert: "X" }])).toEqual({ state: "edited", from: 6, to: 11 });
  });
  it("falls back to a unique quote when no edits are given", () => {
    const a = createAnchor(text, 6, 11);
    expect(resolveAnchor(a, "Why, hello there. Hello brave world")).toMatchObject({ state: "attached", from: 24, to: 29, method: "quote" });
  });
  it("falls back to a unique quote when there is no edit list", () => {
    const a = createAnchor(text, 6, 11);
    expect(resolveAnchor(a, "brave new Hello world")).toMatchObject({ state: "attached", from: 0, to: 5, method: "quote" });
  });
  it("picks a duplicate by context", () => {
    const t = "the cat sat. a dog saw the cat run";
    const a = createAnchor(t, 25, 28);
    expect(resolveAnchor(a, "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx the cat sat. a dog saw the cat run!")).toMatchObject({ state: "attached", from: 59, to: 62, method: "quote" });
    expect(resolveAnchor(createAnchor(t, 4, 7), "yy a cat sat. a dog saw the cat run")).toMatchObject({ state: "attached", from: 5 });
  });
  it("orphans an even duplicate", () => {
    const a = createAnchor("one cat two", 4, 7);
    expect(resolveAnchor(a, "zzzz cat zzz cat zzzz")).toEqual({ state: "orphaned" });
  });
  it("orphans when the quote is gone and there are no edits", () => {
    expect(resolveAnchor(createAnchor(text, 6, 11), "nothing here")).toEqual({ state: "orphaned" });
  });
  it("handles unicode", () => {
    const t = "Hi 😀 wörld 🇮🇷 ok";
    const from = t.indexOf("wörld");
    const edits = [{ from: 0, to: 0, insert: "👋 " }];
    expect(resolve(t, from, from + 5, edits)).toMatchObject({ state: "attached", from: from + 3, to: from + 8 });
    const flag = t.indexOf("🇮🇷");
    expect(resolve(t, flag, flag + 4, [{ from: 0, to: 2, insert: "" }])).toMatchObject({ state: "attached", from: flag - 2 });
  });
  it("does not return a range inside a surrogate pair", () => {
    const a = createAnchor("a😀b", 1, 3);
    expect(resolveAnchor(a, "xa😀b", [{ from: 0, to: 0, insert: "x" }])).toMatchObject({ state: "attached", from: 2, to: 4 });
  });
  it("orphans a malformed edit instead of throwing", () => {
    expect(resolveAnchor(createAnchor(text, 6, 11), text, [{ from: 50, to: 60, insert: "" }], text.length)).toEqual({ state: "orphaned" });
  });
  it("orphans an anchor with no quote", () => {
    expect(resolveAnchor({ quote: "", prefix: "", suffix: "", from: 0, to: 0 }, "abc")).toEqual({ state: "orphaned" });
  });
  it("does not jump to another copy of the quote when the edits say where the range went", () => {
    const t = "brave new world. Be brave.";
    const edits = [{ from: 2, to: 3, insert: "o" }];
    expect(resolveAnchor(createAnchor(t, 0, 5), apply(t, edits), edits, t.length)).toEqual({ state: "edited", from: 0, to: 5 });
  });
  it("orphans an anchor with bad offsets", () => {
    for (const [from, to] of [[-1, 3], [-5, 2], [1.5, 3.5], [5, 2], [1, 9]]) {
      expect(resolveAnchor({ quote: "ab", prefix: "", suffix: "", from: from!, to: to! }, "abcdef", [])).toEqual({ state: "orphaned" });
    }
  });
  it("refuses bad input in the mappers", () => {
    expect(() => mapRange({ from: 5, to: 2 }, [])).toThrow(RangeError);
    expect(() => mapPosition(-1, [])).toThrow(RangeError);
    expect(() => mapPosition(1, [null as unknown as Edit])).toThrow(RangeError);
    expect(resolveAnchor(createAnchor("hello", 0, 2), "hello", [null as unknown as Edit], 5)).toEqual({ state: "orphaned" });
  });
  it("orphans when the edits do not fit the text", () => {
    const a = createAnchor("Hello brave world. brave", 6, 11);
    expect(resolveAnchor(a, "brave", [{ from: 0, to: 0, insert: "x".repeat(50) }])).toEqual({ state: "orphaned" });
    expect(resolveAnchor({ quote: "ab", prefix: "", suffix: "", from: 50, to: 52 }, "ab", [], 5)).toEqual({ state: "orphaned" });
    expect(resolveAnchor(createAnchor("a".repeat(24), 8, 13), "z".repeat(30), [{ from: 0, to: 0, insert: "Oh" }], 24)).toEqual({ state: "orphaned" });
  });
  it("never returns half of a surrogate pair from the quote search", () => {
    expect(resolveAnchor({ quote: "\uDE00", prefix: "", suffix: "", from: 0, to: 1 }, "a😀b")).toEqual({ state: "orphaned" });
    expect(resolveAnchor({ quote: "\uD83D", prefix: "", suffix: "", from: 0, to: 1 }, "a😀b")).toEqual({ state: "orphaned" });
  });
});
