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
      "are **not** dropped — they keep their own series and their own `totals` entry, because " +
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
