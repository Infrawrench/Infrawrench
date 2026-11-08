// The response schemas commands read cloud bodies with.
//
// A command prints `--json` as the body the server sent (every field, in the
// server's order) and decodes only what its text rendering reads, so each
// schema covers a subset of a `@infrawrench/client-core` wire type. `wire`
// ties the two together at compile time: every value of the client-core type
// must decode with the schema, so a field renamed, retyped or removed there
// breaks the CLI's build instead of its output, as the type-only imports
// always did. The imports stay type-only; the CLI takes no runtime dependency
// on client-core.
import { Effect, Predicate, Schema, SchemaTransformation } from "effect";
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

/**
 * An enum value this build does not know: one a newer server added. The CLI
 * ships inside desktop releases while the server deploys ahead of them, so a
 * value it has no case for must still render (as `raw`, or however the legacy
 * fallback did), never fail the listing.
 */
export class Unrecognized {
  constructor(readonly raw: string) {}
}

/** Any string, as {@link Unrecognized}. */
const UnrecognizedString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.instanceOf(Unrecognized),
    SchemaTransformation.transform({
      decode: (raw: string) => new Unrecognized(raw),
      encode: (value: Unrecognized) => value.raw,
    }),
  ),
);

/**
 * A string enum: one of `literals`, or {@link Unrecognized} for anything else.
 *
 * A `switch` over the known values with an `Unrecognized` branch renders a
 * newer server's value, and `wire` still breaks the build when client-core
 * adds a value: a literal missing here is neither a known case nor an
 * `Unrecognized` instance.
 */
export const knownOr = <const L extends ReadonlyArray<string>>(literals: L) =>
  Schema.Union([Schema.Literals(literals), UnrecognizedString]);

/**
 * A tagged union whose tag (`kind`, `field`) may be one this build does not
 * know: the known members decode as they are, and an object whose `tag` is
 * none of `tags` decodes to {@link Unrecognized} carrying that tag. A known
 * tag with a malformed body still fails, as it should.
 */
export const openUnion = <S extends Schema.Top>(
  known: S,
  tag: string,
  tags: ReadonlyArray<string>,
) =>
  Schema.Union([
    known,
    Schema.Record(Schema.String, Schema.Unknown)
      .check(
        Schema.makeFilter((value) => {
          const found = value[tag];
          return Predicate.isString(found) && !tags.includes(found);
        }),
      )
      .pipe(
        Schema.decodeTo(
          Schema.instanceOf(Unrecognized),
          SchemaTransformation.transform<Unrecognized, { readonly [key: string]: unknown }>({
            decode: (value) => new Unrecognized(String(value[tag])),
            encode: (value) => ({ [tag]: value.raw }),
          }),
        ),
      ),
  ]);

/** A decoded row beside the element the server sent, which `--json` prints. */
export interface Paired<A> {
  readonly row: A;
  readonly raw: unknown;
}

const RawArray = Schema.Array(Schema.Unknown);

/**
 * A JSON array decoded with `schema`, each row paired with its raw element by
 * index: for a command that finds one row by what it decoded (a name, an id)
 * and prints that row's raw element under `--json`.
 */
export const decodePaired =
  <A>(schema: Schema.ConstraintDecoder<ReadonlyArray<A>>, path: string) =>
  (body: unknown): Effect.Effect<ReadonlyArray<Paired<A>>, MalformedResponse> =>
    Effect.all([decodeBody(schema, path)(body), decodeBody(RawArray, path)(body)]).pipe(
      Effect.map(([rows, raw]) => rows.map((row, i) => ({ row, raw: raw[i] }))),
    );
