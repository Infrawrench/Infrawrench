/**
 * Idle resource findings: the metric-based half of the savings finder.
 *
 * `orphanRule` answers "is this resource wasted?" from fields the lister
 * already stored: an unattached volume, an unassociated address. Some waste
 * only shows in how a resource is *used*: a NAT gateway nobody routes
 * through, a load balancer with no requests, a cache with no connections, a
 * DynamoDB table paying for capacity it never consumes. Those need the
 * provider's metrics over a window, which needs credentials, which is why
 * this is a separate, credentialed capability rather than another orphan
 * condition.
 *
 * The split follows `quotas` and `seats`:
 *
 * - **The plugin owns the provider half.** It declares its rules
 *   (`manifest.idleFindings`), reads the metrics through
 *   `PluginClient.fetchIdleFindings`, judges each resource against the
 *   thresholds the host hands it, and prices what it flags.
 * - **The host owns everything generic.** A daily poller pass stores the
 *   result per account, the org's settings (lookback window, per-rule
 *   switches and threshold overrides) are passed in on every read, and the
 *   stored findings join the orphan feed so every savings surface (the list,
 *   issue filing, GitHub, the digest, mobile, the CLI) shows them without
 *   learning a new shape.
 *
 * Three honesty rules every implementation keeps, because a flagged resource
 * is one somebody may delete:
 *
 * 1. **No data is not zero.** A resource whose metrics came back empty for
 *    the whole window is only flagged when the provider documents that the
 *    metric is not published while there is no activity (the ELB family says
 *    so in as many words); otherwise it is skipped. Evidence values are
 *    `null` when unknown, never `0`.
 * 2. **Every flag carries its evidence.** The metric, the statistic, the
 *    value over the window and the threshold it was judged against, so the
 *    person reading the finding can check the claim before acting on it.
 * 3. **Never invent a price.** `estimate.basis` says where the figure came
 *    from: `"list-price"` is the provider's published rate for the resource's
 *    configuration, labelled as an estimate everywhere it renders, and a
 *    finding with no defensible figure carries `estimate: null` (counted, not
 *    summed). Hosts prefer the org's real billed spend for the resource when
 *    the cost data carries resource ids.
 */

/** What a threshold or an evidence value counts. Drives formatting only. */
export type IdleValueUnit = "count" | "bytes" | "percent" | "days";

/** The aggregation a piece of evidence was read with, over the whole window. */
export type IdleEvidenceStatistic = "sum" | "max" | "average" | "min" | "count";

/**
 * One tunable bound of a rule. The org's settings override `default` within
 * `[min, max]`; the host clamps stored values back into that range, so a
 * plugin can rely on receiving a value the declaration allows.
 */
export interface IdleThresholdDeclaration {
  /** Stable key, unique within the rule (`maxBytesOut`). */
  key: string;
  /** Short label for the settings form ("Bytes sent to the internet"). */
  label: string;
  /** One line on what the bound means and which way it cuts. */
  description?: string;
  unit: IdleValueUnit;
  default: number;
  min: number;
  max: number;
}

/**
 * What acting on a finding means, which decides what a host may offer:
 *
 * - `remove`: the resource can go (a removal pull request is offered when
 *   Terraform manages it).
 * - `reconfigure`: keep the resource, change how it is billed (a provisioned
 *   table to on-demand). Never offered as a removal.
 * - `stop`: pause it, keep its data (a database).
 */
export type IdleFindingAction = "remove" | "reconfigure" | "stop";

export interface IdleRuleDeclaration {
  /** Stable id, unique within the plugin (`nat-gateway`). */
  id: string;
  /** "Idle NAT gateway". */
  label: string;
  /** What the rule reads and when it flags, in plain English. */
  description: string;
  /**
   * The synced resource types the rule judges. The host hands the plugin the
   * account's stored rows of these types. Empty for a rule about something
   * the plugin does not sync as a resource (a Datadog custom metric): those
   * findings carry `resourceId: null`.
   */
  resourceTypeIds: string[];
  thresholds: IdleThresholdDeclaration[];
  action: IdleFindingAction;
}

/**
 * `manifest.idleFindings`: the plugin can judge resources idle from their
 * metrics via `PluginClient.fetchIdleFindings`, and the host schedules a
 * daily collection pass for its accounts.
 */
export interface IdleFindingsCapabilityDeclaration {
  rules: IdleRuleDeclaration[];
}

