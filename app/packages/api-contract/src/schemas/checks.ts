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
 *
 * Each takes the usual filter annotations, so a check can carry the sentence
 * the zod schema it replaces reported (`{ message: "expected YYYY-MM-DD" }`).
 */
import { Schema, SchemaAST, SchemaTransformation } from "effect";

type FilterAnnotations = Schema.Annotations.Filter;

export const minLength = (n: number, annotations?: FilterAnnotations) =>
  Schema.isMinLength(n, {
    toJsonSchema: ({ type }) => (type === "array" ? { minItems: n } : { minLength: n }),
    ...annotations,
  });

export const maxLength = (n: number, annotations?: FilterAnnotations) =>
  Schema.isMaxLength(n, annotations);

export const lengthBetween = (min: number, max: number) =>
  [minLength(min), maxLength(max)] as const;

export const pattern = (regExp: RegExp, annotations?: FilterAnnotations) =>
  Schema.isPattern(
    regExp.flags.includes("u") ? regExp : new RegExp(regExp.source, `${regExp.flags}u`),
    annotations,
  );

/**
 * The same check, documented and never failing: it states on the value as
 * sent a bound that is enforced after a transformation (see {@link trimmed}).
 */
const documentationOnly = (check: SchemaAST.Filter<string>) =>
  Schema.makeFilter<string>(() => true, check.annotations);

/**
 * A string normalised before it is checked: zod's `z.string().trim().min(1)`
 * and `z.string().transform(f).pipe(z.string().regex(...))`. The checks hold
 * on the normalised value, exactly as zod's did, so `"  ab  "` passes a
 * three-character maximum. A request schema is documented by what is sent,
 * so the same bounds are also stated there by checks that never fail;
 * `annotations` (description, examples) go there too, which is the side the
 * spec shows.
 */
type StringChecks = readonly [SchemaAST.Filter<string>, ...Array<SchemaAST.Filter<string>>];

export const normalized = (
  normalize: (value: string) => string,
  checks: StringChecks,
  annotations: Schema.Annotations.Documentation<string> = {},
) => {
  const [first, ...rest] = checks;
  return Schema.String.check(documentationOnly(first), ...rest.map(documentationOnly))
    .annotate(annotations)
    .pipe(
      Schema.decodeTo(
        Schema.String.check(first, ...rest),
        SchemaTransformation.transform({ decode: normalize, encode: (value: string) => value }),
      ),
    );
};

/** zod's `z.string().trim()` followed by `checks`. */
export const trimmed = (
  checks: StringChecks,
  annotations?: Schema.Annotations.Documentation<string>,
) => normalized((value) => value.trim(), checks, annotations);
