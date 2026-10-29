import { PRINCIPAL_KINDS, type PrincipalKind } from "agentic-identity";
import { CommentsError } from "./errors.js";
import { HIDDEN, VARIATION } from "./text.js";

export { PRINCIPAL_KINDS, type PrincipalKind };

/** What a thread keeps about who wrote a message. Scopes never reach storage. */
export interface Author {
  kind: PrincipalKind;
  name: string;
}

export interface StampInput {
  kind: PrincipalKind;
  name: string;
  /** Rights the host granted this principal, such as `comments:accept`. Used to decide, never stored. */
  scopes?: string[];
}

const MAX_NAME = 128;

const issued = new WeakSet<object>();

/**
 * The only author a write accepts. The host makes one from the principal it authenticated, and an
 * operation never reads an author from its input. An object that `stamp()` did not make is refused,
 * and a stamped one cannot change.
 */
export class Actor implements Author {
  readonly kind: PrincipalKind;
  readonly name: string;
  readonly scopes: readonly string[];

  private constructor(kind: PrincipalKind, name: string, scopes: readonly string[]) {
    this.kind = kind;
    this.name = name;
    this.scopes = Object.freeze([...scopes]);
    Object.freeze(this);
  }

  static of(input: StampInput): Actor {
    const author = readAuthor(input);
    const given = author ? (input as { scopes?: unknown }).scopes : undefined;
    const scopes = given === undefined ? [] : Array.isArray(given) ? Array.from(given as unknown[]) : undefined;
    if (!author || !scopes || !scopes.every((s) => typeof s === "string" && s !== "")) {
      throw new CommentsError("INVALID_AUTHOR", `an author needs a kind (${PRINCIPAL_KINDS.join(", ")}), a name, and scopes that are a list of text`);
    }
    const actor = new Actor(author.kind, author.name, scopes as string[]);
    issued.add(actor);
    return actor;
  }

  static is(value: unknown): value is Actor {
    return typeof value === "object" && value !== null && issued.has(value);
  }
}

/** Make the author for one authenticated principal. Throws when the kind or name is missing or wrong. */
export const stamp = (input: StampInput): Actor => Actor.of(input);

export function assertActor(value: unknown): Actor {
  if (!Actor.is(value) || !readAuthor(value)) throw new CommentsError("INVALID_AUTHOR", "the host must pass an author made with stamp()");
  return value;
}

/** Check an author read from storage or input. Returns a clean copy, or undefined. */
export function readAuthor(value: unknown): Author | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { kind, name } = value as { kind?: unknown; name?: unknown };
  if (!PRINCIPAL_KINDS.includes(kind as PrincipalKind)) return undefined;
  if (typeof name !== "string" || name === "" || name !== name.trim() || name.length > MAX_NAME || HIDDEN.test(name) || VARIATION.test(name) || name !== name.normalize("NFC")) return undefined;
  return { kind: kind as PrincipalKind, name };
}

/** The label a UI shows. Agent work stays marked as machine-made. */
export function authorLabel(author: Author): "person" | "person via agent" | "agent" {
  return author.kind === "human" ? "person" : author.kind === "user_token" ? "person via agent" : "agent";
}
