/**
 * Validating a form value with a request schema, the way the editors did with
 * zod's `safeParse`: either the decoded value, or the first problem, worded
 * as zod worded it so the sentence a form shows did not change with the
 * library underneath it.
 *
 * Two things the form path needs that the API path does not:
 *
 * - **`undefined` keys are dropped first.** The editors build objects with
 *   `field: undefined` for "not set"; zod's `.optional()` accepted that,
 *   `Schema.optionalKey` (which documents the field the way JSON can carry
 *   it) does not. Dropping them is exactly what `JSON.stringify` does on the
 *   way to the API, so the form and the server judge the same value.
 * - **The first issue only**, in zod v3's default English for the checks a
 *   form can actually trip (lengths, bounds, integers, missing and mistyped
 *   fields, enums). Messages a schema states itself (refinements, patterns
 *   with a sentence) are returned as written.
 */
import { Predicate, Result, Schema, SchemaAST, SchemaIssue } from "effect";

export type FormDecodeResult<A> =
  | { readonly success: true; readonly data: A }
  | {
      readonly success: false;
      /** The first problem, in the words the zod schema would have used. */
      readonly message: string;
      readonly path: ReadonlyArray<PropertyKey>;
    };

/** A form value as the API will receive it: `undefined`-valued keys removed, at every depth. */
export function withoutUndefinedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefinedKeys);
  if (!Predicate.isObject(value)) return value;
  const out: Record<PropertyKey, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = withoutUndefinedKeys(entry);
  }
  return out;
}

/** zod's `safeParse`, over an Effect schema. */
export function decodeForm<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
  options?: SchemaAST.ParseOptions,
): FormDecodeResult<S["Type"]> {
  const result = Schema.decodeUnknownResult(schema)(withoutUndefinedKeys(input), {
    ...options,
    reportInput: true,
  });
  if (Result.isSuccess(result)) return { success: true, data: result.success };
  const first = firstIssue(result.failure.issue, []);
  return { success: false, message: first.message, path: first.path };
}

interface FirstIssue {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
}

const fallbackFormatter = SchemaIssue.makeFormatterStandardSchemaV1();

function fallback(issue: SchemaIssue.Issue, path: ReadonlyArray<PropertyKey>): FirstIssue {
  const [entry] = fallbackFormatter(issue).issues;
  const rest = (entry?.path ?? []).map((segment): PropertyKey =>
    Predicate.isPropertyKey(segment) ? segment : segment.key,
  );
  return { path: [...path, ...rest], message: entry?.message ?? "Invalid input" };
}

function firstIssue(issue: SchemaIssue.Issue, path: ReadonlyArray<PropertyKey>): FirstIssue {
  switch (issue._tag) {
    case "Pointer":
      return firstIssue(issue.issue, [...path, ...issue.path]);
    case "Composite": {
      const [head] = issue.issues;
      return firstIssue(head, path);
    }
    case "Encoding":
      return firstIssue(issue.issue, path);
    case "Filter": {
      const stated = issue.filter.annotations?.message;
      if (Predicate.isString(stated)) return { path, message: stated };
      if (issue.issue._tag === "InvalidValue") {
        const own = issue.issue.annotations?.message;
        if (Predicate.isString(own)) return { path, message: own };
        const zod = zodCheckMessage(issue);
        if (zod !== undefined) return { path, message: zod };
        return fallback(issue, path);
      }
      return firstIssue(issue.issue, path);
    }
    case "AnyOf": {
      const literals = literalMembers(issue.ast);
      if (literals !== undefined) {
        return {
          path,
          message: `Invalid enum value. Expected ${literals.map(quote).join(" | ")}, received ${quote(issue.input)}`,
        };
      }
      const [head] = issue.issues;
      return head === undefined ? fallback(issue, path) : firstIssue(head, path);
    }
    case "MissingKey":
      return { path, message: "Required" };
    case "InvalidType": {
      const expected = expectedType(issue.ast);
      if (expected === undefined) return fallback(issue, path);
      const received = receivedType(issue.input);
      return {
        path,
        message:
          received === "undefined" ? "Required" : `Expected ${expected}, received ${received}`,
      };
    }
    case "UnexpectedKey": {
      const key = path[path.length - 1];
      return {
        path,
        message: `Unrecognized key(s) in object: '${String(key)}'`,
      };
    }
    default:
      return fallback(issue, path);
  }
}

function quote(value: unknown): string {
  return Predicate.isString(value) ? `'${value}'` : String(value);
}

function literalMembers(ast: SchemaAST.AST): ReadonlyArray<SchemaAST.LiteralValue> | undefined {
  if (!SchemaAST.isUnion(ast)) return undefined;
  const values: Array<SchemaAST.LiteralValue> = [];
  for (const member of ast.types) {
    if (!SchemaAST.isLiteral(member)) return undefined;
    values.push(member.literal);
  }
  return values;
}

function expectedType(ast: SchemaAST.AST): string | undefined {
  switch (ast._tag) {
    case "String":
      return "string";
    case "Number":
      return "number";
    case "Boolean":
      return "boolean";
    case "Null":
      return "null";
    case "Arrays":
      return "array";
    case "Objects":
      return "object";
    default:
      return undefined;
  }
}

/** zod's `getParsedType`, for "Expected string, received number". */
function receivedType(input: unknown): string {
  if (input === null) return "null";
  if (Array.isArray(input)) return "array";
  if (Predicate.isNumber(input) && Number.isNaN(input)) return "nan";
  return typeof input;
}

/** zod v3's default sentence for the built-in check that failed, when there is one. */
function zodCheckMessage(issue: SchemaIssue.Filter): string | undefined {
  const representation = issue.filter.annotations?.representation;
  if (representation === undefined) return undefined;
  const payload: unknown = representation.payload;
  const input = issue.input;
  const noun = Array.isArray(input) ? "Array" : "String";
  const unit = Array.isArray(input) ? "element(s)" : "character(s)";
  const read = (key: string): string | undefined => {
    if (!Predicate.isObject(payload)) return undefined;
    const value = payload[key];
    return Predicate.isNumber(value) || Predicate.isString(value) ? String(value) : undefined;
  };
  switch (representation.id) {
    case "effect/schema/isMinLength":
      return `${noun} must contain at least ${read("minLength")} ${unit}`;
    case "effect/schema/isMaxLength":
      return `${noun} must contain at most ${read("maxLength")} ${unit}`;
    case "effect/schema/isGreaterThanOrEqualTo":
      return `Number must be greater than or equal to ${read("minimum")}`;
    case "effect/schema/isGreaterThan":
      return `Number must be greater than ${read("exclusiveMinimum")}`;
    case "effect/schema/isLessThanOrEqualTo":
      return `Number must be less than or equal to ${read("maximum")}`;
    case "effect/schema/isLessThan":
      return `Number must be less than ${read("exclusiveMaximum")}`;
    case "effect/schema/isBetween": {
      const minimum = Number(read("minimum"));
      return Predicate.isNumber(input) && input < minimum
        ? `Number must be greater than or equal to ${read("minimum")}`
        : `Number must be less than or equal to ${read("maximum")}`;
    }
    case "effect/schema/isInt":
      return "Expected integer, received float";
    case "effect/schema/isFinite":
      return "Number must be finite";
    case "effect/schema/isPattern":
      return "Invalid";
    default:
      return undefined;
  }
}
