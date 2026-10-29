import * as Y from "yjs";
import type { Anchor, AnchorState } from "./anchor.js";
import { CommentsError } from "./errors.js";
import { assertActor, ERASED_NAME, readAuthor, type Actor, type Author } from "./principal.js";
import { BODY_FORBIDDEN, ID, safeId, safeText, shown } from "./text.js";
import type { Comments } from "./threads.js";
import { copy, exact, invalid, strictCopy, validDate } from "./validate.js";

/** The scope that lets an agent accept or reject a suggestion that another principal wrote. */
export const ACCEPT_SCOPE = "comments:accept";

const MAX_CHANGE = 64_000;
const MAX_RECEIPT = 16_000;
const MAX_SUMMARY = 1_000;
const SUGGESTIONS = "comments.suggestions";
const APPLIED = "comments.suggestion-applied";
const REJECTED = "comments.suggestion-rejected";

export interface Suggestion {
  id: string;
  anchor: Anchor;
  /** Whether the anchored content is still there. Accept refuses an orphaned or edited one. */
  anchorState: AnchorState;
  /** What the host app proposes. This package never reads it. The host's `apply` does. */
  change: unknown;
  summary?: string;
  author: Author;
  createdAt: string;
  status: "pending" | "accepted" | "rejected";
  decidedBy?: Author;
  decidedAt?: string;
}

export interface ApplyContext {
  suggestionId: string;
  anchor: Anchor;
  /** Who wrote the suggestion. */
  author: Author;
  /** Who accepts it. Label the edit with this author. */
  by: Author;
  ydoc: Y.Doc;
}

export interface RevertContext {
  suggestionId: string;
  anchor: Anchor;
  /** Who wrote the suggestion. */
  author: Author;
  /** Who made the application being undone. */
  by: Author;
  ydoc: Y.Doc;
}

/**
 * The host app's side. Each hook is synchronous, so the check and the edit stay in one step.
 * Make every edit in `ydoc`, so it merges with the rest.
 */
export interface SuggestionHost {
  /** Check a change when it is suggested, with the anchor it is for. Return the clean change, or throw. */
  parse?(change: unknown, context: { anchor: Anchor }): unknown;
  /**
   * Make the edit. Throw before you change anything when the edit cannot apply, for example when the
   * anchored content changed. Yjs cannot undo a partial edit. If `apply` edits and then fails, the
   * decision is recorded as accepted with no receipt, and `problems()` reports it. Return a receipt,
   * JSON data that lets `revert` undo this edit.
   */
  apply(change: unknown, context: ApplyContext): unknown;
  /**
   * Two replicas can accept one suggestion before they meet. Each applies the edit. After a merge one
   * application stays and `revert` undoes each other. Every replica runs it at the same time, and the
   * results must merge to one outcome, as a Yjs delete of the same range does. Throw before you change
   * anything. A receipt comes from stored data. A peer that can write comment data can choose it, so
   * check it before you use it. The anchor and the author are stored data too, so a check against them
   * helps against a mistake and not against a peer that can write comment data.
   */
  revert?(receipt: unknown, context: RevertContext): void;
  /** Say that applying the same change twice is harmless. Then `revert` is not needed, and a duplicate is not undone. */
  idempotent?: boolean;
}

export interface NewSuggestion {
  anchor: Anchor;
  change: unknown;
  summary?: string;
}

export interface SuggestionFilter {
  status?: Suggestion["status"];
  anchorState?: AnchorState["state"];
}

type Fields = Y.Map<unknown>;
interface Decision {
  client: number;
  by: Author;
  at: string;
  receipt?: unknown;
}

/**
 * Someone who is not a signed-in person decides their own work when the names match, whatever the
 * kinds. A token counts here, because an agent holds it. A signed-in person may decide their own.
 */
const decidesOwn = (author: Author, decider: Author): boolean => author.name !== ERASED_NAME && author.kind !== "human" && decider.kind !== "human" && author.name === decider.name;

