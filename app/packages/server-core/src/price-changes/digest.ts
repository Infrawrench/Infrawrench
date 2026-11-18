/**
 * The weekly digest's price-changes line: changes over the org's thresholds
 * that took effect during the reported week, plus any found during it that
 * take effect later. Never the reason a digest fails to send.
 */
import { and, eq, gte, lt, or } from "drizzle-orm";
import {
  priceChangeSentence,
  sortPriceChanges,
  summarizePriceChanges,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { priceChangeEvents } from "../db/schema";
import type { DigestPriceChanges, DigestWindow } from "../digest/compose";
import { namePriceChanges } from "./feed";
import { getPriceChangeSettings } from "./settings";

export async function digestPriceChanges(
  organizationId: string,
  window: DigestWindow,
  now = new Date(),
): Promise<DigestPriceChanges | null> {
  try {
    const from = new Date(`${window.weekStart}T00:00:00Z`);
    const to = new Date(Date.parse(`${window.weekEnd}T00:00:00Z`) + 86_400_000);
    const [settings, rows] = await Promise.all([
      getPriceChangeSettings(organizationId),
      db
        .select()
        .from(priceChangeEvents)
        .where(
          and(
            eq(priceChangeEvents.organizationId, organizationId),
            or(
              and(gte(priceChangeEvents.effectiveAt, from), lt(priceChangeEvents.effectiveAt, to)),
              and(
                gte(priceChangeEvents.effectiveAt, to),
                gte(priceChangeEvents.detectedAt, from),
                lt(priceChangeEvents.detectedAt, to),
              ),
            ),
          ),
        ),
    ]);
    if (!settings.enabled || rows.length === 0) return null;
    const changes = (await namePriceChanges(organizationId, rows, now, settings)).filter(
      (c) => !c.belowThreshold,
    );
    if (changes.length === 0) return null;
    const summary = summarizePriceChanges(changes);
    const [largest] = sortPriceChanges(changes);
    return {
      count: summary.count,
      increases: summary.increases,
      decreases: summary.decreases,
      netMonthlyUsd: summary.netMonthlyUsd,
      largest: largest ? priceChangeSentence(largest) : null,
    };
  } catch (err) {
    console.error(`[digest] price changes for org ${organizationId} failed:`, err);
    return null;
  }
}
