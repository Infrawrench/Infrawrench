/**
 * Metric threshold alert rules — "CPU > 90% for 15 minutes on these
 * resources → alert".
 *
 * This module is the shared contract every surface uses: the wire shapes for
 * `/api/org/:orgId/metric-alerts`, the validation bounds the Zod schemas in
 * `@infrawrench/ui/metric-alerts` enforce, and the pure condition formatter
 * the web/desktop panels and the CLI all render with. The evaluator lives in
 * `server-core/src/metric-alerts/`.
 *
 * Resources are selected by *query* (plugin + resource type + tag), never by
 * id list, so a rule automatically covers resources created after the rule
 * was written.
 */
import type { CloudFetch } from "./fetch";

export type MetricAlertComparator = ">" | ">=" | "<" | "<=";

export const METRIC_ALERT_COMPARATORS: readonly MetricAlertComparator[] = [">", ">=", "<", "<="];

/**
 * Bounds the API enforces and the forms echo inline. `forMinutes` is floored
 * at 5 because samples are per-minute rollups written on the resource poll
 * cadence — a shorter window has too few samples to claim "held for the whole
 * window". The ceiling is 24h: the evaluator reads the 1m rollup, whose TTL
 * is 30 days, but a day is where "threshold alert" stops and "report" begins.
 */
export const METRIC_ALERT_LIMITS = {
  maxNameLength: 120,
  maxMetricKeyLength: 200,
  maxTagLength: 200,
  minForMinutes: 5,
  maxForMinutes: 1440,
  minCooldownMinutes: 0,
  maxCooldownMinutes: 10080,
} as const;

/** The resource selector half of a rule. Every field null means "any". */
export interface MetricAlertSelector {
  /** Plugin the resource must belong to; null = any plugin. */
  pluginId: string | null;
  /** Resource type within the plugin; null = any type. */
  resourceTypeId: string | null;
  /** Tag key the resource must carry (matched case-insensitively); null = no tag filter. */
  tagKey: string | null;
  /** Exact value `tagKey` must have; null = any value. */
  tagValue: string | null;
}

/** Body of `POST /api/org/:orgId/metric-alerts` and `PUT .../:id`. */
export interface MetricAlertRuleInput extends MetricAlertSelector {
  name: string;
  /** The metric series label as the resource's charts report it, e.g. "CPU %". */
  metricKey: string;
  comparator: MetricAlertComparator;
  threshold: number;
  /** Trailing window (minutes) the condition must hold for before firing. */
  forMinutes: number;
  /** Least minutes between notified firings for one (rule, resource). */
  cooldownMinutes: number;
  enabled: boolean;
}

