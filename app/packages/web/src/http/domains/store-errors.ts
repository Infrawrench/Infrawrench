/**
 * How the converted service-catalog domains (probes, SLOs, services,
 * scorecards, DORA) answer a store call that throws.
 *
 * Their Hono handlers wrapped each write in `try`/`catch`: the store's input
 * error became `{ error: err.message }` with the status it carries, and
 * anything else was logged and answered `500 { error: "<X> operation failed" }`.
 * {@link storeCall} keeps both answers byte for byte.
 */
import { Effect } from "effect";
import { BadRequest, Conflict, HttpFailure, NotFound } from "../errors";
import { legacyTry } from "../legacy";
import { inputRefusal } from "../object-body";

export interface UnexpectedFailure {
  /** Prefix of the `console.error` line, e.g. `[probes]`. */
  readonly logPrefix: string;
  /** The 500's `error`, e.g. `Probe operation failed`. */
  readonly failure: string;
}

/**
 * A defect (anything the call did not refuse with a typed error) logged and
 * answered as the route's own 500, the way its `catch` block did.
 */
export const unexpectedAs =
  (options: UnexpectedFailure) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(
      Effect.catchDefect((defect) => {
        console.error(`${options.logPrefix} unexpected error:`, defect);
        return Effect.die(new HttpFailure(500, { error: options.failure }));
      }),
    );

interface StoreInputError {
  readonly status: 400 | 404 | 409;
  readonly message: string;
}

export interface StoreCallOptions<I extends StoreInputError> extends UnexpectedFailure {
  /** The store's own refusal class, e.g. `ProbeInputError`. */
  readonly isInputError: (error: unknown) => error is I;
}

/**
 * Run promise code from a handler the way the route's `try` block did: an
 * input error is the typed refusal its status names, anything else a logged
 * 500 with the route's own sentence.
 */
export const storeCall = <A, I extends StoreInputError>(
  options: StoreCallOptions<I>,
  fn: () => PromiseLike<A>,
): Effect.Effect<A, BadRequest | NotFound | Conflict> =>
  legacyTry(fn, (error) => (options.isInputError(error) ? inputRefusal(error) : undefined)).pipe(
    unexpectedAs(options),
  );
