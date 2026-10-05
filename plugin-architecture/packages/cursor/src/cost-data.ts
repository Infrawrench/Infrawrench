/**
 * Cost collection for a Cursor team.
 *
 * Two kinds of money land on a Cursor invoice, and only one of them is in the
 * API:
 *
 * - **Usage-based spend** (requests beyond the plan's included pool, Max Mode,
 *   token-priced models). Read event by event from
 *   `POST /teams/filtered-usage-events`, which carries the model, the member,
 *   the event `kind` and the cents Cursor charged for it (`chargedCents`,
 *   which includes the Cursor token fee). Only chargeable, usage-based events
 *   count: requests drawn from the included pool cost nothing extra.
 * - **Seats**. No endpoint reports the plan, the seat tier or the seat price,
 *   so seat rows are derived from the member list × the price the user set on
 *   the account (defaults are Cursor's published $40 standard / $120 premium
 *   per user per month, https://cursor.com/pricing and
 *   https://cursor.com/docs/account/teams/members, verified 2026-10-04).
 *   Unpaid admins (`free-owner`) take no seat. That derivation is why the
 *   manifest declares `estimated: true`.
 *
 * Seat rows are only written for days inside the current billing cycle: the
 * member list is a snapshot of today, and stamping today's seats onto last
 * quarter would invent spend for people who had not joined yet. Each daily
 * collection re-reads the trailing restatement window, so the history fills in
 * one cycle at a time as it is lived.
 */
import { aiCostTags } from "@infrawrench/plugin-base";
import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import type { CursorContext, CursorTeamMember, CursorUsageEvent } from "./api.js";
import { DAY_MS, getTeamMembers, getTeamSpend, getUsageEvents, isoDay, splitRange } from "./api.js";

export const DEFAULT_STANDARD_SEAT_PRICE = 40;
export const DEFAULT_PREMIUM_SEAT_PRICE = 120;

/** Usage-event pages the collector will walk per window before giving up (1,000 events each). */
const COLLECTOR_MAX_PAGES = 2000;

export interface SeatPricing {
  standardMonthly: number;
  premiumMonthly: number;
  premiumEmails: Set<string>;
}