/** A client id in its one canonical form: whole digits, no sign, no leading zero, within 32 bits. */
const clientOf = (text: string): number | undefined => (/^(0|[1-9]\d{0,9})$/.test(text) && Number(text) <= 0xffffffff ? Number(text) : undefined);

const thenable = (value: unknown): boolean => typeof (value as { then?: unknown } | null)?.then === "function";

/**
 * Suggested changes to content, from people and agents. Nothing changes until a person, or an agent
 * with the accept scope that did not write it, accepts. Accept and reject are safe across replicas.
 */
export class Suggestions {
  private readonly onTransaction: (tr: Y.Transaction) => void;
  private failures: { id: string; reason: string }[] = [];

  constructor(
    private readonly comments: Comments,
    private readonly host: SuggestionHost,
  ) {
    if (typeof host?.apply !== "function" || (typeof host.revert !== "function" && host.idempotent !== true)) {
      invalid("a host needs apply, and either revert or idempotent: true, so two accepts at once cannot apply a change twice");
    }
    // Create the three maps now. A map that first appears inside an update is a placeholder, and its events would not match.
    void [this.map, this.applied, this.rejected];
    this.onTransaction = (tr) => {
      if (!tr.local && [this.applied, this.map].some((type) => tr.changedParentTypes.has(type as Y.AbstractType<any>))) this.settle();
    };
    this.ydoc.on("afterTransaction", this.onTransaction);
    this.settle();
  }

  /** Stop listening to the document. */
  close(): void {
    this.ydoc.off("afterTransaction", this.onTransaction);
  }

  private get ydoc(): Y.Doc {
    return this.comments.ydoc;
  }
  private get map(): Y.Map<Fields> {
    return this.ydoc.getMap<Fields>(SUGGESTIONS);
  }
  /** The three Yjs maps that hold suggestions and their decisions. `Notifications` watches them. */
  get maps(): { suggestions: Y.Map<Y.Map<unknown>>; applied: Y.Map<unknown>; rejected: Y.Map<unknown> } {
    return { suggestions: this.map, applied: this.applied, rejected: this.rejected };
  }

  private get applied(): Y.Map<unknown> {
    return this.ydoc.getMap<unknown>(APPLIED);
  }
  private get rejected(): Y.Map<unknown> {
    return this.ydoc.getMap<unknown>(REJECTED);
  }

  private change(raw: unknown, anchor: Anchor): unknown {
    let clean: unknown;
    try {
      clean = strictCopy(raw);
      if (this.host.parse) clean = strictCopy(this.host.parse(copy(clean), { anchor: copy(anchor) }));
    } catch (error) {
      return invalid(`the change is refused: ${safeText(error instanceof Error ? error.message : error)}`);
    }
    if (JSON.stringify(clean).length > MAX_CHANGE) invalid(`a change holds up to ${MAX_CHANGE} characters of JSON`);
    return clean;
  }

  /**
   * Records of one kind for one suggestion, in client order. A record that is not valid is not counted:
   * one with no author or time, a receipt that is not small JSON, or a decider who decided their own work.
   */
  private records(entries: [string, unknown][], id: string, author: Author | undefined): Decision[] {
    const out: Decision[] = [];
    for (const [key, raw] of entries) {
      const client = clientOf(key.slice(id.length + 1));
      const r = (raw ?? {}) as Record<string, unknown>;
      const by = readAuthor(r.by);
      if (client === undefined || !by || !validDate(r.at) || !author || decidesOwn(author, by)) continue;
      let receipt: unknown = null;
      try {
        receipt = r.receipt === undefined ? null : strictCopy(r.receipt);
        if (JSON.stringify(receipt).length > MAX_RECEIPT) continue;
      } catch {
        continue;
      }
      out.push({ client, by, at: r.at, receipt });
    }
    return out.sort((a, b) => Number(a.receipt !== null) - Number(b.receipt !== null) || a.client - b.client);
  }

  /** Group the entries of a decision map by suggestion id in one pass, so a read does not scan the map per suggestion. */
  private index(map: Y.Map<unknown>): Map<string, [string, unknown][]> {
    const groups = new Map<string, [string, unknown][]>();
    for (const entry of map.entries()) {
      const id = entry[0].slice(0, entry[0].lastIndexOf(":"));
      const group = groups.get(id);
      if (group) group.push(entry);
      else groups.set(id, [entry]);
    }
    return groups;
  }

