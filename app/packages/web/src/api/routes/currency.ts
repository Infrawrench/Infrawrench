import { Hono } from "hono";
import { currencySettingsSchema, exchangeRateInputSchema } from "@infrawrench/ui/cost/config";
import {
  CurrencySettingsError,
  deleteOrgExchangeRate,
  getOrgCurrencyConfig,
  lookupOrgExchangeRate,
  setOrgCurrencySettings,
  upsertOrgExchangeRate,
} from "@infrawrench/server-core/cost/currency-settings";
import { getFxFeedSnapshot, getFxFeedStatus } from "@infrawrench/server-core/cost/fx-feed-store";
import { feedRateFor, publicationIndexFor } from "@infrawrench/server-core/cost/fx-feed";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/**
 * ## Permissions on this surface
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
 */

/** GET /api/org/:orgId/currency: settings, the whole rate table, feed state. */
app.get("/", async (c) => {
  requirePermission(c, "costs:read");
  return c.json(await getOrgCurrencyConfig(c.get("organizationId")));
});

/**
 * GET /api/org/:orgId/currency/lookup?from=EUR&to=USD&date=YYYY-MM-DD
 *
 * The rate a day of spend would convert at under this org's rules (stated
 * rate first, then the feed when automatic rates are on), its source and
 * date, and a sentence explaining why. `to` defaults to the display currency.
 * Read-only, so `costs:read` like the rest of the read side.
 */
app.get("/lookup", async (c) => {
  requirePermission(c, "costs:read");
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") || undefined;
  const date = c.req.query("date") || new Date().toISOString().slice(0, 10);
  try {
    return c.json(await lookupOrgExchangeRate(c.get("organizationId"), { from, to, date }));
  } catch (e) {
    if (e instanceof CurrencySettingsError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const CODE = /^[A-Z]{3}$/;

/**
 * GET /api/org/:orgId/currency/feed?date=YYYY-MM-DD&base=USD
 *
 * The automatic feed's state plus every rate it holds for one day, expressed
 * as "1 unit of each currency in `base`" (default: the display currency, else
 * EUR). Lets the settings page, the CLI and an agent show what the feed says
 * without the org having to turn it on first. The feed is global, so this
 * reveals nothing org-specific.
 */
app.get("/feed", async (c) => {
  requirePermission(c, "costs:read");
  const date = c.req.query("date") || new Date().toISOString().slice(0, 10);
  if (!ISO_DAY.test(date)) return c.json({ error: "date must be YYYY-MM-DD" }, 400);
  const requestedBase = (c.req.query("base") ?? "").trim().toUpperCase();
  if (requestedBase && !CODE.test(requestedBase)) {
    return c.json({ error: "base must be a three-letter currency code" }, 400);
  }
  const [status, snapshot, config] = await Promise.all([
    getFxFeedStatus(),
    getFxFeedSnapshot(),
    requestedBase ? Promise.resolve(null) : getOrgCurrencyConfig(c.get("organizationId")),
  ]);
  const base = requestedBase || config?.displayCurrency || "EUR";
  const index = publicationIndexFor(snapshot, date);
  const rateDate = index >= 0 ? snapshot.dates[index]! : null;
  const rates = status.currencies
    .filter((code) => code !== base)
    .flatMap((code) => {
      const found = feedRateFor(snapshot, code, base, date);
      return found ? [{ currency: code, rate: found.rate }] : [];
    });
  return c.json({ ...status, date, base, rateDate, rates });
});

/**
 * PUT /api/org/:orgId/currency: save the currency settings.
 *
 * `displayCurrency: null` clears it, which turns conversion off everywhere and
 * restores the per-currency view. Clearing is not a destructive act on the
 * rate table: the rates stay, so an org can turn conversion off and back on
 * without re-typing everything it has stated. `autoRates` and `rateBasis` are
 * optional; omitted keeps the stored value.
 */
app.put("/", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = currencySettingsSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid currency settings", issues: parsed.error.issues }, 400);
  }

  try {
    const saved = await setOrgCurrencySettings(organizationId, parsed.data);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "currency_settings.update",
      entityType: "currency_settings",
      entityId: organizationId,
      metadata: {
        displayCurrency: saved.displayCurrency,
        autoRates: saved.autoRates,
        rateBasis: saved.rateBasis,
      },
    });
    return c.json(saved);
  } catch (e) {
    if (e instanceof CurrencySettingsError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

/**
 * PUT /api/org/:orgId/currency/rates: create or replace one rate.
 *
 * An upsert keyed on (from, to, effectiveFrom): the unique index says one rate
 * per pair per day, and correcting a typo means "this is the rate", not "add a
 * second one and let the reader guess which applied".
 */
app.put("/rates", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = exchangeRateInputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid exchange rate", issues: parsed.error.issues }, 400);
  }

  try {
    const rate = await upsertOrgExchangeRate(organizationId, parsed.data, session.userId);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "exchange_rate.upsert",
      entityType: "exchange_rate",
      entityId: rate.id,
      metadata: {
        fromCurrency: rate.fromCurrency,
        toCurrency: rate.toCurrency,
        rate: rate.rate,
        effectiveFrom: rate.effectiveFrom,
        effectiveTo: rate.effectiveTo,
      },
    });
    return c.json(rate);
  } catch (e) {
    if (e instanceof CurrencySettingsError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

/** DELETE /api/org/:orgId/currency/rates/:rateId: drop one stated rate. */
app.delete("/rates/:rateId", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const rateId = c.req.param("rateId");

  const deleted = await deleteOrgExchangeRate(organizationId, rateId);
  if (!deleted) return c.json({ error: "Exchange rate not found" }, 404);

  void logAudit({
    organizationId,
    userId: session.userId,
    action: "exchange_rate.delete",
    entityType: "exchange_rate",
    entityId: rateId,
    metadata: {},
  });
  return c.json({ ok: true });
});

export { app as currencyRoutes };
