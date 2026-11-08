/**
 * How a handler answers a service whose refusal classes carry their own HTTP
 * status (`WorkflowError`, `DeploymentError`, `AiAttributionInputError`, ...).
 *
 * Their Hono routes caught such an error with a `fail(c, e)` that answered
 * `{ error: e.message }` with the status it carries and **rethrew anything
 * else** to the error renderer (a 500 with a correlation id). That last part
 * is what sets {@link statusCall} apart from `refusalCall` and `storeCall`,
 * which turn an unknown error into a route-specific 500 sentence: here it
 * stays the original defect, rendered exactly as before.
 *
 * A status the endpoint declares becomes its typed error; any other is sent
 * as-is, so the wire body is the same whichever the endpoint documents.
 */
import { Effect } from "effect";
import { BadRequest, Conflict, HttpFailure, NotFound, PaymentRequired } from "../errors";
import { legacyTry } from "../legacy";
import type { Refusals } from "./input-refusals";

/** A service refusal, read off a thrown error: its status and its sentence. */
export interface StatusRefusal {
  readonly status: number;
  readonly message: string;
}

/** Recognise the service's refusals; `undefined` for anything else. */
export type ReadRefusal = (error: unknown) => StatusRefusal | undefined;

export const statusCall = <A, E>(
  read: ReadRefusal,
  refusals: Refusals<E>,
  fn: () => PromiseLike<A>,
): Effect.Effect<A, E> =>
  legacyTry(fn, (error) => {
    const refusal = read(error);
    return refusal ? refusals[refusal.status]?.(refusal.message) : undefined;
  }).pipe(
    Effect.catchDefect((defect) => {
      const refusal = read(defect);
      return Effect.die(
        refusal ? new HttpFailure(refusal.status, { error: refusal.message }) : defect,
      );
    }),
  );

/** The declared error for each status these services refuse with. */
export const refuse = {
  400: (error: string) => new BadRequest({ error }),
  402: (error: string) => new PaymentRequired({ error }),
  404: (error: string) => new NotFound({ error }),
  409: (error: string) => new Conflict({ error }),
} as const;
