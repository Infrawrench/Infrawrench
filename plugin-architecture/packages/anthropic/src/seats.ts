/**
 * Claude Enterprise seats for the SaaS seats finder (plugin-base `seats.ts`).
 *
 * The Admin API's member endpoints are shared by Claude Console (API) and
 * Claude Enterprise (claude.ai) organizations, and the organization type is
 * not reported anywhere. It is read off the members' roles instead, because
 * the two role sets are disjoint apart from `user`
 * (https://platform.claude.com/docs/en/api/organization/users/list):
 *
 * - Console: `user`, `developer`, `billing`, `admin`, `claude_code_user`.
 *   Console organizations are pay-as-you-go with no per-seat charge, so they
 *   report no seats.
 * - Enterprise: `user`, `managed`, `owner`, `membership_admin`,
 *   `primary_owner`. Every Enterprise organization has exactly one
 *   `primary_owner`, so a complete member list always decides it.
 *
 * A member list with only `user` roles cannot be told apart and reports no
 * seats. The Claude Team plan has no Admin API at all.
 *
 * Activity comes from the optional Claude Enterprise Analytics API key: the
 * per-user rollup over a date range carries `last_activity_date`, the latest
 * day with any counted activity (chat, Claude Code, Cowork and the other
 * products) inside the window
 * (https://platform.claude.com/docs/en/api/beta/organization/analytics/users/list).
 * Without that key, or while Anthropic has last-activity reporting turned off
 * for the organization, the basis is `none`.
 */
import type { SeatPrice, SeatRecord } from "@infrawrench/plugin-base";

export const SEAT_PRODUCT = "Claude";
export const SEAT_TYPE = "Claude Enterprise";

/** https://claude.com/pricing, read 2026-10: "US$20/seat/month, billed annually". */
export const ENTERPRISE_SEAT_PRICE = 20;
const ENTERPRISE_PRICE_NOTE =
  "claude.com/pricing, 2026-10 (Enterprise, billed annually; usage is billed separately at API rates)";

/** Analytics data starts here; earlier dates are rejected. */
export const ANALYTICS_EARLIEST_DAY = "2026-01-01";
/** The analytics API accepts at most 366 days per range. */
export const ANALYTICS_MAX_RANGE_DAYS = 366;
/**
 * Engagement data lands about a day late ("the most recent available day is
 * usually two days before the current UTC date"), so the newest days of a
 * window carry no evidence yet and are not counted in `windowDays`.
 */
export const ANALYTICS_LAG_DAYS = 2;

const DAY_MS = 86_400_000;

const CONSOLE_ONLY_ROLES = new Set(["developer", "billing", "admin", "claude_code_user"]);
const ENTERPRISE_ONLY_ROLES = new Set(["managed", "owner", "membership_admin", "primary_owner"]);
/** The roles the API can remove; administrative roles return 400. */
const REMOVABLE_ROLES = new Set(["user", "managed"]);

export interface AnthropicOrgUser {
  id: string;
  email?: string;
  name?: string;
  role?: string;
  added_at?: string;
}

export interface AnalyticsUserRow {
  user?: { id?: string; email_address?: string } | null;
  last_activity_date?: string | null;
}

export type OrganizationKind = "enterprise" | "console" | "unknown";

