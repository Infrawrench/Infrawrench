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

const CurrencySettings = strict({
  displayCurrency: CurrencyCode.nullable().openapi({
    description:
      "The currency converted amounts are expressed in, or `null` for no conversion at all. " +
      "`null` is the default and the state of every organization that has not opted in: cost " +
      "data is stored per currency and never merged unless you ask.",
  }),
}).openapi("CurrencySettings");

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
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).openapi("ExchangeRate");

const ExchangeRateInput = strict({
  fromCurrency: CurrencyCode,
  toCurrency: CurrencyCode,
  rate: RateDecimal,
  effectiveFrom: IsoDate,
}).openapi("ExchangeRateInput");

const CurrencyConfig = strict({
  displayCurrency: CurrencyCode.nullable(),
  rates: z.array(ExchangeRate),
}).openapi("CurrencyConfig");

/**
 * The conversion report every converted cost payload carries. Exported so the
 * cost-query and showback path files can attach it to their own responses —
 * a converted number that does not say it was converted is the one outcome
 * this whole surface exists to prevent.
 */
export const CostConversion = strict({
  displayCurrency: CurrencyCode,
  converted: z.array(
    strict({
      currency: CurrencyCode,
      rates: z.array(strict({ effectiveFrom: IsoDate, rate: z.number() })).openapi({
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
}).openapi("CostConversion");

export function registerCurrencyPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/currency",
    tags: ["Currency"],
    summary: "The org's display currency and exchange rate table",
    description:
      "Readable with `costs:read` rather than a settings permission: anyone who can see a " +
      "converted total has to be able to see what it was converted at, or the number is " +
      "unauditable.",
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
    summary: "Set or clear the org's display currency",
    description:
      "Setting a currency opts the organization into converted totals; `null` turns conversion " +
      "off everywhere and restores the per-currency view. Clearing does not delete the rate " +
      "table, so conversion can be turned back on without re-stating anything. Only currencies " +
      "with a configured rate are converted — Infrawrench never fetches live exchange rates.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CurrencySettings } }, required: true },
    },
    responses: {
      200: { description: "Saved", content: { "application/json": { schema: CurrencySettings } } },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/currency/rates",
    tags: ["Currency"],
    summary: "Create or replace one exchange rate",
    description:
      "Upserts on (`fromCurrency`, `toCurrency`, `effectiveFrom`) — one rate per pair per day, " +
      "so correcting a rate replaces it rather than adding a second one whose precedence a " +
      "reader would have to guess. Rates are stated to the display currency in one hop: " +
      "nothing inverts a rate or chains two, because both produce a number you never stated.",
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
      "Removing a rate makes the days it covered fall back to the next-older rate, or to " +
      "unconverted if none remains. Spend never disappears — it reverts to its own currency.",
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
