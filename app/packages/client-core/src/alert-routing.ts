/**
 * Alert routing: the trigger registry, the rule contract, and the pure matcher.
 *
 * This module exists to kill a specific shape. Alert delivery used to be a
 * boolean-per-trigger-per-channel matrix — a column on `push_preferences`, one
 * on `slack_channels`, one on `msteams_webhooks`, and a `TRIGGER_COLUMN` map in
 * each of the three transports — so adding a trigger meant six coordinated
 * edits and a migration, and the only question a channel could answer was
 * "everything of this kind, yes or no". Routing rules make the trigger a
 * *value* rather than a *column*: adding one is an entry in
 * {@link ALERT_TRIGGERS} below and nothing else.
 *
 * It lives in `client-core` rather than `server-core` for the reason every
 * other shared contract here does — the settings UI, the mobile app and the CLI
 * all need the labels, and the settings editor needs the matcher itself to show
 * "this rule would have caught 3 of your last 20 alerts" without a round trip.
 * `@infrawrench/ui` re-exports it; `server-core/src/alerts/` imports it and adds
 * the database and the transports.
 *
 * Everything here is pure. No imports, no clock of its own (callers pass
 * `now`), no randomness — the same inputs always route the same way, which is
 * what makes the rules testable and the preview honest.
 */

// --- Triggers ---

/**
 * How loud an alert is, independent of which trigger raised it. Used for the
 * `severity` condition and for the quiet-hours override: a rule can sleep
 * through `info` and `warning` and still wake someone for `critical`.
 *
 * Ordered — see {@link SEVERITY_RANK}. Three levels rather than five because
 * the callers can actually distinguish three: "something changed", "something
 * is wrong", "someone must act now".
 */
export type AlertSeverity = "info" | "warning" | "critical";

export const SEVERITY_RANK: Record<AlertSeverity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

export const SEVERITY_LABELS: Record<AlertSeverity, string> = {
  info: "Info",
  warning: "Warning",
  critical: "Critical",
};

/** The severities, weakest first. The one list every other surface derives from. */
export const ALERT_SEVERITIES = Object.keys(SEVERITY_RANK) as AlertSeverity[];

/**
 * Narrow unknown JSON to a severity.
 *
 * Worth a guard rather than a cast because an unrecognised value does not fail
 * loudly anywhere downstream — `SEVERITY_RANK[bad]` is `undefined`, and every
 * `>=` comparison against `undefined` is false, so a typo'd `urgentOverride`
 * quietly holds *every* alert including the ones it was written to let through.
 */
export function isAlertSeverity(value: unknown): value is AlertSeverity {
  return typeof value === "string" && value in SEVERITY_RANK;
}

/**
 * One kind of thing that can raise an alert.
 *
 * **This list is the whole registry.** Adding a trigger is this entry plus the
 * `routeAlert` call at the place that raises it — no schema change, no column
 * map, no per-transport edit. That is the point of the rules table.
 *
 * - `pushDefaultMuted` is the shipped per-user default for a member who has
 *   never opened the notifications screen. Only `resourceDrift` is muted: drift
 *   is continuous where every other trigger is exceptional, so defaulting it on
 *   would buzz every phone in a healthy busy org. (This was a `false` column
 *   default before; it is a constant now, which is the same decision in one
 *   fewer place.)
 * - `channelOnly` marks a trigger that never goes to a phone. The weekly digest
 *   is a scheduled summary to read, not an alert to interrupt someone with, so
 *   a `push` destination ignores it.
 * - `defaultSeverity` is what a caller gets if it raises the trigger without
 *   saying; callers that know better (a budget at 100% vs 80%) pass their own.
 */
export interface AlertTriggerDef {
  id: string;
  label: string;
  /** One line for the rule editor's trigger picker. */
  description: string;
  pushDefaultMuted: boolean;
  channelOnly: boolean;
  defaultSeverity: AlertSeverity;
}

