import { Result, Schema, SchemaIssue } from "effect";

export type ValidationResult<T> = { success: true; data: T } | { success: false; issues: string[] };

const toIssues = SchemaIssue.makeFormatterStandardSchemaV1();

const formatPath = (path: NonNullable<ReturnType<typeof toIssues>["issues"][number]["path"]>) =>
  path.reduce<string>((out, segment) => {
    const key = typeof segment === "object" ? segment.key : segment;
    if (typeof key === "number") return `${out}[${key}]`;
    return out ? `${out}.${String(key)}` : String(key);
  }, "");

/**
 * Decode `input` against a contract schema. Unknown keys are stripped from
 * `data`. `issues` lists every failure as `path: message`, never the input value,
 * so a rejected credential cannot end up in a log.
 */
export function validate<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
): ValidationResult<S["Type"]> {
  const result = Schema.decodeUnknownResult(schema, { errors: "all" })(input);
  if (Result.isSuccess(result)) return { success: true, data: result.success };
  return {
    success: false,
    issues: toIssues(result.failure.issue).issues.map(({ path, message }) =>
      path?.length ? `${formatPath(path)}: ${message}` : message,
    ),
  };
}

/** {@link validate}, for a response that should simply have been valid. */
export function decodeOrThrow<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
): S["Type"] {
  const result = validate(schema, input);
  if (result.success) return result.data;
  throw new Error(`Unexpected response: ${result.issues.join("; ")}`);
}