function price(raw: string | undefined, fallback: number): number {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return fallback;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function parseSeatPricing(credentials: Record<string, string>): SeatPricing {
  return {
    standardMonthly: price(credentials["seatPriceMonthly"], DEFAULT_STANDARD_SEAT_PRICE),
    premiumMonthly: price(credentials["premiumSeatPriceMonthly"], DEFAULT_PREMIUM_SEAT_PRICE),
    premiumEmails: new Set(
      (credentials["premiumSeatEmails"] ?? "")
        .split(/[\s,;]+/)
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  };
}

/** `free-owner` is Cursor's unpaid admin: admin rights, no seat, no bill. */
export function isPaidSeat(member: CursorTeamMember): boolean {
  return (member.role ?? "").toLowerCase() !== "free-owner";
}

export type SeatTier = "standard" | "premium" | "none";

export function seatTier(member: CursorTeamMember, pricing: SeatPricing): SeatTier {
  if (!isPaidSeat(member)) return "none";
  return pricing.premiumEmails.has((member.email ?? "").toLowerCase()) ? "premium" : "standard";
}

export function seatMonthlyPrice(tier: SeatTier, pricing: SeatPricing): number {
  if (tier === "premium") return pricing.premiumMonthly;
  if (tier === "standard") return pricing.standardMonthly;
  return 0;
}

/**
 * True for an event Cursor billed on top of the plan. `kind` is free text
 * (`Usage-based`, `Included in Business`, `Errored, Not Charged`, …), so the
 * match is on the words rather than an exact string. Cursor's billing pages
 * now call the same thing "on-demand" usage, so that spelling counts too.
 */
export function isUsageBased(event: CursorUsageEvent): boolean {
  if (event.isChargeable === false) return false;
  return /usage[\s_-]*based|on[\s_-]*demand/i.test(event.kind ?? "");
}

/** Cents charged for one event: `chargedCents` (includes the token fee), else the token cost. */
export function eventCents(event: CursorUsageEvent): number {
  const charged = Number(event.chargedCents);
  if (Number.isFinite(charged)) return charged;
  const tokens = Number(event.tokenUsage?.totalCents);
  return Number.isFinite(tokens) ? tokens : 0;
}

/** UTC day of an event, or undefined for an unparseable timestamp. */
export function eventDay(event: CursorUsageEvent): string | undefined {
  const ms = Number(event.timestamp);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return isoDay(ms);
}

/** Map a lower-cased email to the member's encoded `user_…` id. */
export function memberIdIndex(members: CursorTeamMember[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of members) {
    const email = (m.email ?? "").toLowerCase();
    if (email && m.id) out.set(email, m.id);
  }
  return out;
}

/** Roll usage-based events up into one row per day × model × member. */
export function usageRows(
  events: CursorUsageEvent[],
  memberIds: Map<string, string>,
  range: CostFetchRange,
): CostRow[] {
  const buckets = new Map<string, CostRow>();
  for (const event of events) {
    if (!isUsageBased(event)) continue;
    const date = eventDay(event);
    if (!date || date < range.fromDate || date > range.toDate) continue;
    const cents = eventCents(event);
    if (cents === 0) continue;
    const email = (event.userEmail ?? "").toLowerCase();
    const model = event.model?.trim() || "unknown";
    const maxMode = event.maxMode ? "true" : "false";
    const key = `${date}\u0000${model}\u0000${email}\u0000${maxMode}`;
    let row = buckets.get(key);
    if (!row) {
      row = {
        date,
        service: model,
        resourceId: memberIds.get(email) ?? (email || "unattributed"),
        tags: {
          user: email || "unattributed",
          model,
          maxMode,
          charge: "usage-based",
          // Normalized AI dimensions; see plugin-base `ai-requests.ts`.
          ...aiCostTags({ provider: "cursor", model: model === "unknown" ? undefined : model }),
        },
        currency: "USD",
        amount: 0,
        usageAmount: 0,
        usageUnit: "requests",
      };
      buckets.set(key, row);
    }
    row.amount += cents / 100;
    row.usageAmount = (row.usageAmount ?? 0) + 1;
  }
  return [...buckets.values()].map((r) => ({ ...r, amount: round(r.amount) }));
}

/**
 * One row per paid seat per day, for days in the current billing cycle (and
 * not in the future). Monthly price spread evenly over the year's days, so a
 * month sums to roughly the monthly price whatever its length.
 */
export function seatRows(
  members: CursorTeamMember[],
  pricing: SeatPricing,
  range: CostFetchRange,
  cycleStartMs: number | undefined,
  today: string,
): CostRow[] {
  if (cycleStartMs === undefined) return [];
  const firstDay = maxDay(range.fromDate, isoDay(cycleStartMs));
  const lastDay = minDay(range.toDate, today);
  if (firstDay > lastDay) return [];
  const rows: CostRow[] = [];
  for (const member of members) {
    if (member.isRemoved) continue;
    const tier = seatTier(member, pricing);
    const monthly = seatMonthlyPrice(tier, pricing);
    if (monthly <= 0) continue;
    const daily = round((monthly * 12) / 365);
    const email = (member.email ?? "").toLowerCase();
    for (let day = firstDay; day <= lastDay; day = nextDay(day)) {
      rows.push({
        date: day,
        service: tier === "premium" ? "Premium seat" : "Standard seat",
        resourceId: member.id ?? email,
        tags: { user: email, seat: tier, charge: "seat", ...aiCostTags({ provider: "cursor" }) },
        currency: "USD",
        amount: daily,
        usageAmount: 1,
        usageUnit: "seat-days",
      });
    }
  }
  return rows;
}

/** The collector entry point `fetchCostData` delegates to. */
export async function fetchCursorCostData(
  ctx: CursorContext,
  pricing: SeatPricing,
  range: CostFetchRange,
  now: number = Date.now(),
): Promise<CostRow[]> {
  const today = isoDay(now);
  const startMs = Date.parse(`${range.fromDate}T00:00:00Z`);
  const endMs = Math.min(Date.parse(`${range.toDate}T00:00:00Z`) + DAY_MS - 1, now);
  if (!(startMs <= endMs)) return [];

  const [members, spend] = await Promise.all([getTeamMembers(ctx), getTeamSpend(ctx)]);
  const memberIds = memberIdIndex(members);

  const events: CursorUsageEvent[] = [];
  for (const [from, to] of splitRange(startMs, endMs, 30)) {
    const page = await getUsageEvents(ctx, from, to, { maxPages: COLLECTOR_MAX_PAGES });
    events.push(...page.events);
  }

  return [
    ...usageRows(events, memberIds, range),
    ...seatRows(members, pricing, range, spend.cycleStartMs, today),
  ];
}

function round(amount: number): number {
  return Math.round(amount * 1e6) / 1e6;
}

function nextDay(day: string): string {
  return isoDay(Date.parse(`${day}T00:00:00Z`) + DAY_MS);
}

function maxDay(a: string, b: string): string {
  return a > b ? a : b;
}

function minDay(a: string, b: string): string {
  return a < b ? a : b;
}
