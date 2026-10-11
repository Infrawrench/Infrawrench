/**
 * Per-org seat settings (`org_seat_settings`): the inactivity threshold the
 * findings use. A missing row means the default. Out-of-range values are
 * rejected rather than clamped, so a form never silently shows a different
 * number from the one the user typed (the extended-support stance).
 */
import { eq } from "drizzle-orm";
import {
  DEFAULT_SEAT_INACTIVE_DAYS,
  MAX_SEAT_INACTIVE_DAYS,
  MIN_SEAT_INACTIVE_DAYS,
  type SeatSettings,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { orgSeatSettings } from "../db/schema";

/** Thrown for a value the API rejects; routes map it to a 400. */
export class SeatSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeatSettingsError";
  }
}

export async function getSeatSettings(organizationId: string): Promise<SeatSettings> {
  const [row] = await db
    .select({ inactiveDays: orgSeatSettings.inactiveDays })
    .from(orgSeatSettings)
    .where(eq(orgSeatSettings.organizationId, organizationId))
    .limit(1);
  return { inactiveDays: row?.inactiveDays ?? DEFAULT_SEAT_INACTIVE_DAYS };
}

export function checkInactiveDays(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_SEAT_INACTIVE_DAYS ||
    value > MAX_SEAT_INACTIVE_DAYS
  ) {
    throw new SeatSettingsError(
      `inactiveDays must be a whole number from ${MIN_SEAT_INACTIVE_DAYS} to ${MAX_SEAT_INACTIVE_DAYS}`,
    );
  }
  return value;
}

export async function updateSeatSettings(
  organizationId: string,
  patch: Partial<SeatSettings>,
): Promise<SeatSettings> {
  const current = await getSeatSettings(organizationId);
  const inactiveDays =
    patch.inactiveDays === undefined ? current.inactiveDays : checkInactiveDays(patch.inactiveDays);
  await db
    .insert(orgSeatSettings)
    .values({ organizationId, inactiveDays })
    .onConflictDoUpdate({
      target: orgSeatSettings.organizationId,
      set: { inactiveDays, updatedAt: new Date() },
    });
  return { inactiveDays };
}
