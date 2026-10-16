/**
 * Root-cause attribution for cost anomalies: below the provider or service the
 * detector flagged, *what* moved.
 *
 * Detection (`anomaly-eval.ts`) judges spend per provider and per service,
 * which is the right grain to decide that a day is anomalous and the wrong one
 * to act on: "Amazon EC2 tripled" sends somebody to read a bill. This module
 * decomposes the anomalous day's rise over its baseline along every facet the
 * cost rows carry (resource, account, region, usage unit, charge type and each
 * tag key's values) and keeps the few values per facet that carried most of
 * it, so the alert can say "i-0abc (web-1) is 64% of it".
 *
 * The split follows `anomaly-detect.ts` / `anomaly-eval.ts`:
 *
 * - {@link rankAnomalyContributors} is pure (rows in, ranked contributors out)
 *   and unit-tested without a database.
 * - {@link computeAnomalyContributors} is the I/O: **one** grouped ClickHouse
 *   statement over the anomaly's scope and baseline window
 *   (`getAnomalyContributorRows`), then two small Postgres reads to name what
 *   it found (synced resources by provider id, accounts by id).
 *
 * The baseline is the detector's own: the mean of the same trailing window,
 * zero-filled the same way (a sum divided by the window's length), so within a
 * facet the deltas add up to the anomaly's rise and a share means the same
 * thing on every row.
 *
 * Contributors are computed with no cost visibility scope (the poller has
 * none, and the read side's lazy backfill establishes an unrestricted one) and
 * stored org-wide on the anomaly row. Folding what a scoped viewer may not see
 * happens on read (`foldCostAnomalyContributors` in client-core).
 */
