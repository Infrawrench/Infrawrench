// The response schemas migrated commands read cloud bodies with.
//
// A command prints `--json` as the body the server sent (every field, in the
// server's order) and decodes only what its text rendering reads, so each
// schema covers a subset of a `@infrawrench/client-core` wire type. `wire`
// ties the two together at compile time: every value of the client-core type
// must decode with the schema, so a field renamed, retyped or removed there
// breaks the CLI's build instead of its output, as the type-only imports
// always did. The imports stay type-only; the CLI takes no runtime dependency
// on client-core.
import { Effect, Schema } from "effect";
import { decodeBody } from "./cloud-api";
import type { MalformedResponse } from "./errors";

type Fits<T, S extends Schema.Constraint> = [T] extends [S["Type"]]
  ? unknown
  : { readonly "a value of the client-core type does not decode with this schema": T };

/**
 * `schema`, checked against the client-core type `T` it reads a subset of:
 * `wire<ExpiryListResponse>()(Schema.Struct({ ... }))`.
 *
 * An enum the renderer falls back on for values it does not know (a newer
 * server's classification) is decoded as `Schema.String`, not `Literals`, so
 * an unknown value still renders instead of failing the listing.
 */
export const wire =
  <T>() =>
  <S extends Schema.Constraint>(schema: S & Fits<T, S>): S =>
    schema;

/** Any JSON object, keys in the order the server sent them. */
const JsonObject = Schema.Record(Schema.String, Schema.Unknown);

/**
 * `{ ...head, ...body }`: the `--json` shape most org reads print, such as
 * `{ org, ...response }`. A body that is not an object is `MalformedResponse`.
 */
export const spreadBody = (
  head: Readonly<Record<string, unknown>>,
  body: unknown,
  path: string,
): Effect.Effect<Record<string, unknown>, MalformedResponse> =>
  decodeBody(JsonObject, path)(body).pipe(Effect.map((rest) => ({ ...head, ...rest })));
