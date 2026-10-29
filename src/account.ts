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

export interface CommentsAccountDeps {
  /** Every document that may hold data of the subject. */
  documents: Iterable<CommentsAccountDocument>;
  /** Made with `stamp()`. It must name the subject: the same kind and name. A moderate scope does not widen the run. */
  actor: Actor;
  /**
   * The document store of the HTTP worker (`CommentsDocs`), when the host runs it. It keeps the creator of each
   * document on its row, outside the Yjs state. Pass it so export lists those documents and erase tombstones the creator.
   */
  creators?: { exportCreated(author: Author): Promise<{ documentId: string; createdAt: unknown }[]>; eraseCreated(author: Author): Promise<number> };
}

type JsonRecord = Record<string, unknown>;

export interface CommentsAccount {
  id: "comments";
  /**
   * Collections, each record tagged with `documentId`: `messages` (with the thread anchor), `statusChanges`,
   * `edits` (the subject's edits of other people's messages), `suggestions` (the ones the subject wrote),
   * `decisions` (accepts and rejects by the subject), `documents` (the worker documents the subject created, only
   * when `deps.creators` is set), and `unread` (stored entries of the subject that a read
   * cannot show; the export is not complete when this has a record). The package keeps no grants or audit rows. Its
   * one owner-like record is the creator of a worker document, which `deps.creators` covers. A host that runs the
   * worker and omits `creators` leaves that creator in place.
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
  if (deps.creators !== undefined && (typeof deps.creators?.exportCreated !== "function" || typeof deps.creators.eraseCreated !== "function")) bad("creators needs exportCreated and eraseCreated");
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

export const commentsAccount: CommentsAccount = {
  id: "comments",
  async exportAccount(subject, deps) {
    const { documents, own } = check(subject, deps);
    const out: Record<"messages" | "statusChanges" | "edits" | "suggestions" | "decisions" | "documents" | "unread", JsonRecord[]> = { messages: [], statusChanges: [], edits: [], suggestions: [], decisions: [], documents: [], unread: [] };
    for (const { id: documentId, comments, suggestions } of documents) {
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
    if (deps.creators) out.documents.push(...(await deps.creators.exportCreated(own)));
    return plain(out);
  },
  async eraseAccount(subject, deps) {
    const { documents, own } = check(subject, deps);
    const counts = { messages: 0, statuses: 0, edits: 0, suggestions: 0, decisions: 0, documents: 0 };
    for (const { id, comments, suggestions } of documents) {
      try {
        const c = comments.erasePerson(own.name, own);
        const s = suggestions.erasePerson(own.name, own);
        counts.messages += c.messages;
        counts.statuses += c.statuses;
        counts.edits += c.edits;
        counts.suggestions += s.suggestions;
        counts.decisions += s.decisions;
      } catch (cause) {
        // The document id is not personal data. A repeat finds the documents again and counts only what is left.
        const known = cause instanceof CommentsError;
        const reason = cause instanceof Error ? cause.message : "unknown error";
        throw new CommentsError(known ? cause.code : "CORRUPT", `erase stopped at document ${shown(id)}: ${reason}`, { cause });
      }
    }
    if (deps.creators) counts.documents = await deps.creators.eraseCreated(own);
    return counts;
  },
};
