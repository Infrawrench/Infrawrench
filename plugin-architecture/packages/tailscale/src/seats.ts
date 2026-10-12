import type { SeatPrice, SeatRecord } from "@infrawrench/plugin-base";
import type { User } from "./api.js";

export const SEAT_PRODUCT = "Tailscale";

/** Tailscale Standard, the cheapest paid plan's per-seat list price. */
export const STANDARD_LIST_PRICE = 8;

/**
 * The per-seat price: the one set on the account, else the Standard list
 * price. The API reports neither the plan nor the bill (the OpenAPI document
 * at https://api.tailscale.com/api/v2?outputOpenapiSchema=true has no billing
 * route), so there is nothing to read.
 */
export function tailscaleSeatPrice(configured: string | undefined): SeatPrice {
  const raw = (configured ?? "").trim();
  const value = Number(raw);
  if (raw !== "" && Number.isFinite(value) && value >= 0) {
    return { monthly: value, currency: "USD", source: "configured" };
  }
  return {
    monthly: STANDARD_LIST_PRICE,
    currency: "USD",
    source: "list-price",
    note: "tailscale.com/pricing, 2026-10: Standard, the lowest paid plan (Premium is $18). Set your seat price on the account, or 0 on the free Personal plan.",
  };
}

/**
 * Statuses that occupy a seat. Per https://tailscale.com/pricing/faq a user
 * occupies a seat once they first log in or authenticate a device and vacates
 * it when deleted or suspended; invited and pending-approval users never do.
 * `idle` (not seen for 28 days) still holds its seat, which is the point.
 */
const SEATED_STATUSES: ReadonlySet<string> = new Set(["active", "idle"]);

/**
 * Members of the tailnet as seats. Shared-in users (`type: shared`) belong to
 * another tailnet and are not billed here; the list is read with the default
 * `type=member` and they are dropped again should one appear. A member with
 * no `lastSeen` has never logged in, so it occupies no seat yet.
 */
export function mapTailscaleSeats(
  users: User[],
  tailnet: string,
  price: SeatPrice,
  now: Date = new Date(),
): SeatRecord[] {
  const seats: SeatRecord[] = [];
  for (const u of users) {
    const id = (u.id ?? "").trim();
    if (!id || (u.type ?? "member") !== "member") continue;
    if (!SEATED_STATUSES.has((u.status ?? "").toLowerCase())) continue;
    const lastSeen = (u.lastSeen ?? "").trim();
    if (!lastSeen && !u.currentlyConnected) continue;
    const loginName = (u.loginName ?? "").trim();
    const owner = (u.role ?? "").toLowerCase() === "owner";
    seats.push({
      memberId: id,
      name: (u.displayName ?? "").trim() || null,
      email: loginName.includes("@") ? loginName.toLowerCase() : null,
      login: loginName || null,
      product: SEAT_PRODUCT,
      category: "other",
      seatType: "Tailnet user",
      price,
      activity: {
        basis: "last-activity",
        lastActiveAt: u.currentlyConnected ? now.toISOString() : lastSeen,
        source: "Tailscale last seen on the tailnet (a device connected, or a sign-in)",
      },
      assignedAt: (u.created ?? "").trim() || null,
      removable: !owner,
      removalNote: owner
        ? "The tailnet owner; transfer ownership to another user before removing them."
        : "Suspends the user: their devices stay but cannot exchange traffic and their keys stop working, and the seat is freed. Restore the user to undo. Reduce the seat count in billing to stop paying for the empty seat.",
      context: { tailnet },
      resource: { resourceTypeId: "user", externalId: id },
    });
  }
  return seats;
}