import { and, eq, inArray } from "drizzle-orm";
import type {
  CostAnomalyContributor,
  CostAnomalyContributorFacet,
  CostAnomalyContributorResource,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { accounts, resources } from "../db/schema";
import { isClickHouseConfigured } from "../clickhouse/client";
import { getAnomalyContributorRows, type AnomalyContributorRow } from "../clickhouse/cost-readers";
import { ANOMALY_BASELINE_DAYS } from "./anomaly-detect";
import { addDays } from "./dates";

/** Values kept per facet. */
export const CONTRIBUTORS_PER_FACET = 3;

/** Tag values kept across every tag key, at most one per key. */
export const MAX_TAG_CONTRIBUTORS = 3;

/**
 * Below this share of the rise a value is not "a contributor", it is noise.
 * Stated as a share rather than an amount so it scales with the anomaly.
 */
export const MIN_CONTRIBUTOR_SHARE = 0.05;

/**
 * Rows the statement keeps per facet: one more than are stored, because the
 * resource facet's `""` (spend no resource id was reported for) can take a
 * slot in SQL and is dropped here.
 */
const SQL_PER_FACET = CONTRIBUTORS_PER_FACET + 1;

/** Rows the statement keeps overall, across every facet and tag key. */
const SQL_MAX_ROWS = 400;

/** The physical facets, in the order a contributor list is presented. */
const PHYSICAL_FACETS = [
  "resource",
  "account",
  "region",
  "usage_unit",
  "charge_type",
] as const satisfies readonly CostAnomalyContributorFacet[];

/** A ranked contributor before naming: what the pure half produces. */
export interface RankedContributor {
  facet: CostAnomalyContributorFacet;
  key: string;
  tagKey: string | null;
  /** The one account its spend sits in, or null when several. */
  accountId: string | null;
  /** The one plugin its spend came from, or null when several. */
  pluginId: string | null;
  /** Currency units, not cents. */
  actual: number;
  baselineMean: number;
  delta: number;
  share: number | null;
}

export interface RankContributorsOptions {
  /** The baseline window's length: what turns `baselineTotal` into a mean. */
  baselineDays: number;
  perFacet?: number;
  maxTags?: number;
  minShare?: number;
}

/** Below a cent there is nothing to report. */
const MIN_DELTA = 0.005;

/**
 * Rank the statement's rows into the contributors worth storing. Pure.
 *
 * Only values that *rose* contribute: the question is what drove spend up, and
 * a value that fell is at most context for one that rose more. Within a facet
 * they rank by absolute rise; each keeps its share of the whole rise (the
 * `total` row), and values under {@link MIN_CONTRIBUTOR_SHARE} are dropped as
 * noise. Two values are never contributors whatever they did: the resource
 * facet's empty id (spend the provider reported no resource for, which is not
 * a resource anybody can open) and an empty tag value (not a value).
 *
 * Tag keys compete with each other for {@link MAX_TAG_CONTRIBUTORS} places,
 * one value per key, so `team=data`, `env=prod` and `app=api` beat three
 * values of one key: they are three different statements about the money.
 */
export function rankAnomalyContributors(
  rows: readonly AnomalyContributorRow[],
  options: RankContributorsOptions,
): RankedContributor[] {
  const days = Math.max(1, options.baselineDays);
  const perFacet = options.perFacet ?? CONTRIBUTORS_PER_FACET;
  const maxTags = options.maxTags ?? MAX_TAG_CONTRIBUTORS;
  const minShare = options.minShare ?? MIN_CONTRIBUTOR_SHARE;

  const total = rows.find((r) => r.facet === "total");
  const totalDelta = total ? total.actual - total.baselineTotal / days : null;
  const denominator = totalDelta !== null && totalDelta > MIN_DELTA ? totalDelta : null;

  const candidates: RankedContributor[] = [];
  for (const row of rows) {
    let facet: CostAnomalyContributorFacet;
    let tagKey: string | null = null;
    if (row.facet.startsWith("tag:")) {
      facet = "tag";
      tagKey = row.facet.slice(4);
      if (!tagKey || !row.key) continue;
    } else if ((PHYSICAL_FACETS as readonly string[]).includes(row.facet)) {
      facet = row.facet as CostAnomalyContributorFacet;
      if (facet === "resource" && !row.key) continue;
    } else {
      continue; // `total`, or a facet this build does not know
    }
    const baselineMean = row.baselineTotal / days;
    const delta = row.actual - baselineMean;
    if (!(delta > MIN_DELTA)) continue;
    const share = denominator === null ? null : delta / denominator;
    if (share !== null && share < minShare) continue;
    candidates.push({
      facet,
      key: row.key,
      tagKey,
      accountId: row.accountId || null,
      pluginId: row.pluginId || null,
      actual: row.actual,
      baselineMean,
      delta,
      share,
    });
  }

  const byDelta = (a: RankedContributor, b: RankedContributor) =>
    b.delta - a.delta || a.key.localeCompare(b.key);
  const out: RankedContributor[] = [];
  for (const facet of PHYSICAL_FACETS) {
    out.push(
      ...candidates
        .filter((c) => c.facet === facet)
        .sort(byDelta)
        .slice(0, perFacet),
    );
  }
  const seenKeys = new Set<string>();
  const tags: RankedContributor[] = [];
  for (const c of candidates.filter((x) => x.facet === "tag").sort(byDelta)) {
    if (seenKeys.has(c.tagKey ?? "")) continue;
    seenKeys.add(c.tagKey ?? "");
    tags.push(c);
    if (tags.length >= maxTags) break;
  }
  out.push(...tags);
  return out;
}

/** The slice of an anomaly the decomposition needs. */
export interface AnomalyContributorTarget {
  /** The anomalous day, "YYYY-MM-DD". */
  day: string;
  dimension: "provider" | "service";
  dimensionKey: string;
  currency: string;
}

/** What a facet value is called when it has no value at all. */
function emptyLabel(facet: CostAnomalyContributorFacet): string {
  switch (facet) {
    case "region":
      return "(no region)";
    case "usage_unit":
      return "(no unit)";
    case "tag":
      return "(untagged)";
    default:
      return "(none)";
  }
}

/**
 * Name ranked contributors and convert them to the stored shape. Pure: the
 * lookups are passed in. `resourcesByKey` is keyed `"<accountId> <externalId>"`
 * and, as a fallback for a value spanning accounts, by the bare external id.
 */
export function toStoredContributors(
  ranked: readonly RankedContributor[],
  names: {
    accountNames: ReadonlyMap<string, string>;
    resourcesByKey: ReadonlyMap<string, CostAnomalyContributorResource>;
  },
): CostAnomalyContributor[] {
  return ranked.map((c) => {
    let resource: CostAnomalyContributorResource | null = null;
    let label = c.key || emptyLabel(c.facet);
    if (c.facet === "resource") {
      resource =
        (c.accountId ? names.resourcesByKey.get(`${c.accountId} ${c.key}`) : undefined) ??
        names.resourcesByKey.get(c.key) ??
        null;
      if (resource) label = resource.name;
    } else if (c.facet === "account") {
      label = names.accountNames.get(c.key) ?? label;
    }
    return {
      facet: c.facet,
      key: c.key,
      tagKey: c.tagKey,
      label,
      accountId: c.accountId,
      resource,
      actualCents: Math.round(c.actual * 100),
      baselineCents: Math.round(c.baselineMean * 100),
      deltaCents: Math.round(c.delta * 100),
      share: c.share === null ? null : Math.round(c.share * 10_000) / 10_000,
    };
  });
}

/**
 * Decompose one anomaly and name what it found. Null when it could not be
 * computed (ClickHouse unconfigured or failing, a Postgres read failing):
 * callers store nothing then, so a later pass or read tries again. An empty
 * list is an answer (nothing rose enough to name) and is stored as one.
 *
 * Never throws: contributors annotate an alert that must go out regardless.
 */
export async function computeAnomalyContributors(
  organizationId: string,
  target: AnomalyContributorTarget,
): Promise<CostAnomalyContributor[] | null> {
  if (!isClickHouseConfigured()) return null;
  try {
    const rows = await getAnomalyContributorRows(organizationId, {
      day: target.day,
      baselineFrom: addDays(target.day, -ANOMALY_BASELINE_DAYS),
      baselineDays: ANOMALY_BASELINE_DAYS,
      dimension: target.dimension,
      dimensionKey: target.dimensionKey,
      currency: target.currency,
      perFacet: SQL_PER_FACET,
      maxRows: SQL_MAX_ROWS,
    });
    const ranked = rankAnomalyContributors(rows, { baselineDays: ANOMALY_BASELINE_DAYS });
    if (ranked.length === 0) return [];

    // Synced resources by provider id. The (plugin_id, external_id) index
    // serves this when the rows name their plugin, which is the usual case.
    const resourceKeys = [
      ...new Set(ranked.filter((c) => c.facet === "resource").map((c) => c.key)),
    ];
    const resourcesByKey = new Map<string, CostAnomalyContributorResource>();
    if (resourceKeys.length > 0) {
      const pluginIds = [
        ...new Set(
          ranked
            .filter((c) => c.facet === "resource" && c.pluginId)
            .map((c) => c.pluginId as string),
        ),
      ];
      const found = await db
        .select({
          id: resources.id,
          accountId: resources.accountId,
          pluginId: resources.pluginId,
          resourceTypeId: resources.resourceTypeId,
          name: resources.displayName,
          externalId: resources.externalId,
        })
        .from(resources)
        .where(
          and(
            eq(resources.organizationId, organizationId),
            inArray(resources.externalId, resourceKeys),
            ...(pluginIds.length > 0 ? [inArray(resources.pluginId, pluginIds)] : []),
          ),
        );
      for (const r of found) {
        if (!r.externalId || !r.accountId) continue;
        const value: CostAnomalyContributorResource = {
          id: r.id,
          accountId: r.accountId,
          pluginId: r.pluginId,
          resourceTypeId: r.resourceTypeId,
          name: r.name,
        };
        resourcesByKey.set(`${r.accountId} ${r.externalId}`, value);
        if (!resourcesByKey.has(r.externalId)) resourcesByKey.set(r.externalId, value);
      }
    }

    const accountIds = [
      ...new Set(ranked.filter((c) => c.facet === "account" && c.key).map((c) => c.key)),
    ];
    const accountNames = new Map<string, string>();
    if (accountIds.length > 0) {
      const found = await db
        .select({ id: accounts.id, name: accounts.displayName })
        .from(accounts)
        .where(and(eq(accounts.organizationId, organizationId), inArray(accounts.id, accountIds)));
      for (const a of found) accountNames.set(a.id, a.name);
    }

    return toStoredContributors(ranked, { accountNames, resourcesByKey });
  } catch (err) {
    console.error(
      `[anomaly-contributors] decomposition failed for org ${organizationId} (${target.dimension} ${target.dimensionKey} ${target.currency} on ${target.day}):`,
      err,
    );
    return null;
  }
}
