import type { CostAnomaly } from "./cost-anomalies";
import type { CostFilter, CostGraphConfig } from "./costs";

/* ------------------------------------------------------------------ *
 * Cost anomaly contributors: what, below the provider or service the
 * detector flagged, actually moved.
 * ------------------------------------------------------------------ */

/**
 * The breakdowns a flagged day is decomposed along. Every facet is a full
 * partition of the anomaly's spend (each cost row lands in exactly one value
 * of each), so within one facet the deltas add up to the anomaly's own rise
 * and a share is a share of the same number on every row.
 *
 * - `resource`: the provider-native resource id the cost row carries. Only
 *   plugins that report the `resource` cost dimension produce these, so an
 *   anomaly on a provider that bills per service only has none.
 * - `usage_unit`: the provider's unit for the line ("Hrs", "GB-Mo"), the
 *   closest thing to a usage type every provider reports.
 * - `tag`: one provider tag key's values. A tag key the day's spend does not
 *   carry contributes nothing.
 */
export const COST_ANOMALY_CONTRIBUTOR_FACETS = [
  "resource",
  "account",
  "region",
  "usage_unit",
  "charge_type",
  "tag",
] as const;
export type CostAnomalyContributorFacet = (typeof COST_ANOMALY_CONTRIBUTOR_FACETS)[number];

export const COST_ANOMALY_CONTRIBUTOR_FACET_LABELS: Record<CostAnomalyContributorFacet, string> = {
  resource: "Resource",
  account: "Account",
  region: "Region",
  usage_unit: "Usage unit",
  charge_type: "Charge type",
  tag: "Tag",
};

/**
 * The synced inventory row a `resource` contributor's provider id resolved
 * to, when there is one: what a client needs to open the resource's detail
 * page. Null for resources that were never synced (or were deleted since),
 * which is common: billing reports things inventory never lists.
 */
export interface CostAnomalyContributorResource {
  /** Infrawrench's resource id (not the provider id). */
  id: string;
  accountId: string;
  pluginId: string;
  resourceTypeId: string;
  name: string;
}

/**
 * One value of one facet and how much of the anomalous day's rise it carried.
 *
 * Amounts compare the anomalous day against the mean of the same trailing
 * window the detector used, so `actualCents - baselineCents = deltaCents` and,
 * within a facet, the deltas sum to the anomaly's own delta.
 */
export interface CostAnomalyContributor {
  facet: CostAnomalyContributorFacet;
  /**
   * The value as cost rows carry it: an account id, a region, the
   * provider-native resource id, a usage unit, a charge type or a tag value.
   * Empty for rows with no value (spend with no region, untagged spend) and for
   * the folded `other` row.
   */
  key: string;
  /** The tag key, for the `tag` facet; null otherwise. */
  tagKey: string | null;
  /** What to call it: an account or resource name where one is known, else `key`. */
  label: string;
  /**
   * The account this contributor's spend sits in, when all of it sits in one
   * (always, for `account` and nearly always for `resource`); null when it
   * spans several. This is what cost visibility scopes decide on.
   */
  accountId: string | null;
  /** The synced resource, for a `resource` contributor that matched one. */
  resource: CostAnomalyContributorResource | null;
  /** Spend on the anomalous day, in cents. */
  actualCents: number;
  /** Mean daily spend over the trailing baseline window, in cents. */
  baselineCents: number;
  /** `actualCents - baselineCents`. Negative when this value fell. */
  deltaCents: number;
  /**
   * `deltaCents` over the whole anomaly's rise, 0..1 for the usual case. Can
   * exceed 1 when other values in the same facet fell, and is null when the
   * day did not rise at all (nothing to take a share of).
   */
  share: number | null;
  /**
   * True for the one row per facet standing in for contributors outside the
   * viewer's cost visibility scope: their amounts are summed into it and their
   * names are never sent.
   */
  other?: boolean;
}

/**
 * The least share of the rise a contributor must carry to be called what
 * *drove* it. Below this it is one of several things that moved, and naming
 * it as the cause would send somebody after a fifth of the problem.
 */
export const COST_ANOMALY_DRIVER_MIN_SHARE = 0.2;

