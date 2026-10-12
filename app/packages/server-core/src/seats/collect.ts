/**
 * Collect the paid-seat inventory for one account.
 *
 * The `commitments/collect.ts` shape: the host owns scheduling, storage and
 * findings; the plugin owns the provider calls. A collection is a full
 * snapshot (the plugin contract throws rather than returning a partial list),
 * so storage is an upsert per seat plus a sweep of seats the provider stopped
 * reporting.
 *
 * Before the sweep, the previous inventory is classified with the org's
 * current threshold: a seat that was a finding and is now gone, or newly
 * pending removal, or moved to the tier its downgrade finding suggested, was
 * acted on, wherever that happened. That is recorded as a `detected` realized
 * saving under the same dedupe key the in-app Remove uses.
 */
import { randomUUID } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { computeSeatFindings } from "@infrawrench/client-core";
import { normalizeSeatRecords } from "@infrawrench/plugin-base";

import { db } from "../db/client";
import { accountSeatPolls, accountSeats } from "../db/schema";
import { loadAccountClient } from "../sync-resources";
import { actedOnFindings } from "./acted";
import { captureSeatSaving } from "./capture";
import { getSeatSettings } from "./settings";
import { loadOrgSeats, seatRowFromDb } from "./store";

export interface SeatCollectionResult {
  seatCount: number;
  /** Savings recorded for seats acted on since the last collection. */
  detectedSavings: number;
}

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at);
}

/**
 * Fetch and store the account's seats. Throws on failure: the poller's seats
 * pass owns backoff and the error write.
 */
export async function collectAccountSeats(
  accountId: string,
  organizationId: string,
): Promise<SeatCollectionResult> {
  const { account, plugin, client } = await loadAccountClient(accountId, organizationId);
  if (!plugin.manifest.seats || !client.fetchSeats) {
    throw new Error(`Plugin "${account.pluginId}" does not list seats`);
  }
  const settings = await getSeatSettings(organizationId);
  const records = normalizeSeatRecords(
    await client.fetchSeats(accountId, { lookbackDays: settings.inactiveDays }),
  );
  const collectedAt = new Date();

  const previousRows = await db
    .select()
    .from(accountSeats)
    .where(eq(accountSeats.accountId, accountId));
  const names = { accountName: account.displayName, pluginName: plugin.manifest.displayName };
  const previous = previousRows.map((row) => seatRowFromDb(row, names));
  // Classify against the whole org: a duplicate's other half lives on
  // another account, and only the org-wide inventory knows it was one.
  const org = await loadOrgSeats(organizationId, null);
  const orgFindings = computeSeatFindings(org.rows, {
    inactiveDays: settings.inactiveDays,
    now: collectedAt.getTime(),
  }).findings;
  const previousIds = new Set(previous.map((s) => s.id));
  const acted = actedOnFindings(
    previous,
    orgFindings.filter((f) => previousIds.has(f.seatId)),
    records,
  );

  for (const record of records) {
    const values = {
      organizationId,
      accountId,
      pluginId: account.pluginId,
      memberId: record.memberId,
      seatKey: record.seatKey ?? "",
      name: record.name,
      email: record.email,
      login: record.login ?? null,
      product: record.product,
      category: record.category,
      seatType: record.seatType,
      monthlyPrice: record.price?.monthly ?? null,
      currency: record.price?.currency ?? null,
      priceSource: record.price?.source ?? null,
      priceNote: record.price?.note ?? null,
      activityBasis: record.activity.basis,
      lastActiveAt: toDate(record.activity.lastActiveAt),
      activityWindowDays: record.activity.windowDays ?? null,
      activitySource: record.activity.source,
      assignedAt: toDate(record.assignedAt),
      pendingRemovalOn: toDate(record.pendingRemovalOn),
      removable: record.removable && plugin.manifest.seats.removal === true,
      removalNote: record.removalNote ?? null,
      downgrade: record.downgrade ?? null,
      context: record.context ?? null,
      resourceTypeId: record.resource?.resourceTypeId ?? null,
      externalId: record.resource?.externalId ?? null,
      lastSeenAt: collectedAt,
      updatedAt: collectedAt,
    };
    await db
      .insert(accountSeats)
      .values({ id: randomUUID(), ...values })
      .onConflictDoUpdate({
        target: [accountSeats.accountId, accountSeats.memberId, accountSeats.seatKey],
        set: values,
      });
  }

  // Safe because the fetch either returned the provider's full list or threw.
  await db
    .delete(accountSeats)
    .where(and(eq(accountSeats.accountId, accountId), lt(accountSeats.lastSeenAt, collectedAt)));

  let detectedSavings = 0;
  for (const { seat, finding, action } of acted) {
    const id = await captureSeatSaving({
      organizationId,
      seat,
      action,
      findingKind: finding.kind,
      source: "detected",
      now: collectedAt,
    });
    if (id) detectedSavings += 1;
  }
  return { seatCount: records.length, detectedSavings };
}

/** Record a successful collection: clear the error, schedule the next read. */
export async function markSeatPollSuccess(
  accountId: string,
  organizationId: string,
  nextPollAt: Date,
): Promise<void> {
  const values = {
    organizationId,
    lastPolledAt: new Date(),
    nextPollAt,
    failureCount: 0,
    lastError: null,
  };
  await db
    .insert(accountSeatPolls)
    .values({ accountId, ...values })
    .onConflictDoUpdate({ target: accountSeatPolls.accountId, set: values });
}

/** Record a failure and back off; the Seats section shows the message verbatim. */
export async function markSeatPollFailure(
  accountId: string,
  organizationId: string,
  error: unknown,
  nextPollAt: Date,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const [existing] = await db
    .select({ failureCount: accountSeatPolls.failureCount })
    .from(accountSeatPolls)
    .where(eq(accountSeatPolls.accountId, accountId))
    .limit(1);
  const values = {
    organizationId,
    nextPollAt,
    failureCount: (existing?.failureCount ?? 0) + 1,
    lastError: message.slice(0, 500),
  };
  await db
    .insert(accountSeatPolls)
    .values({ accountId, ...values })
    .onConflictDoUpdate({ target: accountSeatPolls.accountId, set: values });
}

/**
 * Make every seat-capable account in the org due now (the section's Refresh).
 * Returns how many were queued. Accounts with no poll row yet are already due.
 */
export async function requestSeatRefresh(organizationId: string): Promise<number> {
  const rows = await db
    .update(accountSeatPolls)
    .set({ nextPollAt: new Date() })
    .where(eq(accountSeatPolls.organizationId, organizationId))
    .returning({ accountId: accountSeatPolls.accountId });
  return rows.length;
}
