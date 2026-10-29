// The package's side of the account contract: a host calls `exportAccount` and `eraseAccount`
// and never reads the storage layout. The shape matches the account plug-ins of the other packages.
import { CommentsError } from "./errors.js";
import { Actor, assertActor, readAuthor, type Author } from "./principal.js";
import { Suggestions } from "./suggestions.js";
import { shown } from "./text.js";
import { Comments } from "./threads.js";

/** One document the host holds comments on. The host loads it; the package never lists documents. */
export interface CommentsAccountDocument {
  /** A stable id for the document. It goes in each exported record. */
  id: string;
  comments: Comments;
  suggestions: Suggestions;
}

/** What `CommentsDocs` offers the plug-in. */
export interface AccountWorker {
  /** Runs `fn` on each stored document. With `save`, the state `fn` changed is written back in the same transaction. */
  eachAccountDocument(fn: (doc: CommentsAccountDocument) => void, save: boolean): Promise<void>;
  exportCreated(author: Author): Promise<{ documentId: string; createdAt: unknown }[]>;
  eraseCreated(author: Author): Promise<number>;
}

export interface CommentsAccountDeps {
  /** Every document that may hold data of the subject. */
  documents: Iterable<CommentsAccountDocument>;
  /** Made with `stamp()`. It must name the subject: the same kind and name. A moderate scope does not widen the run. */
  actor: Actor;
  /**
   * The document store of the HTTP worker (`CommentsDocs`), when the host runs it. Its rows hold the threads of each
   * document and the creator of each document, outside what `documents` can reach. Pass it, and the run covers every
   * stored document. Without it, a worker host leaves that data in place.
   */
  worker?: AccountWorker;
}

type JsonRecord = Record<string, unknown>;

export interface CommentsAccount {
  id: "comments";
  /**
   * Collections, each record tagged with `documentId`: `messages` (with the thread anchor), `statusChanges`,
   * `edits` (the subject's edits of other people's messages), `suggestions` (the ones the subject wrote),
   * `decisions` (accepts and rejects by the subject), `documents` (the worker documents the subject created, only
   * when `deps.worker` is set), and `unread` (stored entries of the subject that a read
   * cannot show; the export is not complete when this has a record). The package keeps no grants or audit rows. Its
   * one owner-like record is the creator of a worker document, which `deps.worker` covers. A host that runs the
   * worker and omits `worker` leaves that creator in place.
   */
  exportAccount(subject: Author, deps: CommentsAccountDeps): Promise<Record<"messages" | "statusChanges" | "edits" | "suggestions" | "decisions" | "documents" | "unread", JsonRecord[]>>;
  /** Replaces what the subject wrote with a tombstone (see `Comments.erasePerson`). Counts by kind, summed over documents. The thread shape stays. A repeat finds nothing and counts 0. A decision that the subject made on their own suggestion is deleted and not counted, while `unread` in the export counts it. */
  eraseAccount(subject: Author, deps: CommentsAccountDeps): Promise<Record<"messages" | "statuses" | "edits" | "suggestions" | "decisions" | "documents", number>>;
}

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function check(subject: Author, deps: CommentsAccountDeps): { documents: CommentsAccountDocument[]; own: Actor } {
  const who = readAuthor(subject);
  if (!who) throw new CommentsError("INVALID_INPUT", "subject needs a known kind and a name");
  const actor = assertActor(deps?.actor);
  if (actor.kind !== who.kind || actor.name !== who.name) throw new CommentsError("FORBIDDEN", "actor does not match the subject");
  // A missing list would read as a finished run with nothing found, so it is an error. An empty list is valid.
  if (typeof (deps?.documents as { [Symbol.iterator]?: unknown } | undefined)?.[Symbol.iterator] !== "function") throw new CommentsError("INVALID_INPUT", "deps.documents must be a list of documents");
  const documents = [...deps.documents];
  const ids = new Set<unknown>();
  const seen = new Set<unknown>();
  const bad = (why: string): never => {
    throw new CommentsError("INVALID_INPUT", `deps: ${why}`);
  };
  if (deps.worker !== undefined && (["eachAccountDocument", "exportCreated", "eraseCreated"] as const).some((m) => typeof deps.worker?.[m] !== "function")) bad("worker needs eachAccountDocument, exportCreated, and eraseCreated");
  for (const d of documents) {
    if (typeof d?.id !== "string" || d.id === "" || ids.has(d.id)) bad("each document needs a unique id");
    if (!(d.comments instanceof Comments) || !(d.suggestions instanceof Suggestions)) bad("each document needs Comments and Suggestions made by this package");
    if (d.suggestions.comments.ydoc !== d.comments.ydoc) bad("suggestions must be made on the same comments");
    if (seen.has(d.comments.ydoc)) bad("two documents share one Yjs document");
    ids.add(d.id);
    seen.add(d.comments.ydoc);
  }
  // A fresh actor with no scopes: the run covers the subject's own kind only, whatever scopes the caller holds.
  return { documents, own: Actor.of(who) };
}

