/**
 * The alert noise report — which alerts nobody acts on.
 *
 * Alert routing decides where an alert goes. Nothing has ever asked the
 * question that decides whether the whole system works: *are these being read?*
 * An organisation with one rule that fires 400 times a month and has never been
 * acknowledged does not have a monitoring system, it has a filter people have
 * learned to ignore — and the alert that mattered went into the same channel.
 *
 * This module is the pure half: the aggregation, and the rule that decides what
 * counts as noise. Both are pure and clock-free so the settings page and the
 * server produce the same verdict.
 *
 * **Everything here is a description, never an action.** The report says a rule
 * is noisy; it does not disable it, mute it, or change a threshold. That is
 * deliberate — a system that silences its own alerts based on a heuristic is
 * one nobody can trust, and the interesting cases (an alert fired 300 times and
 * ignored *because the team fixed the cause and forgot the rule*) are exactly
 * the ones a heuristic gets wrong.
 */

/** One delivery, reduced to the fields the report reasons about. */
export interface NoiseDelivery {
  trigger: string;
  severity: string;
  /** The rule that routed it; null when nothing matched and defaults applied. */
  ruleId: string | null;
  ruleName: string | null;
  state: string;
  createdAt: string;
  acknowledgedAt: string | null;
}

/**
 * Whether a delivery was ever *acted on*.
 *
 * Only an explicit acknowledgement counts. `sent` is not evidence anybody read
 * it — it means the message left the building — and treating it as engagement
 * would make the report say every organisation is doing fine, which is the one
 * answer that would make it worthless.
 */
export function wasActedOn(delivery: Pick<NoiseDelivery, "state" | "acknowledgedAt">): boolean {
  return delivery.state === "acknowledged" || delivery.acknowledgedAt !== null;
}

/**
 * Whether a delivery *asked* for a response.
 *
 * Only deliveries with an escalation armed can be acknowledged at all, so a
 * plain `sent` alert with no ack button must not be counted as ignored. This is
 * the distinction that keeps the report from indicting an org for not pressing
 * a button it was never shown.
 */
export function couldBeActedOn(delivery: Pick<NoiseDelivery, "state">): boolean {
  return (
    delivery.state === "awaiting_ack" ||
    delivery.state === "acknowledged" ||
    delivery.state === "escalated" ||
    delivery.state === "expired"
  );
}

export interface NoiseGroup {
  /** `rule:<id>` or `trigger:<name>` — stable, so the UI can key on it. */
  key: string;
  label: string;
  /** How the group was formed. */
  kind: "rule" | "trigger";
  count: number;
  /** Deliveries that asked for an acknowledgement. */
  actionable: number;
  acknowledged: number;
  /**
   * Share of *actionable* deliveries that were acknowledged, 0–1. Null when
   * none of them asked for a response — which is not the same as 0%, and
   * rendering it as 0% would be the report's own version of the lie it exists
   * to catch.
   */
  acknowledgedRate: number | null;
  /** Median minutes from delivery to acknowledgement. Null when never acked. */
  medianAckMinutes: number | null;
  /** Newest and oldest delivery in the window, so the UI can say "since". */
  firstAt: string;
  lastAt: string;
  severities: Record<string, number>;
}

export interface NoiseReport {
  /** Window the report covers, ISO 8601. */
  from: string;
  to: string;
  totalDeliveries: number;
  actionableDeliveries: number;
  acknowledgedDeliveries: number;
  /** Groups by rule, loudest first. */
  byRule: NoiseGroup[];
  /** Groups by trigger, loudest first. */
  byTrigger: NoiseGroup[];
  /** Groups the heuristic flags, worst first. Always a subset of `byRule`. */
  noisy: NoisyFinding[];
  generatedAt: string;
}

export type NoiseReason =
  /** Fired often and never acknowledged once. */
  | "never-acknowledged"
  /** Fired often, acknowledged rarely. */
  | "mostly-ignored"
  /** Fires more often than anybody could plausibly read. */
  | "very-frequent";

export interface NoisyFinding {
  key: string;
  label: string;
  reason: NoiseReason;
  count: number;
  acknowledgedRate: number | null;
  /** One sentence a person can act on. Never an action taken automatically. */
  suggestion: string;
}

export const NOISE_LIMITS = {
  /** Below this a group is not enough evidence to call anything noisy. */
  minCountToJudge: 10,
  /** Acknowledged less often than this counts as mostly ignored. */
  ignoredRateBelow: 0.2,
  /** More than this in the window is too many to read, whatever the ack rate. */
  floodCount: 100,
  defaultWindowDays: 30,
  minWindowDays: 1,
  maxWindowDays: 180,
  maxGroups: 25,
} as const;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
}

function buildGroup(
  key: string,
  label: string,
  kind: "rule" | "trigger",
  deliveries: readonly NoiseDelivery[],
): NoiseGroup {
  let actionable = 0;
  let acknowledged = 0;
  const ackMinutes: number[] = [];
  const severities: Record<string, number> = {};
  let firstAt = deliveries[0]?.createdAt ?? "";
  let lastAt = deliveries[0]?.createdAt ?? "";

  for (const delivery of deliveries) {
    severities[delivery.severity] = (severities[delivery.severity] ?? 0) + 1;
    if (delivery.createdAt < firstAt) firstAt = delivery.createdAt;
    if (delivery.createdAt > lastAt) lastAt = delivery.createdAt;
    if (couldBeActedOn(delivery)) actionable += 1;
    if (wasActedOn(delivery)) {
      acknowledged += 1;
      const sent = Date.parse(delivery.createdAt);
      const acked = delivery.acknowledgedAt ? Date.parse(delivery.acknowledgedAt) : Number.NaN;
      if (!Number.isNaN(sent) && !Number.isNaN(acked) && acked >= sent) {
        ackMinutes.push((acked - sent) / 60_000);
      }
    }
  }

  return {
    key,
    label,
    kind,
    count: deliveries.length,
    actionable,
    acknowledged,
    // Null rather than 0 when nothing asked for a response: see the field note.
    acknowledgedRate: actionable === 0 ? null : acknowledged / actionable,
    medianAckMinutes: median(ackMinutes),
    firstAt,
    lastAt,
    severities,
  };
}

