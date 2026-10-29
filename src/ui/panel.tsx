import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AgentBadge, Avatar, Button, Input, Textarea } from "agentic-design/react";
import type { CommentsClient, Me } from "../client.js";
import type { Anchor } from "../anchor.js";
import type { Author } from "../principal.js";
import type { Suggestion } from "../suggestions.js";
import type { Message, Thread } from "../threads.js";
import { holds, mayDecide } from "./rules.js";

/** The calls the panel makes. A `CommentsClient` fits, and so does any object with these methods. */
export type PanelClient = Pick<CommentsClient, "me" | "listThreads" | "addThread" | "reply" | "resolve" | "reopen" | "listSuggestions" | "accept" | "reject">;

export interface CommentsPanelProps {
  client: PanelClient;
  /** The document whose threads the panel shows. */
  docId: string;
  /** The heading. Defaults to "Comments". */
  title?: string;
  /** Show the form that starts a thread on a quote. On by default. A page that makes its own anchors turns it off. */
  newThread?: boolean;
}

type View = "open" | "resolved" | "all";

const VIEWS: { id: View; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "resolved", label: "Resolved" },
  { id: "all", label: "All" },
];

interface Act {
  (key: string, run: () => Promise<unknown>): Promise<void>;
}

// The cards read the client, the document, the signed-in principal, and the write runner from here.
const Ctx = createContext<{ client: PanelClient; docId: string; me: Me | undefined; busy: string | undefined; act: Act } | undefined>(undefined);
function useCtx() {
  const value = useContext(Ctx);
  if (!value) throw new Error("A panel card needs a CommentsPanel above it.");
  return value;
}