function drives(c: CostAnomalyContributor): boolean {
  return (
    !c.other && c.deltaCents > 0 && c.share !== null && c.share >= COST_ANOMALY_DRIVER_MIN_SHARE
  );
}

/**
 * The resource that drove the rise: the `resource` contributor with the
 * largest positive delta, provided it carried at least
 * {@link COST_ANOMALY_DRIVER_MIN_SHARE} of it. Null when none did (or the
 * provider reports no resource ids). Never the folded `other` row:
 * "something you cannot see" is not a resource anybody can open.
 */
export function costAnomalyDriver(
  anomaly: Pick<CostAnomaly, "contributors">,
): CostAnomalyContributor | null {
  let best: CostAnomalyContributor | null = null;
  for (const c of anomaly.contributors ?? []) {
    if (c.facet !== "resource" || !drives(c)) continue;
    if (!best || c.deltaCents > best.deltaCents) best = c;
  }
  return best;
}

/**
 * The single contributor worth naming in a one-line message: the driving
 * resource when there is one, otherwise the largest riser of the most specific
 * facet that has one (an account, then a region, and so on), under the same
 * share floor as the driver. Null when nothing qualifies or nothing was
 * computed.
 */
export function costAnomalyLeadContributor(
  anomaly: Pick<CostAnomaly, "contributors">,
): CostAnomalyContributor | null {
  const driver = costAnomalyDriver(anomaly);
  if (driver) return driver;
  for (const facet of COST_ANOMALY_CONTRIBUTOR_FACETS) {
    let best: CostAnomalyContributor | null = null;
    for (const c of anomaly.contributors ?? []) {
      if (c.facet !== facet || !drives(c)) continue;
      if (!best || c.deltaCents > best.deltaCents) best = c;
    }
    if (best) return best;
  }
  return null;
}

/**
 * The few contributors worth naming in an alert: the lead contributor, then
 * the largest qualifying riser of each *other* facet in facet order, up to
 * `max`. One per facet because the facets describe the same money from
 * different angles ("this resource, in this account, in this region"); three
 * resources would crowd out the account that tells a reader whose it is.
 */
export function costAnomalyHeadlineContributors(
  anomaly: Pick<CostAnomaly, "contributors">,
  max = 3,
): CostAnomalyContributor[] {
  const lead = costAnomalyLeadContributor(anomaly);
  if (!lead) return [];
  const out: CostAnomalyContributor[] = [lead];
  for (const facet of COST_ANOMALY_CONTRIBUTOR_FACETS) {
    if (out.length >= max) break;
    if (facet === lead.facet) continue;
    let best: CostAnomalyContributor | null = null;
    for (const c of anomaly.contributors ?? []) {
      if (c.facet !== facet || !drives(c)) continue;
      if (!best || c.deltaCents > best.deltaCents) best = c;
    }
    if (best) out.push(best);
  }
  return out;
}

/**
 * The clauses the server's lead hint ends with when the change timeline saw
 * the lead resource appear or change in the hint window. Shared so a client
 * can recognise them without parsing prose it did not write.
 */
export const COST_ANOMALY_LEAD_HINT_APPEARED = ", and appeared in the window";
export const COST_ANOMALY_LEAD_HINT_CHANGED = ", and changed in the window";

/**
 * Split an anomaly's hints for a surface that already shows the driving
 * resource on its own line.
 *
 * When there is a lead contributor, detection puts a sentence about it first
 * in `hints` ("resource web-1 (i-0abc) carried 64% of the rise (+$420), and
 * appeared in the window"), which is right for every surface that only
 * renders hints (older clients, the chat agent) and redundant beside a
 * "Driven by" line. This returns the remaining hints, plus what the timeline
 * said about the driver, so that line can carry it instead. Only the driver's
 * own sentence is split off: a lead that is an account or region (no driving
 * resource) stays in the list, since nothing else names it.
 */
