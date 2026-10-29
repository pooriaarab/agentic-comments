// A client that keeps threads in memory, for the demo page. It follows the same decision rule as the Worker, and it
// throws errors with a `code`, so the panel shows what a real server would.
import type { Me } from "../src/client.js";
import type { PanelClient } from "../src/ui/index.js";
import { holds, mayDecide } from "../src/ui/index.js";
import type { Suggestion } from "../src/suggestions.js";
import type { Message, Thread } from "../src/threads.js";

export const PRINCIPALS: Record<string, Me> = {
  maya: { kind: "human", name: "maya", scopes: ["comments:admin"] },
  "review-bot": { kind: "agent_of_human", name: "review-bot", scopes: ["comments:admin"] },
  "copy-editor": { kind: "agent", name: "copy-editor", scopes: ["comments:comment"] },
};

const text = (quote: string) => ({ type: "text" as const, text: quote, start: {}, end: {} });
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 29, 9, 0) + minutes * 60_000).toISOString();
const message = (id: string, minutes: number, kind: Me["kind"], name: string, body: string): Message => ({ id, at: at(minutes), author: { kind, name }, body, mentions: [] });

export function seed(): { threads: Thread[]; suggestions: Suggestion[] } {
  const maya = { kind: "human", name: "maya" } as const;
  return {
    threads: [
      {
        id: "t1", anchor: text("Revenue grew 12 percent in the third quarter."), status: "open", statusBy: maya, statusAt: at(0), anchorState: { state: "attached" }, skipped: 0,
        messages: [message("m1", 0, "human", "maya", "Can we say which regions drove this?"), message("m2", 4, "agent_of_human", "review-bot", "Europe drove most of it. The sales table lists 9 points from Europe.")],
      },
      {
        id: "t2", anchor: text("Churn stayed flat."), status: "open", statusBy: maya, statusAt: at(10), anchorState: { state: "orphaned" }, skipped: 0,
        messages: [message("m3", 10, "human", "maya", "This line left the draft. Do we still need a note on churn?")],
      },
      {
        id: "t3", anchor: text("Headcount is 41."), status: "resolved", statusBy: maya, statusAt: at(30), anchorState: { state: "attached" }, skipped: 0,
        messages: [message("m4", 20, "agent", "copy-editor", "The people page says 43."), message("m5", 28, "human", "maya", "Fixed. Thanks.")],
      },
    ],
    suggestions: [
      { id: "s1", anchor: text("grew 12 percent"), anchorState: { state: "attached" }, change: { replace: "grew 12.4 percent" }, summary: "Use the exact figure from the sales table.", author: { kind: "agent_of_human", name: "review-bot" }, createdAt: at(40), status: "pending" },
      { id: "s2", anchor: text("third quarter"), anchorState: { state: "attached" }, change: { replace: "quarter ending 30 September" }, summary: "Say which dates the quarter covers.", author: { kind: "human", name: "maya" }, createdAt: at(45), status: "pending" },
      { id: "s3", anchor: text("Headcount is 41."), anchorState: { state: "edited", currentText: "Headcount is 43." }, change: { replace: "Headcount is 43." }, author: { kind: "agent", name: "copy-editor" }, createdAt: at(50), status: "pending" },
    ],
  };
}

export type Store = ReturnType<typeof seed> & { next: number };

export const createStore = (): Store => ({ ...seed(), next: 100 });

function refuse(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

/** A client for one principal over a shared store. */
export function memoryClient(store: Store, me: Me): PanelClient {
  const thread = (id: string) => store.threads.find((t) => t.id === id) ?? refuse("NO_THREAD", `no thread with id ${id}`);
  const suggestion = (id: string) => store.suggestions.find((s) => s.id === id) ?? refuse("NO_SUGGESTION", `no suggestion with id ${id}`);
  const needs = (need: "comment" | "write") => holds(me, need) || refuse("FORBIDDEN", `this token needs the comments:${need} scope`);
  const author = { kind: me.kind, name: me.name };
  const stampNow = () => new Date().toISOString();
  const decide = (id: string, status: "accepted" | "rejected") => {
    const s = suggestion(id);
    needs("write");
    const decision = mayDecide(me, s);
    if (!decision.allowed) refuse("FORBIDDEN", `${me.kind}:${me.name} cannot ${status === "accepted" ? "accept" : "reject"} this suggestion`);
    if (status === "accepted" && s.anchorState.state !== "attached") refuse("ANCHOR_CHANGED", "the anchored text changed, so the suggestion cannot apply");
    Object.assign(s, { status, decidedBy: author, decidedAt: stampNow() });
    return s;
  };
  const status = (id: string, to: Thread["status"]) => {
    needs("comment");
    return Object.assign(thread(id), { status: to, statusBy: author, statusAt: stampNow() });
  };
  const copy = <T>(v: T): T => structuredClone(v);
  return {
    me: async () => copy(me),
    listThreads: async () => copy(store.threads),
    listSuggestions: async () => copy(store.suggestions),
    addThread: async (_doc, input) => {
      needs("comment");
      if (input.anchor.type !== "text") refuse("INVALID_ANCHOR", "the demo anchors on text");
      const quote = input.anchor.quote;
      const t: Thread = { id: `t${store.next++}`, anchor: text(quote), status: "open", statusBy: author, statusAt: stampNow(), anchorState: { state: "attached" }, skipped: 0, messages: [{ id: `m${store.next++}`, at: stampNow(), author, body: input.body, mentions: [] }] };
      store.threads.unshift(t);
      return copy(t);
    },
    reply: async (_doc, id, input) => {
      needs("comment");
      const t = thread(id);
      if (t.status === "resolved") refuse("THREAD_RESOLVED", "reopen the thread before you reply");
      const m: Message = { id: `m${store.next++}`, at: stampNow(), author, body: input.body, mentions: [] };
      t.messages.push(m);
      return copy(m);
    },
    resolve: async (_doc, id) => copy(status(id, "resolved")),
    reopen: async (_doc, id) => copy(status(id, "open")),
    accept: async (_doc, id) => copy(decide(id, "accepted")),
    reject: async (_doc, id) => copy(decide(id, "rejected")),
  };
}