export const ALERT_TRIGGERS = [
  {
    id: "syncIncidents",
    label: "Sync failures",
    description: "An account stopped syncing and the incident is still open.",
    pushDefaultMuted: false,
    channelOnly: false,
    defaultSeverity: "critical",
  },
  {
    id: "budgetAlerts",
    label: "Budgets",
    description: "Spend crossed a budget threshold.",
    pushDefaultMuted: false,
    channelOnly: false,
    defaultSeverity: "warning",
  },
  {
    id: "anomalyAlerts",
    label: "Anomalies",
    description: "Statistical spend spike or a brand-new spend source.",
    pushDefaultMuted: false,
    channelOnly: false,
    defaultSeverity: "warning",
  },
  {
    // The third cost family: budgets are an absolute monthly total you chose,
    // anomalies are unconfigured statistical outliers, and this is a
    // *configured relative change* — "this scope moved more than X% (or $Y)
    // versus the prior period" on a cadence the user picked.
    id: "costChangeAlerts",
    label: "Cost changes",
    description: "Spend on a watched scope moved past its change threshold vs the prior period.",
    pushDefaultMuted: false,
    channelOnly: false,
    defaultSeverity: "warning",
  },
  {
    id: "metricAlerts",
    label: "Metric alerts",
    description: "A metric threshold rule fired or recovered.",
    pushDefaultMuted: false,
    channelOnly: false,
    defaultSeverity: "warning",
  },
  {
    id: "resourceDrift",
    label: "Drift",
    description: "Resources appeared, changed or disappeared between polls.",
    pushDefaultMuted: true,
    channelOnly: false,
    defaultSeverity: "info",
  },
  {
    id: "workflowPages",
    label: "Pages",
    description: "A workflow called infra.page(), or an approval needs a decision.",
    pushDefaultMuted: false,
    channelOnly: false,
    defaultSeverity: "critical",
  },
  {
    id: "providerIncidents",
    label: "Provider incidents",
    description: "A provider status page reports an incident touching your resources.",
    pushDefaultMuted: false,
    channelOnly: false,
    defaultSeverity: "warning",
  },
  {
    id: "expiryAlerts",
    label: "Expiry",
    description: "A certificate, domain, token or lease is running out.",
    pushDefaultMuted: false,
    channelOnly: false,
    defaultSeverity: "warning",
  },
  {
    id: "logMatchAlerts",
    label: "Log matches",
    description: "A saved log query matched.",
    pushDefaultMuted: false,
    channelOnly: false,
    defaultSeverity: "warning",
  },
  {
    id: "postureAlerts",
    label: "Posture",
    description: "A critical or high security posture finding.",
    pushDefaultMuted: false,
    channelOnly: false,
    defaultSeverity: "warning",
  },
  {
    id: "probeAlerts",
    label: "Probes",
    description: "A synthetic probe went down or recovered.",
    pushDefaultMuted: false,
    channelOnly: false,
    defaultSeverity: "critical",
  },
  {
    id: "weeklyDigest",
    label: "Weekly digest",
    description: "The Monday-morning summary. Channels only — never a phone.",
    pushDefaultMuted: false,
    channelOnly: true,
    defaultSeverity: "info",
  },
] as const satisfies readonly AlertTriggerDef[];

export type AlertTrigger = (typeof ALERT_TRIGGERS)[number]["id"];

const TRIGGER_BY_ID = new Map<string, AlertTriggerDef>(ALERT_TRIGGERS.map((t) => [t.id, t]));

export function alertTriggerDef(trigger: AlertTrigger): AlertTriggerDef {
  const def = TRIGGER_BY_ID.get(trigger);
  // Unreachable through the type, but rules come out of the database as text
  // and a row written by an older version can name a trigger this build
  // dropped. Failing soft keeps one stale rule from breaking every alert.
  if (!def) {
    return {
      id: trigger,
      label: trigger,
      description: "",
      pushDefaultMuted: false,
      channelOnly: false,
      defaultSeverity: "warning",
    };
  }
  return def;
}

export function isAlertTrigger(value: string): value is AlertTrigger {
  return TRIGGER_BY_ID.has(value);
}

