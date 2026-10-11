/**
 * SaaS seats: the platform-neutral client half.
 *
 * Plugins report the paid seats on each connected account (`fetchSeats`, see
 * plugin-base `seats.ts`) and a daily poller pass stores them. Everything a
 * surface shows is computed from that stored inventory here, purely, so the
 * web server, the CLI and the tests agree on one definition of "idle":
 *
 * - **Inactive**: the provider's evidence says nobody used the seat for the
 *   org's `inactiveDays`. Evidence that cannot cover the window (no activity
 *   reported at all, or a usage window shorter than the threshold) makes the
 *   seat `unknown`, never inactive: "we found nothing" and "we could not look"
 *   must not read the same. A seat assigned inside the window is `new`.
 * - **Duplicate**: one person (matched by email) holds paid seats on two
 *   different products in the same category, say Copilot and Cursor. The seat
 *   used most recently is kept and the others are the finding. The same
 *   product on two accounts is deliberately *not* a duplicate: GitHub bills a
 *   Copilot user once per enterprise however many of its organizations
 *   assign them, and we cannot see the enterprise.
 * - **Downgrade**: the plugin named a cheaper tier the member's own usage
 *   fits, priced in the same currency.
 *
 * One finding per seat, in that order of precedence, so a saving is never
 * counted twice. Server contract: `GET /api/org/:orgId/seats`.
 *
 * Type-only against plugin-base, like `orphans.ts`: mobile imports this
 * barrel.
 */
import type {
  FindingRemediation,
  SeatActivityBasis,
  SeatCategory,
  SeatDowngrade,
  SeatPriceSource,
} from "@infrawrench/plugin-base";
import type { CloudFetch } from "./fetch";

export type {
  SeatActivityBasis,
  SeatCategory,
  SeatDowngrade,
  SeatPriceSource,
} from "@infrawrench/plugin-base";

/** Default inactivity threshold, and the bounds the settings route enforces. */
export const DEFAULT_SEAT_INACTIVE_DAYS = 30;
export const MIN_SEAT_INACTIVE_DAYS = 7;
export const MAX_SEAT_INACTIVE_DAYS = 365;

const DAY_MS = 86_400_000;

/** One stored seat, as the server returns it. */
export interface SeatRow {
  /** Server row id; the handle for removal. */
  id: string;
  accountId: string;
  accountName: string;
  pluginId: string;
  pluginName: string;
  memberId: string;
  /** Empty for providers with one seat per member. */
  seatKey: string;
  name: string | null;
  email: string | null;
  login: string | null;
  product: string;
  category: SeatCategory;
  seatType: string;
  monthlyPrice: number | null;
  currency: string | null;
  priceSource: SeatPriceSource | null;
  priceNote: string | null;
  activityBasis: SeatActivityBasis;
  lastActiveAt: string | null;
  activityWindowDays: number | null;
  /** Plain-English evidence, e.g. "Copilot last activity (vscode)". */
  activitySource: string;
  assignedAt: string | null;
  pendingRemovalOn: string | null;
  removable: boolean;
  removalNote: string | null;
  downgrade: SeatDowngrade | null;
  context: Record<string, string>;
  resource: { resourceTypeId: string; externalId: string } | null;
  /** When the poller last saw this seat at the provider. */
  lastSeenAt: string;
}

/**
 * - `active`: used inside the window.
 * - `inactive`: evidence covers the window and shows no use.
 * - `new`: assigned inside the window and not used yet; too early to say.
 * - `unknown`: the provider's evidence cannot cover the window.
 * - `pending-removal`: already on its way out at the provider.
 */
export type SeatStatus = "active" | "inactive" | "new" | "unknown" | "pending-removal";

export interface SeatView extends SeatRow {
  status: SeatStatus;
  /**
   * Whole days since the last evidence of use. For a seat never used, days
   * since it was assigned (or the provider's window when the assignment date
   * is unknown), with `neverActive` set. Null when there is no evidence.
   */
  daysInactive: number | null;
  neverActive: boolean;
}

export type SeatFindingKind = "inactive" | "duplicate" | "downgrade";

export interface SeatDuplicateRef {
  /** The seat kept: the one the person used most recently. */
  keptSeatId: string;
  keptProduct: string;
  keptAccountName: string;
  keptLastActiveAt: string | null;
}

export interface SeatFinding {
  kind: SeatFindingKind;
  seatId: string;
  /** What acting on it saves per month; null when the seat is unpriced. */
  monthlySaving: number | null;
  currency: string | null;
  duplicate?: SeatDuplicateRef;
  /** For a downgrade: the cheaper tier and the plugin's reason. */
  targetSeatType?: string;
  reason?: string;
  /** Attached by the host from the plugin's seat remediation generator. */
  remediation?: FindingRemediation;
}

export interface SeatTotal {
  currency: string;
  monthly: number;
}

