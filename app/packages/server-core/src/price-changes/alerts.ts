/**
 * The price-change watch's poller pass: once a day per org, scan the org's
 * running instance types against the warehouse's price history, store each
 * change, and raise **one alert per change** (never one per resource) through
 * alert routing under the `priceChangeAlerts` trigger.
 *
 * - A change is alerted once, when it first clears the org's thresholds
 *   while it is still news (upcoming, or within
 *   `PRICE_CHANGE_ALERT_WINDOW_DAYS` of taking effect). Older ones are
 *   recorded and listed, never paged about.
 * - An alerted increase is registered as expected: a one-off anomaly
 *   suppression per affected account from the day the price takes effect,
 *   reason `pricing_change`, so cost anomaly detection does not fire on the
 *   step. Decreases need none (anomaly detection flags spikes).
 *
 * The claim/cooldown protocol is the shared engine in `../alerts/daily-window.ts`
 * with a one-day window. Gateway runtime: `instancePricingUsage` is plugin
 * code. Never throws: errors are logged with the `[price-changes]` prefix.
 */
import { and, count, eq, gte } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  COST_ANOMALY_FEEDBACK_LIMITS,
  defaultSuppressionExpiry,
  formatPriceChangeHourly,
  formatPriceChangePercent,
  formatPriceChangeUsd,
  priceChangeCrossesThreshold,
  priceChangeDay,
  priceChangePercent,
  priceChangeSentence,
  priceChangeSubject,
  PRICE_CHANGE_ALERT_WINDOW_DAYS,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { costAnomalySuppressions, orgPriceChangeSettings, priceChangeEvents } from "../db/schema";
import { routeAlert } from "../alerts/route";
import {
  dailyWindowStore,
  runDailyAlertWindows,
  type DailyWindowOutcome,
  type DailyWindowResult,
  type WindowDelivery,
} from "../alerts/daily-window";
import { orgAppUrl } from "../app-url";
import { scanOrgPriceChanges, type PriceChangeEventRow } from "./detect";
import { namePriceChanges } from "./feed";
import { getPriceChangeSettings, type PriceChangeSettingsRecord } from "./settings";
import { priceWarehouse, type WarehouseRows } from "./warehouse";

/** Least time between scans for one org. */
export const PRICE_CHANGE_SCAN_COOLDOWN_MS = 24 * 60 * 60 * 1000;

type PriceChangeScanOutcome =
  { status: "unavailable" } | { status: "scanned"; changes: number; alerted: number };

export type PriceChangeOrgOutcome = DailyWindowOutcome<PriceChangeScanOutcome>;
export type PriceChangeAlertsResult = DailyWindowResult<PriceChangeScanOutcome>;

const store = dailyWindowStore<PriceChangeSettingsRecord>({
  table: orgPriceChangeSettings,
  cooldownMs: PRICE_CHANGE_SCAN_COOLDOWN_MS,
  claimValues: (organizationId, settings, now) => ({
    organizationId,
    enabled: settings.enabled,
    minMonthlyImpactCents: settings.minMonthlyImpactCents,
    minPercent: settings.minPercent,
    registerExpected: settings.registerExpected,
    lastNotifiedAt: now,
  }),
});

/** Whether a stored change should be alerted now. */
export function shouldAlertPriceChange(
  row: Pick<
    PriceChangeEventRow,
    "alertedAt" | "effectiveAt" | "oldHourlyUsd" | "newHourlyUsd" | "monthlyImpactUsd"
  >,
  settings: Pick<PriceChangeSettingsRecord, "minMonthlyImpactCents" | "minPercent">,
  now: Date,
): boolean {
  if (row.alertedAt) return false;
  const oldest = now.getTime() - PRICE_CHANGE_ALERT_WINDOW_DAYS * 86_400_000;
  if (row.effectiveAt.getTime() < oldest) return false;
  return priceChangeCrossesThreshold(
    {
      monthlyImpactUsd: row.monthlyImpactUsd,
      percent: priceChangePercent(row.oldHourlyUsd, row.newHourlyUsd),
    },
    settings,
  );
}

/**
 * Register an increase as expected: one one-off suppression per affected
 * account, from the day it takes effect, for the standard one-off lifetime.
 * Stops quietly at the org's active-suppression cap rather than failing the
 * alert. Returns the ids created.
 */