/**
 * Triggers a member who has never touched the notifications screen has muted.
 * The `no row means defaults` half of `push_preferences`, expressed once here
 * instead of as a per-column `.default(false)`.
 */
export const DEFAULT_MUTED_TRIGGERS: AlertTrigger[] = ALERT_TRIGGERS.filter(
  (t) => t.pushDefaultMuted,
).map((t) => t.id);

/** Triggers a phone can receive at all — everything but the weekly digest. */
export const PUSHABLE_TRIGGERS: AlertTrigger[] = ALERT_TRIGGERS.filter((t) => !t.channelOnly).map(
  (t) => t.id,
);

// --- Facts an alert carries, and the conditions that match them ---

/**
 * The matchable half of an alert. Everything optional: a trigger that has no
 * account (a provider incident spans the org) simply omits it, and a condition
 * on a fact the alert does not carry never matches.
 *
 * That last rule is deliberate and it is the one worth remembering. `accountId
 * in [prod]` does **not** match an alert with no account — because "an alert
 * about no particular account" is not "an alert about prod", and silently
 * treating it as one would route org-wide pages into a per-account channel.
 * Rules that want the org-wide ones say so by leaving the account condition off.
 */
export interface AlertFacts {
  /** The account the alert is about, when it is about one. */
  accountId?: string;
  /** Plugin id, e.g. `aws`. Present whenever the alert names a provider. */
  pluginId?: string;
  /** Resource type id, for alerts scoped to one kind of thing. */
  resourceTypeId?: string;
  /** The specific resource, when there is one. */
  resourceId?: string;
  /**
   * Money at stake, in **cents of `currency`**, always non-negative. Cents
   * because every other money column in the product is cents; a rule editor
   * that says "$500" stores 50000.
   */
  amountCents?: number;
  currency?: string;
  /**
   * The alert's natural grouping key — an anomaly's service name, a probe's
   * name, a metric rule's name. What a `key` condition matches against.
   */
  key?: string;
}

export type AlertConditionField =
  | "trigger"
  | "severity"
  | "accountId"
  | "pluginId"
  | "resourceTypeId"
  | "amountCents"
  | "key"
  | "text";

/**
 * One clause of a rule. A rule matches when **every** condition matches (AND);
 * "or" is expressed by writing a second rule, which reads better in a list than
 * a nested boolean editor and keeps evaluation order explicit.
 */
export type AlertCondition =
  | { field: "trigger"; op: "in" | "notIn"; values: string[] }
  | { field: "severity"; op: "gte" | "eq"; severity: AlertSeverity }
  | { field: "accountId"; op: "in" | "notIn"; values: string[] }
  | { field: "pluginId"; op: "in" | "notIn"; values: string[] }
  | { field: "resourceTypeId"; op: "in" | "notIn"; values: string[] }
  | { field: "amountCents"; op: "gte" | "lt"; cents: number }
  /** Substring match, case-insensitive, against `facts.key`. */
  | { field: "key"; op: "contains" | "notContains" | "eq"; value: string }
  /** Substring match, case-insensitive, against the title and body together. */
  | { field: "text"; op: "contains" | "notContains"; value: string };

// --- Destinations ---

/**
 * Where a matched alert goes. One destination is one place, so a rule's
 * destination list reads as a list of places rather than a set of flags.
 *
 * `push` is the org's phones, still filtered by each member's own mutes — an
 * org rule decides *whether the org is told*, a member decides *whether their
 * phone rings*. Collapsing those two into the routing table would mean an admin
 * could un-mute someone else's 3am notifications, which is not a knob anyone
 * should hold.
 */
export type AlertDestination =
  { kind: "push" } | { kind: "slack"; channelId: string } | { kind: "msteams"; webhookId: string };

export function destinationKey(d: AlertDestination): string {
  switch (d.kind) {
    case "push":
      return "push";
    case "slack":
      return `slack:${d.channelId}`;
    case "msteams":
      return `msteams:${d.webhookId}`;
  }
}

// --- Quiet hours ---

