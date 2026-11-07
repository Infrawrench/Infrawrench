import { Schema } from "effect";

export const NonEmpty = Schema.NonEmptyString;

// A contract number rejects NaN but allows Infinity. `Schema.Number` accepts
// both and `Schema.Finite` rejects both.
// @effect-diagnostics-next-line schemaNumber:off
export const Num = Schema.Number.check(
  Schema.makeFilter((n: number) => !Number.isNaN(n), { expected: "a number" }),
);

// `Schema.isInt` is a safe-integer check, which would reject 2 ** 53.
const isInteger = Schema.makeFilter((n: number) => Number.isInteger(n), { expected: "an integer" });

export const Int = Num.check(isInteger);
export const PositiveInt = Num.check(isInteger, Schema.isGreaterThan(0));
export const Positive = Num.check(Schema.isGreaterThan(0));
export const NonNegative = Num.check(Schema.isGreaterThanOrEqualTo(0));

export const Url = Schema.String.check(
  Schema.makeFilter((s: string) => URL.canParse(s), { expected: "a URL" }),
);

// `Url` alone is not a scheme guard: it is `new URL()`, so `javascript:alert(1)`
// and `data:text/html,…` both pass it. A value rendered as a link the host opens
// pins its scheme here as well as at the runtime boundaries.
export const httpsUrl = (message: string) =>
  Url.check(Schema.makeFilter((s: string) => s.startsWith("https://"), { message }));

/** A cross-field rule, reported at `path` when given. */
export const rule = <T>(test: (value: T) => boolean, message: string, path?: readonly string[]) =>
  Schema.makeFilter<T>((value) => test(value) || (path ? { path, issue: message } : message));

export const uniqueBy = <T>(key: (item: T) => string, message: string) =>
  rule<ReadonlyArray<T>>((list) => new Set(list.map(key)).size === list.length, message);
