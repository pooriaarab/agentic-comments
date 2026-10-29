import * as Y from "yjs";
import { textAnchor, textOf, type Anchor } from "./anchor.js";
import { CommentsError } from "./errors.js";
import { FileStore } from "./file-store.js";
import { localHost, TEXT_ROOT } from "./local-host.js";
import type { Actor } from "./principal.js";
import { Suggestions, type Suggestion } from "./suggestions.js";
import { Comments, type Message, type Thread } from "./threads.js";
import { exact, invalid } from "./validate.js";

/** Where a comment or suggestion points, in terms a person or agent can write down. */
export type AnchorSpec =
  | { type: "text"; quote: string; occurrence?: number }
  | { type: "cell"; key: string }
  | { type: "slide"; elementId: string }
  | { type: "canvas"; elementId: string };

export interface ListFilter {
  status?: string;
  anchorState?: string;
  mentioning?: string;
}

const CONTEXT = 20;

function anchorFrom(ydoc: Y.Doc, spec: unknown): Anchor {
  const given = exact(spec, ["type", "quote", "occurrence", "key", "elementId"], "an anchor");
  if (given.type === "cell" || given.type === "slide" || given.type === "canvas") {
    return { type: given.type, ...(given.type === "cell" ? { key: given.key } : { elementId: given.elementId }) } as Anchor;
  }
  if (given.type !== "text") return invalid('an anchor type is "text", "cell", "slide", or "canvas"');
  const quote = given.quote;
  if (typeof quote !== "string" || quote === "") return invalid("a text anchor needs a quote");
  const text = ydoc.getText(TEXT_ROOT);
  const value = textOf(text);
  const at: number[] = [];
  for (let i = value.indexOf(quote); i >= 0; i = value.indexOf(quote, i + 1)) at.push(i);
  if (at.length === 0) throw new CommentsError("INVALID_ANCHOR", `no text matches ${JSON.stringify(quote.slice(0, 40))}`);
  const occurrence = given.occurrence;
  if (occurrence !== undefined && (!Number.isSafeInteger(occurrence) || (occurrence as number) < 1 || (occurrence as number) > at.length)) {
    throw new CommentsError("INVALID_ANCHOR", `the quote has ${at.length} matches, not ${String(occurrence)}`);
  }
  if (occurrence === undefined && at.length > 1) {
    const where = at.map((i, n) => `${n + 1}: ...${value.slice(Math.max(0, i - CONTEXT), i + quote.length + CONTEXT).replace(/\s+/g, " ")}...`);
    throw new CommentsError("INVALID_ANCHOR", `the quote matches ${at.length} places; pass an occurrence. ${where.join(" | ")}`);
  }
  const start = at[(occurrence as number | undefined ? (occurrence as number) - 1 : 0)];
  return textAnchor(text, start, start + quote.length);
}

/**
 * Every action the CLI and MCP server offer, on a local file store. Each call takes the actor the operator
 * stamped, and no input carries an author, so both faces return the same shapes and obey the same rules.
 */
export class CommentsService {
  constructor(
    private readonly store: FileStore,
    private readonly actor: Actor,
  ) {}

  private open(ydoc: Y.Doc): { comments: Comments; suggestions: Suggestions } {
    ydoc.getText(TEXT_ROOT);
    const comments = new Comments(ydoc);
    return { comments, suggestions: new Suggestions(comments, localHost) };
  }

  private read<T>(fn: (o: ReturnType<CommentsService["open"]>, ydoc: Y.Doc) => T): T {
    return this.store.read((ydoc) => fn(this.open(ydoc), ydoc));
  }

  private write<T>(fn: (o: ReturnType<CommentsService["open"]>, ydoc: Y.Doc) => T): T {
    return this.store.write((ydoc) => fn(this.open(ydoc), ydoc));
  }

  threads(filter: ListFilter = {}): Thread[] {
    const given = exact(filter, ["status", "anchorState", "mentioning"], "a filter");
    return this.read(({ comments }) => comments.list(given as never));
  }

  thread(id: string): Thread {
    return this.read(({ comments }) => comments.get(id));
  }

  comment(input: { anchor: AnchorSpec; body: string; mentions?: string[] }): Thread {
    const given = exact(input, ["anchor", "body", "mentions"], "a comment");
    return this.write(({ comments }, ydoc) => comments.add({ anchor: anchorFrom(ydoc, given.anchor), body: given.body as string, mentions: given.mentions as string[] | undefined }, this.actor));
  }

  reply(threadId: string, input: { body: string; mentions?: string[] }): Message {
    return this.write(({ comments }) => comments.reply(threadId, exact(input, ["body", "mentions"], "a reply") as never, this.actor));
  }

  resolve(threadId: string): Thread {
    return this.write(({ comments }) => comments.resolve(threadId, this.actor));
  }

  reopen(threadId: string): Thread {
    return this.write(({ comments }) => comments.reopen(threadId, this.actor));
  }

  relocate(threadId: string): Thread {
    return this.write(({ comments }) => comments.relocate(threadId, this.actor));
  }

  suggestions(filter: ListFilter = {}): Suggestion[] {
    const given = exact(filter, ["status", "anchorState"], "a filter");
    return this.read(({ suggestions }) => suggestions.list(given as never));
  }

  suggest(input: { anchor: AnchorSpec; change: unknown; summary?: string }): Suggestion {
    const given = exact(input, ["anchor", "change", "summary"], "a suggestion");
    return this.write(({ suggestions }, ydoc) => suggestions.add({ anchor: anchorFrom(ydoc, given.anchor), change: given.change, summary: given.summary as string | undefined }, this.actor));
  }

  accept(suggestionId: string): Suggestion {
    return this.write(({ suggestions }) => suggestions.accept(suggestionId, this.actor));
  }

  reject(suggestionId: string): Suggestion {
    return this.write(({ suggestions }) => suggestions.reject(suggestionId, this.actor));
  }

  /** The content text of the store. */
  text(): string {
    return this.read((_o, ydoc) => ydoc.getText(TEXT_ROOT).toString());
  }
}
