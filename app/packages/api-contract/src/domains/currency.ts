/**
 * Currency: `/api/org/:orgId/currency`, the endpoint definitions.
 *
 * Reads are `costs:read`; writes are `org:settings:write`.
 *
 * The read side is deliberately the *cost* permission rather than a settings
 * one. Anyone who can see a converted total has to be able to see what it was
 * converted at: a rate table you cannot read makes the number on the graph
 * unauditable, and every cost surface already requires `costs:read`.
 *
 * The write side is deliberately **not** `costs:write` (which tunes anomaly
 * thresholds and pushes rows), and not a per-user preference. Stating an
 * exchange rate restates every historical total the org reports, in the digest
 * that goes to the whole team and in the budget alerts that page people. That
 * is a finance-governance decision with org-wide blast radius, which is what
 * `org:settings:write` gates: the same permission the tag policy uses, its
 * nearest sibling in kind. Every write is audit-logged for the same reason.
 *
 * The request bodies are the shared schemas the currency settings page
 * validates with (`@infrawrench/api-contract/schemas`).
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import {
  CurrencySettingsInput,
  ExchangeRateImportRequest,
  ExchangeRateInput,
  pattern,
} from "../schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { OrgId, OrgParams } from "../http/schemas/common";
import { documentedAs, requiredQuery } from "../http/schemas/documented";

const CurrencyCode = Schema.String.check(pattern(/^[A-Z]{3}$/)).annotate({
  examples: ["USD"],
  description: "ISO 4217 code, upper-case.",
});

const Day = Schema.String.check(pattern(/^\d{4}-\d{2}-\d{2}$/)).annotate({
  examples: ["2026-07-01"],
});

const RateDecimal = Schema.String.check(pattern(/^\d+(\.\d+)?$/)).annotate({
  examples: ["1.0850000000"],
  description:
    "Multiply an amount in `fromCurrency` by this to get `toCurrency`. A decimal **string**, " +
    "not a number: it is stored in a `numeric(20, 10)` column so the digits your finance " +
    "system used survive the round trip exactly, and a JSON number could not promise that.",
});

const RateBasis = Schema.Literals(["daily", "month_end"]).annotate({
  description:
    "Which automatic (feed) rate converts a day's spend. `daily`: the rate published for " +
    "that day, carried forward over weekends and holidays. `month_end`: the rate in force on " +
    "the last day of that day's month, so a whole month converts at one rate. Stated rates " +
    "always apply to the days their own dates cover, whatever the basis.",
});

const RateSource = Schema.Literals(["manual", "ecb"]).annotate({
  description:
    "`manual`: a rate your organization stated. `ecb`: the automatic European Central Bank " +
    "euro reference rate (crossed through EUR when neither side is EUR).",
});

export const CurrencySettings = Schema.Struct({
  displayCurrency: Schema.NullOr(CurrencyCode).annotate({
    description:
      "The currency converted amounts are expressed in, or `null` for no conversion at all. " +
      "`null` is the default and the state of every organization that has not opted in: cost " +
      "data is stored per currency and never merged unless you ask.",
  }),
  autoRates: Schema.Boolean.annotate({
    description:
      "Fill days no stated rate covers from the automatic daily ECB reference-rate feed. Off " +
      "by default. A stated rate always wins over the feed for the days it covers. Currencies " +
      "the ECB does not publish are manual-only.",
  }),
  rateBasis: RateBasis,
}).annotate({ identifier: "CurrencySettings" });

const fxFeedStatusFields = {
  source: Schema.Literal("ecb"),
  sourceName: Schema.String,
  sourceUrl: Schema.String,
  latestRateDate: Schema.NullOr(Day).annotate({
    description: "Newest publication stored, or null before the first successful fetch.",
  }),
  earliestRateDate: Schema.NullOr(Day),
  currencies: Schema.Array(CurrencyCode).annotate({
    description:
      "Currencies in the newest publication, plus EUR. Any other currency is manual-only: it " +
      "converts only at a rate you state.",
  }),
  lastSuccessAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String).annotate({
    description: "Error from the most recent failed fetch; cleared on success.",
  }),
};

const FxFeedStatus = Schema.Struct(fxFeedStatusFields).annotate({ identifier: "FxFeedStatus" });

export const ExchangeRate = Schema.Struct({
  id: Schema.String,
  fromCurrency: CurrencyCode,
  toCurrency: CurrencyCode,
  rate: RateDecimal,
  effectiveFrom: Day.annotate({
    description:
      "Inclusive day this rate starts applying. A given day converts at the rate with the " +
      "greatest `effectiveFrom` on or before it, so historical periods keep the rate that " +
      "applied then. A day earlier than every stated rate has no rate.",
  }),
  effectiveTo: Schema.NullOr(Day).annotate({
    description:
      "Inclusive last day this rate applies, or `null` for open-ended (until a later stated " +
      "rate). Past it, the automatic feed takes over when on; otherwise those days are " +
      "unconverted. An older stated rate never resurfaces past an end date.",
  }),
  createdBy: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}).annotate({ identifier: "ExchangeRate" });

export const CurrencyConfig = Schema.Struct({
  displayCurrency: Schema.NullOr(CurrencyCode),
  autoRates: Schema.Boolean,
  rateBasis: RateBasis,
  rates: Schema.Array(ExchangeRate),
  feed: FxFeedStatus,
}).annotate({ identifier: "CurrencyConfig" });

export const ExchangeRateLookup = Schema.Struct({
  fromCurrency: CurrencyCode,
  toCurrency: CurrencyCode,
  date: Day,
  rateBasis: RateBasis,
  rate: Schema.NullOr(Schema.Finite).annotate({
    description: "Multiply an amount in `fromCurrency` by this. `null`: no rate applies.",
  }),
  source: Schema.NullOr(RateSource),
  rateDate: Schema.NullOr(Day).annotate({
    description: "The stated rate's effective date, or the ECB publication date used.",
  }),
  manualRateId: Schema.NullOr(Schema.String),
  explanation: Schema.String,
}).annotate({ identifier: "ExchangeRateLookup" });

export const FxFeedRates = Schema.Struct({
  ...fxFeedStatusFields,
  date: Day,
  base: CurrencyCode,
  rateDate: Schema.NullOr(Day).annotate({
    description:
      "Publication used for `date`: the same day, or the last one before it over a weekend " +
      "or holiday. Null when the feed holds nothing that early.",
  }),
  rates: Schema.Array(
    Schema.Struct({
      currency: CurrencyCode,
      rate: Schema.Finite.annotate({ description: "Units of `base` per 1 unit of `currency`." }),
    }),
  ),
}).annotate({ identifier: "FxFeedRates" });

const ExchangeRateImportAction = Schema.Literals([
  "create",
  "update",
  "unchanged",
  "error",
]).annotate({
  description:
    "`create`: no stated rate for this pair and effective date yet. `update`: one exists with a " +
    "different rate or end date, and is replaced. `unchanged`: identical to what is stored. " +
    "`error`: invalid, with `error` saying why.",
});

const exchangeRateImportResultFields = {
  dryRun: Schema.Boolean.annotate({ description: "True when nothing was written." }),
  applied: Schema.Boolean.annotate({ description: "True when the rows were written." }),
  rows: Schema.Array(
    Schema.Struct({
      line: Schema.Int.annotate({ description: "Line in the file; the header is line 1." }),
      action: ExchangeRateImportAction,
      rate: Schema.optionalKey(ExchangeRateInput).annotateKey({
        description: "The normalized rate; absent on an `error` row.",
      }),
      previousRate: Schema.optionalKey(
        RateDecimal.annotate({ description: "The stored rate an `update` replaces." }),
      ),
      previousEffectiveTo: Schema.optionalKey(Schema.NullOr(Day)),
      error: Schema.optionalKey(Schema.String),
    }),
  ),
  counts: Schema.Struct({
    create: Schema.Int,
    update: Schema.Int,
    unchanged: Schema.Int,
    error: Schema.Int,
  }),
  fileError: Schema.NullOr(Schema.String).annotate({
    description:
      "A problem with the file as a whole (a missing column, too many rows, the org's rate cap); " +
      "`rows` is then empty or unapplied.",
  }),
};

export const ExchangeRateImportResult = Schema.Struct(exchangeRateImportResultFields).annotate({
  identifier: "ExchangeRateImportResult",
});

const refusalDescription =
  "A malformed body, or a whole-file problem; the body is then the result with " +
  "`fileError` and `error` set.";

/** The body of a whole-file refusal: the result, with `error` beside `fileError`. */
export const ExchangeRateImportRefusalBody = Schema.Struct({
  ...exchangeRateImportResultFields,
  error: Schema.String,
});

