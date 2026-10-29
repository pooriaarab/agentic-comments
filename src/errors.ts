export type CommentsErrorCode =
  | "INVALID_AUTHOR"
  | "INVALID_INPUT"
  | "INVALID_ANCHOR"
  | "NO_THREAD"
  | "THREAD_RESOLVED"
  | "CORRUPT";

export class CommentsError extends Error {
  constructor(
    readonly code: CommentsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CommentsError";
  }
}
