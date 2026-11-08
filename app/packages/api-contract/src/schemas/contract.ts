/**
 * The compile-time check that a schema decodes to exactly a client-core
 * contract type. Internal to the schema modules, not exported from the barrel.
 */

type Normalize<T> = T extends object ? { [K in keyof T]: Normalize<Exclude<T[K], undefined>> } : T;

/**
 * Exact equality, except that `| undefined` on a property is ignored.
 * `exactOptionalPropertyTypes` tells `a?: T` from `a?: T | undefined`; the
 * contract types are written the second way (zod's output is), the schemas
 * decode the first (`Schema.optionalKey`), and JSON cannot carry the
 * difference. Read-only properties are mutually assignable with mutable ones,
 * as TypeScript always treats them, but a read-only array is not an array, so
 * a schema whose arrays are not `Schema.mutable` still fails.
 *
 * Instantiate it (`[true, ...] satisfies SomeTuple`): a tuple type of these
 * that nothing is assigned to resolves to `never` without an error.
 */
export type Exact<A, B> = [Normalize<A>] extends [Normalize<B>]
  ? [Normalize<B>] extends [Normalize<A>]
    ? true
    : never
  : never;

/**
 * The one-way half of {@link Exact}: every decoded value is a valid contract
 * value. For a contract that leaves optional (as a client may write it) a
 * field the schema always fills with its default, where equality cannot hold.
 */
export type Decodes<A, B> = [Normalize<A>] extends [Normalize<B>] ? true : never;
