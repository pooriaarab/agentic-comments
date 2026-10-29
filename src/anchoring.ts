/**
 * Plain-text anchors that survive edits. No Yjs, no framework. Offsets are UTF-16 code units, like
 * `String.prototype.slice`. An anchor keeps its quote and some text around it, so it can be found again
 * when you have no edit list.
 */

/** One edit: replace `text.slice(from, to)` with `insert`. A pure insert has `from === to`. */
export interface Edit {
  from: number;
  to: number;
  insert: string;
}

export interface TextRangeAnchor {
  /** The text under the range when the anchor was made. */
  quote: string;
  /** Text just before the range. */
  prefix: string;
  /** Text just after the range. */
  suffix: string;
  /** The range at creation, in the text it was made for. */
  from: number;
  to: number;
}

export interface OffsetRange {
  from: number;
  to: number;
}

/**
 * `attached`: the range holds the quote. `edited`: the range still exists but holds other text.
 * `orphaned`: the content is gone, or the quote is too ambiguous to trust.
 */
export type Resolution =
  | { state: "attached"; from: number; to: number; method: "mapped" | "quote" }
  | { state: "edited"; from: number; to: number }
  | { state: "orphaned" };

export const CONTEXT_LENGTH = 32;
export const MAX_QUOTE_LENGTH = 2_000;
/** The most copies of a quote that `resolveAnchor` ranks. With more, the anchor is orphaned. */
export const MAX_MATCHES = 500;

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** True when a quote starts with a low surrogate or ends with a high one: half a character. */
const isLoneHalf = (code: number, atStart: boolean): boolean => (atStart ? isLow(code) : isHigh(code));

/** True when `index` sits between the two halves of a surrogate pair. */
function splits(text: string, index: number): boolean {
  return index > 0 && index < text.length && isHigh(text.charCodeAt(index - 1)) && isLow(text.charCodeAt(index));
}

const whole = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** Pin the range `from..to` of `text`. Throws a `RangeError` when the range is empty, outside the text, or splits a character. */
export function createAnchor(text: string, from: number, to: number): TextRangeAnchor {
  if (typeof text !== "string") throw new TypeError("text must be a string");
  if (!whole(from) || !whole(to) || to <= from || to > text.length) {
    throw new RangeError(`the range ${String(from)}..${String(to)} is not inside the text, which has ${text.length} characters`);
  }
  if (splits(text, from) || splits(text, to)) throw new RangeError("the range cuts a character in two");
  if (isLow(text.charCodeAt(from)) || isHigh(text.charCodeAt(to - 1))) throw new RangeError("the range starts or ends inside a character");
  if (to - from > MAX_QUOTE_LENGTH) throw new RangeError(`a quote holds up to ${MAX_QUOTE_LENGTH} characters`);
  let before = Math.max(0, from - CONTEXT_LENGTH);
  if (splits(text, before)) before += 1;
  let after = Math.min(text.length, to + CONTEXT_LENGTH);
  if (splits(text, after)) after -= 1;
  return { quote: text.slice(from, to), prefix: text.slice(before, from), suffix: text.slice(to, after), from, to };
}

function checkEdit(edit: Edit, length: number): void {
  if (typeof edit !== "object" || edit === null) throw new RangeError("an edit must be an object");
  if (!whole(edit.from) || !whole(edit.to) || edit.to < edit.from || edit.to > length || typeof edit.insert !== "string") {
    throw new RangeError(`the edit ${JSON.stringify([edit.from, edit.to])} is not inside a text of ${length} characters`);
  }
}

/**
 * Move one position through edits made one after another. `assoc` 1 puts a position that sits at an
 * insert after the insert. `assoc` -1 puts it before. A position inside a replaced range moves to the
 * end of the insert with `assoc` 1, and to the start of the insert with `assoc` -1. `length` is the text length before the first edit.
 */
export function mapPosition(pos: number, edits: readonly Edit[], assoc: 1 | -1 = 1, length = Infinity): number {
  if (!whole(pos) || !Array.isArray(edits) || (assoc !== 1 && assoc !== -1)) throw new RangeError("the position must be a whole number, the edits a list, and assoc 1 or -1");
  if (length !== Infinity && (!whole(length) || pos > length)) throw new RangeError("the position must be inside a text of a whole length");
  let len = length;
  let p = pos;
  for (const edit of edits) {
    checkEdit(edit, len);
    const removed = edit.to - edit.from;
    const added = edit.insert.length;
    if (p > edit.to) p += added - removed;
    else if (p >= edit.from) {
      if (removed === 0) p = assoc === 1 ? p + added : p;
      else if (p === edit.from) p = edit.from;
      else if (p === edit.to) p = edit.from + added;
      else p = assoc === 1 ? edit.from + added : edit.from;
    }
    len = len === Infinity ? len : len - removed + added;
  }
  return p;
}

/**
 * Move a range through edits. An insert at either edge stays outside the range. Returns null when the
 * edits delete the whole range.
 */
