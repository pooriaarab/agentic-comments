export type CommentsErrorCode =
  | "INVALID_AUTHOR"
  | "INVALID_INPUT"
  | "INVALID_ANCHOR"
  | "NO_THREAD"
  | "THREAD_RESOLVED"
  | "CORRUPT"
  | "NO_SUGGESTION"
  | "FORBIDDEN"
  | "ALREADY_DECIDED"
  | "APPLY_FAILED"
  | "RELOCATE_FAILED"
  | "STORE_MISSING"
  | "STORE_EXISTS"
  | "STORE_CORRUPT"
  | "STORE_LOCKED"
  | "STORE_FULL"
  | "USAGE";

export class CommentsError extends Error {
  constructor(
    readonly code: CommentsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CommentsError";
  }
}