export interface SeatCounts {
  seats: number;
  inactive: number;
  duplicate: number;
  downgrade: number;
  /** Seats whose provider reports no usable activity evidence. */
  unknownActivity: number;
  /** Seats with no price, counted and never summed as zero. */
  unpriced: number;
}

/** One seat-capable account's collection state. */
export interface SeatAccountStatus {
  accountId: string;
  accountName: string;
  pluginId: string;
  pluginName: string;
  seatCount: number;
  lastPolledAt: string | null;
  /** The last collection's error, verbatim; null after a success. */
  lastError: string | null;
}

export interface SeatListResponse {
  inactiveDays: number;
  seats: SeatView[];
  findings: SeatFinding[];
  /** Sum of the findings' savings, per currency. */
  savingsMonthly: SeatTotal[];
  /** What the priced seats cost per month, per currency. */
  spendMonthly: SeatTotal[];
  counts: SeatCounts;
  accounts: SeatAccountStatus[];
}

export interface SeatSettings {
  inactiveDays: number;
}

export interface SeatRemovalResponse {
  effective: "immediate" | "end-of-cycle";
  message: string | null;
}

/** Whole days from `iso` to `now`; null when `iso` does not parse. */
function daysSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.floor((now - at) / DAY_MS));
}

/** Classify one seat against the threshold. Pure; exported for tests and the CLI. */
export function classifySeat(
  seat: SeatRow,
  inactiveDays: number,
  now: number = Date.now(),
): Pick<SeatView, "status" | "daysInactive" | "neverActive"> {
  if (seat.pendingRemovalOn)
    return { status: "pending-removal", daysInactive: null, neverActive: false };
  if (seat.activityBasis === "none")
    return { status: "unknown", daysInactive: null, neverActive: false };

  const sinceActive = daysSince(seat.lastActiveAt, now);
  if (sinceActive !== null) {
    return {
      status: sinceActive >= inactiveDays ? "inactive" : "active",
      daysInactive: sinceActive,
      neverActive: false,
    };
  }

  // No activity on record. Whether that proves anything depends on how far
  // back the provider's evidence reaches and on how long the seat was held.
  const sinceAssigned = daysSince(seat.assignedAt, now);
  if (sinceAssigned !== null && sinceAssigned < inactiveDays) {
    return { status: "new", daysInactive: sinceAssigned, neverActive: true };
  }
  if (seat.activityBasis === "usage-window") {
    const window = seat.activityWindowDays ?? 0;
    if (window < inactiveDays) return { status: "unknown", daysInactive: null, neverActive: false };
    return {
      status: "inactive",
      daysInactive: sinceAssigned === null ? window : Math.min(sinceAssigned, window),
      neverActive: sinceAssigned !== null && sinceAssigned <= window,
    };
  }
  // `last-activity` / `last-login` with a null date means never used. With no
  // assignment date we cannot tell "never" from "assigned this morning".
  if (sinceAssigned === null) return { status: "unknown", daysInactive: null, neverActive: false };
  return { status: "inactive", daysInactive: sinceAssigned, neverActive: true };
}

const KEEP_RANK: Record<SeatStatus, number> = {
  active: 0,
  new: 1,
  unknown: 2,
  inactive: 3,
  "pending-removal": 4,
};

/** Order for choosing which duplicate to keep: most recently used first. */
function keepOrder(a: SeatView, b: SeatView): number {
  const rank = KEEP_RANK[a.status] - KEEP_RANK[b.status];
  if (rank !== 0) return rank;
  const at = a.lastActiveAt ? Date.parse(a.lastActiveAt) : -Infinity;
  const bt = b.lastActiveAt ? Date.parse(b.lastActiveAt) : -Infinity;
  if (at !== bt) return bt - at;
  return a.id.localeCompare(b.id);
}

function addTotal(totals: Map<string, number>, currency: string | null, amount: number | null) {
  if (currency === null || amount === null || !Number.isFinite(amount)) return;
  totals.set(currency, (totals.get(currency) ?? 0) + amount);
}

function toTotals(totals: Map<string, number>): SeatTotal[] {
  return [...totals.entries()]
    .map(([currency, monthly]) => ({ currency, monthly: Math.round(monthly * 100) / 100 }))
    .sort((a, b) => b.monthly - a.monthly);
}

