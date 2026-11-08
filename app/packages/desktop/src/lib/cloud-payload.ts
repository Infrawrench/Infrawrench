/**
 * Request bodies for the cloud transport (`./cloud-client.ts`) built from the
 * client-core input types the panels hand over.
 *
 * Those types write an optional field as `x?: T | undefined`, and the forms
 * do leave keys present with the value `undefined`; the contract's payload
 * schemas declare the same fields with `Schema.optionalKey`, which takes the
 * key absent or a `T`, never `undefined`. Over `invoke` the difference never
 * showed: `JSON.stringify` drops an `undefined` value. The endpoint's encoder
 * refuses one instead, so {@link definedFields} drops those keys first, which
 * is the same body `JSON.stringify` would have sent.
 */

/**
 * `T` with `undefined` taken out of every property, at every depth; optional
 * keys stay optional. Arrays keep their shape (a homomorphic mapped type maps
 * an array's elements).
 */
export type DefinedFields<T> = T extends object
  ? { [K in keyof T]: DefinedFields<Exclude<T[K], undefined>> }
  : T;

/**
 * `value` without its `undefined`-valued keys, in nested objects and array
 * elements too. The overload states what the body does: every key it keeps
 * holds a value that is not `undefined`.
 */
export function definedFields<T>(value: T): DefinedFields<T>;
export function definedFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((element) => definedFields(element));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .map(([key, field]) => [key, definedFields(field)]),
  );
}
