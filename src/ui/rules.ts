import type { Me } from "../client.js";
import type { Suggestion } from "../suggestions.js";

// A local list keeps the UI free of the identity package. The scope order is the one the Worker uses.
const LEVELS = ["comments:read", "comments:comment", "comments:write", "comments:admin"] as const;
const level = (scopes: readonly string[]): number => Math.max(-1, ...scopes.map((s) => LEVELS.indexOf(s as (typeof LEVELS)[number])));

export type Need = "read" | "comment" | "write";

/** Whether the principal holds a scope at least as strong as `need`. */
export function holds(me: Pick<Me, "scopes"> | undefined, need: Need): boolean {
  return me !== undefined && level(me.scopes) >= LEVELS.indexOf(`comments:${need}`);
}

export interface Decision {
  allowed: boolean;
  /** Plain words that say why not. Set when `allowed` is false. */
  reason?: string;
}

/**
 * Whether the signed-in principal may accept a suggestion, and whether it may reject one. The Worker checks the
 * same rule, so this only decides what the page offers. A person may decide any suggestion. An agent needs the
 * `comments:admin` scope or the `comments:accept` right, and never decides its own suggestion.
 */
export function mayDecide(me: Me | undefined, suggestion: Pick<Suggestion, "author" | "status">): Decision {
  if (suggestion.status !== "pending") return { allowed: false };
  if (!me) return { allowed: false, reason: "Sign in to decide this suggestion." };
  const agent = me.kind !== "human";
  // A person needs the write scope. An agent needs the admin scope or the accept right, which stand for write and more.
  if (agent ? level(me.scopes) < LEVELS.indexOf("comments:admin") && !me.scopes.includes("comments:accept") : !holds(me, "write")) {
    return { allowed: false, reason: agent ? "An agent needs the accept right to decide a suggestion. A person can." : "Your access cannot accept or reject suggestions." };
  }
  const { author } = suggestion;
  if (agent && author.kind !== "human" && author.name === me.name) {
    return { allowed: false, reason: "An agent cannot accept or reject its own suggestion. A person or another agent decides." };
  }
  return { allowed: true };
}
