import * as Y from "yjs";
import { describe, expect, test } from "vitest";
import { Comments, CommentsError, ERASED_BODY, MODERATE_SCOPE, stamp, Suggestions, textAnchor, type Anchor, type SuggestionHost } from "./index.js";

// Ways this can fail, written before the code:
//  1. Someone other than the author edits or deletes a message, or a thread with other people's replies.
//  2. A moderator scope is read from input, or an agent with no scope moderates.
//  3. Delete leaves a thread with no message, or leaves a stale copy of the text in storage.
//  4. An edit changes the author, the time, or the order, or lands on a resolved thread or erased message.
//  5. Two replicas edit one message at once and the thread breaks.
//  6. Erase leaves the body, the name, a mention, or the status author of the person; or changes thread shape.
//  7. Erase touches another person, or the actor erases a person it may not.
//  8. Export shows another person's words, or the export is open to anyone.
//  9. The erased person comes back after a merge with a replica that edited the message.

const ada = stamp({ kind: "human", name: "ada" });
const bob = stamp({ kind: "human", name: "bob" });
const bot = stamp({ kind: "agent_of_human", name: "scribe" });
const admin = stamp({ kind: "human", name: "root", scopes: [MODERATE_SCOPE] });
const cell: Anchor = { type: "cell", key: "A1" };

let tick = 0;
const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
const make = (doc = new Y.Doc()) => new Comments(doc, { now: clock });
const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    if (error instanceof CommentsError) return error.code;
    throw error;
  }
  return undefined;
};
const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
};

describe("edit message", () => {
  test("the author edits the body and keeps id, author, time, and place", () => {
    const c = make();
    const t = c.add({ anchor: cell, body: "first" }, ada);
    const reply = c.reply(t.id, { body: "second @bob" }, bob);
    const edited = c.editMessage(t.id, reply.id, { body: "second, fixed" }, bob);
    expect(edited).toMatchObject({ id: reply.id, at: reply.at, author: { kind: "human", name: "bob" }, body: "second, fixed", mentions: [], editedBy: { name: "bob" } });
    expect(edited.editedAt).toBeDefined();
    expect(c.get(t.id).messages.map((m) => m.body)).toEqual(["first", "second, fixed"]);
  });

  test("another person, and an agent with the same name but another kind, are refused", () => {
    const c = make();
    const t = c.add({ anchor: cell, body: "mine" }, ada);
    expect(code(() => c.editMessage(t.id, t.messages[0].id, { body: "x" }, bob))).toBe("FORBIDDEN");
    expect(code(() => c.editMessage(t.id, t.messages[0].id, { body: "x" }, stamp({ kind: "agent", name: "ada" })))).toBe("FORBIDDEN");
    expect(c.get(t.id).messages[0].body).toBe("mine");
  });

  test("a principal with the moderate scope may edit, and the edit names who", () => {
    const c = make();
    const t = c.add({ anchor: cell, body: "mine" }, ada);
    const m = c.editMessage(t.id, t.messages[0].id, { body: "redacted" }, admin);
    expect(m.author.name).toBe("ada");
    expect(m.editedBy?.name).toBe("root");
  });

  test("a bad body, a missing message, a resolved thread, and an extra key are refused", () => {
    const c = make();
    const t = c.add({ anchor: cell, body: "mine" }, ada);
    const id = t.messages[0].id;
    expect(code(() => c.editMessage(t.id, id, { body: " " }, ada))).toBe("INVALID_INPUT");
    expect(code(() => c.editMessage(t.id, id, { body: "x", author: bob } as never, ada))).toBe("INVALID_INPUT");
    expect(code(() => c.editMessage(t.id, "nope", { body: "x" }, ada))).toBe("NO_MESSAGE");
    c.resolve(t.id, ada);
    expect(code(() => c.editMessage(t.id, id, { body: "x" }, ada))).toBe("THREAD_RESOLVED");
  });

  test("two replicas that edit one message at once merge to the later edit", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const ca = make(a);
    const t = ca.add({ anchor: cell, body: "start" }, ada);
    sync(a, b);
    const cb = make(b);
    const id = t.messages[0].id;
    ca.editMessage(t.id, id, { body: "from a" }, ada);
    cb.editMessage(t.id, id, { body: "from b" }, ada);
    sync(a, b);
    expect(ca.get(t.id).messages).toHaveLength(1);
    expect(ca.get(t.id).messages[0].body).toBe(cb.get(t.id).messages[0].body);
    expect(ca.get(t.id).skipped).toBe(0);
    expect(ca.problems()).toEqual([]);
  });
});