export function splitCostAnomalyDriverHint(anomaly: Pick<CostAnomaly, "contributors" | "hints">): {
  driverEvent: "appeared" | "changed" | null;
  otherHints: string[];
} {
  const hints = anomaly.hints ?? [];
  const driver = costAnomalyDriver(anomaly);
  const first = hints[0];
  if (!driver || first === undefined || driver !== costAnomalyLeadContributor(anomaly)) {
    return { driverEvent: null, otherHints: [...hints] };
  }
  if (!first.startsWith(`${costAnomalyContributorPhrase(driver)} `)) {
    return { driverEvent: null, otherHints: [...hints] };
  }
  return {
    driverEvent: first.endsWith(COST_ANOMALY_LEAD_HINT_APPEARED)
      ? "appeared"
      : first.endsWith(COST_ANOMALY_LEAD_HINT_CHANGED)
        ? "changed"
        : null,
    otherHints: hints.slice(1),
  };
}

/** "64%", or null when there is no share to state. */
export function formatContributorShare(share: number | null | undefined): string | null {
  if (share === null || share === undefined || !Number.isFinite(share) || share <= 0) return null;
  const pct = Math.round(share * 100);
  return pct >= 1 ? `${pct}%` : "<1%";
}

/**
 * A contributor named with its facet, for a sentence that has no column
 * header to say what kind of thing it is: `resource web-1 (i-0abc)`,
 * `account Production (acc_1)`, `tag team=data`.
 */
export function costAnomalyContributorPhrase(c: CostAnomalyContributor): string {
  if (c.other) return "other spend";
  const noun: Record<CostAnomalyContributorFacet, string> = {
    resource: "resource",
    account: "account",
    region: "region",
    usage_unit: "usage unit",
    charge_type: "charge type",
    tag: "tag",
  };
  return `${noun[c.facet]} ${costAnomalyContributorName(c)}`;
}

/** A contributor's name as a sentence would say it: the label, plus the id when they differ. */
export function costAnomalyContributorName(c: CostAnomalyContributor): string {
  if (c.facet === "tag") return `${c.tagKey ?? "tag"}=${c.key || "(untagged)"}`;
  if (c.label && c.key && c.label !== c.key) return `${c.label} (${c.key})`;
  return c.label || c.key || "(none)";
}

