/**
 * Paid Cursor seats for the SaaS seats finder (plugin-base `seats.ts`).
 *
 * - **Who holds a seat**: `GET /teams/members`, minus removed members and
 *   unpaid admins (`free-owner`, "Free: $0/user/mo, for unpaid admins who
 *   don't use Cursor", https://cursor.com/docs/account/teams/pricing).
 * - **Activity**: `POST /teams/daily-usage-data` with pagination, which
 *   returns a row per member per day of membership with `isActive`
 *   (https://cursor.com/docs/account/teams/admin-api). The basis is
 *   `usage-window`: the latest active day inside the window read, which is the
 *   org's threshold rounded up to 30 days and capped at
 *   {@link MAX_SEAT_WINDOW_DAYS}. Cursor reports no join date, but paginated
 *   rows only cover days the member belonged to the team, so a first row later
 *   than the window start is that member's join day and becomes `assignedAt`.
 *   A member with no rows at all (joined since Cursor's last hourly roll-up)
 *   has no evidence and reads `none`.
 * - **Price**: the account's configured seat price when the user changed it
 *   from the default, else Cursor's published Teams list price. Enterprise
 *   pricing is custom, so an Enterprise team with no configured price gets
 *   `price: null` rather than a Teams figure.
 * - **Removal**: `POST /teams/remove-member` is Enterprise only, and Cursor
 *   refuses to remove the last paid member or the last admin.
 * - **Downgrade**: never emitted. Cursor publishes no included-usage figure
 *   for a Standard seat (Premium is "5x the usage of a Standard seat"), so
 *   nothing the API reports can show that a Premium member's usage fits a
 *   Standard seat.
 */
import type { SeatPrice, SeatRecord } from "@infrawrench/plugin-base";
import type { CursorDailyUsage, CursorTeamMember } from "./api.js";
import { isoDay } from "./api.js";
import type { SeatPricing } from "./cost-data.js";
import {
  DEFAULT_PREMIUM_SEAT_PRICE,
  DEFAULT_STANDARD_SEAT_PRICE,
  isPaidSeat,
  seatTier,
} from "./cost-data.js";

export const SEAT_PRODUCT = "Cursor";
/** Shortest window read: one API request window, which the member listing reads anyway. */
export const MIN_SEAT_WINDOW_DAYS = 30;
/** Longest window read: three 30-day requests (daily usage is limited to 20 requests a minute). */
export const MAX_SEAT_WINDOW_DAYS = 90;

const STANDARD_LIST_NOTE = "cursor.com/pricing, 2026-10 (Teams, billed monthly)";
const PREMIUM_LIST_NOTE = "cursor.com/docs/account/teams/members, 2026-10 (Teams, billed monthly)";

/** Days of daily usage to read for an org threshold of `lookbackDays`. */
export function seatWindowDays(lookbackDays: number): number {
  const wanted = Number.isFinite(lookbackDays) ? Math.ceil(lookbackDays) : MIN_SEAT_WINDOW_DAYS;
  return Math.min(MAX_SEAT_WINDOW_DAYS, Math.max(MIN_SEAT_WINDOW_DAYS, wanted));
}

/** Which tier prices the user set on the account (a value other than the default). */
export interface ConfiguredSeatPrices {
  standard: boolean;
  premium: boolean;
}

function differsFromDefault(raw: string | undefined, fallback: number): boolean {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return false;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 && value !== fallback;
}

export function configuredSeatPrices(credentials: Record<string, string>): ConfiguredSeatPrices {
  return {
    standard: differsFromDefault(credentials["seatPriceMonthly"], DEFAULT_STANDARD_SEAT_PRICE),
    premium: differsFromDefault(credentials["premiumSeatPriceMonthly"], DEFAULT_PREMIUM_SEAT_PRICE),
  };
}

/** Per-member evidence from the daily usage rows. */
interface MemberEvidence {
  firstDay: string;
  lastActiveDay: string | null;
}

function dayOf(row: CursorDailyUsage): string {
  if (row.day) return row.day;
  if (typeof row.date === "number" && Number.isFinite(row.date)) return isoDay(row.date);
  return "";
}

