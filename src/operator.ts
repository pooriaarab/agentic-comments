import { CommentsError } from "./errors.js";
import { PRINCIPAL_KINDS, stamp, type Actor, type PrincipalKind } from "./principal.js";

/**
 * Stamp the principal the operator set. `as` is `kind:name`, from a flag the operator wrote or from
 * `AGENTIC_COMMENTS_AS`. Scopes come only from `AGENTIC_COMMENTS_SCOPES`, a comma list. A tool input
 * never reaches this function, so an agent that calls a tool cannot pick its own kind or scopes.
 */
export function operatorActor(as: string | undefined, scopes: string | undefined): Actor {
  const value = as?.trim();
  const cut = value === undefined ? -1 : value.indexOf(":");
  if (value === undefined || cut < 1 || cut === value.length - 1) {
    throw new CommentsError("INVALID_AUTHOR", `set the principal as kind:name, for example human:ada. Kinds: ${PRINCIPAL_KINDS.join(", ")}`);
  }
  const list = scopes === undefined || scopes.trim() === "" ? [] : scopes.split(",").map((s) => s.trim());
  return stamp({ kind: value.slice(0, cut) as PrincipalKind, name: value.slice(cut + 1), scopes: list });
}
