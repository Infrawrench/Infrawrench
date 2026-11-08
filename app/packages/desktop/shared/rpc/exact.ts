/**
 * Tie an RPC schema to the shared contract type it carries.
 *
 * Most desktop operations answer with a type that already exists in
 * `@infrawrench/client-core` or `@infrawrench/plugin-base` (the same wire
 * shape the web API serves). The schema has to be written out for Effect RPC
 * to encode and decode it, and {@link exact} keeps that copy honest: the
 * schema's decoded type must be the contract type, both ways, so a field
 * added, renamed, retyped or made optional on either side fails the desktop's
 * typecheck instead of being silently dropped by the encoder.
 *
 * Contract types are mutable interfaces, so arrays in these schemas are
 * `Schema.mutable(Schema.Array(...))`: a `readonly X[]` does not satisfy an
 * `X[]`. Optional properties are `Schema.optionalKey`, which matches `?:`
 * under `exactOptionalPropertyTypes`.
 *
 * Assignability alone cannot see an optional property one side lacks (an
 * object without `note` is assignable to one with `note?:`), so the two key
 * sets are compared as well. That holds for the level `exact` wraps: a nested
 * struct with optional keys gets its own `exact`, against the contract's
 * named type or an indexed access such as
 * `LocalDeployRun["createdResources"][number]`.
 */
import type { Schema } from "effect";

type Matches<T, S extends Schema.Constraint> = [T] extends [S["Type"]]
  ? [S["Type"]] extends [T]
    ? [Exclude<keyof T, keyof S["Type"]>, Exclude<keyof S["Type"], keyof T>] extends [never, never]
      ? unknown
      : {
          readonly "the schema and the contract type name different optional keys": [
            Exclude<keyof T, keyof S["Type"]>,
            Exclude<keyof S["Type"], keyof T>,
          ];
        }
    : { readonly "the schema decodes to more than the contract type allows": T }
  : { readonly "a value of the contract type does not fit this schema": T };

/** `exact<OrphanListResponse>()(Schema.Struct({ ... }))`. */
export const exact =
  <T>() =>
  <S extends Schema.Constraint>(schema: S & Matches<T, S>): S =>
    schema;