  private read(id: string, fields: unknown, indexes = { applied: this.index(this.applied), rejected: this.index(this.rejected) }): Suggestion {
    try {
      if (!ID.test(id)) throw new Error("the suggestion id is not short and plain");
      if (!(fields instanceof Y.Map)) throw new Error("the suggestion is not a map");
      const author = readAuthor(fields.get("author"));
      const createdAt = fields.get("createdAt");
      const summary = fields.get("summary");
      const change = fields.get("change");
      if (!author || !validDate(createdAt)) throw new Error("the suggestion has no valid author or time");
      if (summary !== undefined && !(typeof summary === "string" && summary.trim() !== "" && summary.length <= MAX_SUMMARY && !BODY_FORBIDDEN.test(summary))) {
        throw new Error("the summary is not valid");
      }
      if (change === undefined || JSON.stringify(strictCopy(change)).length > MAX_CHANGE) throw new Error("the change is missing or too large");
      const won = this.records(indexes.applied.get(id) ?? [], id, author)[0];
      const refused = this.records(indexes.rejected.get(id) ?? [], id, author)[0];
      const decision = won ? { status: "accepted" as const, ...won } : refused ? { status: "rejected" as const, ...refused } : undefined;
      const anchor = this.comments.parseAnchor(fields.get("anchor"));
      return {
        id,
        anchor,
        anchorState: this.comments.anchorState(anchor),
        change: copy(change),
        ...(summary === undefined ? {} : { summary }),
        author,
        createdAt,
        status: decision?.status ?? "pending",
        ...(decision ? { decidedBy: decision.by, decidedAt: decision.at } : {}),
      };
    } catch (error) {
      throw new CommentsError("CORRUPT", `suggestion ${shown(id)} is malformed: ${safeText(error instanceof Error ? error.message : error)}`);
    }
  }

  private fields(id: unknown): { id: string; fields: Fields } {
    if (typeof id !== "string" || !ID.test(id) || !this.map.has(id)) throw new CommentsError("NO_SUGGESTION", `no suggestion with id ${shown(id)}`);
    return { id, fields: this.map.get(id) as Fields };
  }

  /** The suggestions a person wrote, and the decisions they made, in this document. A person may export their own data. */
  exportPerson(person: string, actor: Actor): { authored: Suggestion[]; decided: { id: string; status: "accepted" | "rejected"; at: string }[] } {
    const { match } = this.comments.checkPerson(person, actor);
    const all = this.list();
    return {
      authored: all.filter((s) => match(s.author)),
      decided: all.flatMap((s) => (s.decidedBy && s.decidedAt && s.status !== "pending" && match(s.decidedBy) ? [{ id: s.id, status: s.status, at: s.decidedAt }] : [])),
    };
  }

  /**
   * Give every suggestion a person wrote a tombstone author and drop its summary, and give every decision
   * they made a tombstone decider. The change stays, because an accepted change is already part of the
   * content. Returns how many suggestions and decisions it changed.
   */
  erasePerson(person: string, actor: Actor): { suggestions: number; decisions: number } {
    const { match } = this.comments.checkPerson(person, actor);
    const out = { suggestions: 0, decisions: 0 };
    this.ydoc.transact(() => {
      for (const fields of this.map.values()) {
        const author = fields instanceof Y.Map ? readAuthor(fields.get("author")) : undefined;
        if (!author || !match(author)) continue;
        fields.set("author", { kind: author.kind, name: ERASED_NAME });
        fields.delete("summary");
        out.suggestions++;
      }
      for (const map of [this.applied, this.rejected]) {
        for (const [key, raw] of [...map.entries()]) {
          const by = readAuthor((raw as { by?: unknown } | null)?.by);
          if (!by || !match(by)) continue;
          map.set(key, { ...(raw as object), by: { kind: by.kind, name: ERASED_NAME } });
          out.decisions++;
        }
      }
    });
    return out;
  }

