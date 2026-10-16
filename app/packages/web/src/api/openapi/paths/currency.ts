import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam } from "../common";
import type { BuildContext } from "../context";

const CurrencyCode = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .openapi({ example: "USD", description: "ISO 4217 code, upper-case." });

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .openapi({ example: "2026-07-01" });

const RateDecimal = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .openapi({
    example: "1.0850000000",
    description:
      "Multiply an amount in `fromCurrency` by this to get `toCurrency`. A decimal **string**, " +
      "not a number: it is stored in a `numeric(20, 10)` column so the digits your finance " +
      "system used survive the round trip exactly, and a JSON number could not promise that.",
  });

const RateBasis = z.enum(["daily", "month_end"]).openapi({
  description:
    "Which automatic (feed) rate converts a day's spend. `daily`: the rate published for " +
    "that day, carried forward over weekends and holidays. `month_end`: the rate in force on " +
    "the last day of that day's month, so a whole month converts at one rate. Stated rates " +
    "always apply to the days their own dates cover, whatever the basis.",
});

const RateSource = z.enum(["manual", "ecb"]).openapi({
  description:
    "`manual`: a rate your organization stated. `ecb`: the automatic European Central Bank " +
    "euro reference rate (crossed through EUR when neither side is EUR).",
});

const DisplayCurrencyField = CurrencyCode.nullable().openapi({
  description:
    "The currency converted amounts are expressed in, or `null` for no conversion at all. " +
    "`null` is the default and the state of every organization that has not opted in: cost " +
    "data is stored per currency and never merged unless you ask.",
});

const AutoRatesField = z.boolean().openapi({
  description:
    "Fill days no stated rate covers from the automatic daily ECB reference-rate feed. Off " +
    "by default. A stated rate always wins over the feed for the days it covers. Currencies " +
    "the ECB does not publish are manual-only.",
});

const CurrencySettings = strict({
  displayCurrency: DisplayCurrencyField,
  autoRates: AutoRatesField,
  rateBasis: RateBasis,
}).openapi("CurrencySettings");

const CurrencySettingsInput = strict({
  displayCurrency: DisplayCurrencyField,
  autoRates: AutoRatesField.optional().openapi({
    description: "Omitted keeps the stored value.",
  }),
  rateBasis: RateBasis.optional().openapi({ description: "Omitted keeps the stored value." }),
}).openapi("CurrencySettingsInput");

const FxFeedStatus = strict({
  source: z.literal("ecb"),
  sourceName: z.string(),
  sourceUrl: z.string(),
  latestRateDate: IsoDate.nullable().openapi({
    description: "Newest publication stored, or null before the first successful fetch.",
  }),
  earliestRateDate: IsoDate.nullable(),
  currencies: z.array(CurrencyCode).openapi({
    description:
      "Currencies in the newest publication, plus EUR. Any other currency is manual-only: it " +
      "converts only at a rate you state.",
  }),
  lastSuccessAt: z.string().nullable(),
  lastError: z.string().nullable().openapi({
    description: "Error from the most recent failed fetch; cleared on success.",
  }),
}).openapi("FxFeedStatus");