export function mapRange(range: OffsetRange, edits: readonly Edit[], length = Infinity): OffsetRange | null {
  if (!Array.isArray(edits)) throw new RangeError("the edits must be a list");
  if (!whole(range?.from) || !whole(range?.to) || range.to <= range.from) throw new RangeError("the range must be two whole numbers, from before to");
  let { from, to } = range;
  let len = length;
  for (const edit of edits) {
    from = mapPosition(from, [edit], 1, len);
    to = mapPosition(to, [edit], -1, len);
    if (to <= from) return null;
    len = len === Infinity ? len : len - (edit.to - edit.from) + edit.insert.length;
  }
  return { from, to };
}

/** Every start index of `quote` in `text`, overlaps included. */
function occurrences(text: string, quote: string, max: number): number[] {
  const out: number[] = [];
  for (let i = text.indexOf(quote); i >= 0 && out.length < max; i = text.indexOf(quote, i + 1)) out.push(i);
  return out;
}

const commonSuffix = (a: string, b: string): number => {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
};
const commonPrefix = (a: string, b: string): number => {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
};

/**
 * Find an anchor in `newText`.
 *
 * With `edits` (the changes from the text the anchor was made for to `newText`), the edits are the truth:
 * the mapped range is `attached` if it holds the quote, `edited` if it holds other text, and `orphaned`
 * if the edits delete it or it falls outside the text. The quote is not searched. Pass `originalLength`
 * (the length of the old text) to also check that the edits fit both texts.
 *
 * With no edits, search for the quote. One match wins. With several, the match whose surrounding text
 * fits best wins. On a tie, the match at the old offsets wins, else the anchor is `orphaned`: a wrong
 * place is worse than none. A bad anchor, a half character, and too many matches also orphan.
 */
export function resolveAnchor(anchor: TextRangeAnchor, newText: string, edits?: readonly Edit[], originalLength?: number): Resolution {
  if (typeof newText !== "string") throw new TypeError("text must be a string");
  if (typeof anchor?.quote !== "string" || anchor.quote === "") return { state: "orphaned" };
  const quote = anchor.quote;
  if (quote.length > MAX_QUOTE_LENGTH || (edits !== undefined && !Array.isArray(edits))) return { state: "orphaned" };
  if (!whole(anchor.from) || !whole(anchor.to) || anchor.to - anchor.from !== quote.length) return { state: "orphaned" };
  if (isLoneHalf(quote.charCodeAt(0), true) || isLoneHalf(quote.charCodeAt(quote.length - 1), false)) return { state: "orphaned" };
  if (originalLength !== undefined) {
    // The edits must fit both texts. If they do not, the edit list is bad data.
    const final = (edits ?? []).reduce((n, e) => n - (e?.to - e?.from) + (typeof e?.insert === "string" ? e.insert.length : NaN), originalLength);
    if (!whole(originalLength) || anchor.to > originalLength || (edits && final !== newText.length)) return { state: "orphaned" };
  }
  let mapped: OffsetRange | null;
  try {
    mapped = edits ? mapRange({ from: anchor.from, to: anchor.to }, edits, originalLength) : { from: anchor.from, to: anchor.to };
  } catch (error) {
    if (error instanceof RangeError) return { state: "orphaned" };
    throw error;
  }
  if (edits && mapped === null) return { state: "orphaned" };
  const valid = mapped && mapped.to <= newText.length && !splits(newText, mapped.from) && !splits(newText, mapped.to);
  if (edits) {
    // A list of edits is the truth about where the range went. A copy of the quote elsewhere is not it.
    if (!valid || !mapped) return { state: "orphaned" };
    return newText.slice(mapped.from, mapped.to) === quote
      ? { state: "attached", from: mapped.from, to: mapped.to, method: "mapped" }
      : { state: "edited", from: mapped.from, to: mapped.to };
  }
  const found = occurrences(newText, quote, MAX_MATCHES + 1).filter((at) => !splits(newText, at) && !splits(newText, at + quote.length));
  if (found.length === 0 || found.length > MAX_MATCHES) return { state: "orphaned" };
  const result = (at: number): Resolution => ({ state: "attached", from: at, to: at + quote.length, method: at === anchor.from ? "mapped" : "quote" });
  if (found.length === 1) return result(found[0]!);
  const score = (at: number) =>
    commonSuffix(anchor.prefix ?? "", newText.slice(Math.max(0, at - CONTEXT_LENGTH), at)) +
    commonPrefix(anchor.suffix ?? "", newText.slice(at + quote.length, at + quote.length + CONTEXT_LENGTH));
  const ranked = found.map((at) => ({ at, score: score(at) })).sort((a, b) => b.score - a.score);
  const best = ranked.filter((r) => r.score === ranked[0]!.score);
  if (best.length === 1) return result(best[0]!.at);
  // A tie: the copy at the old offsets wins, because the text may be unchanged. Otherwise a wrong place is worse than none.
  return best.some((r) => r.at === anchor.from) ? result(anchor.from) : { state: "orphaned" };
}