  /** Propose a change. Anyone can suggest. The host stamps the author. */
  add(input: NewSuggestion, actor: Actor): Suggestion {
    const who = assertActor(actor);
    const given = exact(input, ["anchor", "change", "summary"], "a new suggestion");
    const anchor = this.comments.checkAnchor(given.anchor);
    const change = this.change(given.change, anchor);
    const summary = given.summary;
    if (summary !== undefined && !(typeof summary === "string" && summary.trim() !== "" && summary.length <= MAX_SUMMARY && !BODY_FORBIDDEN.test(summary))) {
      invalid(`a summary must be text of 1 to ${MAX_SUMMARY} characters, with no control or invisible characters`);
    }
    const id = globalThis.crypto.randomUUID();
    const createdAt = this.comments.time();
    this.ydoc.transact(() => {
      const fields: Fields = new Y.Map();
      this.map.set(id, fields);
      fields.set("anchor", anchor);
      fields.set("change", change);
      if (summary !== undefined) fields.set("summary", summary);
      fields.set("author", { kind: who.kind, name: who.name });
      fields.set("createdAt", createdAt);
    });
    return this.get(id);
  }

  /** A person decides. An agent needs the accept scope, and never decides its own suggestion. */
  private mayDecide(who: Actor, s: Suggestion, verb: string): void {
    const ok = !decidesOwn(s.author, who) && (who.kind === "human" || who.scopes.includes(ACCEPT_SCOPE));
    if (!ok) throw new CommentsError("FORBIDDEN", `${who.kind}:${shown(who.name)} cannot ${verb} this suggestion: a signed-in person, or a principal with the ${ACCEPT_SCOPE} scope that did not write it, can`);
  }

  /**
   * Apply the change as the accepting author and record the decision, in one step. Accepting an
   * accepted suggestion changes nothing. When `apply` throws, the suggestion stays pending.
   */
  accept(suggestionId: string, actor: Actor): Suggestion {
    const who = assertActor(actor);
    if ((this.ydoc as unknown as { _transaction: unknown })._transaction !== null) {
      throw new CommentsError("APPLY_FAILED", "accept cannot run inside another Yjs transaction, such as an observer or an apply hook");
    }
    const { id, fields } = this.fields(suggestionId);
    const s = this.read(id, fields);
    this.mayDecide(who, s, "accept");
    if (s.status === "accepted") return s;
    if (s.status === "rejected") throw new CommentsError("ALREADY_DECIDED", `suggestion ${shown(id)} is already rejected`);
    const by: Author = { kind: who.kind, name: who.name };
    const at = this.comments.time();
    this.ydoc.transact((tr) => {
      const edited = () => tr.changed.size > 0 || tr.deleteSet.clients.size > 0;
      let receipt: unknown = null;
      let failure: unknown;
      try {
        if (s.anchorState.state === "orphaned" || s.anchorState.state === "edited") {
          throw new Error(s.anchorState.state === "orphaned" ? "the anchored content is gone" : "the anchored content has changed since the suggestion was made");
        }
        this.comments.checkAnchor(s.anchor);
        const change = this.change(s.change, s.anchor);
        receipt = this.host.apply(change, { suggestionId: id, anchor: copy(s.anchor), author: Object.freeze({ ...s.author }), by: Object.freeze({ ...by }), ydoc: this.ydoc });
        if (thenable(receipt)) throw new Error("apply must finish at once and cannot return a promise");
        receipt = receipt === undefined ? null : strictCopy(receipt);
        if (JSON.stringify(receipt).length > MAX_RECEIPT) throw new Error(`a receipt holds up to ${MAX_RECEIPT} characters of JSON`);
      } catch (error) {
        failure = error;
        receipt = null;
      }
      if (failure !== undefined) {
        const reason = safeText(failure instanceof Error ? failure.message : failure);
        if (!edited()) throw new CommentsError("APPLY_FAILED", `the change could not be applied: ${reason}`);
        this.failures.push({ id: safeId(id), reason: `apply failed after it edited the document, so the decision is recorded without a receipt: ${reason}` });
      }
      this.applied.set(`${id}:${this.ydoc.clientID}`, { by, at, receipt });
    });
    return this.get(id);
  }

