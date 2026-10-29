import { CommentsError } from "./errors.js";

export const PRINCIPAL_KINDS = ["human", "agent_of_human", "agent_of_agent", "agent", "user_token"] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

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

/**
 * The only author a write accepts. The host makes one from the principal it authenticated, and an
 * operation never reads an author from its input. Nobody can build an Actor with a literal or
 * change one after it exists.
 */
export class Actor implements Author {
  readonly kind: PrincipalKind;
  readonly name: string;
  readonly scopes: readonly string[];
  #stamped = true;

  private constructor(kind: PrincipalKind, name: string, scopes: readonly string[]) {
    this.kind = kind;
    this.name = name;
    this.scopes = Object.freeze([...scopes]);
    Object.freeze(this);
  }

  static of(input: StampInput): Actor {
    const scopes = (input as { scopes?: unknown } | null)?.scopes;
    const ok =
      readAuthor(input) !== undefined &&
      (scopes === undefined || (Array.isArray(scopes) && scopes.every((s) => typeof s === "string" && s !== "")));
    if (!ok) {
      throw new CommentsError("INVALID_AUTHOR", `an author needs a kind (${PRINCIPAL_KINDS.join(", ")}), a name, and scopes that are a list of text`);
    }
    return new Actor(input.kind, input.name, input.scopes ?? []);
  }

  static is(value: unknown): value is Actor {
    return typeof value === "object" && value !== null && #stamped in value;
  }
}

/** Make the author for one authenticated principal. Throws when the kind or name is missing or wrong. */
export const stamp = (input: StampInput): Actor => Actor.of(input);

export function assertActor(value: unknown): Actor {
  if (!Actor.is(value)) throw new CommentsError("INVALID_AUTHOR", "the host must pass an author made with stamp()");
  return value;
}

/** Check an author read from storage or input. Returns a clean copy, or undefined. */
export function readAuthor(value: unknown): Author | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { kind, name } = value as { kind?: unknown; name?: unknown };
  if (!PRINCIPAL_KINDS.includes(kind as PrincipalKind)) return undefined;
  if (typeof name !== "string" || name.trim() === "" || name.length > MAX_NAME) return undefined;
  return { kind: kind as PrincipalKind, name };
}

/** The label a UI shows. Agent work stays marked as machine-made. */
export function authorLabel(author: Author): "person" | "person via agent" | "agent" {
  return author.kind === "human" ? "person" : author.kind === "user_token" ? "person via agent" : "agent";
}
