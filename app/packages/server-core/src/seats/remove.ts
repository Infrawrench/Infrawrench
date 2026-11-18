/**
 * The in-app Remove on a seat finding: the plugin's `removeSeat`, then the
 * stored row updated to match and the realized saving recorded.
 *
 * Only a seat that is currently a finding can be removed here. The button is
 * a savings action, not a member-management console, and refusing anything
 * else means a stale tab cannot remove somebody who started using the tool
 * this morning. The caller (the route) owns the permission check, the change
 * freeze and the audit row.
 */
import { and, eq } from "drizzle-orm";
import type { SeatFinding, SeatRemovalResponse, SeatView } from "@infrawrench/client-core";
import { db } from "../db/client";
import { accountSeats } from "../db/schema";
import { getOrgAccountClient } from "../org-accounts";
import { captureSeatSaving } from "./capture";
import { listSeats } from "./feed";

/** A refusal the route maps to a status code. */
export class SeatRemovalError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 | 502,
  ) {
    super(message);
    this.name = "SeatRemovalError";
  }
}

export interface SeatRemovalOutcome extends SeatRemovalResponse {
  seat: SeatView;
  finding: SeatFinding;
}

/** Look the seat and its finding up as the caller sees them. */
export async function findRemovableSeat(
  organizationId: string,
  seatId: string,
): Promise<{ seat: SeatView; finding: SeatFinding }> {
  const list = await listSeats(organizationId, { withoutRemediation: true });
  const seat = list.seats.find((s) => s.id === seatId);
  if (!seat) throw new SeatRemovalError("Seat not found", 404);
  const finding = list.findings.find((f) => f.seatId === seatId);
  if (!finding || finding.kind === "downgrade") {
    throw new SeatRemovalError(
      "This seat is not flagged as inactive or duplicated, so it can't be removed from here.",
      409,
    );
  }
  if (!seat.removable) {
    throw new SeatRemovalError(
      seat.removalNote ?? `${seat.pluginName} does not let this seat be removed over its API.`,
      400,
    );
  }
  return { seat, finding };
}

export async function removeSeat(
  organizationId: string,
  seatId: string,
  userId: string | null,
): Promise<SeatRemovalOutcome> {
  const { seat, finding } = await findRemovableSeat(organizationId, seatId);
  const result = await executeSeatRemoval(organizationId, seat, finding, userId);
  return { ...result, seat, finding };
}

/**
 * Remove a departing person's seat from their offboarding checklist.
 *
 * Unlike the savings action this does not require the seat to be a finding:
 * the person is leaving, so a seat they used this morning still goes. It
 * still refuses a seat the provider does not let Infrawrench remove. A saving
 * is recorded only when the seat was also a finding, since that is the only
 * case the realized-savings report can describe honestly.
 */
export async function removeSeatForOffboarding(
  organizationId: string,
  seatId: string,
  userId: string | null,
): Promise<SeatRemovalResponse & { seat: SeatView }> {
  const list = await listSeats(organizationId, { withoutRemediation: true, unscoped: true });
  const seat = list.seats.find((s) => s.id === seatId);
  if (!seat) throw new SeatRemovalError("Seat not found", 404);
  if (!seat.removable) {
    throw new SeatRemovalError(
      seat.removalNote ?? `${seat.pluginName} does not let this seat be removed over its API.`,
      400,
    );
  }
  const finding = list.findings.find((f) => f.seatId === seatId && f.kind !== "downgrade") ?? null;
  const result = await executeSeatRemoval(organizationId, seat, finding, userId);
  return { ...result, seat };
}

async function executeSeatRemoval(
  organizationId: string,
  seat: SeatView,
  finding: SeatFinding | null,
  userId: string | null,
): Promise<SeatRemovalResponse> {
  const seatId = seat.id;
  const ctx = await getOrgAccountClient(seat.accountId, organizationId);
  if (!ctx) throw new SeatRemovalError("Account not found", 404);
  if (!ctx.client.removeSeat) {
    throw new SeatRemovalError(`${seat.pluginName} does not support removing seats`, 400);
  }

  let result;
  try {
    result = await ctx.client.removeSeat(seat.accountId, {
      memberId: seat.memberId,
      ...(seat.seatKey ? { seatKey: seat.seatKey } : {}),
      email: seat.email,
      login: seat.login,
      context: seat.context,
    });
  } catch (err) {
    throw new SeatRemovalError(err instanceof Error ? err.message : String(err), 502);
  }

  // Mirror the change so the finding disappears now rather than at the next
  // daily collection: a seat billed to the end of the cycle is marked pending,
  // an immediate removal drops the row.
  if (result.effective === "end-of-cycle") {
    await db
      .update(accountSeats)
      .set({ pendingRemovalOn: new Date(), updatedAt: new Date() })
      .where(and(eq(accountSeats.organizationId, organizationId), eq(accountSeats.id, seatId)));
  } else {
    await db
      .delete(accountSeats)
      .where(and(eq(accountSeats.organizationId, organizationId), eq(accountSeats.id, seatId)));
  }

  if (finding) {
    await captureSeatSaving({
      organizationId,
      seat,
      action: "remove",
      findingKind: finding.kind,
      source: "in_app",
      userId,
    });
  }

  return { effective: result.effective, message: result.message ?? null };
}