  /** Same right as accept. A person can withdraw their own suggestion. */
  reject(suggestionId: string, actor: Actor): Suggestion {
    const who = assertActor(actor);
    const { id, fields } = this.fields(suggestionId);
    const s = this.read(id, fields);
    this.mayDecide(who, s, "reject");
    if (s.status === "rejected") return s;
    if (s.status === "accepted") throw new CommentsError("ALREADY_DECIDED", `suggestion ${shown(id)} is already accepted`);
    this.rejected.set(`${id}:${this.ydoc.clientID}`, { by: { kind: who.kind, name: who.name }, at: this.comments.time() });
    return this.get(id);
  }

  get(suggestionId: string): Suggestion {
    const { id, fields } = this.fields(suggestionId);
    return this.read(id, fields);
  }

  /** In the order they were made. A malformed suggestion is skipped, and `problems()` names it. */
  list(filter: SuggestionFilter = {}): Suggestion[] {
    const given = exact(filter, ["status", "anchorState"], "a filter");
    if (given.anchorState !== undefined && !["attached", "edited", "orphaned", "unknown"].includes(given.anchorState as string)) invalid("anchorState must be attached, edited, orphaned, or unknown");
    if (given.status !== undefined && !["pending", "accepted", "rejected"].includes(given.status as string)) invalid("status must be pending, accepted, or rejected");
    return this.readAll()
      .suggestions.filter((s) => given.status === undefined || s.status === given.status)
      .filter((s) => given.anchorState === undefined || s.anchorState.state === given.anchorState)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Suggestions that could not be read, and reverts that failed. */
  problems(): { id: string; reason: string }[] {
    return [...this.readAll().problems, ...this.failures];
  }

  private readAll(): { suggestions: Suggestion[]; problems: { id: string; reason: string }[] } {
    const suggestions: Suggestion[] = [];
    const problems: { id: string; reason: string }[] = [];
    const indexes = { applied: this.index(this.applied), rejected: this.index(this.rejected) };
    for (const [id, fields] of this.map.entries()) {
      try {
        suggestions.push(this.read(id, fields, indexes));
      } catch (error) {
        problems.push({ id: safeId(id), reason: (error as Error).message });
      }
    }
    return { suggestions, problems };
  }

  /**
   * Two replicas can accept one suggestion before they meet. After a merge, the application of the
   * lowest client id stays, and the host reverts each other one. Every replica reaches the same result.
   * A revert that throws leaves its record, so the next merge tries again.
   */
  settle(): void {
    const groups = this.index(this.applied);
    const indexes = { applied: groups, rejected: this.index(this.rejected) };
    this.failures = this.failures.filter((f) => f.reason.startsWith("apply failed") || f.reason.startsWith("a duplicate application has no receipt"));
    this.ydoc.transact(() => {
      for (const [id, entries] of groups) {
        if (entries.length < 2 || !ID.test(id) || !this.map.has(id)) continue;
        let s: Suggestion;
        try {
          s = this.read(id, this.map.get(id), indexes);
        } catch {
          continue;
        }
        for (const loser of this.records(entries, id, s.author).slice(1)) {
          const key = `${id}:${loser.client}`;
          if (this.host.idempotent) {
            this.applied.delete(key);
            continue;
          }
          if (loser.receipt === null) {
            this.failures.push({ id: safeId(id), reason: "a duplicate application has no receipt, so its edit cannot be undone and stays in the document" });
            this.applied.delete(key);
            continue;
          }
          try {
            this.host.revert?.(loser.receipt, { suggestionId: id, anchor: copy(s.anchor), author: Object.freeze({ ...s.author }), by: Object.freeze({ ...loser.by }), ydoc: this.ydoc });
            this.applied.delete(key);
          } catch (error) {
            this.failures.push({ id: safeId(id), reason: `a duplicate application could not be reverted: ${safeText(error instanceof Error ? error.message : error)}` });
          }
        }
      }
    });
  }
}
