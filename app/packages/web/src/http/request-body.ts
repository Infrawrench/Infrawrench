/**
 * Request bodies read the way the Hono handlers read them, for endpoints
 * served with `handleRaw` (whose declared `payload` documents the body and is
 * never decoded).
 *
 * Reading:
 * - {@link readJson} is `await c.req.json()`: a body that is not JSON was an
 *   uncaught `SyntaxError`, the 500 the error renderer still sends.
 * - {@link readJsonOr} is `await c.req.json().catch(() => fallback)`, which the
 *   validated routes used so a missing body reached their validator.
 * - {@link readObjectBody} is a body that must be a JSON object, refused with
 *   its own two sentences, for the endpoints whose 400s have always named the
 *   field at fault ("rotationDays must be a whole number"): the handler checks
 *   each field itself and refuses with `badRequest`.
 * - {@link fieldsOf} is the destructuring handlers did on a parsed body, and
 *   {@link trimmedField} the `body.field?.trim()` on one of its fields.
 * - {@link readFormFields} is `c.req.parseBody()`, with {@link formString} and
 *   {@link formFile} for its fields.
 *
 * Judging:
 * - {@link decodeFirstIssue} is a zod `safeParse` route: strict (unknown keys
 *   refused at every level) and refused with the first issue's sentence,
 *   worded as zod worded it, as `{ error }`.
 * - {@link decodeAsPayload} answers a refusal as the endpoint's own payload
 *   400, `{ error: InvalidRequestMessage, issues }`, for a body read with
 *   {@link readJsonOr} because an absent one meant "use the defaults".
 */
import { Effect, Predicate, Schema } from "effect";
import { HttpServerRequest } from "effect/http";
import { HttpApiError } from "effect/http-api";
import { decodeForm, STRICT_PARSE_OPTIONS } from "@infrawrench/api-contract/schemas";
import { BadRequest } from "@infrawrench/api-contract";

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

export type ObjectBody =
  | { readonly ok: true; readonly body: { readonly [key: string]: unknown } }
  | { readonly ok: false; readonly error: string };

/**
 * The body as a JSON object. Discriminated on `ok` rather than on an `error`
 * key, because `{"error": "..."}` is a perfectly legal request body.
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

/**
 * Decode `body` against `schema` as a zod `safeParse` route did: unknown keys
 * refused at every level (zod's `.strict()`), and a refusal answered with the
 * first issue's sentence in zod's words (`decodeForm`).
 */
export const decodeFirstIssue = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  body: unknown,
): Effect.Effect<S["Type"], BadRequest> => {
  const result = decodeForm(schema, body, STRICT_PARSE_OPTIONS);
  return result.success
    ? Effect.succeed(result.data)
    : Effect.fail(new BadRequest({ error: result.message }));
};

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

export type FormFields = ReadonlyMap<string, FormDataEntryValue>;

const FORM_TYPES = new Set(["multipart/form-data", "application/x-www-form-urlencoded"]);

/**
 * A multipart or URL-encoded body as its fields, the last value of a repeated
 * name winning, and any other content type as no fields at all (so the
 * route's own "Missing ..." 400 answers it). The body is read from the web
 * request in full, as Hono read it: no size cap beyond what the session
 * gateway already carries.
 */
export const readFormFields = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<FormFields> =>
  Effect.gen(function* () {
    const mediaType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType === undefined || !FORM_TYPES.has(mediaType)) return new Map();
    const web = yield* Effect.orDie(HttpServerRequest.toWeb(request));
    // A body that does not parse as the form it claims to be was a 500.
    const form = yield* Effect.promise(() => web.formData());
    const fields = new Map<string, FormDataEntryValue>();
    form.forEach((value, key) => fields.set(key, value));
    return fields;
  });

/** A text field, or undefined when absent or a file. */
export const formString = (fields: FormFields, name: string): string | undefined => {
  const value = fields.get(name);
  return Predicate.isString(value) ? value : undefined;
};

/** A file field, or undefined when absent or plain text. */
export const formFile = (fields: FormFields, name: string): File | undefined => {
  const value = fields.get(name);
  return value instanceof File ? value : undefined;
};