type Collected = Record<"messages" | "statusChanges" | "edits" | "suggestions" | "decisions" | "documents" | "unread", JsonRecord[]>;

function collect({ id: documentId, comments, suggestions }: CommentsAccountDocument, own: Actor, out: Collected): void {
  const c = comments.exportPerson(own.name, own);
  const s = suggestions.exportPerson(own.name, own);
  for (const t of c.threads) {
    for (const message of t.messages) out.messages.push({ ...message, documentId, threadId: t.threadId, anchor: t.anchor });
    if (t.statusChange) out.statusChanges.push({ ...t.statusChange, documentId, threadId: t.threadId });
  }
  for (const e of c.edits) out.edits.push({ ...e, documentId });
  for (const x of s.authored) out.suggestions.push({ ...x, documentId });
  for (const d of s.decided) out.decisions.push({ documentId, suggestionId: d.id, status: d.status, at: d.at });
  const unread = c.unread + s.unread;
  if (unread > 0) out.unread.push({ documentId, count: unread });
}

type Counts = Record<"messages" | "statuses" | "edits" | "suggestions" | "decisions" | "documents", number>;

// The document id is not personal data. A repeat finds the documents again and counts only what is left.
async function stopAt<T>(where: string, run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    const known = cause instanceof CommentsError;
    const reason = cause instanceof Error ? cause.message : "unknown error";
    throw new CommentsError(known ? cause.code : "CORRUPT", `erase stopped at ${where}: ${reason}`, { cause });
  }
}

function wipe({ comments, suggestions }: CommentsAccountDocument, own: Actor, counts: Counts): void {
  const c = comments.erasePerson(own.name, own);
  const s = suggestions.erasePerson(own.name, own);
  counts.messages += c.messages;
  counts.statuses += c.statuses;
  counts.edits += c.edits;
  counts.suggestions += s.suggestions;
  counts.decisions += s.decisions;
}

export const commentsAccount: CommentsAccount = {
  id: "comments",
  async exportAccount(subject, deps) {
    const { documents, own } = check(subject, deps);
    const out: Collected = { messages: [], statusChanges: [], edits: [], suggestions: [], decisions: [], documents: [], unread: [] };
    for (const doc of documents) collect(doc, own, out);
    if (deps.worker) {
      await deps.worker.eachAccountDocument((doc) => collect(doc, own, out), false);
      out.documents.push(...(await deps.worker.exportCreated(own)));
    }
    return plain(out);
  },
  async eraseAccount(subject, deps) {
    const { documents, own } = check(subject, deps);
    const counts: Counts = { messages: 0, statuses: 0, edits: 0, suggestions: 0, decisions: 0, documents: 0 };
    for (const doc of documents) await stopAt(`document ${shown(doc.id)}`, () => wipe(doc, own, counts));
    if (deps.worker) {
      // A stop inside one stored document rolls that document back, so it is never half erased.
      // The counts are kept per document id, so a transaction that the store runs again does not count twice.
      const each = new Map<string, Counts>();
      await stopAt("a worker document", () =>
        deps.worker!.eachAccountDocument((doc) => {
          const one: Counts = { messages: 0, statuses: 0, edits: 0, suggestions: 0, decisions: 0, documents: 0 };
          wipe(doc, own, one);
          each.set(doc.id, one);
        }, true),
      );
      for (const c of each.values()) for (const k of Object.keys(counts) as (keyof Counts)[]) counts[k] += c[k];
      counts.documents = await stopAt("the worker creators", () => deps.worker!.eraseCreated(own));
    }
    return counts;
  },
};