/**
 * A recurring local-time window during which a rule holds its alerts instead of
 * sending them.
 *
 * **Hold, not drop.** A suppressed 3am alert is gone; a held one arrives at
 * 08:00 with its original timestamp. The queue costs one table and one poller
 * pass, which is the same table and pass escalation already needs, so the
 * expensive-looking option is the cheap one.
 *
 * Windows are half-open `[start, end)` in local minutes-of-day and may wrap
 * past midnight (22:00 → 08:00 is `startMinute: 1320, endMinute: 480`). A
 * window with `start === end` is empty, not all-day — "quiet from 9 to 9" is
 * far more likely to be a mis-set form than a request for total silence, and
 * total silence is what disabling the rule is for.
 */
export interface QuietHours {
  /** IANA zone the window is expressed in, e.g. `Europe/Berlin`. */
  timezone: string;
  /** Local minutes past midnight the window opens, 0–1439. */
  startMinute: number;
  /** Local minutes past midnight the window closes, 0–1439. May be < start. */
  endMinute: number;
  /**
   * ISO weekdays (1 = Monday … 7 = Sunday) the window applies on, matched
   * against the day the window *opened*, so a Friday-night window that runs to
   * Saturday morning is one window and not two. Empty means every day.
   */
  days: number[];
  /**
   * Severity at or above which quiet hours do not apply. `null` holds
   * everything the rule matches. Most orgs want `critical` here: sleep through
   * budget warnings, wake for a page.
   */
  urgentOverride: AlertSeverity | null;
}

// --- Escalation ---

/**
 * "If nobody acknowledges this within N minutes, tell these people too."
 *
 * Escalation never replaces the original delivery — it adds a second one. The
 * acknowledge action is a button on the Slack message; anything else the org
 * gets told through (Teams, push) still fires, it just cannot ack.
 */
export interface EscalationPolicy {
  /** Minutes to wait for an acknowledgement before escalating. */
  afterMinutes: number;
  /** Where the escalation goes. Usually a different channel than the original. */
  destinations: AlertDestination[];
}

// --- Rules ---

export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  /** Evaluation order, ascending. Ties break on `id` so the order is total. */
  position: number;
  conditions: AlertCondition[];
  destinations: AlertDestination[];
  /**
   * Whether evaluation continues past this rule.
   *
   * `false` (the default, and what the editor calls "Stop here") makes the list
   * first-match-wins, which is what "anomalies over $500 → #incidents, else →
   * #infra-noise" needs: the general rule sits below the specific one and only
   * sees what the specific one didn't take. `true` makes the rule a tee — an
   * audit channel that copies everything without shadowing the rules under it.
   */
  continueOnMatch: boolean;
  quietHours: QuietHours | null;
  escalation: EscalationPolicy | null;
}

/** Bounds the API enforces, exported so the editor can enforce the same ones. */
export const ALERT_RULE_LIMITS = {
  maxRulesPerOrg: 100,
  maxNameLength: 80,
  maxConditionsPerRule: 12,
  maxDestinationsPerRule: 20,
  maxValuesPerCondition: 50,
  maxTextLength: 200,
  /**
   * Floored at 1 minute: below that the escalation lands before anyone has read
   * the original, which makes it noise rather than a safety net.
   */
  minEscalationMinutes: 1,
  /** A week. Past that the alert is history, not something to escalate. */
  maxEscalationMinutes: 10_080,
} as const;

// --- Matching ---

function lower(s: string | undefined): string {
  return (s ?? "").toLowerCase();
}

function inList(value: string | undefined, values: string[]): boolean {
  // A fact the alert does not carry never matches a membership test — see the
  // note on AlertFacts. `notIn` inverts the same rule, so an alert with no
  // account is *excluded* by `accountId notIn [x]` too. Both directions of a
  // condition on an absent fact fail, which keeps "this rule is about accounts"
  // true regardless of which way the operator points.
  return value !== undefined && values.includes(value);
}

