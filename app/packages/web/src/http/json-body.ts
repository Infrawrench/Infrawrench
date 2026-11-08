/**
 * JSON bodies read the way the Hono handlers read them, for endpoints served
 * with `handleRaw` (see `./object-body.ts` for the ones that wanted an object).
 *
 * - {@link readJson} is `await c.req.json()`: a body that is not JSON was an
 *   uncaught `SyntaxError`, the 500 the error renderer still sends.
 * - {@link readJsonOr} is `await c.req.json().catch(() => fallback)`, which the
 *   Zod-validated routes used so a missing body reached their validator.
 * - {@link fieldsOf} is the destructuring those handlers did on the result.
 * - {@link decodeFirstIssue} answers a refused body with the first issue's
 *   message as `{ error }`, as `schema.safeParse(...)` routes did.
 * - {@link decodeAsPayload} answers it as the endpoint's own payload 400,
 *   `{ error: InvalidRequestMessage, issues }`, for a body read with
 *   {@link readJsonOr} because an absent one meant "use the defaults".
 */
import { Effect, Predicate, Schema, SchemaIssue } from "effect";
import type { HttpServerRequest } from "effect/http";
import { HttpApiError } from "effect/http-api";
import { BadRequest } from "./errors";

const parseJson = (text: string): unknown => JSON.parse(text);

/** A body that is not JSON, carrying the parser's own error. */
class InvalidJson extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "SyntaxError";
  }
}

/** The body parsed as JSON; a body that is not JSON is a defect (a 500). */
export const readJson = (request: HttpServerRequest.HttpServerRequest): Effect.Effect<unknown> =>
  request.text.pipe(
    Effect.orDie,
    Effect.flatMap((text) =>
      Effect.try({ try: () => parseJson(text), catch: (e) => new InvalidJson(e) }),
    ),
    Effect.orDie,
  );

/** The body parsed as JSON, or `fallback` when it is absent or not JSON. */
export const readJsonOr = (
  request: HttpServerRequest.HttpServerRequest,
  fallback: unknown,
): Effect.Effect<unknown> =>
  request.text.pipe(
    Effect.flatMap((text) =>
      Effect.try({ try: () => parseJson(text), catch: (e) => new InvalidJson(e) }),
    ),
    Effect.orElseSucceed(() => fallback),
  );

/**
 * The properties of a parsed body, as `const { a, b } = await c.req.json()`
 * saw them: a JSON `null` threw (a 500), any other non-object has none.
 */
export const fieldsOf = (body: unknown): Effect.Effect<{ readonly [key: string]: unknown }> => {
  if (body === null) {
    return Effect.die(new TypeError("Cannot destructure a null request body"));
  }
  return Effect.succeed(Predicate.isObject(body) ? body : {});
};

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * Decode `value` against `schema`, refusing unknown keys at every level (Zod's
 * `.strict()`), and answer a refusal with the first issue's message.
 */
export const decodeFirstIssue = <S extends Schema.Decoder<unknown>>(
  schema: S,
  value: unknown,
): Effect.Effect<S["Type"], BadRequest, S["DecodingServices"]> =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      (error) =>
        new BadRequest({
          error: formatIssues(error.issue).issues[0]?.message ?? "Invalid body",
        }),
    ),
  );

/**
 * Decode `value` against `schema` as if HttpApi had decoded it as the
 * payload: a refusal is the 400 the error renderer sends for any payload that
 * fails its schema, with the endpoint's `InvalidRequestMessage` and every
 * issue. For `readJsonOr` bodies, where HttpApi's own decoding would refuse
 * the empty or unreadable body the route always took as `{}`.
 */
export const decodeAsPayload = <S extends Schema.Decoder<unknown>>(
  schema: S,
  value: unknown,
): Effect.Effect<S["Type"], never, S["DecodingServices"]> =>
  Schema.decodeUnknownEffect(schema)(value, { errors: "all" }).pipe(
    Effect.mapError((cause) => new HttpApiError.HttpApiSchemaError({ kind: "Payload", cause })),
    // The renderer answers a schema error raised as a defect as it does a typed one.
    Effect.orDie,
  );

/**
 * `body.field?.trim()` on a destructured body field, as the Hono handlers
 * wrote it: `undefined` for an absent or null field, the trimmed string, or,
 * for any other JSON value, the `TypeError` (a 500) the handler threw.
 */
export const trimmedField = (value: unknown, name: string): Effect.Effect<string | undefined> => {
  if (typeof value === "string" || value === undefined || value === null) {
    return Effect.succeed(typeof value === "string" ? value.trim() : undefined);
  }
  return Effect.die(new TypeError(`body.${name}?.trim is not a function`));
};
