/**
 * One error class for everything this package rejects, so a caller can tell
 * malformed input (answer the client, drop the pack) from a bug.
 */
export type GitErrorCode =
  | "bad-object"
  | "bad-pack"
  | "bad-index"
  | "bad-delta"
  | "bad-zlib"
  | "bad-pkt-line"
  | "bad-ref"
  | "missing-object"
  | "limit";

export class GitError extends Error {
  readonly code: GitErrorCode;

  constructor(code: GitErrorCode, message: string) {
    super(message);
    this.name = "GitError";
    this.code = code;
  }
}