/** Whether one condition holds for an alert. Pure; never throws. */
export function conditionMatches(
  condition: AlertCondition,
  input: {
    trigger: string;
    severity: AlertSeverity;
    title: string;
    body: string;
    facts: AlertFacts;
  },
): boolean {
  switch (condition.field) {
    case "trigger":
      return condition.op === "in"
        ? condition.values.includes(input.trigger)
        : !condition.values.includes(input.trigger);
    case "severity":
      return condition.op === "gte"
        ? SEVERITY_RANK[input.severity] >= SEVERITY_RANK[condition.severity]
        : input.severity === condition.severity;
    case "accountId":
      return condition.op === "in"
        ? inList(input.facts.accountId, condition.values)
        : input.facts.accountId !== undefined && !condition.values.includes(input.facts.accountId);
    case "pluginId":
      return condition.op === "in"
        ? inList(input.facts.pluginId, condition.values)
        : input.facts.pluginId !== undefined && !condition.values.includes(input.facts.pluginId);
    case "resourceTypeId":
      return condition.op === "in"
        ? inList(input.facts.resourceTypeId, condition.values)
        : input.facts.resourceTypeId !== undefined &&
            !condition.values.includes(input.facts.resourceTypeId);
    case "amountCents": {
      const amount = input.facts.amountCents;
      // No amount is not "an amount of zero": a drift digest is not a $0 spend
      // anomaly, and letting it satisfy `< $500` would route it by a rule that
      // is plainly about money.
      if (amount === undefined) return false;
      return condition.op === "gte" ? amount >= condition.cents : amount < condition.cents;
    }
    case "key": {
      const key = lower(input.facts.key);
      if (input.facts.key === undefined) return false;
      const needle = condition.value.toLowerCase();
      if (condition.op === "eq") return key === needle;
      const hit = key.includes(needle);
      return condition.op === "contains" ? hit : !hit;
    }
    case "text": {
      // Title and body join with a newline so a needle cannot match across the
      // seam between them and appear to be text nobody wrote.
      const hay = `${lower(input.title)}\n${lower(input.body)}`;
      const hit = hay.includes(condition.value.toLowerCase());
      return condition.op === "contains" ? hit : !hit;
    }
  }
}

export interface AlertMatchInput {
  trigger: string;
  severity: AlertSeverity;
  title: string;
  body: string;
  facts: AlertFacts;
}

/** Whether every one of a rule's conditions holds. An empty list matches all. */
export function ruleMatches(rule: AlertRule, input: AlertMatchInput): boolean {
  if (!rule.enabled) return false;
  return rule.conditions.every((c) => conditionMatches(c, input));
}

/**
 * One rule's share of a routed alert, after quiet hours have had their say.
 * Kept per-rule rather than flattened because escalation and the hold deadline
 * are the rule's, not the alert's: two rules can match the same alert and want
 * different windows.
 */
export interface RoutedLeg {
  ruleId: string;
  ruleName: string;
  destinations: AlertDestination[];
  escalation: EscalationPolicy | null;
  /**
   * When quiet hours hold this leg: the instant the window closes and it should
   * be delivered. `null` means send now.
   */
  holdUntil: Date | null;
}

export interface RoutingDecision {
  legs: RoutedLeg[];
  /** Rule ids that matched, in evaluation order — for the "why" in the log. */
  matchedRuleIds: string[];
  /** True when the list was exhausted without a single match. */
  unrouted: boolean;
}

/**
 * Walk an org's rules in order and decide where one alert goes.
 *
 * Order matters and is the feature: the first matching rule wins unless it says
 * `continueOnMatch`. That is what lets a narrow rule sit above a broad one
 * ("anomalies over $500 on prod → #incidents" above "anomalies → #infra-noise")
 * without either of them naming the other.
 *
 * Pure: `now` and `sortedRules` come in, a decision comes out, nothing is sent.
 * The caller (`server-core/src/alerts/route.ts`) does the sending.
 */
