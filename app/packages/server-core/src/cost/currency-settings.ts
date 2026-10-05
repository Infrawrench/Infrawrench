/**
 * Read/write side of `org_currency_settings` and `org_exchange_rates`: the
 * opt-in display currency, the automatic-rates switch and basis, and the rate
 * table the org states for itself. Also the one loader every converter uses
 * (`loadOrgRateBook`), which joins the stated rates with the global feed.
 *
 * The conversion arithmetic is not here. It lives in `./currency-convert.ts`,
 * which is pure and has no db import, so the rate-selection rules can be tested
 * exhaustively without a database. This module is the boring half: load, upsert,
 * delete, and normalize.
 *
 * A missing settings row and a row with a null `displayCurrency` are the same
 * thing ("do not convert") which is what every org that has never opened the
 * form gets, and what makes this feature byte-identically absent by default.
 */
import { and, asc, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  EXCHANGE_RATE_BASES,
  EXCHANGE_RATE_LIMITS,
  normalizeCurrencyCode,
  type ExchangeRate,
  type ExchangeRateBasis,
  type ExchangeRateInput,
  type ExchangeRateLookup,
  type OrgCurrencyConfig,
  type OrgCurrencySettings,
  type OrgCurrencySettingsInput,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { orgCurrencySettings, orgExchangeRates } from "../db/schema";
import { RateBook } from "./currency-convert";
import { getFxFeedSnapshot, getFxFeedStatus } from "./fx-feed-store";

export type { ExchangeRate, ExchangeRateInput, OrgCurrencyConfig, OrgCurrencySettings };

/** Invalid caller input: routes map this to a 400. */
export class CurrencySettingsError extends Error {}

type RateRow = typeof orgExchangeRates.$inferSelect;

function toRate(row: RateRow): ExchangeRate {
  return {
    id: row.id,
    fromCurrency: row.fromCurrency,
    toCurrency: row.toCurrency,
    // `numeric` comes back as the exact decimal string the org typed. It stays
    // a string all the way to the form; see the column JSDoc for why.
    rate: row.rate,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The org's display currency. A missing row reads as null ("do not convert")
 * so an org that predates this table behaves exactly as it always did.
 */
export async function getOrgCurrencySettings(organizationId: string): Promise<OrgCurrencySettings> {
  const [row] = await db
    .select({
      displayCurrency: orgCurrencySettings.displayCurrency,
      autoRates: orgCurrencySettings.autoRates,
      rateBasis: orgCurrencySettings.rateBasis,
    })
    .from(orgCurrencySettings)
    .where(eq(orgCurrencySettings.organizationId, organizationId));
  return toSettings(row);
}

function toBasis(raw: string | null | undefined): ExchangeRateBasis {
  return (EXCHANGE_RATE_BASES as readonly string[]).includes(raw ?? "")
    ? (raw as ExchangeRateBasis)
    : "daily";
}

function toSettings(
  row: { displayCurrency: string | null; autoRates: boolean; rateBasis: string } | undefined,
): OrgCurrencySettings {
  return {
    displayCurrency: row?.displayCurrency ?? null,
    autoRates: row?.autoRates ?? false,
    rateBasis: toBasis(row?.rateBasis),
  };
}

/**
 * Save the currency settings. Creates the row on first use. `autoRates` and
 * `rateBasis` left undefined keep their stored values, so an older client
 * that only knows about the display currency cannot reset them.
 */
export async function setOrgCurrencySettings(
  organizationId: string,
  input: OrgCurrencySettingsInput,
  now = new Date(),
): Promise<OrgCurrencySettings> {
  let code: string | null = null;
  if (input.displayCurrency !== null) {
    code = normalizeCurrencyCode(input.displayCurrency);
    if (!code) {
      throw new CurrencySettingsError(
        `"${input.displayCurrency}" is not a currency code; expected three letters, e.g. USD.`,
      );
    }
  }
  if (input.rateBasis !== undefined && !EXCHANGE_RATE_BASES.includes(input.rateBasis)) {
    throw new CurrencySettingsError(`rateBasis must be one of ${EXCHANGE_RATE_BASES.join(", ")}.`);
  }

  const set: Partial<typeof orgCurrencySettings.$inferInsert> = {
    displayCurrency: code,
    updatedAt: now,
  };
  if (input.autoRates !== undefined) set.autoRates = input.autoRates;
  if (input.rateBasis !== undefined) set.rateBasis = input.rateBasis;

  const [row] = await db
    .insert(orgCurrencySettings)
    .values({
      organizationId,
      displayCurrency: code,
      autoRates: input.autoRates ?? false,
      rateBasis: input.rateBasis ?? "daily",
    })
    .onConflictDoUpdate({ target: orgCurrencySettings.organizationId, set })
    .returning({
      displayCurrency: orgCurrencySettings.displayCurrency,
      autoRates: orgCurrencySettings.autoRates,
      rateBasis: orgCurrencySettings.rateBasis,
    });
  if (!row) throw new Error("Failed to save currency settings");
  return toSettings(row);
}

/** Set (or clear, with null) the display currency alone. */
export async function setOrgDisplayCurrency(
  organizationId: string,
  displayCurrency: string | null,
  now = new Date(),
): Promise<OrgCurrencySettings> {
  return setOrgCurrencySettings(organizationId, { displayCurrency }, now);
}

/**
 * Every rate the org has stated, newest effective date first: the order the
 * editor shows and the order lookup wants.
 */
export async function listOrgExchangeRates(organizationId: string): Promise<ExchangeRate[]> {
  const rows = await db
    .select()
    .from(orgExchangeRates)
    .where(eq(orgExchangeRates.organizationId, organizationId))
    .orderBy(
      asc(orgExchangeRates.fromCurrency),
      desc(orgExchangeRates.effectiveFrom),
      asc(orgExchangeRates.toCurrency),
    );
  return rows.map(toRate);
}

/**
 * Settings, the whole rate table, and the feed's state: one round trip for the
 * settings page.
 */
export async function getOrgCurrencyConfig(organizationId: string): Promise<OrgCurrencyConfig> {
  const [settings, rates, feed] = await Promise.all([
    getOrgCurrencySettings(organizationId),
    listOrgExchangeRates(organizationId),
    getFxFeedStatus(),
  ]);
  return { ...settings, rates, feed };
}

/**
 * Every rate the org can convert at, as a `RateBook`: its stated rates, plus
 * the global feed history when automatic rates are on. The single loader for
 * every converter (graphs, budgets, digest, invoices, showback), so they all
 * apply the same precedence.
 *
 * `settings` may be passed by a caller that has already read them.
 */
export async function loadOrgRateBook(
  organizationId: string,
  settings?: OrgCurrencySettings,
): Promise<RateBook> {
  const resolved = settings ?? (await getOrgCurrencySettings(organizationId));
  const [manual, feed] = await Promise.all([
    listOrgExchangeRates(organizationId),
    resolved.autoRates ? getFxFeedSnapshot() : Promise.resolve(null),
  ]);
  return new RateBook({ manual, feed, basis: resolved.rateBasis });
}

/**
 * The rates a cost query needs: the display currency and the org's rate book,
 * in one call, so every reader converts against the same snapshot.
 *
 * Returns a null display currency when the org has not opted in, which is the
 * signal the pure converter takes to do nothing at all.
 */
export async function loadConversionContext(
  organizationId: string,
  requested?: string | undefined,
): Promise<{ displayCurrency: string | null; rates: RateBook }> {
  const none = { displayCurrency: null, rates: RateBook.manualOnly([]) };
  // No request, no conversion: the caller has to ask, every time. A stored
  // display currency alone must never start converting a caller that did not
  // opt in (the MCP tools and older clients among them).
  if (!requested) return none;

  const settings = await getOrgCurrencySettings(organizationId);
  // The org's configured currency is authoritative. A request naming a
  // different one is honoured only if the org has actually configured that
  // currency, otherwise there are no rates pointing at it and conversion
  // would report everything unconverted, which is noise rather than an answer.
  if (!settings.displayCurrency) return none;
  const wanted = normalizeCurrencyCode(requested);
  if (!wanted || wanted !== settings.displayCurrency) return none;

  return {
    displayCurrency: settings.displayCurrency,
    rates: await loadOrgRateBook(organizationId, settings),
  };
}

/**
 * What a day of spend in `from` would convert to `to` at, after the org's
 * precedence rules, with a plain-English explanation. Backs
 * `GET /currency/lookup`, the CLI and the MCP tool. `to` defaults to the
 * display currency.
 */
export async function lookupOrgExchangeRate(
  organizationId: string,
  query: { from: string; to?: string | undefined; date: string },
): Promise<ExchangeRateLookup> {
  const from = normalizeCurrencyCode(query.from);
  if (!from) throw new CurrencySettingsError("from must be a three-letter currency code.");
  if (!ISO_DAY.test(query.date)) throw new CurrencySettingsError("date must be YYYY-MM-DD.");
  const settings = await getOrgCurrencySettings(organizationId);
  const to = query.to ? normalizeCurrencyCode(query.to) : settings.displayCurrency;
  if (!to) {
    throw new CurrencySettingsError(
      query.to
        ? "to must be a three-letter currency code."
        : "No display currency is set; pass `to` to name the target currency.",
    );
  }
  const book = await loadOrgRateBook(organizationId, settings);
  const { resolved, text } = book.explain(from, to, query.date);
  return {
    fromCurrency: from,
    toCurrency: to,
    date: query.date,
    rateBasis: settings.rateBasis,
    rate: resolved?.rate ?? null,
    source: resolved?.source ?? null,
    rateDate: resolved?.effectiveFrom ?? null,
    manualRateId: resolved?.manualRateId ?? null,
    explanation: text,
  };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Validate and normalize a rate body, or throw a `CurrencySettingsError`. */
function normalizeInput(
  input: ExchangeRateInput,
): Required<Omit<ExchangeRateInput, "effectiveTo">> & { effectiveTo: string | null } {
  const fromCurrency = normalizeCurrencyCode(input.fromCurrency ?? "");
  const toCurrency = normalizeCurrencyCode(input.toCurrency ?? "");
  if (!fromCurrency || !toCurrency) {
    throw new CurrencySettingsError(
      "fromCurrency and toCurrency must be three-letter codes, e.g. EUR and USD.",
    );
  }
  if (fromCurrency === toCurrency) {
    throw new CurrencySettingsError(
      `A rate from ${fromCurrency} to itself has no meaning: spend already in the display currency is never converted.`,
    );
  }
  if (typeof input.effectiveFrom !== "string" || !ISO_DAY.test(input.effectiveFrom)) {
    throw new CurrencySettingsError("effectiveFrom must be a YYYY-MM-DD date.");
  }
  const effectiveTo = input.effectiveTo ?? null;
  if (effectiveTo !== null) {
    if (typeof effectiveTo !== "string" || !ISO_DAY.test(effectiveTo)) {
      throw new CurrencySettingsError("effectiveTo must be a YYYY-MM-DD date or null.");
    }
    if (effectiveTo < input.effectiveFrom) {
      throw new CurrencySettingsError("effectiveTo must be on or after effectiveFrom.");
    }
  }

  const raw = String(input.rate ?? "").trim();
  const value = Number(raw);
  if (raw === "" || !Number.isFinite(value)) {
    throw new CurrencySettingsError("rate must be a decimal number.");
  }
  if (value < EXCHANGE_RATE_LIMITS.rateMin || value > EXCHANGE_RATE_LIMITS.rateMax) {
    // Zero and negatives land here. A zero rate would erase a currency's spend
    // from the total while still reporting it as converted: the exact silent
    // understatement this feature exists to prevent.
    throw new CurrencySettingsError(
      `rate must be greater than 0 and at most ${EXCHANGE_RATE_LIMITS.rateMax}.`,
    );
  }

  return { fromCurrency, toCurrency, rate: raw, effectiveFrom: input.effectiveFrom, effectiveTo };
}

/**
 * Create or replace the rate for (org, from, to, effectiveFrom).
 *
 * An upsert rather than a create: the unique index says one rate per pair per
 * day, and a finance user correcting a typo means "this is the rate", not "add
 * a second one and let the reader guess".
 */
export async function upsertOrgExchangeRate(
  organizationId: string,
  input: ExchangeRateInput,
  createdBy: string | null,
  now = new Date(),
): Promise<ExchangeRate> {
  const safe = normalizeInput(input);

  // Bounded read rather than COUNT(*): the cap is the only thing being checked,
  // so stopping at it is enough and stays cheap as the table grows.
  const existing = await db
    .select({ id: orgExchangeRates.id })
    .from(orgExchangeRates)
    .where(eq(orgExchangeRates.organizationId, organizationId))
    .limit(EXCHANGE_RATE_LIMITS.maxRates);
  if (existing.length >= EXCHANGE_RATE_LIMITS.maxRates) {
    throw new CurrencySettingsError(
      `An org can hold at most ${EXCHANGE_RATE_LIMITS.maxRates} exchange rates.`,
    );
  }

  const [row] = await db
    .insert(orgExchangeRates)
    .values({ id: randomUUID(), organizationId, createdBy, ...safe })
    .onConflictDoUpdate({
      target: [
        orgExchangeRates.organizationId,
        orgExchangeRates.fromCurrency,
        orgExchangeRates.toCurrency,
        orgExchangeRates.effectiveFrom,
      ],
      set: { rate: safe.rate, effectiveTo: safe.effectiveTo, createdBy, updatedAt: now },
    })
    .returning();
  if (!row) throw new Error("Failed to save exchange rate");
  return toRate(row);
}

/** Delete one rate. Returns false when it was already gone or another org's. */
export async function deleteOrgExchangeRate(
  organizationId: string,
  rateId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(orgExchangeRates)
    .where(
      and(eq(orgExchangeRates.organizationId, organizationId), eq(orgExchangeRates.id, rateId)),
    )
    .returning({ id: orgExchangeRates.id });
  return deleted.length > 0;
}