describe("delete message and thread", () => {
  test("the author deletes a reply, and the text is gone from the stored update", () => {
    const doc = new Y.Doc();
    const c = make(doc);
    const t = c.add({ anchor: cell, body: "keep" }, ada);
    const r = c.reply(t.id, { body: "secret-words-here" }, bob);
    expect(c.deleteMessage(t.id, r.id, bob)).toEqual({ threadId: t.id, messageId: r.id });
    expect(c.get(t.id).messages.map((m) => m.body)).toEqual(["keep"]);
    expect(Buffer.from(Y.encodeStateAsUpdate(doc)).includes("secret-words-here")).toBe(false);
  });

  test("another person is refused, a moderator may, and the last message stays", () => {
    const c = make();
    const t = c.add({ anchor: cell, body: "one" }, ada);
    const r = c.reply(t.id, { body: "two" }, bob);
    expect(code(() => c.deleteMessage(t.id, r.id, ada))).toBe("FORBIDDEN");
    expect(code(() => c.deleteMessage(t.id, r.id, bot))).toBe("FORBIDDEN");
    c.deleteMessage(t.id, r.id, admin);
    expect(code(() => c.deleteMessage(t.id, t.messages[0].id, ada))).toBe("INVALID_INPUT");
  });

  test("the opener deletes a thread only while every message is theirs", () => {
    const c = make();
    const t = c.add({ anchor: cell, body: "one" }, ada);
    c.reply(t.id, { body: "mine too" }, ada);
    const u = c.add({ anchor: cell, body: "other" }, ada);
    c.reply(u.id, { body: "bob here" }, bob);
    expect(c.deleteThread(t.id, ada)).toEqual({ threadId: t.id });
    expect(code(() => c.get(t.id))).toBe("NO_THREAD");
    expect(code(() => c.deleteThread(u.id, ada))).toBe("FORBIDDEN");
    expect(code(() => c.deleteThread(u.id, bot))).toBe("FORBIDDEN");
    c.deleteThread(u.id, admin);
    expect(c.list()).toEqual([]);
  });

  test("a missing thread is NO_THREAD", () => {
    expect(code(() => make().deleteThread("nope", ada))).toBe("NO_THREAD");
  });
});

