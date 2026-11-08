/** Org currency settings and stated exchange rates (PUT /currency, /currency/rates), as Effect schemas. */
import { Schema } from "effect";
import {
  CURRENCY_CODE_PATTERN,
  EXCHANGE_RATE_BASES,
  EXCHANGE_RATE_CSV_LIMITS,
  EXCHANGE_RATE_LIMITS,
  type ExchangeRateImportRequest as ExchangeRateImportRequestContract,
  type ExchangeRateInput as ExchangeRateInputContract,
  type OrgCurrencySettingsInput as OrgCurrencySettingsInputContract,
} from "@infrawrench/client-core";
import { maxLength, normalized, pattern, trimmed } from "./checks";
import type { Exact } from "./contract";
import { IsoDate } from "./primitives";

/** A currency code, trimmed and upper-cased before it is checked. */
const CurrencyCodeField = normalized(
  (value) => value.trim().toUpperCase(),
  [pattern(CURRENCY_CODE_PATTERN, { message: "expected a three-letter code, e.g. USD" })],
  { examples: ["USD"], description: "ISO 4217 code, upper-case." },
);

const RateBasis = Schema.Literals(EXCHANGE_RATE_BASES).annotate({
  description:
    "Which automatic (feed) rate converts a day's spend. `daily`: the rate published for " +
    "that day, carried forward over weekends and holidays. `month_end`: the rate in force on " +
    "the last day of that day's month, so a whole month converts at one rate. Stated rates " +
    "always apply to the days their own dates cover, whatever the basis.",
});

/**
 * zod's `currencySettingsSchema`. `displayCurrency` is nullable and
 * *required*: a PUT that omits it is refused rather than quietly clearing a
 * setting the org turned on deliberately.
 */
export const CurrencySettingsInput = Schema.Struct({
  displayCurrency: Schema.NullOr(CurrencyCodeField).annotateKey({
    description:
      "The currency converted amounts are expressed in, or `null` for no conversion at all. " +
      "`null` is the default and the state of every organization that has not opted in: cost " +
      "data is stored per currency and never merged unless you ask.",
  }),
  /** Optional: omitted keeps the stored value, so an older client cannot switch it off by saving. */
  autoRates: Schema.optionalKey(Schema.Boolean).annotateKey({
    description: "Omitted keeps the stored value.",
  }),
  rateBasis: Schema.optionalKey(RateBasis).annotateKey({
    description: "Omitted keeps the stored value.",
  }),
}).annotate({ identifier: "CurrencySettingsInput" });

const RateDay = IsoDate.annotate({ examples: ["2026-07-01"] });

/**
 * One stated rate. `rate` stays a *decimal string*: it is stored in a
 * `numeric` column so the org's own digits survive, and parsing it to a float
 * here would throw them away.
 */
export const ExchangeRateInput = Schema.Struct({
  fromCurrency: CurrencyCodeField,
  toCurrency: CurrencyCodeField,
  rate: trimmed(
    [
      pattern(/^\d+(\.\d+)?$/, { message: "expected a positive decimal, e.g. 1.0850" }),
      Schema.makeFilter(
        (v: string) => {
          const n = Number(v);
          return n >= EXCHANGE_RATE_LIMITS.rateMin && n <= EXCHANGE_RATE_LIMITS.rateMax;
        },
        { message: "rate must be greater than 0" },
      ),
    ],
    {
      examples: ["1.0850000000"],
      description:
        "Multiply an amount in `fromCurrency` by this to get `toCurrency`. A decimal **string**, " +
        "not a number: it is stored in a `numeric(20, 10)` column so the digits your finance " +
        "system used survive the round trip exactly, and a JSON number could not promise that.",
    },
  ),
  effectiveFrom: RateDay,
  /** Inclusive last day, or null/omitted for open-ended. */
  effectiveTo: Schema.optionalKey(
    Schema.NullOr(RateDay).annotate({
      description: "Omitted or `null` for open-ended. Must not be before `effectiveFrom`.",
    }),
  ),
}).annotate({ identifier: "ExchangeRateInput" });

/** `POST /currency/rates/import`: a CSV of stated rates. Rows are validated server-side. */
export const ExchangeRateImportRequest = Schema.Struct({
  csv: Schema.String.check(maxLength(EXCHANGE_RATE_CSV_LIMITS.maxChars)).annotate({
    description:
      "The file's text, with a header row. Columns (matched by name, case and punctuation " +
      "insensitive): `from`, `to`, `rate`, and either `effective_from` (+ optional " +
      "`effective_to`) or `billing_period` (`YYYY-MM`, shorthand for that month's first and " +
      "last day). Comma, semicolon, tab or pipe delimited. At most 2,000 rows.",
    examples: [
      "from,to,rate,effective_from,effective_to,billing_period\nEUR,USD,1.08,2026-01-01,,\nJPY,USD,0.0067,,,2026-04\n",
    ],
  }),
  dryRun: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Classify every row and write nothing. The preview the settings page shows.",
    }),
  ),
  skipInvalid: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Write the valid rows even when some rows are invalid. Without it an upload with any " +
        "invalid row writes nothing.",
    }),
  ),
}).annotate({ identifier: "ExchangeRateImportRequest" });

export type CurrencySchemasMatchContract = [
  Exact<typeof CurrencySettingsInput.Type, OrgCurrencySettingsInputContract>,
  Exact<typeof ExchangeRateInput.Type, ExchangeRateInputContract>,
  Exact<typeof ExchangeRateImportRequest.Type, ExchangeRateImportRequestContract>,
];
[true, true, true] satisfies CurrencySchemasMatchContract;
