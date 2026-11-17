import { Predicate, Result, Schema, SchemaIssue } from "effect";
import { STRICT_PARSE_OPTIONS } from "@infrawrench/api-contract/schemas";

export type ToolInputDecodeResult<A> =
  | { readonly success: true; readonly data: A }
  | { readonly success: false; readonly message: string };

const formatter = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * A schema failure as one line the model or MCP client can fix its call from:
 * every problem (up to twelve) as `path: message`, separated by `; `. A
 * problem with the value as a whole is labelled `root` when one is given.
 */
function formatToolInputIssues(issue: SchemaIssue.Issue, root?: string): string {
  return formatter(issue)
    .issues.slice(0, 12)
    .map((entry) => {
      const path = (entry.path ?? []).map((segment) =>
        String(Predicate.isPropertyKey(segment) ? segment : segment.key),
      );
      if (path.length > 0) return `${path.join(".")}: ${entry.message}`;
      return root === undefined ? entry.message : `${root}: ${entry.message}`;
    })
    .join("; ");
}

/**
 * A tool handler's input decoded by a request schema, the way the HTTP route
 * for the same operation decodes its body: the decoded value (defaults
 * filled, strings trimmed), or every problem in {@link formatToolInputIssues}.
 *
 * Unknown keys are dropped, as the API drops them, unless `strict` is set for
 * a body the API decodes with `STRICT_PARSE_OPTIONS` (a canvas spec). `root`
 * labels a problem with the value as a whole.
 */
export function decodeToolInput<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
  options: { readonly strict?: boolean; readonly root?: string } = {},
): ToolInputDecodeResult<S["Type"]> {
  const result = Schema.decodeUnknownResult(schema)(input, {
    ...(options.strict ? STRICT_PARSE_OPTIONS : {}),
    errors: "all",
  });
  return Result.isSuccess(result)
    ? { success: true, data: result.success }
    : { success: false, message: formatToolInputIssues(result.failure.issue, options.root) };
}
