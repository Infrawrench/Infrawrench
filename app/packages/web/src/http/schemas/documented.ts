/**
 * Values a handler reads as they arrived, documented as what clients send.
 *
 * Some routes never validated an input against the type their spec stated:
 * they read the raw query string and parsed it themselves (`parseInt(page)`,
 * `c.req.query("mine") === "1"`), answering with their own sentences, or
 * accepted strings the documented enum does not list (permission wildcards).
 * Decoding those inputs against the documented schema would change which
 * requests succeed, so they are declared here as the raw value, with the
 * documented schema attached for the OpenAPI document only.
 *
 * ```ts
 * query: { page: Schema.optionalKey(documentedAs(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)))) }
 * ```
 */
import { Predicate, Schema } from "effect";

/**
 * A string, read as-is, that the document describes as `doc`. The handler
 * keeps whatever parsing and refusals it always had.
 */
export const documentedAs = <S extends Schema.Top>(doc: S) =>
  Schema.Any.pipe(
    Schema.refine(Predicate.isString, {
      // The id names the check for persisted representations; nothing here persists one.
      representation: { id: "infrawrench/documentedAs", payload: null, schemas: [doc.ast] },
      toJsonSchema: ({ schemas }) => schemas[0] ?? {},
    }),
  );

/**
 * An `OpenApi.Transform` dropping `required: true` from the request body, for
 * endpoints whose spec never marked the body required (HttpApi always does).
 */
export const optionalRequestBody = (
  operation: Record<string, unknown>,
): Record<string, unknown> => {
  const body = operation["requestBody"];
  if (!Predicate.isObject(body)) return operation;
  const { required: _required, ...rest } = body;
  return { ...operation, requestBody: rest };
};

/**
 * An `OpenApi.Transform` marking query parameters required in the document,
 * for parameters declared `optionalKey(documentedAs(...))` so that a missing
 * one still reaches the handler's own 400 ("resourceId is required").
 */
export const requiredQuery =
  (names: readonly string[]) =>
  (operation: Record<string, unknown>): Record<string, unknown> => {
    const parameters = operation["parameters"];
    if (!Array.isArray(parameters)) return operation;
    return {
      ...operation,
      parameters: parameters.map((parameter: unknown) =>
        Predicate.isObject(parameter) &&
        parameter["in"] === "query" &&
        Predicate.isString(parameter["name"]) &&
        names.includes(parameter["name"])
          ? { ...parameter, required: true }
          : parameter,
      ),
    };
  };

/**
 * An `OpenApi.Transform` setting one response's description, for an endpoint
 * whose old spec worded a status its own way ("A live savings view already
 * uses this name."). The status default comes from the spec builder.
 */
export const describeResponse =
  (status: number, description: string) =>
  (operation: Record<string, unknown>): Record<string, unknown> => {
    const responses = operation["responses"];
    if (!Predicate.isObject(responses)) return operation;
    const response = (responses as Record<string, unknown>)[String(status)];
    if (!Predicate.isObject(response)) return operation;
    return {
      ...operation,
      responses: { ...responses, [String(status)]: { ...response, description } },
    };
  };
