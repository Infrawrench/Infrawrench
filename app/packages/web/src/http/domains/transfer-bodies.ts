/**
 * Request and response bodies of the file-transfer endpoints (object storage
 * and SFTP uploads and downloads, the Linux app setup stream), read and
 * written the way the Hono routes did.
 *
 * - {@link readFormFields} is `c.req.parseBody()`: a multipart or URL-encoded
 *   body as its fields, the last value of a repeated name winning, and any
 *   other content type as no fields at all (so the route's own "Missing ..."
 *   400 answers it). The body is read from the web request in full, as Hono
 *   read it: no size cap beyond what the session gateway already carries.
 * - {@link webStream} is `Readable.toWeb(stream)`: a pull-driven web body over
 *   a Node stream the handler has already started filling. Each pull only
 *   reads what the scoped work wrote, so it needs no request scope of its own.
 */
import { Effect, Predicate } from "effect";
import { HttpServerRequest } from "effect/http";

export type FormFields = ReadonlyMap<string, FormDataEntryValue>;

const FORM_TYPES = new Set(["multipart/form-data", "application/x-www-form-urlencoded"]);

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

/** A web body over `source`, read as the client reads it. */
export function webStream(source: AsyncIterable<unknown>): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else if (next.value instanceof Uint8Array) controller.enqueue(next.value);
        else controller.enqueue(new TextEncoder().encode(String(next.value)));
      } catch (e) {
        controller.error(e);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}
