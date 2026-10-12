import type { SeatPrice, SeatRecord } from "@infrawrench/plugin-base";
import type { HubMember } from "./mappers.js";

export const SEAT_PRODUCT = "Docker";

/** Docker Team billed annually, the cheapest published per-seat price for an organization. */
export const TEAM_ANNUAL_LIST_PRICE = 15;

/**
 * The per-seat price: the one set on the account, else the Team annual list
 * price. The Hub API reports neither the organization's plan nor its billing
 * (https://docs.docker.com/reference/api/hub/latest/ has billing events for
 * webhooks only), so there is nothing to read.
 */
export function dockerSeatPrice(configured: string | undefined): SeatPrice {
  const raw = (configured ?? "").trim();
  const value = Number(raw);
  if (raw !== "" && Number.isFinite(value) && value >= 0) {
    return { monthly: value, currency: "USD", source: "configured" };
  }
  return {
    monthly: TEAM_ANNUAL_LIST_PRICE,
    currency: "USD",
    source: "list-price",
    note: "docker.com/pricing, 2026-10: Team billed annually, the lowest organization price (Team monthly is $16, Business $24). Set your seat price on the account for an exact figure.",
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function latest(...dates: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestAt = -Infinity;
  for (const d of dates) {
    const t = d ? Date.parse(d) : NaN;
    if (Number.isFinite(t) && t > bestAt) {
      best = d!;
      bestAt = t;
    }
  }
  return best;
}

/**
 * The organization's members as seats. Every member (owners, editors,
 * members and guests) occupies one of the subscription's seats; pending
 * invitations do too, but they are listed under Invites and left out here
 * (`role: Invitee` rows are skipped should the API include them).
 *
 * Activity: `last_logged_in_at` and `last_seen_at` exist only when the
 * organization has insights visible (Business). A member with neither is
 * `basis: "none"`, never flagged: `date_joined` is when the Docker account
 * was created, not when it joined this organization, so it cannot stand in
 * as the assignment date for a "never signed in" verdict.
 */
export function mapDockerSeats(org: string, members: HubMember[], price: SeatPrice): SeatRecord[] {
  const active = members.filter(
    (m) => text(m.username) && text(m.role).toLowerCase() !== "invitee",
  );
  const owners = active.filter((m) => text(m.role).toLowerCase() === "owner");
  return active.map((m) => {
    const username = text(m.username);
    const role = text(m.role).toLowerCase() || "member";
    const lastActive = latest(m.last_logged_in_at, m.last_seen_at);
    const soleOwner = role === "owner" && owners.length === 1;
    const email = text(m.email).toLowerCase();
    return {
      memberId: `${org}/${username}`,
      name: text(m.full_name) || null,
      email: email || null,
      login: username,
      product: SEAT_PRODUCT,
      category: "other",
      seatType: role.charAt(0).toUpperCase() + role.slice(1),
      price,
      activity: lastActive
        ? {
            basis: "last-login",
            lastActiveAt: lastActive,
            source: "Docker last sign-in or last seen (organization insights)",
          }
        : {
            basis: "none",
            lastActiveAt: null,
            source: "Docker reports sign-ins only with organization insights",
          },
      assignedAt: null,
      removable: !soleOwner,
      removalNote: soleOwner
        ? "The organization's only owner; Docker refuses to remove the last owner."
        : "Removes the member from the organization and its teams, freeing the seat. Docker keeps billing for purchased seats, so also reduce the seat count in Billing (it takes effect at the next billing cycle).",
      context: { org },
      resource: { resourceTypeId: "dockerhub-member", externalId: `${org}/${username}` },
    };
  });
}
