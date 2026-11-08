/**
 * Errors several RPC groups share, and the one way the main process turns a
 * thrown value into the sentence an error carries.
 */
import { Predicate, Schema } from "effect";

/**
 * A local-mode scan could not read the workspace: the SQLite database or the
 * plugin metadata it runs over. The message is what the panel shows.
 */
export class LocalWorkspaceError extends Schema.TaggedError<LocalWorkspaceError>()(
  "LocalWorkspaceError",
  { message: Schema.String },
) {
  /** For `Effect.tryPromise({ try, catch: LocalWorkspaceError.fromCause })`. */
  static fromCause(cause: unknown): LocalWorkspaceError {
    return new LocalWorkspaceError({ message: errorMessage(cause) });
  }
}

/** The message of a thrown `Error`, or the thrown value as a string. */
export function errorMessage(cause: unknown): string {
  return Predicate.isError(cause) ? cause.message : String(cause);
}
