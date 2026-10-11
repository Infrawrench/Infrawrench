import type { SeatPrice, SeatRecord } from "@infrawrench/plugin-base";
import type { OktaUser } from "./types.js";

export const SEAT_PRODUCT = "Okta";

/** Okta Workforce Identity Starter, the cheapest suite with a published price. */
export const STARTER_LIST_PRICE = 6;

/**
 * User statuses that hold an Okta licence.
 *
 * Okta publishes no billing definition of a "user" (the status reference,
 * https://help.okta.com/oie/en-us/content/topics/users-groups-profiles/usgp-end-user-states.htm,
 * says nothing about licensing), so this follows the common reading of the
 * Workforce contract: every activated user that is not deactivated counts.
 *
 * - Counted: ACTIVE, RECOVERY (password reset), PASSWORD_EXPIRED, LOCKED_OUT,
 *   SUSPENDED (an admin suspended the account but its app assignments stay;
 *   suspension does not free the licence), and PROVISIONED (activated, waiting
 *   for the user to finish setting a password: the account exists and is
 *   assigned, so a PROVISIONED user nobody ever activates is exactly the kind
 *   of idle licence worth flagging).
 * - Not counted: STAGED (created, never activated) and DEPROVISIONED
 *   (deactivated; the list endpoint omits them anyway).
 */
export const LICENSED_STATUSES: ReadonlySet<string> = new Set([
  "ACTIVE",
  "RECOVERY",
  "PASSWORD_EXPIRED",
  "LOCKED_OUT",
  "SUSPENDED",
  "PROVISIONED",
]);

/** The per-user price: the one set on the account, else the Starter list price. */
export function oktaSeatPrice(configured: string | undefined): SeatPrice {
  const value = Number((configured ?? "").trim());
  if ((configured ?? "").trim() !== "" && Number.isFinite(value) && value >= 0) {
    return { monthly: value, currency: "USD", source: "configured" };
  }
  return {
    monthly: STARTER_LIST_PRICE,
    currency: "USD",
    source: "list-price",
    note: "okta.com/pricing, 2026-10: Workforce Identity Starter, the lowest suite's list price, billed annually. Set your contract price on the account for an exact figure.",
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** One licensed Okta user as a seat; null for a user that holds no licence. */
export function mapOktaSeat(user: OktaUser, orgUrl: string, price: SeatPrice): SeatRecord | null {
  const id = text(user.id);
  const status = text(user.status).toUpperCase();
  if (!id || !LICENSED_STATUSES.has(status)) return null;
  const p = user.profile ?? {};
  const name =
    text(p.displayName) || [text(p.firstName), text(p.lastName)].filter(Boolean).join(" ");
  const email = text(p.email).toLowerCase();
  const login = text(p.login);
  return {
    memberId: id,
    name: name || null,
    email: email || null,
    login: login || null,
    product: SEAT_PRODUCT,
    category: "identity",
    seatType: status === "SUSPENDED" ? "User (suspended)" : "User",
    price,
    // `lastLogin` is null for a user who has never signed in; with
    // `assignedAt` set the host treats that as "never used" once the account
    // is older than the org's threshold.
    activity: {
      basis: "last-login",
      lastActiveAt: text(user.lastLogin) || null,
      source: "Okta last sign-in",
    },
    assignedAt: text(user.activated) || text(user.created) || null,
    removable: true,
    removalNote:
      "Deactivates the user: Okta removes every app assignment (which can delete their data in those apps) and frees the licence. The user can be reactivated later, but their app assignments have to be redone.",
    context: { orgUrl },
    resource: { resourceTypeId: "user", externalId: id },
  };
}
