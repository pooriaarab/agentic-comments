import * as Y from "yjs";
import { describe, expect, test } from "vitest";
import { Comments, CommentsError, Notifications, ERASED_BODY, MODERATE_SCOPE, stamp, Suggestions, textAnchor, type Anchor, type SuggestionHost } from "./index.js";

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
    expect(c.erasePerson("ada", ada)).toEqual({ messages: 2, statuses: 1, edits: 0 });
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
    expect(c.erasePerson("scribe", bot)).toEqual({ messages: 1, statuses: 1, edits: 0 });
    expect(c.get(t.id).messages[0].author).toEqual({ kind: "agent_of_human", name: "erased" });
    expect(code(() => c.editMessage(t.id, t.messages[0].id, { body: "x" }, admin))).toBe("FORBIDDEN");
    expect(c.erasePerson("scribe", bot)).toEqual({ messages: 0, statuses: 0, edits: 0 });
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
    expect(s.exportPerson("ada", ada).authored.map((x) => x.summary)).toEqual(["ada idea"]);
    expect(code(() => s.erasePerson("ada", bob))).toBe("FORBIDDEN");
    expect(s.erasePerson("ada", ada)).toEqual({ suggestions: 1, decisions: 0 });
    const left = s.list();
    expect(left.map((x) => x.author.name).sort()).toEqual(["bob", "erased"]);
    expect(left.find((x) => x.author.name === "erased")?.summary).toBeUndefined();
    expect(s.exportPerson("ada", ada).authored).toEqual([]);
  });

  test("a decision by the person is exported and erased, and the suggestion stays decided", () => {
    const doc = new Y.Doc();
    const s = new Suggestions(make(doc), host);
    const one = s.add({ anchor: cell, change: { value: 1 }, summary: "bob idea" }, bob);
    s.reject(one.id, ada);
    expect(s.exportPerson("ada", ada).decided).toMatchObject([{ id: one.id, status: "rejected" }]);
    expect(s.erasePerson("ada", ada)).toEqual({ suggestions: 0, decisions: 1 });
    expect(s.get(one.id)).toMatchObject({ status: "rejected", decidedBy: { kind: "human", name: "erased" } });
    expect(s.exportPerson("ada", ada).decided).toEqual([]);
  });
});