const ExchangeRate = strict({
  id: z.string(),
  fromCurrency: CurrencyCode,
  toCurrency: CurrencyCode,
  rate: RateDecimal,
  effectiveFrom: IsoDate.openapi({
    description:
      "Inclusive day this rate starts applying. A given day converts at the rate with the " +
      "greatest `effectiveFrom` on or before it, so historical periods keep the rate that " +
      "applied then. A day earlier than every stated rate has no rate.",
  }),
  effectiveTo: IsoDate.nullable().openapi({
    description:
      "Inclusive last day this rate applies, or `null` for open-ended (until a later stated " +
      "rate). Past it, the automatic feed takes over when on; otherwise those days are " +
      "unconverted. An older stated rate never resurfaces past an end date.",
  }),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).openapi("ExchangeRate");

const ExchangeRateInput = strict({
  fromCurrency: CurrencyCode,
  toCurrency: CurrencyCode,
  rate: RateDecimal,
  effectiveFrom: IsoDate,
  effectiveTo: IsoDate.nullable().optional().openapi({
    description: "Omitted or `null` for open-ended. Must not be before `effectiveFrom`.",
  }),
}).openapi("ExchangeRateInput");

const ExchangeRateImportRequest = strict({
  csv: z
    .string()
    .max(512 * 1024)
    .openapi({
      description:
        "The file's text, with a header row. Columns (matched by name, case and punctuation " +
        "insensitive): `from`, `to`, `rate`, and either `effective_from` (+ optional " +
        "`effective_to`) or `billing_period` (`YYYY-MM`, shorthand for that month's first and " +
        "last day). Comma, semicolon, tab or pipe delimited. At most 2,000 rows.",
      example:
        "from,to,rate,effective_from,effective_to,billing_period\nEUR,USD,1.08,2026-01-01,,\nJPY,USD,0.0067,,,2026-04\n",
    }),
  dryRun: z.boolean().optional().openapi({
    description: "Classify every row and write nothing. The preview the settings page shows.",
  }),
  skipInvalid: z
    .boolean()
    .optional()
    .openapi({
      description:
        "Write the valid rows even when some rows are invalid. Without it an upload with any " +
        "invalid row writes nothing.",
    }),
}).openapi("ExchangeRateImportRequest");

const ExchangeRateImportAction = z.enum(["create", "update", "unchanged", "error"]).openapi({
  description:
    "`create`: no stated rate for this pair and effective date yet. `update`: one exists with a " +
    "different rate or end date, and is replaced. `unchanged`: identical to what is stored. " +
    "`error`: invalid, with `error` saying why.",
});

const ExchangeRateImportCounts = strict({
  create: z.number().int(),
  update: z.number().int(),
  unchanged: z.number().int(),
  error: z.number().int(),
});

const ExchangeRateImportResult = strict({
  dryRun: z.boolean().openapi({ description: "True when nothing was written." }),
  applied: z.boolean().openapi({ description: "True when the rows were written." }),
  rows: z.array(
    strict({
      line: z.number().int().openapi({ description: "Line in the file; the header is line 1." }),
      action: ExchangeRateImportAction,
      rate: ExchangeRateInput.optional().openapi({
        description: "The normalized rate; absent on an `error` row.",
      }),
      previousRate: RateDecimal.optional().openapi({
        description: "The stored rate an `update` replaces.",
      }),
      previousEffectiveTo: IsoDate.nullable().optional(),
      error: z.string().optional(),
    }),
  ),
  counts: ExchangeRateImportCounts,
  fileError: z
    .string()
    .nullable()
    .openapi({
      description:
        "A problem with the file as a whole (a missing column, too many rows, the org's rate cap); " +
        "`rows` is then empty or unapplied.",
    }),
}).openapi("ExchangeRateImportResult");

const CurrencyConfig = strict({
  displayCurrency: CurrencyCode.nullable(),
  autoRates: z.boolean(),
  rateBasis: RateBasis,
  rates: z.array(ExchangeRate),
  feed: FxFeedStatus,
}).openapi("CurrencyConfig");

const ExchangeRateLookup = strict({
  fromCurrency: CurrencyCode,
  toCurrency: CurrencyCode,
  date: IsoDate,
  rateBasis: RateBasis,
  rate: z.number().nullable().openapi({
    description: "Multiply an amount in `fromCurrency` by this. `null`: no rate applies.",
  }),
  source: RateSource.nullable(),
  rateDate: IsoDate.nullable().openapi({
    description: "The stated rate's effective date, or the ECB publication date used.",
  }),
  manualRateId: z.string().nullable(),
  explanation: z.string(),
}).openapi("ExchangeRateLookup");

const FxFeedRates = FxFeedStatus.extend({
  date: IsoDate,
  base: CurrencyCode,
  rateDate: IsoDate.nullable().openapi({
    description:
      "Publication used for `date`: the same day, or the last one before it over a weekend " +
      "or holiday. Null when the feed holds nothing that early.",
  }),
  rates: z.array(
    strict({
      currency: CurrencyCode,
      rate: z.number().openapi({ description: "Units of `base` per 1 unit of `currency`." }),
    }),
  ),
}).openapi("FxFeedRates");

/**
 * The conversion report every converted cost payload carries: a converted
 * number that does not say it was converted is the one outcome this whole
 * surface exists to prevent.
 */
const CostConversion = strict({
  displayCurrency: CurrencyCode,
  converted: z.array(
    strict({
      currency: CurrencyCode,
      rates: z
        .array(
          strict({
            effectiveFrom: IsoDate.openapi({
              description:
                "A stated rate's effective date, or the ECB publication date of a feed rate.",
            }),
            rate: z.number(),
            source: RateSource.optional(),
            firstDay: IsoDate.optional().openapi({
              description: "First day of the queried data this rate converted.",
            }),
            lastDay: IsoDate.optional().openapi({
              description: "Last day of the queried data this rate converted.",
            }),
          }),
        )
        .openapi({
          description:
            "Every rate applied across the queried range, newest first. More than one entry " +
            "means the range spans a rate change and the total is a blend.",
        }),
    }),
  ),
  unconverted: z.array(CurrencyCode).openapi({
    description:
      "Currencies present in the data that your organization holds no usable rate for. These " +
      "are **not** dropped; they keep their own series and their own `totals` entry, because " +
      "silently omitting a currency would understate the total.",
  }),
  rateBasis: RateBasis.optional().openapi({
    description: "Present when automatic rates were available to this conversion.",
  }),
}).openapi("CostConversion");

export function registerCurrencyPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/currency",
    tags: ["Currency"],
    summary: "The org's currency settings, exchange rate table and feed state",
    description:
      "Readable with `costs:read` rather than a settings permission: anyone who can see a " +
      "converted total has to be able to see what it was converted at, or the number is " +
      "unauditable. `feed` reports the automatic ECB reference-rate feed (global, the same " +
      "for every organization): its newest publication, its coverage and its last error.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Currency settings and rates",
        content: { "application/json": { schema: CurrencyConfig } },
      },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/currency",
    tags: ["Currency"],
    summary: "Save the org's currency settings",
    description:
      "Setting a display currency opts the organization into converted totals; `null` turns " +
      "conversion off everywhere and restores the per-currency view. Clearing does not delete " +
      "the rate table, so conversion can be turned back on without re-stating anything. With " +
      "`autoRates` off, only currencies with a stated rate are converted; with it on, the " +
      "daily ECB reference rates fill the days no stated rate covers.",
    request: {
      params: OrgIdParam,
      body: {
        content: { "application/json": { schema: CurrencySettingsInput } },
        required: true,
      },
    },
    responses: {
      200: { description: "Saved", content: { "application/json": { schema: CurrencySettings } } },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/currency/lookup",
    tags: ["Currency"],
    summary: "Which rate a day of spend converts at",
    description:
      "Applies the organization's precedence (a stated rate covering the day, else the " +
      "automatic feed when on, at the day or month-end rate per `rateBasis`) and explains the " +
      "outcome. `to` defaults to the display currency; `date` defaults to today.",
    request: {
      params: OrgIdParam,
      query: z.object({
        from: CurrencyCode,
        to: CurrencyCode.optional(),
        date: IsoDate.optional(),
      }),
    },
    responses: {
      200: {
        description: "The applicable rate, or none",
        content: { "application/json": { schema: ExchangeRateLookup } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/currency/feed",
    tags: ["Currency"],
    summary: "Automatic reference rates for one day",
    description:
      "Every rate the ECB feed holds for `date` (default today; weekends and holidays carry the " +
      "last publication), expressed in `base` (default the display currency, else EUR), plus " +
      "the feed's state. Readable whether or not the organization has automatic rates on.",
    request: {
      params: OrgIdParam,
      query: z.object({ date: IsoDate.optional(), base: CurrencyCode.optional() }),
    },
    responses: {
      200: {
        description: "Feed rates",
        content: { "application/json": { schema: FxFeedRates } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/currency/rates",
    tags: ["Currency"],
    summary: "Create or replace one exchange rate",
    description:
      "Upserts on (`fromCurrency`, `toCurrency`, `effectiveFrom`): one rate per pair per day, " +
      "so correcting a rate replaces it rather than adding a second one whose precedence a " +
      "reader would have to guess. Stated rates are one hop to the display currency and are " +
      "never inverted or chained. A stated rate always wins over the automatic feed for the " +
      "days it covers; give it an `effectiveTo` to hand the days after back to the feed.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: ExchangeRateInput } }, required: true },
    },
    responses: {
      200: { description: "Saved", content: { "application/json": { schema: ExchangeRate } } },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/currency/rates/template",
    tags: ["Currency"],
    summary: "CSV template for uploading exchange rates",
    description:
      "The header row `POST /currency/rates/import` reads, plus one example row per shape: an " +
      "open-ended rate, a bounded override, and a `billing_period` row.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "The template",
        content: { "text/csv": { schema: z.string() } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/currency/rates/import",
    tags: ["Currency"],
    summary: "Upload many exchange rates from a CSV",
    description:
      "Upserts every row on (`fromCurrency`, `toCurrency`, `effectiveFrom`), exactly as the " +
      "single-rate PUT does, in one transaction. Send `dryRun: true` first to see each row " +
      "classified (`create`, `update`, `unchanged`, `error` with the reason); an upload with an " +
      "invalid row writes nothing unless `skipInvalid` is set. Uploaded rates are ordinary " +
      "stated rates: they win over the automatic feed for the days they cover, and a " +
      "`billing_period` row (or an `effective_to`) hands the days after it back to the next " +
      "rate or the feed. Requires `org:settings:write`; applied uploads are audit-logged as " +
      "`exchange_rate.import`.",
    request: {
      params: OrgIdParam,
      body: {
        content: { "application/json": { schema: ExchangeRateImportRequest } },
        required: true,
      },
    },
    responses: {
      200: {
        description: "The preview, or the applied upload",
        content: { "application/json": { schema: ExchangeRateImportResult } },
      },
      400: {
        description:
          "A malformed body, or a whole-file problem; the body is then the result with " +
          "`fileError` and `error` set.",
        content: {
          "application/json": {
            schema: ExchangeRateImportResult.extend({ error: z.string() }).openapi(
              "ExchangeRateImportRefusal",
            ),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/currency/rates/{rateId}",
    tags: ["Currency"],
    summary: "Delete one exchange rate",
    description:
      "Removing a rate makes the days it covered fall back to the next-older rate, then the " +
      "automatic feed when on, or to unconverted if none applies. Spend never disappears: it " +
      "reverts to its own currency.",
    request: {
      params: OrgIdParam.extend({
        rateId: z.string().openapi({ param: { name: "rateId", in: "path" } }),
      }),
    },
    responses: {
      200: {
        description: "Deleted",
        content: { "application/json": { schema: strict({ ok: z.boolean() }) } },
      },
      404: ErrorResponses[404],
    },
  });
}