describe("export and erase a person", () => {
  const setup = () => {
    const doc = new Y.Doc();
    doc.getText("t").insert(0, "hello world");
    const c = make(doc);
    const t = c.add({ anchor: textAnchor(doc.getText("t"), 0, 5), body: "ada says hi @bob" }, ada);
    const r = c.reply(t.id, { body: "bob replies" }, bob);
    c.reply(t.id, { body: "ada again" }, ada);
    c.editMessage(t.id, r.id, { body: "bob edited" }, bob);
    c.resolve(t.id, ada);
    const u = c.add({ anchor: cell, body: "only bob" }, bob);
    return { doc, c, t, u };
  };

  test("export lists only that person's messages and status change", () => {
    const { c, t } = setup();
    const out = c.exportPerson("ada", ada);
    expect(out.person).toBe("ada");
    expect(out.threads).toHaveLength(1);
    expect(out.threads[0].threadId).toBe(t.id);
    expect(out.threads[0].messages.map((m) => m.body)).toEqual(["ada says hi @bob", "ada again"]);
    expect(out.threads[0].statusChange?.status).toBe("resolved");
    expect(JSON.stringify(out)).not.toContain("bob replies");
    expect(JSON.stringify(out)).not.toContain("only bob");
  });

  test("export and erase of another person need the moderate scope", () => {
    const { c } = setup();
    for (const who of [bob, bot]) {
      expect(code(() => c.exportPerson("ada", who))).toBe("FORBIDDEN");
      expect(code(() => c.erasePerson("ada", who))).toBe("FORBIDDEN");
    }
    expect(c.exportPerson("ada", admin).threads).toHaveLength(1);
    expect(code(() => c.exportPerson("", ada))).toBe("INVALID_INPUT");
    expect(code(() => c.erasePerson("erased", admin))).toBe("INVALID_INPUT");
  });

  test("erase tombstones body, name, mentions, and status author; shape stays; others stay", () => {
    const { doc, c, t, u } = setup();
    const before = c.get(t.id);
    expect(c.erasePerson("ada", ada)).toEqual({ messages: 2, statuses: 1 });
    const after = c.get(t.id);
    expect(after.messages.map((m) => m.id)).toEqual(before.messages.map((m) => m.id));
    expect(after.messages.map((m) => m.at)).toEqual(before.messages.map((m) => m.at));
    expect(after.messages[0]).toMatchObject({ body: ERASED_BODY, author: { kind: "human", name: "erased" }, mentions: [], erased: true });
    expect(after.messages[1]).toMatchObject({ body: "bob edited", author: { name: "bob" } });
    expect(after.statusBy).toEqual({ kind: "human", name: "erased" });
    expect(after.status).toBe("resolved");
    expect(c.get(u.id).messages[0].author.name).toBe("bob");
    expect(c.exportPerson("ada", ada).threads).toEqual([]);
    const stored = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("latin1");
    expect(stored).not.toContain("ada says hi");
    expect(stored).not.toContain("ada again");
    expect(c.problems()).toEqual([]);
  });

  test("an erased message cannot be edited, keeps the machine-made kind, and erase twice is a no-op", () => {
    const c = make();
    const t = c.add({ anchor: cell, body: "bot note" }, bot);
    expect(c.erasePerson("scribe", bot)).toEqual({ messages: 1, statuses: 1 });
    expect(c.get(t.id).messages[0].author).toEqual({ kind: "agent_of_human", name: "erased" });
    expect(code(() => c.editMessage(t.id, t.messages[0].id, { body: "x" }, admin))).toBe("FORBIDDEN");
    expect(c.erasePerson("scribe", bot)).toEqual({ messages: 0, statuses: 0 });
  });

  test("erase wins over an edit made at the same time on another replica", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const ca = make(a);
    const t = ca.add({ anchor: cell, body: "start" }, ada);
    sync(a, b);
    const cb = make(b);
    ca.erasePerson("ada", ada);
    cb.editMessage(t.id, t.messages[0].id, { body: "late edit" }, ada);
    sync(a, b);
    expect(ca.get(t.id).messages[0].body).toBe(ERASED_BODY);
    expect(cb.get(t.id).messages[0].body).toBe(ERASED_BODY);
  });
});

describe("suggestions of a person", () => {
  const host: SuggestionHost = { apply: () => ({}), idempotent: true };
  test("export lists them and erase gives them a tombstone author and drops the summary", () => {
    const doc = new Y.Doc();
    const c = make(doc);
    const s = new Suggestions(c, host);
    s.add({ anchor: cell, change: { value: 1 }, summary: "ada idea" }, ada);
    s.add({ anchor: cell, change: { value: 2 }, summary: "bob idea" }, bob);
    expect(s.exportPerson("ada", ada).map((x) => x.summary)).toEqual(["ada idea"]);
    expect(code(() => s.erasePerson("ada", bob))).toBe("FORBIDDEN");
    expect(s.erasePerson("ada", ada)).toBe(1);
    const left = s.list();
    expect(left.map((x) => x.author.name).sort()).toEqual(["bob", "erased"]);
    expect(left.find((x) => x.author.name === "erased")?.summary).toBeUndefined();
    expect(s.exportPerson("ada", ada)).toEqual([]);
  });
});