describe("review findings", () => {
  const agentAda = stamp({ kind: "agent", name: "ada" });

  test("a principal of another kind with the same name cannot export or erase a person, and erase leaves its messages", () => {
    const c = make();
    const t = c.add({ anchor: cell, body: "human ada" }, ada);
    c.reply(t.id, { body: "agent ada" }, agentAda);
    expect(c.exportPerson("ada", agentAda).threads[0].messages.map((m) => m.body)).toEqual(["agent ada"]);
    expect(c.erasePerson("ada", ada)).toMatchObject({ messages: 1 });
    expect(c.get(t.id).messages.map((m) => m.body)).toEqual(["[erased]", "agent ada"]);
    expect(c.exportPerson("ada", admin).threads[0].messages.map((m) => m.body)).toEqual(["agent ada"]);
  });

  test("erase reaches an edit made at the same time on another replica, in the stored data", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const ca = make(a);
    const t = ca.add({ anchor: cell, body: "start" }, ada);
    sync(a, b);
    ca.erasePerson("ada", ada);
    make(b).editMessage(t.id, t.messages[0].id, { body: "late-secret" }, ada);
    sync(a, b);
    expect(ca.erasePerson("ada", ada)).toMatchObject({ messages: 1 });
    expect(Buffer.from(Y.encodeStateAsUpdate(a)).includes("late-secret")).toBe(false);
    expect(ca.get(t.id).messages[0].body).toBe(ERASED_BODY);
    expect(ca.problems()).toEqual([]);
  });

  test("erase reaches a bad message, a message past the read limit, and an unreadable thread; export counts what it cannot show", () => {
    const doc = new Y.Doc();
    const c = make(doc);
    const t = c.add({ anchor: cell, body: "ok" }, bob);
    const list = (doc.getMap("comments.threads").get(t.id) as Y.Map<unknown>).get("messages") as Y.Array<unknown>;
    list.push([{ id: "bad1", at: "nope", author: { kind: "human", name: "ada" }, body: "ada-bad-secret", mentions: [] }]);
    const broken = new Y.Map<unknown>();
    doc.getMap("comments.threads").set("broken", broken);
    broken.set("messages", Y.Array.from([{ id: "bad2", at: "nope", author: { kind: "human", name: "ada" }, body: "ada-broken-secret", mentions: [] }]));
    expect(c.exportPerson("ada", ada)).toMatchObject({ threads: [], unread: 2 });
    expect(c.erasePerson("ada", ada)).toMatchObject({ messages: 2 });
    const stored = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("latin1");
    expect(stored).not.toContain("ada-bad-secret");
    expect(stored).not.toContain("ada-broken-secret");
    expect(c.exportPerson("ada", ada).unread).toBe(0);
  });

  test("erase also removes the person's name as an editor of another's message", () => {
    const c = make();
    const t = c.add({ anchor: cell, body: "bob wrote" }, bob);
    const mod = stamp({ kind: "human", name: "ada", scopes: [MODERATE_SCOPE] });
    c.editMessage(t.id, t.messages[0].id, { body: "bob wrote, cleaned" }, mod);
    expect(c.exportPerson("ada", mod).edits).toEqual([{ threadId: t.id, messageId: t.messages[0].id, at: expect.any(String) }]);
    expect(c.erasePerson("ada", mod)).toMatchObject({ messages: 0, edits: 1 });
    expect(c.get(t.id).messages[0]).toMatchObject({ body: "bob wrote, cleaned", author: { name: "bob" }, editedBy: { name: "erased" } });
  });

  test("two replicas that delete different messages at once leave a thread that a moderator can still delete", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const ca = make(a);
    const t = ca.add({ anchor: cell, body: "one" }, ada);
    const r = ca.reply(t.id, { body: "two" }, bob);
    sync(a, b);
    ca.deleteMessage(t.id, t.messages[0].id, ada);
    make(b).deleteMessage(t.id, r.id, bob);
    sync(a, b);
    expect(code(() => ca.get(t.id))).toBe("CORRUPT");
    expect(code(() => ca.deleteThread(t.id, ada))).toBe("CORRUPT");
    expect(ca.deleteThread(t.id, admin)).toEqual({ threadId: t.id });
    expect(ca.problems()).toEqual([]);
  });

  test("no principal can take the name of a tombstone, and a tombstone is nobody's to delete", () => {
    expect(code(() => stamp({ kind: "human", name: "erased" }))).toBe("INVALID_AUTHOR");
    const c = make();
    const t = c.add({ anchor: cell, body: "one" }, ada);
    const r = c.reply(t.id, { body: "two" }, ada);
    c.erasePerson("ada", ada);
    expect(code(() => c.deleteMessage(t.id, r.id, ada))).toBe("FORBIDDEN");
    expect(code(() => c.deleteThread(t.id, ada))).toBe("FORBIDDEN");
    expect(c.deleteMessage(t.id, r.id, admin).messageId).toBe(r.id);
  });

  test("copies that disagree on time or kind are not merged, and a forged erased flag is refused", () => {
    const doc = new Y.Doc();
    const c = make(doc);
    const t = c.add({ anchor: cell, body: "one" }, ada);
    const list = (doc.getMap("comments.threads").get(t.id) as Y.Map<unknown>).get("messages") as Y.Array<unknown>;
    const first = list.get(0) as Record<string, unknown>;
    const stamped = { editedAt: "2026-02-01T00:00:00.000Z", editedBy: { kind: "human", name: "ada" } };
    list.push([{ ...first, ...stamped, at: "2026-03-01T00:00:00.000Z" }]);
    list.delete(0, 1);
    list.insert(0, [{ ...first, ...stamped }]);
    expect(c.problems()).not.toEqual([]);
    expect(code(() => c.get(t.id))).toBe("CORRUPT");
    const forged = new Y.Doc();
    const f = make(forged);
    const u = f.add({ anchor: cell, body: "real body" }, ada);
    const fl = (forged.getMap("comments.threads").get(u.id) as Y.Map<unknown>).get("messages") as Y.Array<unknown>;
    fl.insert(0, [{ ...(fl.get(0) as object), erased: true }]);
    fl.delete(1, 1);
    expect(f.problems().length).toBeGreaterThan(0);
  });

  test("an edit or an erase is not a new message to a notifier", () => {
    const c = make();
    const n = new Notifications(c);
    const seen: string[] = [];
    n.subscribe((e) => void seen.push(e.type));
    const t = c.add({ anchor: cell, body: "start" }, ada);
    const r = c.reply(t.id, { body: "reply" }, bob);
    c.editMessage(t.id, r.id, { body: "reply, fixed" }, bob);
    c.erasePerson("bob", bob);
    expect(seen).toEqual(["thread.created", "message.added"]);
    n.close();
  });
});

