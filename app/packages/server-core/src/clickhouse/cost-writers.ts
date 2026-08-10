import type { CostChargeType, CostRow } from "@infrawrench/plugin-base";
import { getClickHouseClient, isClickHouseConfigured } from "./client";

export interface CostDailyRow {
  organization_id: string;
  account_id: string;
  plugin_id: string;
  day: string;
  service: string;
  region: string;
  resource_id: string;
  tags: Record<string, string>;
  tags_hash: string;
  currency: string;
  amount: number;
  usage_amount: number;
  usage_unit: string;
  /** What kind of charge this is; "usage" for everything that doesn't say. */
  charge_type: string;
  /** Cash spread over the period it covers. Only meaningful when reported. */
  amortized_amount: number;
  /**
   * 1 when the plugin reported an amortized amount, 0 when it said nothing.
   * Distinguishes a reported 0 (a purchase row, which amortizes to nothing on
   * its purchase day) from an absent one (readers fall back to `amount`).
   */
  amortized_reported: number;
  /** Reservation / savings plan / CUD this row belongs to; "" when none. */
  commitment_id: string;
}

/**
 * Tag keys the host owns. Mirrors `RESERVED_TAG_PREFIX` in `cost/cost-ingest.ts`
 * (restated rather than imported — that module imports this one, and a cycle
 * between the writer and its validator helps nobody). Pushed rows are rejected
 * for using this prefix, so nothing a caller supplies can collide with the
 * synthetic entries {@link hashTags} folds in below.
 */
const RESERVED_KEY_PREFIX = "infrawrench:";

/**
 * The parts of a row's identity that are NOT columns in `cost_daily`'s ORDER BY
 * but must still keep rows apart. See {@link hashTags}.
 */
export interface CostRowKeyExtras {
  chargeType?: string | undefined;
  commitmentId?: string | undefined;
}

/**
 * Stable 64-bit FNV-1a hash of a canonicalized (key-sorted, `=`/`\n`-joined)
 * tags map, as a decimal string for ClickHouse's UInt64. Deterministic across
 * processes so re-ingested rows land on the same ReplacingMergeTree key.
 *
 * **Why charge type and commitment id are hashed in here.** `cost_daily` is a
 * ReplacingMergeTree whose sort key is
 * `(org, account, day, service, region, resource_id, tags_hash, currency)`, and
 * that key is frozen — it cannot gain `charge_type` without re-keying three
 * years of history (`clickhouse/migrate.ts` explains why the ALTER path may
 * only add columns). But a provider legitimately reports several charge types
 * for the same account, day, service and region: the EC2 usage line, the credit
 * applied against it, and the tax on it are three rows identical in every key
 * column. Written as-is, ReplacingMergeTree treats them as three versions of
 * one row and `FINAL` keeps only the last one ingested — the org's spend would
 * silently become whichever line the provider happened to page in last.
 *
 * So they are folded into `tags_hash`, which IS in the key, as synthetic
 * `infrawrench:`-prefixed entries. This is the same trick pushed rows use to
 * keep their key space disjoint from the collectors' (`cost/cost-ingest.ts`),
 * for the same reason.
 *
 * **The fold is conditional, and that is not an optimization.** A row with no
 * charge type (or an explicit `usage`) and no commitment id hashes to exactly
 * what it hashed to before this field existed. That is what makes re-collecting
 * a day *replace* the rows already stored for it instead of doubling every
 * historical number the first time a restatement window is re-fetched. Do not
 * "simplify" this by always appending the charge type.
 *
 * **The synthetic entries go into the hash only — never into the `tags` column
 * {@link toCostDailyRows} writes — and something depends on that.**
 * `clickhouse/cost-reconcile.ts` distinguishes a collector's rows from rows a
 * user pushed by looking for a reserved key in the *stored* `tags`, so if these
 * entries were also stored, every attribution row a collector writes would look
 * pushed, and reconciliation would skip exactly the rows it exists to fix —
 * silently, since it would still run and still find nothing. The two ends are
 * cross-referenced; change neither alone.
 */
export function hashTags(
  tags: Record<string, string> | undefined,
  extras?: CostRowKeyExtras,
): string {
  const keys = tags ? Object.keys(tags).sort() : [];
  const parts = keys.map((k) => `${k}=${tags![k]}`);

  // Only non-default values are folded in — see the note above about why the
  // default must hash identically to a plain tags map.
  const chargeType = extras?.chargeType ?? "usage";
  if (chargeType !== "usage") parts.push(`${RESERVED_KEY_PREFIX}charge_type=${chargeType}`);
  const commitmentId = extras?.commitmentId ?? "";
  if (commitmentId) parts.push(`${RESERVED_KEY_PREFIX}commitment=${commitmentId}`);

  if (parts.length === 0) return "0";
  const canonical = parts.join("\n");
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= BigInt(canonical.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(10);
}

/** Map plugin CostRows onto cost_daily rows for one account. */
export function toCostDailyRows(
  meta: { organizationId: string; accountId: string; pluginId: string },
  rows: CostRow[],
): CostDailyRow[] {
  return rows.map((r) => {
    const chargeType: CostChargeType = r.chargeType ?? "usage";
    const commitmentId = r.commitmentId ?? "";
    return {
      organization_id: meta.organizationId,
      account_id: meta.accountId,
      plugin_id: meta.pluginId,
      day: r.date,
      service: r.service ?? "",
      region: r.region ?? "",
      resource_id: r.resourceId ?? "",
      tags: r.tags ?? {},
      // Charge type and commitment id ride in the hash because the sort key
      // cannot carry them — without this a credit would replace the usage line
      // it was credited against. See hashTags.
      tags_hash: hashTags(r.tags, { chargeType, commitmentId }),
      currency: r.currency,
      amount: r.amount,
      usage_amount: r.usageAmount ?? 0,
      usage_unit: r.usageUnit ?? "",
      charge_type: chargeType,
      // Absent and zero are different answers and must stay different: a
      // commitment purchase amortizes to *zero* on its purchase day, while a
      // provider with no amortized data at all has *no* answer and readers fall
      // back to `amount`. Collapsing the two shows the purchase at full cash
      // alongside all of its amortized slices.
      amortized_amount: r.amortizedAmount ?? 0,
      amortized_reported: r.amortizedAmount === undefined ? 0 : 1,
      commitment_id: commitmentId,
    };
  });
}

export async function insertCostRows(rows: CostDailyRow[]): Promise<void> {
  if (!isClickHouseConfigured() || rows.length === 0) return;
  // Unlike the fire-and-forget metric writers, cost collection must know
  // about failures so the poller can back off and retry — let errors throw.
  await getClickHouseClient().insert({ table: "cost_daily", values: rows, format: "JSONEachRow" });
}
