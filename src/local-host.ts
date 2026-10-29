import * as Y from "yjs";
import { textRange } from "./anchor.js";
import { CommentsError } from "./errors.js";
import type { SuggestionHost } from "./suggestions.js";

/** The root Y.Text that a local store keeps its content in. */
export const TEXT_ROOT = "text";
/** The root Y.Map that holds values for cell, slide, canvas, and custom anchors. */
export const VALUES_ROOT = "values";

const MAX_TEXT = 100_000;

const refuse = (message: string): never => {
  throw new CommentsError("INVALID_INPUT", message);
};

/** The key a value for a non-text anchor lives under. */
export function valueKey(anchor: { type: string; key?: unknown; elementId?: unknown }): string {
  const id = anchor.key ?? anchor.elementId;
  return typeof id === "string" ? `${anchor.type}:${id}` : refuse("this anchor has no key or element id");
}

/**
 * The host for a local store. A text anchor takes `{ "replace": "text" }` and swaps the anchored range.
 * Any other anchor takes `{ "value": <JSON> }` and sets that key in the values map.
 */
export const localHost: SuggestionHost = {
  parse(change) {
    const c = (change ?? {}) as Record<string, unknown>;
    const keys = Object.keys(c);
    if (keys.length === 1 && keys[0] === "replace" && typeof c.replace === "string" && c.replace.length <= MAX_TEXT) return { replace: c.replace };
    if (keys.length === 1 && keys[0] === "value") return { value: c.value };
    return refuse('a change is { "replace": text } for a text anchor, or { "value": JSON } for another anchor');
  },

  apply(change, ctx) {
    const c = change as { replace?: string; value?: unknown };
    if (ctx.anchor.type === "text") {
      if (typeof c.replace !== "string") throw new Error('a text anchor needs { "replace": text }');
      const range = textRange(ctx.anchor, ctx.ydoc);
      if (!range) throw new Error("the anchored text is gone");
      range.type.delete(range.from, range.to - range.from);
      range.type.insert(range.from, c.replace);
      return {
        kind: "text",
        start: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(range.type, range.from, 0)),
        end: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(range.type, range.from + c.replace.length, -1)),
      };
    }
    if (!("value" in c)) throw new Error('this anchor needs { "value": JSON }');
    ctx.ydoc.getMap(VALUES_ROOT).set(valueKey(ctx.anchor), c.value);
    return { kind: "value" };
  },

  revert(receipt, ctx) {
    const r = (receipt ?? {}) as { kind?: unknown; start?: unknown; end?: unknown };
    if (r.kind === "value") return;
    if (r.kind !== "text" || typeof r.start !== "object" || r.start === null || typeof r.end !== "object" || r.end === null) {
      throw new Error("the receipt is not a text receipt");
    }
    const at = (json: object) => {
      try {
        return Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), ctx.ydoc);
      } catch {
        return null;
      }
    };
    const from = at(r.start);
    const to = at(r.end);
    if (from && to && from.type === to.type && from.type instanceof Y.Text && to.index > from.index) {
      from.type.delete(from.index, to.index - from.index);
    }
  },
};