export function organizationKind(users: AnthropicOrgUser[]): OrganizationKind {
  let enterprise = false;
  let consoleOrg = false;
  for (const u of users) {
    const role = (u.role ?? "").toLowerCase();
    if (ENTERPRISE_ONLY_ROLES.has(role)) enterprise = true;
    if (CONSOLE_ONLY_ROLES.has(role)) consoleOrg = true;
  }
  if (enterprise === consoleOrg) return "unknown";
  return enterprise ? "enterprise" : "console";
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The analytics range for an org threshold of `lookbackDays`: from
 * `startingDate` (inclusive) to `endingDate` (today, exclusive), widened by
 * the reporting lag and clamped to the API's limits. `windowDays` is how many
 * of those days can carry evidence.
 */
export function analyticsWindow(
  lookbackDays: number,
  now: number,
): { startingDate: string; endingDate: string; windowDays: number } {
  const wanted = Math.ceil(Number.isFinite(lookbackDays) ? lookbackDays : 30) + ANALYTICS_LAG_DAYS;
  const days = Math.min(ANALYTICS_MAX_RANGE_DAYS, Math.max(1 + ANALYTICS_LAG_DAYS, wanted));
  const endingDate = isoDay(now);
  let startingDate = isoDay(now - days * DAY_MS);
  if (startingDate < ANALYTICS_EARLIEST_DAY) startingDate = ANALYTICS_EARLIEST_DAY;
  const span = Math.round((Date.parse(endingDate) - Date.parse(startingDate)) / DAY_MS);
  return { startingDate, endingDate, windowDays: Math.max(0, span - ANALYTICS_LAG_DAYS) };
}

/** What the analytics rollup says, or null when no activity evidence is available. */
export interface AnalyticsEvidence {
  windowDays: number;
  /** Latest active day per user id and per lower-cased email; null = none in the window. */
  byId: Map<string, string | null>;
  byEmail: Map<string, string | null>;
}

/**
 * Index the rollup rows. Returns null when no row carries `last_activity_date`
 * at all: Anthropic omits the field while last-activity reporting is not
 * enabled for the organization, and "omitted" must not read as "never used".
 */
export function analyticsEvidence(
  rows: AnalyticsUserRow[],
  windowDays: number,
): AnalyticsEvidence | null {
  const reported = rows.filter((r) => r && "last_activity_date" in r);
  if (reported.length === 0 || windowDays <= 0) return null;
  const byId = new Map<string, string | null>();
  const byEmail = new Map<string, string | null>();
  for (const row of reported) {
    const day =
      typeof row.last_activity_date === "string" && row.last_activity_date
        ? row.last_activity_date
        : null;
    const id = row.user?.id?.trim();
    const email = row.user?.email_address?.trim().toLowerCase();
    if (id) byId.set(id, day);
    if (email) byEmail.set(email, day);
  }
  return { windowDays, byId, byEmail };
}

const PRICE: SeatPrice = {
  monthly: ENTERPRISE_SEAT_PRICE,
  currency: "USD",
  source: "list-price",
  note: ENTERPRISE_PRICE_NOTE,
};

function lookup(
  evidence: AnalyticsEvidence | null,
  id: string,
  email: string | null,
): { day: string | null } | null {
  if (!evidence) return null;
  if (evidence.byId.has(id)) return { day: evidence.byId.get(id) ?? null };
  if (email && evidence.byEmail.has(email)) return { day: evidence.byEmail.get(email) ?? null };
  return null;
}

/** One seat per member of a Claude Enterprise organization; [] for anything else. */
export function buildClaudeSeats(
  users: AnthropicOrgUser[],
  evidence: AnalyticsEvidence | null,
  hasAnalyticsKey: boolean,
): SeatRecord[] {
  if (organizationKind(users) !== "enterprise") return [];
  const out: SeatRecord[] = [];
  for (const u of users) {
    const id = u.id?.trim();
    if (!id) continue;
    const email = u.email?.trim().toLowerCase() || null;
    const role = (u.role ?? "").toLowerCase();
    const seen = lookup(evidence, id, email);
    const removable = REMOVABLE_ROLES.has(role);
    out.push({
      memberId: id,
      name: u.name?.trim() || null,
      email,
      product: SEAT_PRODUCT,
      category: "ai-assistant",
      seatType: SEAT_TYPE,
      price: PRICE,
      activity:
        evidence && seen
          ? {
              basis: "usage-window",
              lastActiveAt: seen.day,
              windowDays: evidence.windowDays,
              source: "Claude Enterprise analytics (chat, Claude Code, Cowork and other products)",
            }
          : {
              basis: "none",
              lastActiveAt: null,
              source: !hasAnalyticsKey
                ? "Add a Claude Enterprise Analytics API key to see activity"
                : evidence
                  ? "Not in Claude Enterprise analytics"
                  : "Claude Enterprise analytics reports no last activity for this organization",
            },
      assignedAt: u.added_at?.trim() || null,
      removable,
      removalNote: removable
        ? "Removes the member and returns the seat to the organization's pool; lower the seat count in claude.ai billing to stop paying for it. Members managed by SCIM are removed in your identity provider."
        : "Owners, membership admins and the primary owner are removed in claude.ai organization settings, not through the API.",
      downgrade: null,
      resource: { resourceTypeId: "organization-user", externalId: id },
    });
  }
  return out;
}
