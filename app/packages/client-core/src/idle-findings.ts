/**
 * Metric-based idle findings: the wire contract for the org's tuning of the
 * idle rules (`/api/org/:orgId/idle-findings`) and the formatting every
 * surface shares for the evidence behind a flagged row.
 *
 * The findings themselves ride the orphan feed (`GET /orphans`, see
 * `./orphans`): an idle row is an `OrphanedResource` with `idle` set, so the
 * savings list, issue filing, GitHub issues and pull requests, mobile and the
 * CLI all show them without a second shape. What is new here is the part a
 * person tunes: which rules run, their thresholds, and the lookback window,
 * plus the per-account collection status that explains an empty list.
 *
 * Type-only against plugin-base, like `./orphans`, so mobile can import it.
 */
import type {
  IdleFindingAction,
  IdleMetricEvidence,
  IdleValueUnit,
  OrphanedResource,
} from "@infrawrench/plugin-base";

import type { CloudFetch } from "./fetch";

export type {
  IdleFindingAction,
  IdleMetricEvidence,
  IdleSavingsEstimate,
  IdleValueUnit,
  OrphanIdleDetail,
} from "@infrawrench/plugin-base";

/** What the org changed about one rule; absent keys keep the declared default. */
export interface IdleRuleOverride {
  enabled?: boolean;
  thresholds?: Record<string, number>;
}

/** The org's idle-rule tuning (`org_idle_finding_settings`). */
export interface IdleFindingSettings {
  /** Master switch: off stops collection and hides every idle row. */
  enabled: boolean;
  /** Days of metrics each rule judges over. */
  lookbackDays: number;
  /** Overrides keyed by `pluginId:ruleId`. */
  rules: Record<string, IdleRuleOverride>;
}

/**
 * Bounds on the lookback window. Mirrors plugin-base `IDLE_LOOKBACK_LIMITS`
 * (a test pins the two together): client-core cannot import it at runtime.
 * 42 days is the shortest retention among the providers' metric stores at
 * full resolution (Cloud Monitoring keeps GKE system metrics six weeks).
 */
export const IDLE_FINDING_LIMITS = {
  minLookbackDays: 7,
  maxLookbackDays: 42,
  /** Rule overrides per org; far above the number of declared rules. */
  maxRules: 200,
} as const;

export const DEFAULT_IDLE_FINDING_SETTINGS: IdleFindingSettings = {
  enabled: true,
  lookbackDays: 14,
  rules: {},
};

/** One threshold of a rule, with the value the org's settings resolve to. */
export interface IdleRuleThresholdView {
  key: string;
  label: string;
  description: string | null;
  unit: IdleValueUnit;
  default: number;
  min: number;
  max: number;
  /** The effective value: the org's override clamped into range, or the default. */
  value: number;
}

/** One declared rule, as the settings form renders it. */
export interface IdleRuleView {
  /** `pluginId:ruleId`. */
  ruleKey: string;
  pluginId: string;
  pluginName: string;
  ruleId: string;
  label: string;
  description: string;
  action: IdleFindingAction;
  /** Display names of the resource types it judges; empty for a non-resource rule. */
  resourceTypeNames: string[];
  enabled: boolean;
  thresholds: IdleRuleThresholdView[];
}

/** Collection status for one account whose plugin declares idle rules. */
export interface IdleAccountStatus {
  accountId: string;
  accountName: string;
  pluginId: string;
  pluginName: string;
  lastPolledAt: string | null;
  nextPollAt: string | null;
  /** Last failure, null after a success. */
  lastError: string | null;
  helpLabel: string | null;
  helpUrl: string | null;
  /** Idle findings currently stored for the account. */
  findingCount: number;
}

/** `GET /idle-findings`: settings, the rule catalog and per-account status. */
export interface IdleFindingsOverview {
  settings: IdleFindingSettings;
  rules: IdleRuleView[];
  accounts: IdleAccountStatus[];
}

export async function fetchIdleFindingsOverview(
  api: CloudFetch,
  orgId: string,
): Promise<IdleFindingsOverview> {
  const res = await api.org<IdleFindingsOverview>(orgId, "/idle-findings");
  return res ?? { settings: { ...DEFAULT_IDLE_FINDING_SETTINGS }, rules: [], accounts: [] };
}

/** `PUT /idle-findings/settings` (`org:settings:write`): replaces the tuning. */
export async function saveIdleFindingSettings(
  api: CloudFetch,
  orgId: string,
  settings: IdleFindingSettings,
): Promise<IdleFindingSettings> {
  const res = await api.org<IdleFindingSettings>(orgId, "/idle-findings/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  return res ?? settings;
}

/** `POST /idle-findings/rescan` (`org:settings:write`): every account due now. */
export async function rescanIdleFindings(api: CloudFetch, orgId: string): Promise<void> {
  await api.org(orgId, "/idle-findings/rescan", { method: "POST" });
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/**
 * Format one evidence or threshold value. Bytes use decimal units, the
 * convention every provider's console uses for traffic; counts are grouped;
 * percentages keep up to two decimals so "0.4%" does not read as "0%".
 */
export function formatIdleValue(value: number | null, unit: IdleValueUnit): string {
  if (value === null || !Number.isFinite(value)) return "no data";
  switch (unit) {
    case "bytes": {
      let v = value;
      let i = 0;
      while (Math.abs(v) >= 1000 && i < BYTE_UNITS.length - 1) {
        v /= 1000;
        i += 1;
      }
      const digits = i === 0 || v >= 100 ? 0 : 1;
      return `${v.toFixed(digits)} ${BYTE_UNITS[i]}`;
    }
    case "percent":
      return `${Number(value.toFixed(2))}%`;
    case "days":
      return `${Math.round(value)} d`;
    case "count":
    default:
      return Math.abs(value) >= 1000
        ? Math.round(value).toLocaleString("en-US")
        : String(Number(value.toFixed(2)));
  }
}

/**
 * One evidence line in plain English, for the surfaces that are not
 * translated (the CLI, GitHub/Jira/Linear issue bodies):
 * `Bytes sent to the internet (BytesOutToDestination, sum): 0 B, flags at ≤ 1.0 MB`.
 */
export function describeIdleEvidence(e: IdleMetricEvidence): string {
  const head = `${e.label} (${e.metric}, ${e.statistic}): ${formatIdleValue(e.value, e.unit)}`;
  if (e.threshold === undefined || e.threshold === null) return head;
  const op = e.comparison === "atLeast" ? "≥" : "≤";
  return `${head}, flags at ${op} ${formatIdleValue(e.threshold, e.unit)}`;
}

/** The figure a savings row is worth per month, and where it came from. */
export interface OrphanMonthlyFigure {
  amount: number;
  currency: string;
  /** `billing`: the org's own billed spend; `list-price`: a published-rate estimate. */
  basis: "billing" | "list-price";
}

/**
 * What a flagged row saves per month: real billed spend scaled to 30 days
 * when the cost data matched the resource, else the plugin's list-price
 * estimate, else null (unpriced: counted, never summed as zero).
 */
export function orphanMonthlyFigure(
  row: Pick<OrphanedResource, "cost" | "estimate">,
  costWindowDays: number,
): OrphanMonthlyFigure | null {
  if (row.cost && costWindowDays > 0) {
    return {
      amount: Math.round(((row.cost.amount * 30) / costWindowDays) * 100) / 100,
      currency: row.cost.currency,
      basis: "billing",
    };
  }
  if (row.estimate) {
    return {
      amount: row.estimate.monthlyAmount,
      currency: row.estimate.currency,
      basis: "list-price",
    };
  }
  return null;
}