export function routeAlertRules(
  rules: AlertRule[],
  input: AlertMatchInput,
  now: Date,
): RoutingDecision {
  const ordered = [...rules].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const legs: RoutedLeg[] = [];
  const matchedRuleIds: string[] = [];

  for (const rule of ordered) {
    if (!ruleMatches(rule, input)) continue;
    matchedRuleIds.push(rule.id);

    const held = rule.quietHours ? quietHoldUntil(rule.quietHours, input.severity, now) : null;

    if (rule.destinations.length > 0) {
      legs.push({
        ruleId: rule.id,
        ruleName: rule.name,
        destinations: rule.destinations,
        escalation: rule.escalation,
        holdUntil: held,
      });
    }

    // A matched rule stops the walk even when it has no destinations — an
    // enabled, destination-less rule is how you say "swallow these", and it has
    // to shadow the broader rules below it or it would do nothing at all.
    if (!rule.continueOnMatch) break;
  }

  return { legs, matchedRuleIds, unrouted: matchedRuleIds.length === 0 };
}

// --- Quiet-hours arithmetic ---

/**
 * The local wall clock in `timezone` at `instant`, as ISO weekday (1–7) and
 * minutes past midnight.
 *
 * `Intl.DateTimeFormat` with an explicit `timeZone` is the only zone maths in
 * the product that does not need a dependency, and it handles DST because it
 * asks the platform's tz database rather than doing offset arithmetic. An
 * invalid zone throws — callers treat that as "no quiet hours" rather than
 * dropping the alert, because a typo'd timezone must not silence a pager.
 */
export function localClock(timezone: string, instant: Date): { weekday: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(instant);

  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const weekdayNames: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };
  const weekday = weekdayNames[get("weekday")] ?? 1;
  // `hour12: false` still renders midnight as "24" in some ICU versions, so
  // fold it back rather than producing a 1440-minute day.
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  return { weekday, minute: hour * 60 + minute };
}

/** Whether a window covers a given local weekday+minute. */
function windowCovers(quiet: QuietHours, weekday: number, minute: number): boolean {
  const { startMinute, endMinute, days } = quiet;
  if (startMinute === endMinute) return false;

  const wraps = endMinute < startMinute;
  const inSpan = wraps
    ? minute >= startMinute || minute < endMinute
    : minute >= startMinute && minute < endMinute;
  if (!inSpan) return false;
  if (days.length === 0) return true;

  // `days` names the day the window *opened*. Past midnight in a wrapping
  // window that is yesterday, so a Fri 22:00–08:00 window still covers 02:00 on
  // Saturday without Saturday being listed.
  const openedOn = wraps && minute < endMinute ? ((weekday + 5) % 7) + 1 : weekday;
  return days.includes(openedOn);
}

/** Whether `instant` falls inside the window, ignoring the severity override. */
export function isWithinQuietHours(quiet: QuietHours, instant: Date): boolean {
  let clock: { weekday: number; minute: number };
  try {
    clock = localClock(quiet.timezone, instant);
  } catch {
    return false;
  }
  return windowCovers(quiet, clock.weekday, clock.minute);
}

/**
 * Narrow unknown JSON to a quiet-hours window.
 *
 * The stored column outlives the build that wrote it — a rule saved by a newer
 * version, or hand-edited in psql — and the arithmetic below assumes numbers
 * and an array. A malformed object would make `windowCovers` throw on
 * `days.includes` or leave `delta` as `NaN` and produce an Invalid Date, both
 * inside the fan-out of an unrelated alert. Reading it back through this guard
 * degrades that to "this rule has no quiet hours", which is the safe direction:
 * the alert goes out.
 */
export function isQuietHours(value: unknown): value is QuietHours {
  if (!value || typeof value !== "object") return false;
  const q = value as Partial<QuietHours>;
  const minute = (n: unknown): boolean =>
    Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 1439;
  if (!minute(q.startMinute) || !minute(q.endMinute)) return false;
  if (typeof q.timezone !== "string" || !q.timezone) return false;
  if (!Array.isArray(q.days)) return false;
  if (q.days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) return false;
  return q.urgentOverride == null || isAlertSeverity(q.urgentOverride);
}

