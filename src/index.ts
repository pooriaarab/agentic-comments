export { VERSION } from "./version.js";
export { Comments, type CommentsOptions, type Message, type NewReply, type NewThread, type Thread, type ThreadFilter } from "./threads.js";
export { textAnchor, textOf, type Anchor, type AnchorKind, type CanvasAnchor, type CellAnchor, type RelativePositionJson, type SlideAnchor, type TextAnchor } from "./anchor.js";
export { Actor, authorLabel, stamp, PRINCIPAL_KINDS, type Author, type PrincipalKind, type StampInput } from "./principal.js";
export { CommentsError, type CommentsErrorCode } from "./errors.js";
export {
  ACCEPT_SCOPE,
  Suggestions,
  type ApplyContext,
  type NewSuggestion,
  type RevertContext,
  type Suggestion,
  type SuggestionFilter,
  type SuggestionHost,
} from "./suggestions.js";
