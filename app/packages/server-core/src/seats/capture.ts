/**
 * Realized savings for seats: removing an idle or duplicate seat, or moving
 * one to a cheaper tier, is a saving the realized-savings report measures.
 *
 * Two capture points, one saving: the in-app Remove records `in_app` at the
 * moment the provider accepts it, and the daily collection records `detected`
 * when a flagged seat disappears (or goes pending removal) however it was
 * removed. Both use {@link seatSavingsDedupeKey}, so the second is a no-op.
 *
 * Seats have no per-resource billing rows to measure against, so these
 * events carry price-based estimates (`baselineDailyEstimate` /
 * `postDailyEstimate`) and the report shows them under the `estimate` basis.
 * Best-effort and never throws, the `savings/capture.ts` rule: the removal
 * already happened.
 */
import {
  AVERAGE_DAYS_PER_MONTH,
  seatHolderLabel,
  seatSavingsDedupeKey,
  type SeatFindingKind,
  type SeatRow,
} from "@infrawrench/client-core";
import { isoDay } from "../cost/dates";
import { recordSavingsEvent } from "../savings/events";

export interface SeatSavingCapture {
  organizationId: string;
  seat: SeatRow;
  /** What was done: a removal (inactive or duplicate finding) or a downgrade. */
  action: "remove" | "downgrade";
  /** The finding that justified it, for the note. */
  findingKind: SeatFindingKind;
  source: "in_app" | "detected";
  userId?: string | null;
  now?: Date;
}

function noteFor(kind: SeatFindingKind): string {
  switch (kind) {
    case "inactive":
      return "Seat was inactive";
    case "duplicate":
      return "Same person held a seat on another tool in the same category";
    case "downgrade":
      return "Moved to a cheaper tier";
  }
}

/** Record the saving; returns the event id, or null when it already existed or failed. */
export async function captureSeatSaving(input: SeatSavingCapture): Promise<string | null> {
  try {
    const { seat } = input;
    const holder = seatHolderLabel(seat);
    const perDay = seat.monthlyPrice === null ? null : seat.monthlyPrice / AVERAGE_DAYS_PER_MONTH;
    let postPerDay: number | null = perDay === null ? null : 0;
    let title = `Removed ${seat.product} seat for ${holder}`;
    let dedupeKey = seatSavingsDedupeKey(seat);
    if (input.action === "downgrade") {
      const target = seat.downgrade;
      if (!target || target.price.currency !== seat.currency) return null;
      postPerDay = target.price.monthly / AVERAGE_DAYS_PER_MONTH;
      title = `Moved ${holder} to ${target.seatType}`;
      dedupeKey = `seat_downgrade:${seat.accountId}:${seat.memberId}:${target.seatType}`;
    }
    return await recordSavingsEvent({
      organizationId: input.organizationId,
      kind: "saas_seat",
      source: input.source,
      title,
      note: noteFor(input.findingKind),
      occurredOn: isoDay(input.now ?? new Date()),
      accountId: seat.accountId,
      pluginId: seat.pluginId,
      resourceTypeId: seat.resource?.resourceTypeId ?? null,
      resourceId: null,
      // No per-seat billing rows: leave the billing join empty so the report
      // measures from the price estimate rather than matching nothing.
      externalId: null,
      resourceName: `${holder} (${seat.seatType})`,
      tags: null,
      projectedMonthlyAmount:
        perDay === null || postPerDay === null
          ? null
          : (perDay - postPerDay) * AVERAGE_DAYS_PER_MONTH,
      currency: seat.currency,
      baselineDailyEstimate: perDay,
      postDailyEstimate: postPerDay,
      dedupeKey,
      createdByUserId: input.userId ?? null,
    });
  } catch (err) {
    console.warn(
      `[seats] recording saving for ${input.seat.id}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