/**
 * When the window covering `instant` closes, or `null` when `instant` is not
 * inside one.
 *
 * Minute-of-day arithmetic, not a forward scan: the distance to the window's
 * end is `endMinute - nowMinute` carried past midnight when that goes negative,
 * which covers both the ordinary window and the wrapping one.
 *
 * Two details that matter downstream. The result is floored to the whole
 * minute, so every alert held inside one window converges on the same release
 * instant and the flush pass sends them as one batch instead of a trickle. And
 * the DST correction below re-reads the local clock at the candidate instant:
 * adding N minutes of *real* time across a spring-forward would otherwise land
 * an hour off the local time the user typed into the form.
 */
export function quietHoursEnd(quiet: QuietHours, instant: Date): Date | null {
  let clock: { weekday: number; minute: number };
  try {
    clock = localClock(quiet.timezone, instant);
  } catch {
    return null;
  }
  if (!windowCovers(quiet, clock.weekday, clock.minute)) return null;

  // Minutes from now until the window's end, in local wall-clock terms. Inside
  // a non-wrapping window `endMinute > minute` so this is already positive;
  // inside the evening half of a wrapping one it is negative and carries.
  let delta = quiet.endMinute - clock.minute;
  if (delta <= 0) delta += 1440;

  const floored = Math.floor(instant.getTime() / 60_000) * 60_000;
  let end = new Date(floored + delta * 60_000);

  // One correction pass. If the local clock at `end` is not the boundary we
  // aimed at, the interval crossed a UTC-offset change; shifting by the
  // difference lands on the intended local minute. A single pass is enough
  // because offset changes are at most an hour and never adjacent.
  try {
    const drift = localClock(quiet.timezone, end).minute - quiet.endMinute;
    if (drift !== 0) {
      const wrapped = drift > 720 ? drift - 1440 : drift < -720 ? drift + 1440 : drift;
      end = new Date(end.getTime() - wrapped * 60_000);
    }
  } catch {
    // Zone became unreadable between the two calls, which cannot really happen;
    // the uncorrected instant is still inside the right hour.
  }
  return end;
}

/**
 * The instant a leg held by `quiet` should be released, or `null` when it
 * should go out now — either because the window is closed or because the alert
 * is urgent enough to ignore it.
 */
export function quietHoldUntil(quiet: QuietHours, severity: AlertSeverity, now: Date): Date | null {
  if (quiet.urgentOverride && SEVERITY_RANK[severity] >= SEVERITY_RANK[quiet.urgentOverride]) {
    return null;
  }
  return quietHoursEnd(quiet, now);
}

// --- Defaults ---

/**
 * The rule an org that has never written one behaves as if it had: everything,
 * everywhere, which is exactly what the boolean matrix did when every box was
 * ticked. Synthesized in memory rather than inserted, the same way
 * `org_digest_settings` and `org_cost_anomaly_settings` treat a missing row as
 * the shipped defaults — so connecting a Slack channel keeps working on day one
 * without anyone opening the rules editor.
 *
 * Drift is the exception, as it always was: it is excluded here and reachable
 * only by writing a rule for it, which is the same decision the `false` column
 * default used to encode.
 */
export function defaultAlertRule(destinations: AlertDestination[]): AlertRule {
  return {
    id: "default",
    name: "All alerts",
    enabled: true,
    position: 0,
    conditions: [
      {
        field: "trigger",
        op: "notIn",
        values: ["resourceDrift"],
      },
    ],
    destinations,
    continueOnMatch: false,
    quietHours: null,
    escalation: null,
  };
}

// --- Validation (shared by the API and the editor) ---

