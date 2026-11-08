/**
 * Sending what a legacy service returned as an endpoint's success body.
 *
 * HttpApi encodes a handler's success value through the endpoint's schema,
 * and Effect's encoder drops every property the schema does not list. The
 * hand-written spec these schemas come from was never checked against the
 * routes, so a field it forgot (and some client reads) would silently vanish.
 * Until each schema has been proven complete, existing endpoints send the
 * service's value exactly as `c.json(value)` did, through {@link respond}:
 *
 * - the body is the value, untouched (`JSON.stringify` semantics, so a `Date`
 *   is an ISO string, as before);
 * - under test, the value is also decoded against the documented schema, and a
 *   present field of the wrong type fails the request, so a route test is a
 *   spec test too (a missing field is a partial fixture, not drift, and passes);
 * - elsewhere a mismatch is logged once per endpoint and issue, and sent anyway.
 *
 * A handler whose service returns exactly the schema's type can return the
 * value itself instead and get the encoding.
 */
import { Effect, Schema, SchemaIssue } from "effect";
import { HttpServerResponse } from "effect/http";

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();
const reported = new Set<string>();

const strictMode = () => process.env["NODE_ENV"] === "test" || process.env["VITEST"] !== undefined;

/** True when every problem in `issue` is a key the value lacks. */
function onlyMissingKeys(issue: SchemaIssue.Issue): boolean {
  switch (issue._tag) {
    case "MissingKey":
      return true;
    case "Pointer":
      return onlyMissingKeys(issue.issue);
    case "Composite":
      return issue.issues.every(onlyMissingKeys);
    // A union (`NullOr(Struct)`, ...) fits when one member would have, so the
    // fixture is partial rather than wrong when any member's issue is.
    case "AnyOf":
      return issue.issues.some(onlyMissingKeys);
    default:
      return false;
  }
}

/** Send `value` as the 200 (or `status`) body, checking it against `schema` as above. */
export const respond =
  <S extends Schema.Top>(schema: S, options?: { readonly status?: number }) =>
  (
    value: unknown,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse, never, S["DecodingServices"]> =>
    Effect.gen(function* () {
      // What the client receives is `JSON.stringify(value)`, so that is what is
      // checked: the wire JSON against the schema's JSON form.
      const wire: unknown = JSON.parse(JSON.stringify(value) ?? "null");
      const result = yield* Effect.result(
        Schema.decodeUnknownEffect(Schema.toCodecJson(schema))(wire, { errors: "all" }),
      );
      if (result._tag === "Failure") {
        const issues = formatIssue(result.failure.issue).issues;
        const summary = issues
          .map((i) => `${i.path?.map(String).join(".") ?? ""}: ${i.message}`)
          .join("; ");
        if (strictMode() && !onlyMissingKeys(result.failure.issue)) {
          return yield* Effect.die(new Error(`Response does not match its schema: ${summary}`));
        }
        if (strictMode())
          return HttpServerResponse.jsonUnsafe(value, { status: options?.status ?? 200 });
        // Production logs name the fields only. An issue's message can quote
        // the value, and some of these bodies are secrets (account credentials).
        const fields = issues.map((i) => i.path?.map(String).join(".") || "(root)").join(", ");
        const key = `${String(schema.ast.annotations?.["identifier"] ?? "")}|${fields}`;
        if (!reported.has(key)) {
          reported.add(key);
          console.warn(`[api] response does not match its documented schema at: ${fields}`);
        }
      }
      return HttpServerResponse.jsonUnsafe(value, { status: options?.status ?? 200 });
    });
