/**
 * Answering a service's refusals the way the Hono routes did.
 *
 * Many services refuse with an error that carries its own HTTP status
 * (`ProbeInputError`, `WorkflowError`, `LeaseInputError`, ...), and their
 * routes answered it as `c.json({ error: err.message }, err.status)`. What the
 * routes did with *anything else* varied, and is the one choice a caller makes:
 *
 * - most rethrew it to the error renderer (a 500 with a correlation id);
 * - the routes that wrapped each write in `try`/`catch` logged it and answered
 *   `500 { error: "<X> operation failed" }`, their own sentence.
 *
 * {@link refusalCall} runs promise code through `legacyTry` with that choice
 * as its {@link RefusalPolicy}: a refusal whose status the endpoint declares
 * is the endpoint's typed error, one it does not declare is sent as-is (so the
 * wire body is the same whichever the endpoint documents), and anything else
 * is the original defect or the route's own 500, as the policy says.
 */
import { Effect } from "effect";
import { BadRequest, Conflict, HttpFailure, NotFound, PaymentRequired } from "./errors";
import { legacyTry } from "./legacy";

/** A service refusal, read off a thrown error: its status and its sentence. */
export interface StatusRefusal {
  readonly status: number;
  readonly message: string;
}

/** Recognise the service's refusals; `undefined` for anything else. */
export type ReadRefusal = (error: unknown) => StatusRefusal | undefined;

/** The endpoint's declared error for each status it documents. */
export type Refusals<E> = { readonly [status: number]: ((error: string) => E) | undefined };

/** The declared error for each status these services refuse with. */
export const refuse = {
  400: (error: string) => new BadRequest({ error }),
  402: (error: string) => new PaymentRequired({ error }),
  404: (error: string) => new NotFound({ error }),
  409: (error: string) => new Conflict({ error }),
} as const;

/** The statuses a store's input error carries (400, 404, 409), each as its declared error. */
export const inputRefusals = { 400: refuse[400], 404: refuse[404], 409: refuse[409] } as const;

/**
 * A store's input error (`OnCallInputError`, `InvoiceError`, ...) as the
 * declared error its status names, for a `legacyTry` mapper.
 */
export const inputRefusal = (error: {
  readonly status: 400 | 404 | 409;
  readonly message: string;
}): BadRequest | NotFound | Conflict => inputRefusals[error.status](error.message);

/** The route's own 500, for anything that is not a refusal. */
export interface UnexpectedFailure {
  /** Prefix of the `console.error` line, e.g. `[probes]`. */
  readonly logPrefix: string;
  /** The 500's `error`, e.g. `Probe operation failed`. */
  readonly failure: string;
}

/**
 * How a service's errors are answered: {@link read} recognises its refusals,
 * and {@link unexpected}, when set, is the logged 500 for anything else
 * (unset, anything else stays the original defect).
 */
export interface RefusalPolicy {
  readonly read: ReadRefusal;
  readonly unexpected?: UnexpectedFailure | undefined;
}

/**
 * The policy for a refusal class whose instances carry `status` and
 * `message`: `refusalsOf(ProbeInputError, { logPrefix, failure })`.
 */
export const refusalsOf = (
  refusal: abstract new (...args: never) => StatusRefusal,
  unexpected?: UnexpectedFailure,
): RefusalPolicy => ({
  read: (error) => (error instanceof refusal ? error : undefined),
  unexpected,
});

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

/**
 * Call promise code from a handler, answering the service's refusals as
 * `policy` says (a bare {@link ReadRefusal} is a policy with no route 500).
 */
export const refusalCall = <A, E>(
  policy: RefusalPolicy | ReadRefusal,
  refusals: Refusals<E>,
  fn: () => PromiseLike<A>,
): Effect.Effect<A, E> => {
  const { read, unexpected }: RefusalPolicy =
    typeof policy === "function" ? { read: policy } : policy;
  return legacyTry(fn, (error) => {
    const refusal = read(error);
    return refusal ? refusals[refusal.status]?.(refusal.message) : undefined;
  }).pipe(
    Effect.catchDefect((defect) => {
      const refusal = read(defect);
      if (refusal) return Effect.die(new HttpFailure(refusal.status, { error: refusal.message }));
      if (unexpected === undefined) return Effect.die(defect);
      console.error(`${unexpected.logPrefix} unexpected error:`, defect);
      return Effect.die(new HttpFailure(500, { error: unexpected.failure }));
    }),
  );
};
