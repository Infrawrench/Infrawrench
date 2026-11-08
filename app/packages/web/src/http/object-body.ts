/**
 * Hand-validated JSON bodies, for the endpoints whose 400s have always named
 * the field at fault ("rotationDays must be a whole number") rather than the
 * `{ error, issues }` the schema renderer sends.
 *
 * Those endpoints declare their documented `payload` and are served with
 * `handleRaw`, so the body is not decoded for them; the handler reads it with
 * {@link readObjectBody} and checks each field itself, exactly as the Hono
 * handler did, and the wire answers stay sentence for sentence.
 */
import { Effect, Predicate } from "effect";
import type { HttpServerRequest } from "effect/http";
import { BadRequest, Conflict, NotFound } from "./errors";

export type ObjectBody =
  | { readonly ok: true; readonly body: { readonly [key: string]: unknown } }
  | { readonly ok: false; readonly error: string };

/**
 * The body as a JSON object. Discriminated on `ok` rather than on an `error`
 * key, because `{"error": "..."}` is a perfectly legal request body. The
 * sentences are `api/object-body.ts`'s, which the Hono routes still use.
 */
export const readObjectBody = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<ObjectBody> =>
  request.json.pipe(
    Effect.map((parsed): ObjectBody =>
      Predicate.isObject(parsed) && !Array.isArray(parsed)
        ? { ok: true, body: parsed }
        : { ok: false, error: "Request body must be an object" },
    ),
    Effect.orElseSucceed((): ObjectBody => ({ ok: false, error: "Invalid JSON body" })),
  );

/** The 400 a hand check refuses a body with. */
export const invalidBody = (error: string) => new BadRequest({ error });

/**
 * A store's input error (`OnCallInputError`, `RunbookInputError`, ...) as the
 * status it carries: the routes answered `c.json({ error: err.message }, err.status)`.
 */
export const inputRefusal = (error: {
  readonly status: 400 | 404 | 409;
  readonly message: string;
}): BadRequest | NotFound | Conflict => {
  switch (error.status) {
    case 404:
      return new NotFound({ error: error.message });
    case 409:
      return new Conflict({ error: error.message });
    default:
      return new BadRequest({ error: error.message });
  }
};