export function memberEvidence(rows: CursorDailyUsage[]): Map<string, MemberEvidence> {
  const out = new Map<string, MemberEvidence>();
  for (const row of rows) {
    const email = (row.email ?? "").trim().toLowerCase();
    const day = dayOf(row);
    if (!email || !day) continue;
    const e = out.get(email) ?? { firstDay: day, lastActiveDay: null };
    if (day < e.firstDay) e.firstDay = day;
    if (row.isActive === true && (e.lastActiveDay === null || day > e.lastActiveDay)) {
      e.lastActiveDay = day;
    }
    out.set(email, e);
  }
  return out;
}

export interface BuildSeatsInput {
  members: CursorTeamMember[];
  usage: CursorDailyUsage[];
  /** First day (UTC, `YYYY-MM-DD`) the usage covers. */
  windowStartDay: string;
  windowDays: number;
  pricing: SeatPricing;
  configured: ConfiguredSeatPrices;
  /** True when the team is on Enterprise (custom pricing, API removal). */
  enterprise: boolean;
}

function seatPrice(
  tier: "standard" | "premium",
  input: Pick<BuildSeatsInput, "pricing" | "configured" | "enterprise">,
): SeatPrice | null {
  const premium = tier === "premium";
  if (premium ? input.configured.premium : input.configured.standard) {
    return {
      monthly: premium ? input.pricing.premiumMonthly : input.pricing.standardMonthly,
      currency: "USD",
      source: "configured",
    };
  }
  // Enterprise is "Custom" on cursor.com/pricing: a Teams list price would be a guess.
  if (input.enterprise) return null;
  return {
    monthly: premium ? DEFAULT_PREMIUM_SEAT_PRICE : DEFAULT_STANDARD_SEAT_PRICE,
    currency: "USD",
    source: "list-price",
    note: premium ? PREMIUM_LIST_NOTE : STANDARD_LIST_NOTE,
  };
}

function isAdmin(member: CursorTeamMember): boolean {
  const role = (member.role ?? "").toLowerCase();
  return role === "owner" || role === "free-owner";
}

export function buildCursorSeats(input: BuildSeatsInput): SeatRecord[] {
  const current = input.members.filter((m) => !m.isRemoved);
  const paid = current.filter(isPaidSeat);
  const admins = current.filter(isAdmin).length;
  const evidence = memberEvidence(input.usage);
  const out: SeatRecord[] = [];
  for (const member of paid) {
    const email = (member.email ?? "").trim().toLowerCase();
    const memberId = (member.id ?? "").trim() || email;
    if (!memberId) continue;
    const tier = seatTier(member, input.pricing) === "premium" ? "premium" : "standard";
    const e = email ? evidence.get(email) : undefined;

    let blocker: string | null = null;
    if (!input.enterprise) {
      blocker =
        "Cursor's API removes members on Enterprise plans only; remove them from the Members page of the team dashboard.";
    } else if (paid.length <= 1) {
      blocker = "Cursor keeps at least one paid member on the team.";
    } else if (isAdmin(member) && admins <= 1) {
      blocker = "This is the team's only admin, and Cursor keeps at least one.";
    }

    out.push({
      memberId,
      name: member.name?.trim() || null,
      email: email || null,
      product: SEAT_PRODUCT,
      category: "ai-coding",
      seatType: tier === "premium" ? "Premium" : "Standard",
      price: seatPrice(tier, input),
      activity: e
        ? {
            basis: "usage-window",
            lastActiveAt: e.lastActiveDay,
            windowDays: input.windowDays,
            source: "Cursor daily usage (editor, agent, Tab or Bugbot activity)",
          }
        : {
            basis: "none",
            lastActiveAt: null,
            source: "No daily usage reported for this member yet",
          },
      // Paginated daily usage only covers days of membership, so a first row
      // after the window start is the join day.
      assignedAt: e && e.firstDay > input.windowStartDay ? e.firstDay : null,
      removable: blocker === null,
      removalNote:
        blocker ??
        "Removes the member from the team. A member who used credits this cycle keeps the seat billed until the cycle ends.",
      downgrade: null,
      resource: { resourceTypeId: "team-member", externalId: memberId },
    });
  }
  return out;
}
