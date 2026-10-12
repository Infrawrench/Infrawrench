/**
 * SaaS seats: the per-person licences a provider bills every month whether
 * or not anybody uses them (a Copilot seat, a Cursor seat, a GitLab billable
 * member, an Okta user).
 *
 * The savings finder's cloud passes look at resources; this looks at people.
 * The plugin owns the provider half: who holds a seat, what it costs, and the
 * *evidence* of when it was last used. The host owns everything generic: the
 * schedule (a daily poller pass stores the inventory), the findings (inactive
 * for the org's N days, the same person paying twice across tools, a cheaper
 * tier), realized savings and the digest line.
 *
 * Two honesty rules every implementation must keep, because the feature is
 * only worth anything if a flagged seat really is idle:
 *
 * 1. **Absent evidence is `basis: "none"`, never an old date.** A provider that
 *    reports no activity at all yields a seat the host lists as "activity
 *    unknown" and never flags as inactive, however long it has been held.
 * 2. **Never invent a price.** `price.source` says where the figure came from;
 *    a list-price estimate is labelled as one, and a seat with no defensible
 *    figure carries `price: null` (counted, not summed).
 */

/**
 * How the plugin knows when the seat was last used.
 *
 * - `last-activity`: the provider reports the last time the member used the
 *   product itself (Copilot's `last_activity_at`, GitLab's
 *   `last_activity_on`). The strongest evidence.
 * - `last-login`: the provider reports the last sign-in only. Signing in is
 *   weaker evidence than using, but an account nobody signed in to is idle.
 * - `usage-window`: the provider reports usage per day over a bounded window
 *   (`windowDays`); `lastActiveAt` is the latest day with usage in it, and
 *   null means none inside the window, which only proves inactivity for
 *   `windowDays`, not longer.
 * - `none`: the provider reports no activity for this seat. Never flagged.
 */
export type SeatActivityBasis = "last-activity" | "last-login" | "usage-window" | "none";

export interface SeatActivity {
  basis: SeatActivityBasis;
  /** ISO timestamp (or `YYYY-MM-DD`) of the latest evidence; null when none was found. */
  lastActiveAt: string | null;
  /** For `usage-window`: how many days back the provider's data was read. */
  windowDays?: number;
  /**
   * Plain-English description of the evidence, shown beside the date:
   * "Copilot last activity (vscode)", "Okta last sign-in".
   */
  source: string;
}

/**
 * Where a seat price came from.
 *
 * - `billing`: the provider's bill or subscription for this account.
 * - `catalog`: the provider's own price API for this plan.
 * - `configured`: a price the user entered on the account (the Cursor
 *   credential fields), for providers that report none.
 * - `list-price`: the provider's published list price, as an estimate.
 *   Negotiated and annual prices differ; surfaces label it.
 */
export type SeatPriceSource = "billing" | "catalog" | "configured" | "list-price";

export interface SeatPrice {
  /** Per seat per month. */
  monthly: number;
  /** ISO 4217. */
  currency: string;
  source: SeatPriceSource;
  /** Where a list price was read and when, e.g. "github.com/features/copilot/plans, 2026-10". */
  note?: string;
}

/**
 * What kind of tool the seat is for. Two seats held by one person in the
 * same category on different tools (Copilot and Cursor, GitHub and GitLab)
 * are a duplicate finding; `other` never is, because two unrelated tools
 * are not a duplicate.
 */
export type SeatCategory = "ai-coding" | "ai-assistant" | "source-control" | "identity" | "other";

export const SEAT_CATEGORIES: readonly SeatCategory[] = [
  "ai-coding",
  "ai-assistant",
  "source-control",
  "identity",
  "other",
];

/** A cheaper tier the plugin can justify from what it sees. */
export interface SeatDowngrade {
  /** The provider's name for the cheaper tier, e.g. "Copilot Business". */
  seatType: string;
  price: SeatPrice;
  /** Why the cheaper tier would do, from evidence: "No premium requests in 30 days". */
  reason: string;
}

/** One paid seat as the provider reports it. */
export interface SeatRecord {
  /** Provider-native member id; stable across reads. */
  memberId: string;
  /**
   * Distinguishes several seats one member holds in the same account (rare;
   * empty for most providers). `memberId` + `seatKey` is the identity.
   */
  seatKey?: string;
  name: string | null;
  /** The email the member signs in with, lower-cased. The cross-tool join key. */
  email: string | null;
  /** Provider username where it has one (GitHub login). */
  login?: string | null;
  /** The product the seat is for, as the provider names it: "GitHub Copilot". */
  product: string;
  category: SeatCategory;
  /** The provider's name for the seat or plan: "Copilot Business", "Premium". */
  seatType: string;
  price: SeatPrice | null;
  activity: SeatActivity;
  /** When the seat was assigned; a seat newer than the org's window is never inactive. */
  assignedAt: string | null;
  /**
   * The seat is already on its way out (Copilot's pending cancellation):
   * listed, never flagged, never counted as a saving.
   */
  pendingRemovalOn?: string | null;
  /** True when `PluginClient.removeSeat` can remove this seat. */
  removable: boolean;
  /** What removal does, e.g. "Billed until the end of the cycle". */
  removalNote?: string;
  downgrade?: SeatDowngrade | null;
  /**
   * Account-level context the plugin's remediation generator needs and the
   * seat itself does not carry (the GitHub organization login, the GitLab
   * group id, the Okta domain). Strings only; stored as-is.
   */
  context?: Record<string, string>;
  /** The synced resource this seat corresponds to, when the plugin lists one. */
  resource?: { resourceTypeId: string; externalId: string };
}