describe("second review findings", () => {
  const host: SuggestionHost = { apply: () => ({}), idempotent: true };
  const bot2 = stamp({ kind: "agent", name: "bot" });

  test("erase never turns a refused self-decision into a valid one, and an erased pending suggestion cannot be accepted", () => {
    const doc = new Y.Doc();
    const s = new Suggestions(make(doc), host);
    const one = s.add({ anchor: cell, change: { value: 1 }, summary: "mine" }, bot2);
    doc.getMap("comments.suggestion-rejected").set(`${one.id}:7`, { by: { kind: "user_token", name: "bot" }, at: "2026-01-01T00:00:00.000Z" });
    expect(s.get(one.id).status).toBe("pending");
    s.erasePerson("bot", bot2);
    s.erasePerson("bot", stamp({ kind: "user_token", name: "bot" }));
    expect(s.get(one.id)).toMatchObject({ status: "pending", change: null, author: { name: "erased" } });
    expect(code(() => s.accept(one.id, ada))).toBe("FORBIDDEN");
  });

  test("an accepted suggestion keeps its change after erase", () => {
    const s = new Suggestions(make(), host);
    const one = s.add({ anchor: cell, change: { value: 5 } }, bob);
    s.accept(one.id, ada);
    s.erasePerson("bob", bob);
    expect(s.get(one.id)).toMatchObject({ status: "accepted", change: { value: 5 }, author: { name: "erased" } });
  });

  test("export counts a status record and an edit stamp in a thread it cannot read", () => {
    const doc = new Y.Doc();
    const c = make(doc);
    const t = c.add({ anchor: cell, body: "bob wrote" }, bob);
    c.resolve(t.id, ada);
    const fields = doc.getMap("comments.threads").get(t.id) as Y.Map<unknown>;
    fields.set("anchor", { type: "nonsense" });
    expect(c.exportPerson("ada", ada)).toMatchObject({ threads: [], unread: 1 });
    expect(c.erasePerson("ada", ada)).toMatchObject({ statuses: 1 });
    expect(c.exportPerson("ada", ada).unread).toBe(0);
  });

  test("an edit and a delete made at once keep the edit", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const ca = make(a);
    const t = ca.add({ anchor: cell, body: "one" }, ada);
    const r = ca.reply(t.id, { body: "two" }, bob);
    sync(a, b);
    ca.deleteMessage(t.id, r.id, admin);
    make(b).editMessage(t.id, r.id, { body: "two, edited" }, bob);
    sync(a, b);
    expect(ca.get(t.id).messages.map((m) => m.body)).toEqual(["one", "two, edited"]);
  });
});

describe("third review findings", () => {
  const host: SuggestionHost = { apply: () => ({}), idempotent: true };

  test("a decision is erased and exported even when its suggestion cannot be read or is missing", () => {
    const doc = new Y.Doc();
    const s = new Suggestions(make(doc), host);
    const one = s.add({ anchor: cell, change: { value: 1 } }, bob);
    s.reject(one.id, ada);
    (doc.getMap("comments.suggestions").get(one.id) as Y.Map<unknown>).set("author", { kind: "nope" });
    doc.getMap("comments.suggestion-applied").set("ghost:5", { by: { kind: "human", name: "ada" }, at: "2026-01-01T00:00:00.000Z" });
    expect(s.exportPerson("ada", ada).unread).toBe(2);
    expect(s.erasePerson("ada", ada)).toEqual({ suggestions: 0, decisions: 2 });
    expect(Buffer.from(Y.encodeStateAsUpdate(doc)).toString("latin1")).not.toContain('"ada"');
    expect(s.exportPerson("ada", ada).unread).toBe(0);
  });

  test("a thread with a bad message list still has its status record erased", () => {
    const doc = new Y.Doc();
    const c = make(doc);
    const t = c.add({ anchor: cell, body: "bob wrote" }, bob);
    c.resolve(t.id, ada);
    (doc.getMap("comments.threads").get(t.id) as Y.Map<unknown>).set("messages", "broken");
    expect(c.exportPerson("ada", ada).unread).toBe(1);
    expect(c.erasePerson("ada", ada)).toMatchObject({ statuses: 1 });
  });

  test("concurrent edits of one message make no event on a replica that had the original", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const ca = make(a);
    const t = ca.add({ anchor: cell, body: "start" }, ada);
    const r = ca.reply(t.id, { body: "reply" }, bob);
    sync(a, b);
    const cb = make(b);
    const seen: string[] = [];
    const na = new Notifications(ca);
    na.subscribe((e) => void seen.push(`${e.type}:${e.source}`));
    ca.editMessage(t.id, r.id, { body: "y1 @carol" }, bob);
    cb.editMessage(t.id, r.id, { body: "y2 @dave" }, bob);
    sync(a, b);
    expect(seen).toEqual([]);
    na.close();
  });
});
