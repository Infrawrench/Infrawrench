import { and, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { db } from "./db/client";
import { changeFreezes } from "./db/schema";

/**
 * The "is this org frozen right now?" read, shared by the web API's
 * destructive-mutation gates (`web/src/services/change-freezes.ts`, which
 * layers the HTTP 423 / override / audit behavior on top) and the poller's
 * sleep/wake schedule pass, which has no HTTP context but must still respect
 * a freeze: a scheduled stop/start during a freeze window is skipped and
 * surfaced as `skipped_freeze`, never silently executed.
 *
 * "In effect" = active AND started AND not past its end — computed, never
 * stored, so ending or extending a freeze applies immediately.
 */

export interface ActiveChangeFreeze {
  id: string;
  organizationId: string;
  name: string;
  reason: string | null;
  startsAt: Date;
  endsAt: Date | null;
  active: boolean;
  createdByUserId: string | null;
  endedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The freeze currently in effect for the org, or null. */
export async function findActiveChangeFreeze(
  organizationId: string,
  at: Date = new Date(),
): Promise<ActiveChangeFreeze | null> {
  const rows = await db
    .select()
    .from(changeFreezes)
    .where(
      and(
        eq(changeFreezes.organizationId, organizationId),
        eq(changeFreezes.active, true),
        lte(changeFreezes.startsAt, at),
        or(isNull(changeFreezes.endsAt), gt(changeFreezes.endsAt, at)),
      ),
    )
    .orderBy(desc(changeFreezes.startsAt))
    .limit(1);
  return rows[0] ?? null;
}