function defaultMoney(cents: number, currency: string): string {
  const amount = cents / 100;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: Math.abs(amount) < 10 ? 2 : 0,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/**
 * One contributor as a plain-English line, for alert bodies, issue text and
 * the chat agent: `resource web-1 (i-0abc): +$420 vs a $12/day baseline, 64%
 * of the rise`. English on purpose: these are server-rendered messages, the same as
 * the rest of the alert text.
 */
export function describeCostAnomalyContributor(
  c: CostAnomalyContributor,
  currency: string,
  money: (cents: number, currency: string) => string = defaultMoney,
): string {
  const name = costAnomalyContributorPhrase(c);
  const sign = c.deltaCents >= 0 ? "+" : "-";
  const share = formatContributorShare(c.share);
  const against =
    c.baselineCents === 0
      ? " from nothing"
      : ` vs a ${money(c.baselineCents, currency)}/day baseline`;
  return (
    `${name}: ${sign}${money(Math.abs(c.deltaCents), currency)}${against}` +
    (share ? `, ${share} of the rise` : "")
  );
}

/**
 * Keep only what a cost-scoped viewer may see, and fold the rest.
 *
 * A contributor is visible when all of its spend sits in an account the
 * viewer's scope grants (`accountId` in `visibleAccountIds`); one spanning
 * several accounts, or sitting in one outside the scope, is not. Per facet,
 * everything not visible is summed into a single `other` row with no key,
 * label or resource, so the viewer learns that something else moved, and by
 * how much, without learning what it was.
 *
 * `visibleAccountIds` null means unrestricted: the list is returned as is.
 */
export function foldCostAnomalyContributors(
  contributors: readonly CostAnomalyContributor[],
  visibleAccountIds: ReadonlySet<string> | null,
): CostAnomalyContributor[] {
  if (!visibleAccountIds) return [...contributors];
  const out: CostAnomalyContributor[] = [];
  const others = new Map<CostAnomalyContributorFacet, CostAnomalyContributor>();
  for (const c of contributors) {
    const visible = !c.other && c.accountId !== null && visibleAccountIds.has(c.accountId);
    if (visible) {
      out.push(c);
      continue;
    }
    const existing = others.get(c.facet);
    if (existing) {
      existing.actualCents += c.actualCents;
      existing.baselineCents += c.baselineCents;
      existing.deltaCents += c.deltaCents;
      existing.share =
        existing.share === null || c.share === null ? null : existing.share + c.share;
    } else {
      others.set(c.facet, {
        facet: c.facet,
        key: "",
        tagKey: null,
        label: "Other",
        accountId: null,
        resource: null,
        actualCents: c.actualCents,
        baselineCents: c.baselineCents,
        deltaCents: c.deltaCents,
        share: c.share,
        other: true,
      });
    }
  }
  // Each facet's `other` row goes after that facet's visible rows, so a list
  // grouped by facet still reads top-down.
  const result: CostAnomalyContributor[] = [];
  for (const facet of COST_ANOMALY_CONTRIBUTOR_FACETS) {
    result.push(...out.filter((c) => c.facet === facet));
    const other = others.get(facet);
    if (other) result.push(other);
  }
  return result;
}

/**
 * The cost filters that chart one contributor's spend: the anomaly's own
 * provider or service, narrowed to the contributor's value. Null for a
 * contributor no cost filter can express (a usage unit is not a cost
 * dimension; the folded `other` row is deliberately nothing in particular).
 */
export function costAnomalyContributorFilters(
  anomaly: Pick<CostAnomaly, "dimension" | "dimensionKey">,
  c: CostAnomalyContributor,
): CostFilter[] | null {
  if (c.other) return null;
  const scope: CostFilter = {
    dimension: anomaly.dimension === "provider" ? "provider" : "service",
    op: "in",
    values: [anomaly.dimensionKey],
  };
  switch (c.facet) {
    case "resource":
      return [scope, { dimension: "resource", op: "in", values: [c.key] }];
    case "account":
      return [scope, { dimension: "account", op: "in", values: [c.key] }];
    case "region":
      return [scope, { dimension: "region", op: "in", values: [c.key] }];
    case "charge_type":
      return [scope, { dimension: "charge_type", op: "in", values: [c.key] }];
    case "tag":
      return c.tagKey
        ? [scope, { dimension: "tag", op: "in", values: [c.key], tagKey: c.tagKey }]
        : null;
    case "usage_unit":
      return null;
  }
}

/** Days of baseline a contributor chart shows before the anomalous day. */
export const COST_ANOMALY_CHART_DAYS_BEFORE = 27;
/** Days a contributor chart shows after it, so a reader sees whether it persisted. */
export const COST_ANOMALY_CHART_DAYS_AFTER = 7;

function shiftDay(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * A daily cost graph of one contributor around the anomalous day: the four
 * weeks of baseline before it and a week after (clamped to `today`), filtered
 * to the anomaly's scope and the contributor's value. What "open the cost
 * report for this" draws, and what saving it as a report stores. Null for a
 * contributor no filter can express (see {@link costAnomalyContributorFilters}).
 *
 * Absolute dates, not a relative preset: the point of the chart is that day,
 * and a saved "last 30 days" report would have scrolled past it within a month.
 */
export function costAnomalyContributorGraphConfig(
  anomaly: Pick<CostAnomaly, "day" | "dimension" | "dimensionKey">,
  contributor: CostAnomalyContributor,
  today: string = new Date().toISOString().slice(0, 10),
): CostGraphConfig | null {
  const filters = costAnomalyContributorFilters(anomaly, contributor);
  if (!filters) return null;
  const after = shiftDay(anomaly.day, COST_ANOMALY_CHART_DAYS_AFTER);
  return {
    version: 1,
    chartType: "stacked_bar",
    binning: "daily",
    dateRange: {
      kind: "absolute",
      from: shiftDay(anomaly.day, -COST_ANOMALY_CHART_DAYS_BEFORE),
      to: after < today ? after : today < anomaly.day ? anomaly.day : today,
    },
    groupBy: "none",
    filters,
    topN: 5,
    comparePreviousPeriod: false,
    showForecast: false,
  };
}