/** A stored resource row the host hands the plugin to judge. */
export interface IdleScanResource {
  /** Infrawrench resource id; echoed back on a finding. */
  id: string;
  resourceTypeId: string;
  externalId: string | null;
  displayName: string;
  /** The stored `fields` bag, primitives only. */
  fields: Record<string, string | number | boolean>;
  /** The stored resolved outputs (ARNs and the like), when the host keeps them. */
  resolvedOutputs: Record<string, string>;
}

/** The settings one enabled rule runs with. */
export interface IdleRuleRequest {
  /** Every declared threshold, resolved: the org's override or the default. */
  thresholds: Record<string, number>;
}

export interface IdleScanRequest {
  /** Days of metrics to judge over. */
  lookbackDays: number;
  /** End of the window (ISO). The start is `lookbackDays` before it. */
  windowEnd: string;
  /** Enabled rules only, keyed by rule id. A rule absent here must not run. */
  rules: Record<string, IdleRuleRequest>;
  /** The account's stored resources of every enabled rule's types. */
  resources: IdleScanResource[];
}

/** One metric reading behind a finding. */
export interface IdleMetricEvidence {
  /** Provider metric name (`BytesOutToDestination`). */
  metric: string;
  /** Plain label ("Bytes sent to the internet"). */
  label: string;
  statistic: IdleEvidenceStatistic;
  /** The value over the whole window; null when the provider had no data. */
  value: number | null;
  unit: IdleValueUnit;
  /** The bound it was judged against, when it was one of the deciding readings. */
  threshold?: number | null;
  /** Which side of the threshold flags: `atMost` (value ≤ threshold) is the idle side. */
  comparison?: "atMost" | "atLeast";
}

/** Monthly figure a finding would save. */
export interface IdleSavingsEstimate {
  monthlyAmount: number;
  /** ISO 4217. */
  currency: string;
  /** `list-price`: the provider's published rate for this configuration. */
  basis: "list-price";
  /** Caveat shown beside the figure ("node hours only; data transfer excluded"). */
  note?: string;
}

/** One idle finding, as the plugin reports it. */
export interface IdleFindingRecord {
  /** The declared rule that flagged it. */
  ruleId: string;
  /**
   * Stable identity of the thing flagged within the account and rule, so
   * successive collections line up: the resource's externalId, or the metric
   * name for a subject that is not a synced resource.
   */
  subjectKey: string;
  /** The `IdleScanResource.id` judged, or null for a non-resource subject. */
  resourceId: string | null;
  /** Null exactly when `resourceId` is. */
  resourceTypeId: string | null;
  displayName: string;
  /** What a non-resource subject is ("Custom metric"); ignored for resources. */
  subjectLabel?: string;
  /** One sentence, the plugin's own wording, naming the deciding evidence. */
  reason: string;
  evidence: IdleMetricEvidence[];
  estimate: IdleSavingsEstimate | null;
  /** Primitive fields remediation generators may read (region, node type). */
  fields?: Record<string, string | number | boolean>;
}

/**
 * Throw from `fetchIdleFindings` when the credential cannot read what the
 * rules need (no `cloudwatch:GetMetricData`, a scope missing on a key), so
 * the host shows the fix instead of an empty list that reads as "nothing is
 * idle". Matched structurally by name, like `QuotaAccessError`.
 */
export class IdleFindingAccessError extends Error {
  readonly helpLabel: string | undefined;
  readonly helpUrl: string | undefined;

  constructor(message: string, help?: { label: string; url: string }) {
    super(message);
    this.name = "IdleFindingAccessError";
    this.helpLabel = help?.label;
    this.helpUrl = help?.url;
  }
}

/** Bounds on the org-wide lookback window, shared by every host. */
export const IDLE_LOOKBACK_LIMITS = { min: 7, max: 42, default: 14 } as const;

/** Globally unique rule key: rule ids are only unique within a plugin. */
export function idleRuleKey(pluginId: string, ruleId: string): string {
  return `${pluginId}:${ruleId}`;
}

/**
 * Resolve a rule's thresholds from the org's overrides: each declared key
 * takes the override when it is a finite number, clamped into the declared
 * range, and the default otherwise. Unknown override keys are ignored, so a
 * renamed threshold falls back to its default instead of erroring.
 */
