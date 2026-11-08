/** Small values several request bodies share. */
import { Schema } from "effect";
import { CURRENCY_CODE_PATTERN } from "@infrawrench/client-core";
import { minLength, pattern } from "./checks";

/** A calendar day, `YYYY-MM-DD`. Shape only, as every zod `isoDate` was. */
export const IsoDate = Schema.String.check(
  pattern(/^\d{4}-\d{2}-\d{2}$/, { message: "expected YYYY-MM-DD" }),
);

/** zod's `z.string().min(1)`: ids and references, never validated further here. */
export const NonEmptyString = Schema.String.check(minLength(1));

/** An upper-case ISO 4217 code, as sent (`CURRENCY_CODE_PATTERN`). */
export const CurrencyCode = Schema.String.check(pattern(CURRENCY_CODE_PATTERN));

/**
 * zod's `.strict()`. Effect has no per-schema switch for excess properties
 * (the parse option reaches every object below the one it is passed to), so
 * the bodies whose zod schemas were strict say so in their docs and are
 * decoded with these options: `Schema.decodeUnknown*(X)(input,
 * STRICT_PARSE_OPTIONS)`, or `HttpApi.PayloadParseOptions` on the endpoint.
 */
export const STRICT_PARSE_OPTIONS = { onExcessProperty: "error" } as const;
