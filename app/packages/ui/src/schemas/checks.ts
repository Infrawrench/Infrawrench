/**
 * Length and pattern checks that document what they enforce.
 *
 * `Schema.isMinLength(n)` validates JavaScript's `length` (UTF-16 code units)
 * but documents `minLength: ceil(n / 2)`, the bound that holds in JSON
 * Schema's code points whatever the characters are. This API has always
 * documented the number it checks (zod measures `length` too), and a spec that
 * says a currency code may be two characters long is wrong for every client,
 * so these keep the stated number.
 *
 * Patterns are only exported to JSON Schema when the regex has the `u` flag,
 * whose semantics JSON Schema shares; {@link pattern} adds it.
 */
import { Schema } from "effect";

export const minLength = (n: number) =>
  Schema.isMinLength(n, {
    toJsonSchema: ({ type }) => (type === "array" ? { minItems: n } : { minLength: n }),
  });

export const maxLength = (n: number) => Schema.isMaxLength(n);

export const lengthBetween = (min: number, max: number) =>
  [minLength(min), maxLength(max)] as const;

export const pattern = (regExp: RegExp) =>
  Schema.isPattern(
    regExp.flags.includes("u") ? regExp : new RegExp(regExp.source, `${regExp.flags}u`),
  );
