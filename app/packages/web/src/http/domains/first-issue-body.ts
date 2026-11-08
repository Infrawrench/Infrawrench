/**
 * A request body judged the way a Hono route's zod `safeParse` judged it:
 * strict (zod's `.strict()`, unknown keys refused at every level) and refused
 * with the first issue's sentence, worded as zod worded it, as `{ error }`.
 *
 * For endpoints served with `handleRaw` that read the body themselves, so the
 * route keeps its own reading of an absent or non-JSON body (`readJson` for
 * `await c.req.json()`, `readJsonOr(request, null)` for `.catch(() => null)`).
 */
import { Effect, type Schema } from "effect";
import { decodeForm, STRICT_PARSE_OPTIONS } from "@infrawrench/ui/schemas";
import { BadRequest } from "../errors";

export const decodeFirstIssueStrict = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  body: unknown,
): Effect.Effect<S["Type"], BadRequest> => {
  const result = decodeForm(schema, body, STRICT_PARSE_OPTIONS);
  return result.success
    ? Effect.succeed(result.data)
    : Effect.fail(new BadRequest({ error: result.message }));
};