/** The 400 an import answers: a malformed body, or the result of a refused file. */
export class ExchangeRateImportRefusal extends Schema.Error<ExchangeRateImportRefusal>(
  "infrawrench/http/currency/ExchangeRateImportRefusal",
)(
  { ...exchangeRateImportResultFields, error: Schema.String },
  { httpApiStatus: 400, identifier: "ExchangeRateImportRefusal", description: refusalDescription },
) {}

/** What a rate delete answers; the hand-written spec said `ok: boolean`, never the `Ok` literal. */
const RateDeleted = Schema.Struct({ ok: Schema.Boolean });

/** The query a hand-parsed handler reads as-is; see `documentedAs`. */
const optionalQuery = <S extends Schema.Top>(doc: S) => Schema.optionalKey(documentedAs(doc));

export class CurrencyGroup extends HttpApiGroup.make("currency")
  .add(
    HttpApiEndpoint.get("get", "/", {
      params: OrgParams,
      success: CurrencyConfig,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "The org's currency settings, exchange rate table and feed state")
      .annotate(
        OpenApi.Description,
        "Readable with `costs:read` rather than a settings permission: anyone who can see a " +
          "converted total has to be able to see what it was converted at, or the number is " +
          "unauditable. `feed` reports the automatic ECB reference-rate feed (global, the same " +
          "for every organization): its newest publication, its coverage and its last error.",
      )
      .annotate(SuccessDescription, "Currency settings and rates"),
    HttpApiEndpoint.put("update", "/", {
      params: OrgParams,
      payload: CurrencySettingsInput,
      success: CurrencySettings,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Save the org's currency settings")
      .annotate(
        OpenApi.Description,
        "Setting a display currency opts the organization into converted totals; `null` turns " +
          "conversion off everywhere and restores the per-currency view. Clearing does not delete " +
          "the rate table, so conversion can be turned back on without re-stating anything. With " +
          "`autoRates` off, only currencies with a stated rate are converted; with it on, the " +
          "daily ECB reference rates fill the days no stated rate covers.",
      )
      .annotate(SuccessDescription, "Saved")
      .annotate(InvalidRequestMessage, "Invalid currency settings"),
    HttpApiEndpoint.get("lookup", "/lookup", {
      params: OrgParams,
      query: {
        from: optionalQuery(CurrencyCode),
        to: optionalQuery(CurrencyCode),
        date: optionalQuery(Day),
      },
      success: ExchangeRateLookup,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Which rate a day of spend converts at")
      .annotate(
        OpenApi.Description,
        "Applies the organization's precedence (a stated rate covering the day, else the " +
          "automatic feed when on, at the day or month-end rate per `rateBasis`) and explains the " +
          "outcome. `to` defaults to the display currency; `date` defaults to today.",
      )
      .annotate(SuccessDescription, "The applicable rate, or none")
      .annotate(OpenApi.Transform, requiredQuery(["from"])),
    HttpApiEndpoint.get("feed", "/feed", {
      params: OrgParams,
      query: { date: optionalQuery(Day), base: optionalQuery(CurrencyCode) },
      success: FxFeedRates,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Automatic reference rates for one day")
      .annotate(
        OpenApi.Description,
        "Every rate the ECB feed holds for `date` (default today; weekends and holidays carry the " +
          "last publication), expressed in `base` (default the display currency, else EUR), plus " +
          "the feed's state. Readable whether or not the organization has automatic rates on.",
      )
      .annotate(SuccessDescription, "Feed rates"),
    HttpApiEndpoint.put("upsertRate", "/rates", {
      params: OrgParams,
      payload: ExchangeRateInput,
      success: ExchangeRate,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Create or replace one exchange rate")
      .annotate(
        OpenApi.Description,
        "Upserts on (`fromCurrency`, `toCurrency`, `effectiveFrom`): one rate per pair per day, " +
          "so correcting a rate replaces it rather than adding a second one whose precedence a " +
          "reader would have to guess. Stated rates are one hop to the display currency and are " +
          "never inverted or chained. A stated rate always wins over the automatic feed for the " +
          "days it covers; give it an `effectiveTo` to hand the days after back to the feed.",
      )
      .annotate(SuccessDescription, "Saved")
      .annotate(InvalidRequestMessage, "Invalid exchange rate"),
    HttpApiEndpoint.get("rateTemplate", "/rates/template", {
      params: OrgParams,
      success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/csv" })),
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "CSV template for uploading exchange rates")
      .annotate(
        OpenApi.Description,
        "The header row `POST /currency/rates/import` reads, plus one example row per shape: an " +
          "open-ended rate, a bounded override, and a `billing_period` row.",
      )
      .annotate(SuccessDescription, "The template"),
    HttpApiEndpoint.post("importRates", "/rates/import", {
      params: OrgParams,
      payload: ExchangeRateImportRequest,
      success: ExchangeRateImportResult,
      error: ExchangeRateImportRefusal,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Upload many exchange rates from a CSV")
      .annotate(
        OpenApi.Description,
        "Upserts every row on (`fromCurrency`, `toCurrency`, `effectiveFrom`), exactly as the " +
          "single-rate PUT does, in one transaction. Send `dryRun: true` first to see each row " +
          "classified (`create`, `update`, `unchanged`, `error` with the reason); an upload with an " +
          "invalid row writes nothing unless `skipInvalid` is set. Uploaded rates are ordinary " +
          "stated rates: they win over the automatic feed for the days they cover, and a " +
          "`billing_period` row (or an `effective_to`) hands the days after it back to the next " +
          "rate or the feed. Requires `org:settings:write`; applied uploads are audit-logged as " +
          "`exchange_rate.import`.",
      )
      .annotate(SuccessDescription, "The preview, or the applied upload")
      .annotate(InvalidRequestMessage, "Invalid exchange rate upload"),
    HttpApiEndpoint.delete("deleteRate", "/rates/:rateId", {
      params: { orgId: OrgId, rateId: Schema.String },
      success: RateDeleted,
      error: NotFound,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Delete one exchange rate")
      .annotate(
        OpenApi.Description,
        "Removing a rate makes the days it covered fall back to the next-older rate, then the " +
          "automatic feed when on, or to unconverted if none applies. Spend never disappears: it " +
          "reverts to its own currency.",
      )
      .annotate(SuccessDescription, "Deleted"),
  )
  .prefix("/api/org/:orgId/currency")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Currency") {}

export class CurrencyApi extends withApiDefaults(HttpApi.make("currency").add(CurrencyGroup)) {}
