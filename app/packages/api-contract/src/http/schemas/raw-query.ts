/**
 * Query parameters a handler reads from the URL itself, documented as what a
 * caller sends.
 *
 * The browser hops (the WorkOS callback, the Slack and provider OAuth
 * callbacks, the Slack link landing) answer every input themselves: a missing
 * `code` is their own page, a provider's `error` is their own redirect. They
 * read the first value of each parameter, as Hono's `c.req.query(name)` did,
 * so a repeated parameter must reach them too, where even `documentedAs`
 * (`./documented.ts`) would refuse the array a repeated key decodes to. These
 * accept any value and only document `doc`.
 *
 * ```ts
 * query: { code: undecodedQuery(Schema.String.annotate({ description: "..." })) }
 * ```
 */
import { Predicate, Schema } from "effect";

/** An optional query parameter, never refused, documented as `doc`. */
export const undecodedQuery = <S extends Schema.Top>(doc: S) =>
  Schema.optionalKey(
    Schema.Any.pipe(
      Schema.refine(Predicate.isUnknown, {
        // The id names the check for persisted representations; nothing here persists one.
        representation: { id: "infrawrench/undecodedQuery", payload: null, schemas: [doc.ast] },
        toJsonSchema: ({ schemas }) => schemas[0] ?? {},
      }),
    ),
  );