export async function registerExpectedPriceChange(
  organizationId: string,
  row: PriceChangeEventRow,
  now: Date,
): Promise<string[]> {
  if (row.monthlyImpactUsd <= 0) return [];
  const day = priceChangeDay(row.effectiveAt.toISOString());
  const today = now.toISOString().slice(0, 10);
  const accountIds = [...new Set(row.resources.map((r) => r.accountId))];
  const [active] = await db
    .select({ n: count() })
    .from(costAnomalySuppressions)
    .where(
      and(
        eq(costAnomalySuppressions.organizationId, organizationId),
        gte(costAnomalySuppressions.expiresOn, today),
      ),
    );
  let room = COST_ANOMALY_FEEDBACK_LIMITS.maxActiveSuppressions - Number(active?.n ?? 0);
  const ids: string[] = [];
  const note =
    `List price change: ${priceChangeSubject(row)} ` +
    `${formatPriceChangeHourly(row.oldHourlyUsd)} to ${formatPriceChangeHourly(row.newHourlyUsd)}`;
  for (const accountId of accountIds) {
    if (room <= 0) {
      console.warn(
        `[price-changes] org ${organizationId} is at the active suppression cap; ` +
          `change ${row.id} is not registered as expected for account ${accountId}`,
      );
      break;
    }
    const id = randomUUID();
    await db.insert(costAnomalySuppressions).values({
      id,
      organizationId,
      scope: "account",
      scopeKey: accountId,
      tagKey: null,
      recurrence: "one_off",
      anchorDay: day,
      startsOn: day,
      expiresOn: defaultSuppressionExpiry("one_off", day),
      reason: "pricing_change",
      note: note.slice(0, COST_ANOMALY_FEEDBACK_LIMITS.noteMaxLength),
      createdByUserId: null,
    });
    ids.push(id);
    room--;
  }
  return ids;
}

/** Route one change's alert, register it as expected, and stamp it. Returns deliveries. */
async function alertOne(
  organizationId: string,
  row: PriceChangeEventRow,
  settings: PriceChangeSettingsRecord,
  now: Date,
): Promise<number> {
  const [change] = await namePriceChanges(organizationId, [row], now, settings);
  if (!change) return 0;
  const sentence = priceChangeSentence(change);
  const names = change.resources.map((r) => r.displayName);
  const shown = names.slice(0, 5).join(", ");
  const more = row.resources.length - Math.min(names.length, 5);
  const resourcesLine = `Affected: ${shown}${more > 0 ? ` and ${more} more` : ""}`;
  const increase = row.monthlyImpactUsd > 0;
  const title = `${increase ? "Price increase" : "Price cut"}: ${row.instanceType} ${formatPriceChangePercent(change.percent)}`;
  const accountIds = [...new Set(row.resources.map((r) => r.accountId))];
  const routed = await routeAlert({
    organizationId,
    trigger: "priceChangeAlerts",
    severity: increase ? "warning" : "info",
    title,
    body: `${sentence}.\n${resourcesLine}`,
    pushBody: `${formatPriceChangeUsd(row.monthlyImpactUsd, { signed: true })}/mo: ${sentence}`,
    context: "Published list prices, not your discounts or negotiated rates.",
    url: orgAppUrl(organizationId, "price-catalog/changes"),
    pushData: { type: "price_change", orgId: organizationId, changeId: row.id },
    facts: {
      pluginId: row.pluginId,
      amountCents: Math.round(Math.abs(row.monthlyImpactUsd) * 100),
      currency: "USD",
      key: row.instanceType,
      ...(accountIds.length === 1 && accountIds[0] ? { accountId: accountIds[0] } : {}),
    },
  });
  const suppressionIds =
    increase && settings.registerExpected
      ? await registerExpectedPriceChange(organizationId, row, now)
      : [];
  await db
    .update(priceChangeEvents)
    .set({ alertedAt: now, suppressionIds: [...row.suppressionIds, ...suppressionIds] })
    .where(eq(priceChangeEvents.id, row.id));
  return routed.succeeded + routed.held;
}

function deliverWith(warehouse: WarehouseRows | null) {
  return async (
    organizationId: string,
    settings: PriceChangeSettingsRecord,
    now: Date,
    delivery: WindowDelivery,
  ): Promise<PriceChangeScanOutcome> => {
    if (!warehouse) {
      delivery.spent = true;
      return { status: "unavailable" };
    }
    const rows = await scanOrgPriceChanges(organizationId, warehouse, now);
    // A completed scan keeps the window: the changes are stored whether or
    // not anyone is routed to hear about them, and each alert is stamped.
    delivery.spent = true;
    let alerted = 0;
    for (const row of rows) {
      if (!shouldAlertPriceChange(row, settings, now)) continue;
      delivery.succeeded += await alertOne(organizationId, row, settings, now);
      alerted++;
    }
    return { status: "scanned", changes: rows.length, alerted };
  };
}

/** The poller pass: claim up to `limit` due orgs and scan each. */
export async function runPriceChangeAlerts(
  options: { limit?: number; warehouse?: WarehouseRows | null } = {},
  now = new Date(),
): Promise<PriceChangeAlertsResult> {
  const warehouse = options.warehouse === undefined ? priceWarehouse() : options.warehouse;
  return runDailyAlertWindows(
    {
      logPrefix: "price-changes",
      store,
      getSettings: getPriceChangeSettings,
      deliver: deliverWith(warehouse),
    },
    { limit: options.limit ?? 4 },
    now,
  );
}
