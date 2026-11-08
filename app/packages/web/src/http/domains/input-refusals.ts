/**
 * How the leases, schedules and environments domains answer a store call
 * that throws, where each endpoint documents its own subset of the statuses
 * the store's input error can carry (and some name their 409 body, such as
 * `LeaseConflict`).
 *
 * Their Hono handlers wrapped each write in `try`/`catch`: the store's input
 * error became `{ error: err.message }` with the status it carries, and
 * anything else was logged and answered `500 { error: "<X> operation failed" }`.
 * {@link refusalCall} keeps both answers byte for byte: a status the endpoint
 * declares is its typed error, any other is sent as-is.
 */
import { Effect } from "effect";
import { HttpFailure } from "../errors";
import { legacyTry } from "../legacy";

interface StoreInputError {
  readonly status: number;
  readonly message: string;
}

export interface RefusalCallOptions<I extends StoreInputError> {
  /** The store's own refusal class, e.g. `LeaseInputError`. */
  readonly isInputError: (error: unknown) => error is I;
  /** Prefix of the `console.error` line for anything else, e.g. `[leases]`. */
  readonly logPrefix: string;
  /** The 500's `error`, e.g. `Lease operation failed`. */
  readonly failure: string;
}

/** The endpoint's declared error for each status it documents. */
export type Refusals<E> = { readonly [status: number]: ((error: string) => E) | undefined };

export const refusalCall = <A, I extends StoreInputError, E>(
  options: RefusalCallOptions<I>,
  refusals: Refusals<E>,
  fn: () => PromiseLike<A>,
): Effect.Effect<A, E> =>
  legacyTry(fn, (error) =>
    options.isInputError(error) ? refusals[error.status]?.(error.message) : undefined,
  ).pipe(
    Effect.catchDefect((defect) => {
      if (options.isInputError(defect)) {
        return Effect.die(new HttpFailure(defect.status, { error: defect.message }));
      }
      console.error(`${options.logPrefix} unexpected error:`, defect);
      return Effect.die(new HttpFailure(500, { error: options.failure }));
    }),
  );