/**
 * Group deliveries by rule and by trigger, loudest first.
 *
 * Deliveries with no rule are grouped under one "no rule matched" entry rather
 * than dropped: an organisation whose alerts are all falling through to the
 * defaults is exactly the one this report should be shouting at.
 */
export function groupNoise(deliveries: readonly NoiseDelivery[]): {
  byRule: NoiseGroup[];
  byTrigger: NoiseGroup[];
} {
  const byRuleKey = new Map<string, NoiseDelivery[]>();
  const byTriggerKey = new Map<string, NoiseDelivery[]>();

  for (const delivery of deliveries) {
    const ruleKey = delivery.ruleId ? `rule:${delivery.ruleId}` : "rule:none";
    byRuleKey.set(ruleKey, [...(byRuleKey.get(ruleKey) ?? []), delivery]);
    const triggerKey = `trigger:${delivery.trigger}`;
    byTriggerKey.set(triggerKey, [...(byTriggerKey.get(triggerKey) ?? []), delivery]);
  }

  const rules = [...byRuleKey.entries()].map(([key, list]) =>
    buildGroup(
      key,
      key === "rule:none" ? "No rule matched" : (list[0]?.ruleName ?? "Deleted rule"),
      "rule",
      list,
    ),
  );
  const triggers = [...byTriggerKey.entries()].map(([key, list]) =>
    buildGroup(key, list[0]?.trigger ?? key, "trigger", list),
  );

  const loudestFirst = (a: NoiseGroup, b: NoiseGroup) =>
    b.count - a.count || a.key.localeCompare(b.key);
  return {
    byRule: rules.sort(loudestFirst).slice(0, NOISE_LIMITS.maxGroups),
    byTrigger: triggers.sort(loudestFirst).slice(0, NOISE_LIMITS.maxGroups),
  };
}

/**
 * Which groups are noise.
 *
 * Three reasons, checked in order of how confident they are. The order matters:
 * "never acknowledged once in 200 deliveries" is a far stronger statement than
 * "acknowledged 15% of the time", and reporting the weaker one for a group that
 * qualifies for the stronger would understate it.
 *
 * A group below `minCountToJudge` is never flagged. Three unacknowledged alerts
 * is not evidence of anything, and a report that cried noise at every new rule
 * would be the second thing people learn to ignore.
 */
export function findNoisy(groups: readonly NoiseGroup[]): NoisyFinding[] {
  const findings: NoisyFinding[] = [];
  for (const group of groups) {
    if (group.count < NOISE_LIMITS.minCountToJudge) continue;

    if (group.actionable >= NOISE_LIMITS.minCountToJudge && group.acknowledged === 0) {
      findings.push({
        key: group.key,
        label: group.label,
        reason: "never-acknowledged",
        count: group.count,
        acknowledgedRate: group.acknowledgedRate,
        suggestion:
          "Nobody has acknowledged this once. Either it is not worth paging for, or it is going somewhere nobody reads.",
      });
      continue;
    }

    if (group.count >= NOISE_LIMITS.floodCount) {
      findings.push({
        key: group.key,
        label: group.label,
        reason: "very-frequent",
        count: group.count,
        acknowledgedRate: group.acknowledgedRate,
        suggestion:
          "This fires more often than anybody can read. Consider a tighter condition, or routing it to a channel rather than a phone.",
      });
      continue;
    }

    if (
      group.acknowledgedRate !== null &&
      group.actionable >= NOISE_LIMITS.minCountToJudge &&
      group.acknowledgedRate < NOISE_LIMITS.ignoredRateBelow
    ) {
      findings.push({
        key: group.key,
        label: group.label,
        reason: "mostly-ignored",
        count: group.count,
        acknowledgedRate: group.acknowledgedRate,
        suggestion:
          "Most of these are never acknowledged. Worth asking whether the ones that are matter more than the ones that are not.",
      });
    }
  }
  // Loudest first among findings, so the worst offender is at the top.
  return findings.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** Assemble the whole report from a window of deliveries. */
export function buildNoiseReport(
  deliveries: readonly NoiseDelivery[],
  window: { from: string; to: string; generatedAt: string },
): NoiseReport {
  const { byRule, byTrigger } = groupNoise(deliveries);
  return {
    from: window.from,
    to: window.to,
    totalDeliveries: deliveries.length,
    actionableDeliveries: deliveries.filter(couldBeActedOn).length,
    acknowledgedDeliveries: deliveries.filter(wasActedOn).length,
    byRule,
    byTrigger,
    noisy: findNoisy(byRule),
    generatedAt: window.generatedAt,
  };
}

/** "62%" / "—". A rate nobody could compute is a dash, never a zero. */
export function formatAckRate(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}