const when = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const stamp = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${when.format(date)} UTC`;
};

function failure(error: unknown): string {
  const code = typeof (error as { code?: unknown })?.code === "string" ? `${(error as { code: string }).code}: ` : "";
  return `${code}${error instanceof Error ? error.message : String(error)}`;
}

/** Who wrote it. A person shows a name. An agent shows the agent badge, so the words say a machine made it. */
function Who({ author, agentLabel }: { author: Author; agentLabel: string }) {
  if (author.kind === "human") {
    return (
      <span className="agd-comments__who">
        <Avatar entry={{ id: `person-${author.name}`, name: author.name, kind: "person" }} />
        <strong className="agd-comments__name">{author.name}</strong>
      </span>
    );
  }
  return <AgentBadge name={author.name} label={agentLabel} />;
}

function anchorLabel(anchor: Anchor): string {
  switch (anchor.type) {
    case "text":
      return "Text";
    case "cell":
      return `Cell ${anchor.key}`;
    case "slide":
      return `Slide element ${anchor.elementId}`;
    case "canvas":
      return `Canvas element ${anchor.elementId}`;
    default:
      return "Anchor";
  }
}

function AnchorNote({ state }: { state: Thread["anchorState"] }) {
  if (state.state === "attached") return null;
  const text =
    state.state === "orphaned"
      ? "The anchored content is gone. You can still read and reply."
      : state.state === "edited"
        ? `The text changed since this comment. It now reads: “${state.currentText}”`
        : "The panel cannot tell if the content is still there.";
  return <p className={`agd-comments__state agd-comments__state--${state.state}`}>{text}</p>;
}

function Quote({ anchor }: { anchor: Anchor }) {
  return (
    <figure className="agd-comments__anchor">
      <figcaption className="agd-comments__label">{anchorLabel(anchor)}</figcaption>
      {anchor.type === "text" && <blockquote className="agd-comments__quote">{anchor.text}</blockquote>}
    </figure>
  );
}

function Body({ message }: { message: Message }) {
  return (
    <li className="agd-comments__message">
      <div className="agd-comments__meta">
        <Who author={message.author} agentLabel="Comment by an agent" />
        <time className="agd-comments__time" dateTime={message.at}>
          {stamp(message.at)}
        </time>
        {message.editedAt && <span className="agd-comments__time">edited</span>}
      </div>
      <p className="agd-comments__body">{message.body}</p>
    </li>
  );
}

function changeText(change: unknown): string {
  if (typeof change === "object" && change !== null && "replace" in change && typeof (change as { replace: unknown }).replace === "string") return (change as { replace: string }).replace;
  try {
    return JSON.stringify(change) ?? "";
  } catch {
    return "";
  }
}

const Status = ({ value }: { value: string }) => <span className={`agd-pill agd-comments__status agd-comments__status--${value}`}>{value[0]!.toUpperCase() + value.slice(1)}</span>;

function ThreadCard({ thread }: { thread: Thread }) {
  const { client, docId, me, busy, act } = useCtx();
  const id = useId();
  const [draft, setDraft] = useState("");
  const resolved = thread.status === "resolved";
  const mayComment = holds(me, "comment");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;
    void act(`${thread.id}:reply`, async () => {
      await client.reply(docId, thread.id, { body });
      setDraft("");
    });
  };
  return (
    <li className="agd-comments__thread">
      <article aria-labelledby={`${id}-h`}>
        <header className="agd-comments__item-top">
          <h3 className="agd-comments__item-title" id={`${id}-h`}>
            {anchorLabel(thread.anchor)} <Status value={thread.status} />
          </h3>
          {mayComment && (
            <Button size="sm" loading={busy === `${thread.id}:status`} onClick={() => void act(`${thread.id}:status`, () => (resolved ? client.reopen(docId, thread.id) : client.resolve(docId, thread.id)))}>
              {resolved ? "Reopen" : "Resolve"}
              <span className="agd-sr-only"> thread on {anchorLabel(thread.anchor)}</span>
            </Button>
          )}
        </header>
        <Quote anchor={thread.anchor} />
        <AnchorNote state={thread.anchorState} />
        <ul className="agd-comments__messages" aria-label="Messages">
          {thread.messages.map((m) => (
            <Body key={m.id} message={m} />
          ))}
        </ul>
        {resolved ? (
          <p className="agd-comments__note">Reopen this thread to reply.</p>
        ) : mayComment ? (
          <form className="agd-comments__reply" onSubmit={submit}>
            <Textarea label="Reply" rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={10_000} />
            <Button type="submit" variant="primary" size="sm" loading={busy === `${thread.id}:reply`}>
              Reply
            </Button>
          </form>
        ) : null}
      </article>
    </li>
  );
}

function SuggestionCard({ suggestion }: { suggestion: Suggestion }) {
  const { client, docId, me, busy, act } = useCtx();
  const decision = mayDecide(me, suggestion);
  const usable = suggestion.anchorState.state === "attached";
  const pending = suggestion.status === "pending";
  return (
    <li className="agd-comments__thread">
      <div className="agd-comments__meta">
        <Who author={suggestion.author} agentLabel="Suggested by an agent" />
        <time className="agd-comments__time" dateTime={suggestion.createdAt}>
          {stamp(suggestion.createdAt)}
        </time>
        <Status value={suggestion.status} />
      </div>
      <Quote anchor={suggestion.anchor} />
      {suggestion.summary && <p className="agd-comments__body">{suggestion.summary}</p>}
      <p className="agd-comments__change">
        <span className="agd-comments__label">Proposed change</span>
        <code className="agd-comments__code">{changeText(suggestion.change)}</code>
      </p>
      {pending && <AnchorNote state={suggestion.anchorState} />}
      {suggestion.decidedBy && (
        <p className="agd-comments__note">
          {suggestion.status === "accepted" ? "Accepted" : "Rejected"} by {suggestion.decidedBy.kind === "human" ? "" : "an agent, "}
          {suggestion.decidedBy.name}.
        </p>
      )}
      {pending && decision.allowed && (
        <div className="agd-comments__actions">
          <Button variant="primary" size="sm" loading={busy === `${suggestion.id}:accept`} disabled={!usable} onClick={() => void act(`${suggestion.id}:accept`, () => client.accept(docId, suggestion.id))}>
            Accept<span className="agd-sr-only"> suggestion</span>
          </Button>
          <Button size="sm" loading={busy === `${suggestion.id}:reject`} onClick={() => void act(`${suggestion.id}:reject`, () => client.reject(docId, suggestion.id))}>
            Reject<span className="agd-sr-only"> suggestion</span>
          </Button>
        </div>
      )}
      {pending && decision.allowed && !usable && <p className="agd-comments__note">The anchored text changed or is gone. You can reject this suggestion, and you cannot accept it.</p>}
      {pending && !decision.allowed && decision.reason && <p className="agd-comments__note">{decision.reason}</p>}
    </li>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  const id = useId();
  return (
    <section className="agd-comments__section" aria-labelledby={id}>
      <h2 className="agd-comments__heading" id={id}>
        {title} <span className="agd-comments__count">{count}</span>
      </h2>
      {children}
    </section>
  );
}

/**
 * A threaded comments panel: thread list, reply box, resolve and reopen, the quote each thread points at, an agent or
 * person mark on every message, and accept and reject buttons for suggestions. The buttons follow the product rule: an
 * agent never decides its own suggestion. The server still checks every call, so a hidden button is a help and not a lock.
 * It needs the `agentic-design/styles.css` and `agentic-comments/ui.css` styles on the page.
 */
export function CommentsPanel({ client, docId, title = "Comments", newThread = true }: CommentsPanelProps) {
  const [me, setMe] = useState<Me>();
  const [threads, setThreads] = useState<Thread[]>();
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [view, setView] = useState<View>("open");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [quote, setQuote] = useState("");
  const [body, setBody] = useState("");
  const alive = useRef(true);

  const load = useCallback(async () => {
    const [m, t, s] = await Promise.all([client.me(), client.listThreads(docId), client.listSuggestions(docId)]);
    if (!alive.current) return;
    setMe(m);
    setThreads(t);
    setSuggestions(s);
  }, [client, docId]);

  useEffect(() => {
    alive.current = true;
    setThreads(undefined);
    setError(undefined);
    load().catch((e) => alive.current && setError(failure(e)));
    return () => {
      alive.current = false;
    };
  }, [load]);

  // Run one write, then read again. A failure shows as it is, and the panel never retries with other input.
  const act: Act = async (key, run) => {
    setBusy(key);
    setError(undefined);
    try {
      await run();
      await load();
    } catch (e) {
      if (alive.current) setError(failure(e));
      await load().catch(() => undefined); // show what the server holds now. The error stays.
    } finally {
      if (alive.current) setBusy(undefined);
    }
  };

  const start = (event: FormEvent) => {
    event.preventDefault();
    const q = quote.trim();
    const b = body.trim();
    if (!q || !b) return;
    void act("new", async () => {
      await client.addThread(docId, { anchor: { type: "text", quote: q }, body: b });
      setQuote("");
      setBody("");
    });
  };

  const shown = (threads ?? []).filter((t) => view === "all" || t.status === view);
  const pending = suggestions.filter((s) => s.status === "pending");
  const decided = suggestions.filter((s) => s.status !== "pending");

  return (
    <Ctx.Provider value={{ client, docId, me, busy, act }}>
      <div className="agd-comments">
        <header className="agd-comments__top">
          <h1 className="agd-comments__title">{title}</h1>
          {me && (
            <p className="agd-comments__me">
              Signed in as <Who author={me} agentLabel="Signed in as an agent" />
            </p>
          )}
        </header>
        {error && (
          <p className="agd-comments__error" role="alert">
            {error}
          </p>
        )}
        <p className="agd-sr-only" role="status">
          {threads === undefined && !error ? "Loading comments" : ""}
        </p>
        {newThread && holds(me, "comment") && (
          <form className="agd-comments__new" onSubmit={start}>
            <Input label="Quote to comment on" value={quote} onChange={(e) => setQuote(e.target.value)} hint="Text that occurs once in the document." maxLength={2_000} />
            <Textarea label="Comment" rows={2} value={body} onChange={(e) => setBody(e.target.value)} maxLength={10_000} />
            <Button type="submit" variant="primary" loading={busy === "new"}>
              Add comment
            </Button>
          </form>
        )}
        <Section title="Threads" count={shown.length}>
          <div className="agd-comments__views" role="group" aria-label="Show threads">
            {VIEWS.map((v) => (
              <Button key={v.id} size="sm" variant={view === v.id ? "primary" : "secondary"} aria-pressed={view === v.id} onClick={() => setView(v.id)}>
                {v.label}
              </Button>
            ))}
          </div>
          {threads === undefined ? null : shown.length === 0 ? (
            <p className="agd-comments__empty">{view === "all" ? "No threads yet." : `No ${view} threads.`}</p>
          ) : (
            <ul className="agd-comments__list">
              {shown.map((t) => (
                <ThreadCard key={t.id} thread={t} />
              ))}
            </ul>
          )}
        </Section>
        <Section title="Suggestions" count={pending.length}>
          {suggestions.length === 0 ? (
            <p className="agd-comments__empty">No suggestions.</p>
          ) : (
            <ul className="agd-comments__list">
              {[...pending, ...decided].map((s) => (
                <SuggestionCard key={s.id} suggestion={s} />
              ))}
            </ul>
          )}
        </Section>
      </div>
    </Ctx.Provider>
  );
}