export function validateAlertRule(rule: {
  name: string;
  conditions: AlertCondition[];
  destinations: AlertDestination[];
  quietHours: QuietHours | null;
  escalation: EscalationPolicy | null;
}): string | null {
  const L = ALERT_RULE_LIMITS;
  if (!rule.name.trim()) return "Rule name is required";
  if (rule.name.length > L.maxNameLength) {
    return `Rule name must be ${L.maxNameLength} characters or fewer`;
  }
  if (rule.conditions.length > L.maxConditionsPerRule) {
    return `A rule can have at most ${L.maxConditionsPerRule} conditions`;
  }
  if (rule.destinations.length > L.maxDestinationsPerRule) {
    return `A rule can have at most ${L.maxDestinationsPerRule} destinations`;
  }
  for (const c of rule.conditions) {
    if ("values" in c) {
      if (c.values.length === 0) return "A condition must list at least one value";
      if (c.values.length > L.maxValuesPerCondition) {
        return `A condition can list at most ${L.maxValuesPerCondition} values`;
      }
    }
    if ("value" in c) {
      if (!c.value.trim()) return "A text condition needs something to match";
      if (c.value.length > L.maxTextLength) {
        return `A text condition must be ${L.maxTextLength} characters or fewer`;
      }
    }
    if (c.field === "amountCents" && (!Number.isFinite(c.cents) || c.cents < 0)) {
      return "An amount condition needs a non-negative number";
    }
  }
  if (rule.quietHours) {
    const q = rule.quietHours;
    if (typeof q !== "object") return "Quiet hours must be an object";
    const bad = (n: number): boolean => !Number.isInteger(n) || n < 0 || n > 1439;
    if (bad(q.startMinute) || bad(q.endMinute)) return "Quiet hours must be times of day";
    if (!Array.isArray(q.days) || q.days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
      return "Quiet-hours days must be ISO weekdays (1–7)";
    }
    if (typeof q.timezone !== "string") return "Quiet hours need a timezone";
    // Null means "hold everything", which is the documented default. Anything
    // else must be a real severity: an unrecognised value ranks below every
    // real one, so it would hold every alert including the pages the override
    // exists to let through — the exact opposite of what was asked for, and
    // silently.
    if (q.urgentOverride != null && !isAlertSeverity(q.urgentOverride)) {
      return `Quiet-hours override must be one of ${ALERT_SEVERITIES.join(", ")}`;
    }
    try {
      localClock(q.timezone, new Date(0));
    } catch {
      return `Unknown timezone "${q.timezone}"`;
    }
  }
  if (rule.escalation) {
    const e = rule.escalation;
    if (!Number.isInteger(e.afterMinutes) || e.afterMinutes < L.minEscalationMinutes) {
      return `Escalation must wait at least ${L.minEscalationMinutes} minute`;
    }
    if (e.afterMinutes > L.maxEscalationMinutes) {
      return `Escalation must wait at most ${L.maxEscalationMinutes} minutes`;
    }
    if (e.destinations.length === 0) return "Escalation needs at least one destination";
    if (e.destinations.length > L.maxDestinationsPerRule) {
      return `Escalation can have at most ${L.maxDestinationsPerRule} destinations`;
    }
  }
  return null;
}

// --- Wire types for the rules API ---

/** `GET /api/org/:orgId/alert-rules` — rules plus what the editor needs to name destinations. */
export interface AlertRulesResponse {
  rules: AlertRule[];
  /** True when `rules` is the synthesized default rather than stored rows. */
  usingDefaults: boolean;
  slackChannels: Array<{ id: string; name: string; isPrivate: boolean }>;
  msTeamsWebhooks: Array<{ id: string; label: string }>;
  accounts: Array<{ id: string; displayName: string; pluginId: string }>;
}

export type AlertRuleInput = Omit<AlertRule, "id"> & { id?: string };

/**
 * Where one delivery leg has got to.
 *
 * `sent` and `acknowledged` are both terminal successes and are kept apart on
 * purpose: `sent` is "it went out and nothing more was asked of it", while
 * `acknowledged` means a human pressed the button. Collapsing them would lose
 * the only evidence that escalation was unnecessary rather than merely unarmed.
 */
export type AlertDeliveryState =
  "held" | "awaiting_ack" | "sent" | "acknowledged" | "escalated" | "expired";

/** `GET /api/org/:orgId/alert-deliveries` — the held/awaiting-ack queue. */
export interface AlertDeliveryRecord {
  id: string;
  trigger: AlertTrigger;
  severity: AlertSeverity;
  title: string;
  body: string;
  ruleName: string | null;
  state: AlertDeliveryState;
  createdAt: string;
  deliverAfter: string | null;
  escalateAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedByUserId: string | null;
}