/** Options the host passes to `fetchSeats`. */
export interface SeatFetchOptions {
  /**
   * The org's inactivity threshold in days. A `usage-window` provider should
   * read at least this far back when its API allows, so a seat with no
   * usage can be called inactive for the whole threshold.
   */
  lookbackDays: number;
}

/** What `removeSeat` did. */
export interface SeatRemovalResult {
  /** `end-of-cycle` when the provider keeps billing until the period ends. */
  effective: "immediate" | "end-of-cycle";
  /** Shown to the person who clicked Remove. */
  message?: string;
}

/** The identity of a seat the host asks a plugin to remove. */
export interface SeatRef {
  memberId: string;
  seatKey?: string;
  email?: string | null;
  login?: string | null;
  context?: Record<string, string>;
}

/**
 * Manifest declaration: the plugin reports seats via `fetchSeats`, and the
 * host schedules a daily collection pass for its accounts.
 */
export interface SeatsCapabilityDeclaration {
  /** The products this plugin reports seats for, e.g. ["GitHub Copilot"]. */
  products: string[];
  /** True when the client implements `removeSeat`. */
  removal?: boolean;
}

const BASES: readonly SeatActivityBasis[] = ["last-activity", "last-login", "usage-window", "none"];
const PRICE_SOURCES: readonly SeatPriceSource[] = [
  "billing",
  "catalog",
  "configured",
  "list-price",
];

function cleanString(value: unknown, max = 300): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function cleanDate(value: unknown): string | null {
  const text = cleanString(value, 40);
  if (!text) return null;
  return Number.isNaN(Date.parse(text)) ? null : text;
}

function cleanPrice(value: unknown): SeatPrice | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Partial<SeatPrice>;
  if (typeof p.monthly !== "number" || !Number.isFinite(p.monthly) || p.monthly < 0) return null;
  const currency = cleanString(p.currency, 3)?.toUpperCase();
  if (!currency || !PRICE_SOURCES.includes(p.source as SeatPriceSource)) return null;
  const note = cleanString(p.note, 300);
  return {
    monthly: p.monthly,
    currency,
    source: p.source as SeatPriceSource,
    ...(note ? { note } : {}),
  };
}

/**
 * Validate and normalise what a plugin returned, dropping malformed rows
 * rather than failing the read: the host stores what survives. Emails are
 * lower-cased here so the duplicate join never depends on a plugin
 * remembering to. An unparseable activity date becomes `null` with its
 * basis kept, and an unknown basis becomes `none`, so a bug can only ever
 * make a seat read as "unknown", never as idle.
 */
export function normalizeSeatRecords(records: unknown): SeatRecord[] {
  if (!Array.isArray(records)) return [];
  const out: SeatRecord[] = [];
  const seen = new Set<string>();
  for (const raw of records) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Partial<SeatRecord>;
    const memberId = cleanString(r.memberId, 200);
    const product = cleanString(r.product, 100);
    const seatType = cleanString(r.seatType, 100);
    if (!memberId || !product || !seatType) continue;
    const seatKey = cleanString(r.seatKey, 100) ?? "";
    const identity = `${memberId}\u0000${seatKey}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const activityRaw = (r.activity ?? {}) as Partial<SeatActivity>;
    const basis = BASES.includes(activityRaw.basis as SeatActivityBasis)
      ? (activityRaw.basis as SeatActivityBasis)
      : "none";
    const windowDays =
      typeof activityRaw.windowDays === "number" && activityRaw.windowDays > 0
        ? Math.floor(activityRaw.windowDays)
        : undefined;
    const category = SEAT_CATEGORIES.includes(r.category as SeatCategory)
      ? (r.category as SeatCategory)
      : "other";
    const downgradePrice = r.downgrade ? cleanPrice(r.downgrade.price) : null;
    const downgradeType = r.downgrade ? cleanString(r.downgrade.seatType, 100) : null;
    const context: Record<string, string> = {};
    if (r.context && typeof r.context === "object") {
      for (const [k, v] of Object.entries(r.context)) {
        if (typeof v === "string" && v) context[k.slice(0, 60)] = v.slice(0, 300);
      }
    }
    const resource =
      r.resource &&
      cleanString(r.resource.resourceTypeId, 100) &&
      cleanString(r.resource.externalId, 300)
        ? { resourceTypeId: r.resource.resourceTypeId, externalId: r.resource.externalId }
        : undefined;
    out.push({
      memberId,
      ...(seatKey ? { seatKey } : {}),
      name: cleanString(r.name, 200),
      email: cleanString(r.email, 320)?.toLowerCase() ?? null,
      login: cleanString(r.login, 200),
      product,
      category,
      seatType,
      price: cleanPrice(r.price),
      activity: {
        basis,
        lastActiveAt: basis === "none" ? null : cleanDate(activityRaw.lastActiveAt),
        ...(basis === "usage-window" && windowDays ? { windowDays } : {}),
        source: cleanString(activityRaw.source, 200) ?? "",
      },
      assignedAt: cleanDate(r.assignedAt),
      pendingRemovalOn: cleanDate(r.pendingRemovalOn),
      removable: r.removable === true,
      ...(cleanString(r.removalNote, 300) ? { removalNote: cleanString(r.removalNote, 300)! } : {}),
      downgrade:
        downgradePrice && downgradeType
          ? {
              seatType: downgradeType,
              price: downgradePrice,
              reason: cleanString(r.downgrade!.reason, 300) ?? "",
            }
          : null,
      ...(Object.keys(context).length > 0 ? { context } : {}),
      ...(resource ? { resource } : {}),
    });
  }
  return out;
}