export function resolveIdleThresholds(
  rule: Pick<IdleRuleDeclaration, "thresholds">,
  overrides: Readonly<Record<string, unknown>> | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of rule.thresholds) {
    const raw = overrides?.[t.key];
    const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    out[t.key] = Number.isFinite(n) ? Math.min(t.max, Math.max(t.min, n)) : t.default;
  }
  return out;
}

/** Clamp a stored lookback back into {@link IDLE_LOOKBACK_LIMITS}. */
export function clampIdleLookbackDays(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return IDLE_LOOKBACK_LIMITS.default;
  return Math.min(IDLE_LOOKBACK_LIMITS.max, Math.max(IDLE_LOOKBACK_LIMITS.min, Math.round(n)));
}

const MAX_TEXT = 500;
const MAX_KEY = 512;
const MAX_EVIDENCE = 8;

function clampText(value: unknown, max = MAX_TEXT): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The host's guard over what a plugin returned: drops findings for rules the
 * plugin did not declare or the request did not enable, findings about a
 * resource that was not in the request, malformed evidence and non-finite or
 * negative estimates, and keeps the first of any duplicate (rule, subject).
 * Text is clamped. Never throws: a plugin bug costs findings, not the pass.
 */
export function normalizeIdleFindings(
  records: readonly IdleFindingRecord[],
  request: Pick<IdleScanRequest, "rules" | "resources">,
): IdleFindingRecord[] {
  const resourceIds = new Map(request.resources.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const out: IdleFindingRecord[] = [];
  for (const raw of Array.isArray(records) ? records : []) {
    if (!raw || typeof raw !== "object") continue;
    const ruleId = clampText(raw.ruleId, 100);
    if (!ruleId || !request.rules[ruleId]) continue;
    const subjectKey = clampText(raw.subjectKey, MAX_KEY);
    if (!subjectKey) continue;
    const dedupe = `${ruleId}\u0000${subjectKey}`;
    if (seen.has(dedupe)) continue;

    let resourceId: string | null = null;
    let resourceTypeId: string | null = null;
    if (raw.resourceId != null) {
      const resource = resourceIds.get(String(raw.resourceId));
      if (!resource) continue;
      resourceId = resource.id;
      resourceTypeId = resource.resourceTypeId;
    }

    const evidence: IdleMetricEvidence[] = [];
    for (const e of Array.isArray(raw.evidence) ? raw.evidence : []) {
      if (!e || typeof e !== "object") continue;
      const metric = clampText(e.metric, 200);
      const label = clampText(e.label, 200) || metric;
      if (!metric) continue;
      evidence.push({
        metric,
        label,
        statistic: e.statistic,
        value: finiteOrNull(e.value),
        unit: e.unit,
        ...(e.threshold !== undefined ? { threshold: finiteOrNull(e.threshold) } : {}),
        ...(e.comparison ? { comparison: e.comparison } : {}),
      });
      if (evidence.length >= MAX_EVIDENCE) break;
    }

    let estimate: IdleSavingsEstimate | null = null;
    const est = raw.estimate;
    if (
      est &&
      typeof est.monthlyAmount === "number" &&
      Number.isFinite(est.monthlyAmount) &&
      est.monthlyAmount >= 0 &&
      typeof est.currency === "string" &&
      /^[A-Z]{3}$/.test(est.currency)
    ) {
      estimate = {
        monthlyAmount: Math.round(est.monthlyAmount * 100) / 100,
        currency: est.currency,
        basis: "list-price",
        ...(est.note ? { note: clampText(est.note) } : {}),
      };
    }

    const fields: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(raw.fields ?? {})) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") fields[k] = v;
    }

    seen.add(dedupe);
    out.push({
      ruleId,
      subjectKey,
      resourceId,
      resourceTypeId,
      displayName: clampText(raw.displayName, 300) || subjectKey,
      ...(resourceId === null && raw.subjectLabel
        ? { subjectLabel: clampText(raw.subjectLabel, 100) }
        : {}),
      reason: clampText(raw.reason) || "Idle over the lookback window",
      evidence,
      estimate,
      fields,
    });
  }
  return out;
}

/**
 * True when `value` sits on the idle side of `threshold`. A null value (no
 * data) is never idle by itself; see the module's first honesty rule.
 */
export function idleAtMost(value: number | null, threshold: number): boolean {
  return value !== null && value <= threshold;
}
