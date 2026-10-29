import * as Y from "yjs";
import { describe, expect, test } from "vitest";
import { commentsAccount, type CommentsAccountDocument } from "./account.js";
import { Comments, CommentsError, MODERATE_SCOPE, stamp, Suggestions, ERASED_NAME, type Anchor, type SuggestionHost } from "./index.js";

// Ways this can fail, written before the code:
//  1. Export holds another person's words, or misses a kind (message, status, edit, suggestion, decision).
//  2. Erase leaves the name or body of the subject, or touches another person.
//  3. A second erase counts again or throws.
//  4. An actor that is not the subject, or one with the moderate scope, widens the run.
//  5. A bad subject or bad documents are accepted.

const ada = stamp({ kind: "human", name: "ada" });
const bob = stamp({ kind: "human", name: "bob" });
const admin = stamp({ kind: "human", name: "root", scopes: [MODERATE_SCOPE] });
const cell: Anchor = { type: "cell", key: "A1" };
const host: SuggestionHost = { parse: (c) => c, apply: () => ({}), revert: () => {} };

const doc = (id: string): CommentsAccountDocument => {
  const comments = new Comments(new Y.Doc());
  return { id, comments, suggestions: new Suggestions(comments, host) };
};
const seed = () => {
  const d = doc("d1");
  const t = d.comments.add({ anchor: cell, body: "ada says" }, ada);
  d.comments.reply(t.id, { body: "bob says" }, bob);
  d.comments.resolve(t.id, ada);
  const t2 = d.comments.add({ anchor: { type: "cell", key: "B2" }, body: "bob thread" }, bob);
  d.comments.editMessage(t2.id, t2.messages[0].id, { body: "bob edit" }, stamp({ kind: "human", name: "ada", scopes: [MODERATE_SCOPE] }));
  const s = d.suggestions.add({ anchor: cell, change: { value: 1 } }, ada);
  const s2 = d.suggestions.add({ anchor: cell, change: { value: 2 } }, bob);
  d.suggestions.reject(s2.id, ada);
  return { d, t, s };
};
const code = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (e) {
    if (e instanceof CommentsError) return e.code;
    throw e;
  }
};

describe("commentsAccount", () => {
  test("exports what the subject wrote, and no words of others", async () => {
    const { d } = seed();
    const out = await commentsAccount.exportAccount(ada, { documents: [d, doc("empty")], actor: ada });
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]).toMatchObject({ documentId: "d1", body: "ada says" });
    expect(out.edits).toHaveLength(1);
    expect(out.statusChanges).toHaveLength(1);
    expect(out.suggestions).toHaveLength(1);
    expect(out.decisions).toHaveLength(1);
    expect(out.unread).toEqual([]);
    expect(JSON.stringify(out)).not.toContain("bob says");
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });

  test("erases, counts, and a second erase counts 0", async () => {
    const { d, t } = seed();
    const first = await commentsAccount.eraseAccount(ada, { documents: [d], actor: ada });
    expect(first).toEqual({ messages: 1, statuses: 1, edits: 1, suggestions: 1, decisions: 1 });
    const thread = d.comments.get(t.id);
    expect(thread.messages.map((m) => m.author.name)).toEqual([ERASED_NAME, "bob"]);
    expect(thread.messages[1].body).toBe("bob says");
    const second = await commentsAccount.eraseAccount(ada, { documents: [d], actor: ada });
    expect(second).toEqual({ messages: 0, statuses: 0, edits: 0, suggestions: 0, decisions: 0 });
    const out = await commentsAccount.exportAccount(ada, { documents: [d], actor: ada });
    expect(Object.values(out).every((v) => v.length === 0)).toBe(true);
  });

  test("an actor that is not the subject is refused, and a moderator scope does not widen it", async () => {
    const { d } = seed();
    expect(await code(() => commentsAccount.exportAccount(ada, { documents: [d], actor: bob }))).toBe("FORBIDDEN");
    expect(await code(() => commentsAccount.eraseAccount(ada, { documents: [d], actor: admin }))).toBe("FORBIDDEN");
    const agent = stamp({ kind: "agent_of_human", name: "ada", scopes: [MODERATE_SCOPE] });
    await commentsAccount.eraseAccount(agent, { documents: [d], actor: agent });
    expect(d.comments.list().flatMap((t) => t.messages).some((m) => m.author.name === "ada")).toBe(true);
  });

  test("bad subject or documents are refused", async () => {
    expect(await code(() => commentsAccount.exportAccount({ kind: "robot", name: "x" } as never, { documents: [], actor: ada }))).toBe("INVALID_INPUT");
    expect(await code(() => commentsAccount.exportAccount(ada, { actor: ada } as never))).toBe("INVALID_INPUT");
    expect(await code(() => commentsAccount.eraseAccount(ada, { documents: {}, actor: ada } as never))).toBe("INVALID_INPUT");
    const bare = { id: "n", comments: { ydoc: undefined, exportPerson() {}, erasePerson() {} }, suggestions: { comments: { ydoc: undefined }, exportPerson() {}, erasePerson() {} } };
    expect(await code(() => commentsAccount.exportAccount(ada, { documents: [bare as never], actor: ada }))).toBe("INVALID_INPUT");
    const d = doc("same");
    expect(await code(() => commentsAccount.exportAccount(ada, { documents: [d, { ...d, id: "other" }], actor: ada }))).toBe("INVALID_INPUT");
    const again = new Comments(d.comments.ydoc);
    expect(await code(() => commentsAccount.exportAccount(ada, { documents: [d, { id: "b", comments: again, suggestions: new Suggestions(again, host) }], actor: ada }))).toBe("INVALID_INPUT");
    expect(await code(() => commentsAccount.exportAccount(ada, { documents: [{ id: "x", comments: d.comments, suggestions: doc("y").suggestions }], actor: ada }))).toBe("INVALID_INPUT");
    expect(await code(() => commentsAccount.exportAccount(ada, { documents: [d, d], actor: ada }))).toBe("INVALID_INPUT");
    expect(await code(() => commentsAccount.exportAccount(ada, { documents: [], actor: { kind: "human", name: "ada" } as never }))).toBe("INVALID_AUTHOR");
  });

  test("a document that fails stops the erase, names it, and keeps the earlier ones erased", async () => {
    const a = seed().d;
    const b = seed().d;
    b.comments.erasePerson = () => {
      throw new CommentsError("CORRUPT", "bad entry");
    };
    const failure = await commentsAccount.eraseAccount(ada, { documents: [a, { ...b, id: "d2" }], actor: ada }).catch((e) => e);
    expect(failure).toBeInstanceOf(CommentsError);
    expect(failure.code).toBe("CORRUPT");
    expect(failure.message).toContain('document "d2"');
    expect((await commentsAccount.exportAccount(ada, { documents: [a], actor: ada })).messages).toEqual([]);
    b.comments.erasePerson = () => {
      throw new Error("plain");
    };
    const plain = await commentsAccount.eraseAccount(ada, { documents: [{ ...b, id: "d2" }], actor: ada }).catch((e) => e);
    expect(plain).toBeInstanceOf(CommentsError);
    expect(plain.message).toContain('document "d2": plain');
    expect(plain.cause).toBeInstanceOf(Error);
  });
});
