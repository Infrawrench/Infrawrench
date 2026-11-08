/**
 * Query parameters, documented as what they mean rather than as their wire
 * encoding.
 *
 * HttpApi decodes a query through the schema's string-tree codec and documents
 * that encoding, so `Schema.Int` in a `query` reads as `type: string` with a
 * numeric `pattern` in the generated operation, where the hand-written spec
 * (and every SDK generated from it) said `integer`. {@link numericQuery} puts
 * the number back:
 *
 * ```ts
 * HttpApiEndpoint.get("shifts", "/:id/shifts", {
 *   query: { count: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 }))) },
 * }).annotate(OpenApi.Transform, numericQuery({ count: { type: "integer", minimum: 1, maximum: 60 } }))
 * ```
 *
 * State the bounds the schema checks, or that the service applies (a limit it
 * clamps): these change what is documented, never what is accepted.
 * {@link enumQuery} is the same for a string parameter whose handler reads a
 * known set of values and treats anything else as the default, so the decoder
 * has to accept any string while the document lists the values.
 */
import { Predicate } from "effect";

export interface NumericQueryParam {
  readonly type: "integer" | "number";
  readonly minimum?: number;
  readonly maximum?: number;
}

type ParamDoc = object;

const restateQuery =
  (params: Readonly<Record<string, ParamDoc>>) =>
  (operation: Record<string, unknown>): Record<string, unknown> => {
    const parameters = operation["parameters"];
    if (!Array.isArray(parameters)) return operation;
    return {
      ...operation,
      parameters: parameters.map((parameter: unknown) => {
        if (!Predicate.isObject(parameter) || parameter["in"] !== "query") return parameter;
        const name = parameter["name"];
        const doc = Predicate.isString(name) ? params[name] : undefined;
        if (!doc) return parameter;
        const schema = Predicate.isObject(parameter["schema"]) ? parameter["schema"] : {};
        const { type: _type, pattern: _pattern, ...rest } = schema;
        return { ...parameter, schema: { ...rest, ...doc } };
      }),
    };
  };

/** An `OpenApi.Transform` restating the named query parameters as numbers. */
export const numericQuery = (params: Readonly<Record<string, NumericQueryParam>>) =>
  restateQuery(params);

/** An `OpenApi.Transform` listing the values the named string query parameters take. */
export const enumQuery = (params: Readonly<Record<string, readonly string[]>>) =>
  restateQuery(
    Object.fromEntries(
      Object.entries(params).map(([name, values]) => [name, { type: "string", enum: values }]),
    ),
  );