/** Findings, totals and counts over a stored inventory. */
export function computeSeatFindings(
  rows: readonly SeatRow[],
  opts: { inactiveDays: number; now?: number; accounts?: SeatAccountStatus[] },
): SeatListResponse {
  const now = opts.now ?? Date.now();
  const seats: SeatView[] = rows.map((row) => ({
    ...row,
    ...classifySeat(row, opts.inactiveDays, now),
  }));
  const findings: SeatFinding[] = [];
  const flagged = new Set<string>();

  for (const seat of seats) {
    if (seat.status !== "inactive") continue;
    flagged.add(seat.id);
    findings.push({
      kind: "inactive",
      seatId: seat.id,
      monthlySaving: seat.monthlyPrice,
      currency: seat.currency,
    });
  }

  // Duplicates: same email, same category, different products.
  const groups = new Map<string, SeatView[]>();
  for (const seat of seats) {
    if (!seat.email || seat.category === "other") continue;
    if (seat.status === "pending-removal" || flagged.has(seat.id)) continue;
    const key = `${seat.email}\u0000${seat.category}`;
    const list = groups.get(key);
    if (list) list.push(seat);
    else groups.set(key, [seat]);
  }
  for (const list of groups.values()) {
    if (new Set(list.map((s) => s.product)).size < 2) continue;
    const ordered = [...list].sort(keepOrder);
    const kept = ordered[0]!;
    for (const seat of ordered.slice(1)) {
      // A second seat on the kept seat's own product is not a cross-tool duplicate.
      if (seat.product === kept.product) continue;
      flagged.add(seat.id);
      findings.push({
        kind: "duplicate",
        seatId: seat.id,
        monthlySaving: seat.monthlyPrice,
        currency: seat.currency,
        duplicate: {
          keptSeatId: kept.id,
          keptProduct: kept.product,
          keptAccountName: kept.accountName,
          keptLastActiveAt: kept.lastActiveAt,
        },
      });
    }
  }

  for (const seat of seats) {
    if (!seat.downgrade || flagged.has(seat.id) || seat.status === "pending-removal") continue;
    if (seat.monthlyPrice === null || seat.currency === null) continue;
    if (seat.downgrade.price.currency !== seat.currency) continue;
    const saving = seat.monthlyPrice - seat.downgrade.price.monthly;
    if (!(saving > 0)) continue;
    flagged.add(seat.id);
    findings.push({
      kind: "downgrade",
      seatId: seat.id,
      monthlySaving: Math.round(saving * 100) / 100,
      currency: seat.currency,
      targetSeatType: seat.downgrade.seatType,
      reason: seat.downgrade.reason,
    });
  }

  const byId = new Map(seats.map((s) => [s.id, s]));
  findings.sort((a, b) => {
    const diff = (b.monthlySaving ?? -1) - (a.monthlySaving ?? -1);
    if (diff !== 0) return diff;
    return (byId.get(a.seatId)?.daysInactive ?? 0) - (byId.get(b.seatId)?.daysInactive ?? 0);
  });

  const savings = new Map<string, number>();
  for (const f of findings) addTotal(savings, f.currency, f.monthlySaving);
  const spend = new Map<string, number>();
  for (const s of seats) {
    if (s.status !== "pending-removal") addTotal(spend, s.currency, s.monthlyPrice);
  }

  return {
    inactiveDays: opts.inactiveDays,
    seats,
    findings,
    savingsMonthly: toTotals(savings),
    spendMonthly: toTotals(spend),
    counts: {
      seats: seats.length,
      inactive: findings.filter((f) => f.kind === "inactive").length,
      duplicate: findings.filter((f) => f.kind === "duplicate").length,
      downgrade: findings.filter((f) => f.kind === "downgrade").length,
      unknownActivity: seats.filter((s) => s.status === "unknown").length,
      unpriced: seats.filter((s) => s.monthlyPrice === null).length,
    },
    accounts: opts.accounts ?? [],
  };
}

/** The seat a finding is about, from the same response. */
export function seatForFinding(
  response: Pick<SeatListResponse, "seats">,
  finding: SeatFinding,
): SeatView | undefined {
  return response.seats.find((s) => s.id === finding.seatId);
}

/** Stable React key for a finding. */
export function seatFindingKey(finding: SeatFinding): string {
  return `${finding.kind}:${finding.seatId}`;
}

/** Who the seat belongs to, in the most useful form available. */
export function seatHolderLabel(
  seat: Pick<SeatRow, "name" | "email" | "login" | "memberId">,
): string {
  return seat.name || seat.email || seat.login || seat.memberId;
}

/**
 * The dedupe key a removal's realized saving is recorded under. The in-app
 * remove and the poller noticing the seat gone produce the same key, so one
 * removal is one saving.
 */
export function seatSavingsDedupeKey(
  seat: Pick<SeatRow, "accountId" | "memberId" | "seatKey">,
): string {
  return `seat_removal:${seat.accountId}:${seat.memberId}${seat.seatKey ? `:${seat.seatKey}` : ""}`;
}

export function emptySeatListResponse(): SeatListResponse {
  return computeSeatFindings([], { inactiveDays: DEFAULT_SEAT_INACTIVE_DAYS });
}

export async function fetchSeatList(api: CloudFetch, orgId: string): Promise<SeatListResponse> {
  return (await api.org<SeatListResponse>(orgId, "/seats")) ?? emptySeatListResponse();
}
