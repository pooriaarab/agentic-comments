import * as Y from "yjs";
import { CommentsError } from "./errors.js";
import { HIDDEN } from "./text.js";

/** A Yjs relative position as JSON. It names an item, not an index, so it follows its text. */
export interface RelativePositionJson {
  type?: { client: number; clock: number };
  tname?: string;
  item?: { client: number; clock: number };
  assoc?: number;
}

export interface TextAnchor {
  type: "text";
  /** The text under the range when the comment was made. `Comments.add` checks it against the document. */
  text: string;
  start: RelativePositionJson;
  end: RelativePositionJson;
}

export interface CellAnchor {
  type: "cell";
  /** A cell key the host app defines, such as `Sheet1!B4` or a stable cell id. */
  key: string;
}

export interface SlideAnchor {
  type: "slide";
  elementId: string;
}

export interface CanvasAnchor {
  type: "canvas";
  elementId: string;
}

/**
 * Where a thread points. A custom kind (see `AnchorKind`) returns its own shape, so narrow on `type`
 * before you read its fields.
 */
export type Anchor = TextAnchor | CellAnchor | SlideAnchor | CanvasAnchor;

/** Teach `Comments` a new anchor type. `parse` returns a clean copy or throws. */
export interface AnchorKind {
  type: string;
  parse(raw: Record<string, unknown>): { type: string };
}

/**
 * Whether the content under an anchor is still there.
 * `attached`: yes, as it was. `edited`: the range is there, with other text. `orphaned`: the content is
 * gone. `unknown`: nothing can tell, as for a cell with no host answer.
 */
export type AnchorState = { state: "attached" } | { state: "edited"; currentText: string } | { state: "orphaned" } | { state: "unknown" };

export const MAX_QUOTE = 2_000;
/** The most JSON characters one stored anchor holds. */
export const MAX_ANCHOR = 4_096;
const MAX_KEY = 256;

const bad = (message: string): never => {
  throw new CommentsError("INVALID_ANCHOR", message);
};

function key(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.trim() === "" || raw.length > MAX_KEY || HIDDEN.test(raw)) bad(`${field} must be text of 1 to ${MAX_KEY} characters, with no control or invisible characters`);
  return raw as string;
}

function id(raw: unknown, field: string): { client: number; clock: number } {
  const { client, clock } = (raw ?? {}) as { client?: unknown; clock?: unknown };
  if (!Number.isSafeInteger(client) || !Number.isSafeInteger(clock) || (client as number) < 0 || (clock as number) < 0) {
    bad(`${field} must hold a client and a clock that are whole numbers of 0 or more`);
  }
  return { client: client as number, clock: clock as number };
}

function position(raw: unknown, field: string): RelativePositionJson {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad(`${field} must be a relative position`);
  const p = raw as Record<string, unknown>;
  const out: RelativePositionJson = {};
  if (p.type !== undefined) out.type = id(p.type, `${field}.type`);
  if (p.item !== undefined) out.item = id(p.item, `${field}.item`);
  if (p.tname !== undefined) out.tname = key(p.tname, `${field}.tname`);
  if (p.assoc !== undefined) {
    if (p.assoc !== 0 && p.assoc !== -1) bad(`${field}.assoc must be 0 or -1`);
    out.assoc = p.assoc as number;
  }
  if (out.type === undefined && out.item === undefined && out.tname === undefined) bad(`${field} must name an item or a type`);
  return out;
}

const parseText = (raw: Record<string, unknown>): TextAnchor => {
  if (typeof raw.text !== "string" || raw.text === "" || raw.text.length > MAX_QUOTE) bad(`text must be 1 to ${MAX_QUOTE} characters`);
  const start = position(raw.start, "start");
  const end = position(raw.end, "end");
  const owner = (p: RelativePositionJson) => JSON.stringify([p.type ?? null, p.tname ?? null]);
  if (start.item === undefined || end.item === undefined) bad("a text range needs an item position at each end");
  if ((start.type && start.tname) || (end.type && end.tname) || owner(start) !== owner(end)) bad("both ends of a text range must name the same Yjs type");
  const anchor: TextAnchor = { type: "text", text: raw.text as string, start, end };
  if (JSON.stringify(anchor).length > MAX_ANCHOR) bad(`an anchor holds up to ${MAX_ANCHOR} characters of JSON, so the quoted text is too long`);
  return anchor;
};

export const BUILT_IN_KINDS: readonly AnchorKind[] = [
  { type: "text", parse: parseText },
  { type: "cell", parse: (raw): CellAnchor => ({ type: "cell", key: key(raw.key, "key") }) },
  { type: "slide", parse: (raw): SlideAnchor => ({ type: "slide", elementId: key(raw.elementId, "elementId") }) },
  { type: "canvas", parse: (raw): CanvasAnchor => ({ type: "canvas", elementId: key(raw.elementId, "elementId") }) },
];

/** The text of a Yjs text type. An embed counts as one character, so indexes match Yjs positions. */
export function textOf(type: Y.Text | Y.XmlText): string {
  return (type.toDelta() as { insert: unknown }[]).map((d) => (typeof d.insert === "string" ? d.insert : "￼")).join("");
}

/** Pin a range of a Yjs text. Later edits by any replica do not move the anchor off its text. */
export function textAnchor(type: Y.Text | Y.XmlText, from: number, to: number): TextAnchor {
  try {
    const value = textOf(type);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to > value.length) {
      bad(`the range ${from}..${to} is not inside the text, which has ${value.length} characters`);
    }
    return parseText({
      text: value.slice(from, to),
      start: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(type, from, 0)),
      end: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(type, to, -1)),
    });
  } catch (error) {
    if (error instanceof CommentsError) throw error;
    throw new CommentsError("INVALID_ANCHOR", `the text cannot be anchored: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function place(json: RelativePositionJson, ydoc: Y.Doc) {
  try {
    return Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), ydoc);
  } catch {
    return null;
  }
}

/** Where a text anchor sits now. Null when its text type is gone or the positions point outside this document. */
export function textRange(anchor: TextAnchor, ydoc: Y.Doc): { type: Y.Text; from: number; to: number } | null {
  const from = place(anchor.start, ydoc);
  const to = place(anchor.end, ydoc);
  if (!from || !to || !(from.type instanceof Y.Text) || to.type !== from.type) return null;
  return { type: from.type, from: from.index, to: to.index };
}

export function textState(anchor: TextAnchor, ydoc: Y.Doc): AnchorState {
  const range = textRange(anchor, ydoc);
  if (!range || range.to <= range.from) return { state: "orphaned" };
  const current = textOf(range.type).slice(range.from, range.to);
  return current === anchor.text ? { state: "attached" } : { state: "edited", currentText: current.slice(0, MAX_QUOTE) };
}

/** The one place in a text where the quote occurs. Undefined when it occurs never, or more than once. */
export function onlyOccurrence(type: Y.Text, quote: string): number | undefined {
  const value = textOf(type);
  const first = value.indexOf(quote);
  return first >= 0 && value.indexOf(quote, first + 1) < 0 ? first : undefined;
}