/** Wire shape of a rule as every read endpoint returns it. */
export interface MetricAlertRule extends MetricAlertRuleInput {
  id: string;
  /** When the poller last evaluated this rule; null before the first pass. */
  lastEvalAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A rule with its live firing state, as the list endpoint returns it. */
export interface MetricAlertRuleWithStatus extends MetricAlertRule {
  /** Resources currently in breach of this rule. */
  firingCount: number;
  /** Resources the selector matches right now. */
  matchingResourceCount: number;
}

export type MetricAlertEventStatus = "firing" | "resolved";

/** One continuous breach of one rule on one resource. */
export interface MetricAlertEvent {
  id: string;
  ruleId: string;
  /** Denormalized rule name so history renders after a rule rename/delete. */
  ruleName: string;
  resourceId: string;
  resourceName: string;
  status: MetricAlertEventStatus;
  /** Worst sample observed in the breaching window, in the metric's unit. */
  observedValue: number;
  firedAt: string;
  resolvedAt: string | null;
}

/** A metric series that actually exists, for the rule builder's key picker. */
export interface MetricSeriesKeyOption {
  label: string;
  unit: string;
  /** Distinct resources that reported this series in the last 7 days. */
  resourceCount: number;
}

/** What `GET /metric-alerts/selector-preview` returns — the "who does this cover?" check. */
export interface MetricAlertSelectorPreview {
  matchingResourceCount: number;
  /** Up to 10 matching display names, for the form's live preview. */
  sampleResourceNames: string[];
}

/**
 * What the org's resources actually offer to select on — the pickers are fed
 * from this rather than a full plugin catalog, so the form never offers a
 * plugin or tag the org has no resources for.
 */
export interface MetricAlertSelectorOptions {
  plugins: Array<{ pluginId: string; resourceTypeIds: string[] }>;
  tagKeys: string[];
}

export const DEFAULT_METRIC_ALERT_INPUT: MetricAlertRuleInput = {
  name: "",
  pluginId: null,
  resourceTypeId: null,
  tagKey: null,
  tagValue: null,
  metricKey: "",
  comparator: ">",
  threshold: 90,
  forMinutes: 15,
  cooldownMinutes: 60,
  enabled: true,
};

/** `"CPU % > 90 for 15m"` — the one-line condition, shared by UI and CLI. */
export function describeMetricAlertCondition(
  rule: Pick<MetricAlertRuleInput, "metricKey" | "comparator" | "threshold" | "forMinutes">,
): string {
  return `${rule.metricKey} ${rule.comparator} ${rule.threshold} for ${rule.forMinutes}m`;
}

/** `"aws · ec2-instance · env=prod"`, or `"all resources"` for an empty selector. */
export function describeMetricAlertSelector(selector: MetricAlertSelector): string {
  const parts: string[] = [];
  if (selector.pluginId) parts.push(selector.pluginId);
  if (selector.resourceTypeId) parts.push(selector.resourceTypeId);
  if (selector.tagKey) {
    parts.push(selector.tagValue ? `${selector.tagKey}=${selector.tagValue}` : selector.tagKey);
  }
  return parts.length > 0 ? parts.join(" · ") : "all resources";
}

/* ------------------------------ fetch helpers ----------------------------- */

export async function listMetricAlertRules(
  api: CloudFetch,
  orgId: string,
): Promise<MetricAlertRuleWithStatus[]> {
  return (await api.org<MetricAlertRuleWithStatus[]>(orgId, "/metric-alerts")) ?? [];
}

export async function createMetricAlertRule(
  api: CloudFetch,
  orgId: string,
  input: MetricAlertRuleInput,
): Promise<MetricAlertRule | null> {
  return api.org<MetricAlertRule>(orgId, "/metric-alerts", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateMetricAlertRule(
  api: CloudFetch,
  orgId: string,
  ruleId: string,
  input: MetricAlertRuleInput,
): Promise<MetricAlertRule | null> {
  return api.org<MetricAlertRule>(orgId, `/metric-alerts/${encodeURIComponent(ruleId)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function deleteMetricAlertRule(
  api: CloudFetch,
  orgId: string,
  ruleId: string,
): Promise<void> {
  await api.org(orgId, `/metric-alerts/${encodeURIComponent(ruleId)}`, { method: "DELETE" });
}

export async function listMetricAlertEvents(
  api: CloudFetch,
  orgId: string,
  options: { ruleId?: string; limit?: number } = {},
): Promise<MetricAlertEvent[]> {
  const params = new URLSearchParams();
  if (options.ruleId) params.set("ruleId", options.ruleId);
  if (options.limit) params.set("limit", String(options.limit));
  const qs = params.toString();
  return (
    (await api.org<MetricAlertEvent[]>(orgId, `/metric-alerts/events${qs ? `?${qs}` : ""}`)) ?? []
  );
}

export async function listMetricSeriesKeyOptions(
  api: CloudFetch,
  orgId: string,
  filter: { pluginId?: string | null; resourceTypeId?: string | null } = {},
): Promise<MetricSeriesKeyOption[]> {
  const params = new URLSearchParams();
  if (filter.pluginId) params.set("pluginId", filter.pluginId);
  if (filter.resourceTypeId) params.set("resourceTypeId", filter.resourceTypeId);
  const qs = params.toString();
  return (
    (await api.org<MetricSeriesKeyOption[]>(
      orgId,
      `/metric-alerts/metric-keys${qs ? `?${qs}` : ""}`,
    )) ?? []
  );
}

export async function getMetricAlertSelectorOptions(
  api: CloudFetch,
  orgId: string,
): Promise<MetricAlertSelectorOptions> {
  return (
    (await api.org<MetricAlertSelectorOptions>(orgId, "/metric-alerts/selector-options")) ?? {
      plugins: [],
      tagKeys: [],
    }
  );
}

export async function previewMetricAlertSelector(
  api: CloudFetch,
  orgId: string,
  selector: MetricAlertSelector,
): Promise<MetricAlertSelectorPreview | null> {
  const params = new URLSearchParams();
  if (selector.pluginId) params.set("pluginId", selector.pluginId);
  if (selector.resourceTypeId) params.set("resourceTypeId", selector.resourceTypeId);
  if (selector.tagKey) params.set("tagKey", selector.tagKey);
  if (selector.tagValue) params.set("tagValue", selector.tagValue);
  const qs = params.toString();
  return api.org<MetricAlertSelectorPreview>(
    orgId,
    `/metric-alerts/selector-preview${qs ? `?${qs}` : ""}`,
  );
}
