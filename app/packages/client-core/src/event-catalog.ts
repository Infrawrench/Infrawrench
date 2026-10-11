/**
 * Event subscriptions: the typed catalog of Infrawrench's own events, the
 * envelope every destination receives, the subscription wire contract, and
 * the pure filter matcher.
 *
 * Alert routing (`alert-routing.ts`) answers "which people hear about this";
 * this module answers "which machines get a copy". They are deliberately two
 * registries: a routing trigger is a *message* (rendered title and body, quiet
 * hours, escalation), an event is *data* with a versioned schema a consumer
 * can parse. A raise site calls both.
 *
 * **Registering an event type is one call**: {@link defineEventType}. The
 * field spec it takes is the single source for the TypeScript payload type
 * (via {@link EventData}), the OpenAPI component the web spec generates from
 * the registry, the catalog endpoint, the settings picker, the CLI and the
 * docs table. Nothing else needs editing; see KNOWLEDGE.md "Event
 * subscriptions".
 *
 * Pure: no imports with side effects, no clock (callers pass `now`).
 */

import type { AlertSeverity } from "./alert-routing";
import { SEVERITY_RANK, isAlertSeverity } from "./alert-routing";

// --- Field specs ---

export type EventFieldType = "string" | "number" | "integer" | "boolean" | "string[]" | "datetime";

export interface EventFieldSpec {
  type: EventFieldType;
  description: string;
  /** The value may be `null` (it is always present). */
  nullable?: boolean;
  /** Allowed values, for `string` fields. */
  enum?: readonly string[];
}

type FieldBase<F extends EventFieldSpec> = F extends { enum: readonly (infer E)[] }
  ? E
  : F["type"] extends "string" | "datetime"
    ? string
    : F["type"] extends "number" | "integer"
      ? number
      : F["type"] extends "boolean"
        ? boolean
        : string[];

type FieldValue<F extends EventFieldSpec> = F extends { nullable: true }
  ? FieldBase<F> | null
  : FieldBase<F>;

/** The `data` object a field spec describes. */
export type EventFieldsData<F extends Record<string, EventFieldSpec>> = {
  -readonly [K in keyof F]: FieldValue<F[K]>;
};

export type EventCategory =
  "cost" | "security" | "reliability" | "access" | "operations" | "system";

export const EVENT_CATEGORY_LABELS: Record<EventCategory, string> = {
  cost: "Cost",
  security: "Security",
  reliability: "Reliability",
  access: "Access",
  operations: "Operations",
  system: "System",
};

export interface EventTypeDef<
  F extends Record<string, EventFieldSpec> = Record<string, EventFieldSpec>,
> {
  /** Dotted, lowercase, stable forever: `cost.anomaly.detected`. */
  type: string;
  /**
   * Payload schema version. Additive changes (a new field) keep the number; a
   * removed, renamed or retyped field bumps it, and consumers branch on the
   * envelope's `version`.
   */
  version: number;
  label: string;
  description: string;
  category: EventCategory;
  /** Severity when the raise site does not say. */
  defaultSeverity: AlertSeverity;
  /**
   * The payload carries spend. Subscribing to it (explicitly, or through an
   * "all events" subscription) needs `costs:read` on top of
   * `org:settings:write`, and private (user-scoped) cost objects never emit.
   */
  carriesCost?: boolean;
  /** Not offered in the picker (the test event). */
  internal?: boolean;
  fields: F;
}

/** The payload type of a definition: `EventData<typeof COST_ANOMALY_DETECTED>`. */
export type EventData<D> = D extends EventTypeDef<infer F> ? EventFieldsData<F> : never;

const registry = new Map<string, EventTypeDef>();

const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/**
 * Register an event type. This is the whole registration: the returned
 * definition is what `publishEvent` (server-core `events/publish.ts`) takes,
 * and the catalog, OpenAPI components, picker and docs all read the registry.
 *
 * Throws on a malformed or duplicate type so a collision fails at import time
 * rather than as two schemas under one name.
 */
export function defineEventType<const F extends Record<string, EventFieldSpec>>(
  def: EventTypeDef<F>,
): EventTypeDef<F> {
  if (!EVENT_TYPE_PATTERN.test(def.type)) {
    throw new Error(
      `Event type "${def.type}" must be dotted lowercase, e.g. "cost.anomaly.detected"`,
    );
  }
  if (!Number.isInteger(def.version) || def.version < 1) {
    throw new Error(`Event type "${def.type}" needs a positive integer version`);
  }
  if (registry.has(def.type)) throw new Error(`Event type "${def.type}" is already registered`);
  registry.set(def.type, def as unknown as EventTypeDef);
  return def;
}

/** Every registered type, in registration order (the picker's order). */
export function listEventTypes(options: { includeInternal?: boolean } = {}): EventTypeDef[] {
  return [...registry.values()].filter((d) => options.includeInternal || !d.internal);
}

export function getEventType(type: string): EventTypeDef | undefined {
  return registry.get(type);
}

/** OpenAPI component name for a type's payload: `EventData_cost_anomaly_detected_v1`. */
export function eventSchemaName(def: Pick<EventTypeDef, "type" | "version">): string {
  return `EventData_${def.type.replace(/\./g, "_")}_v${def.version}`;
}

/**
 * JSON Schema (draft 2020-12 subset, also valid OpenAPI 3.1) for a type's
 * `data`. The catalog endpoint serves it and the web spec builds the same
 * shape as Zod; both come from the field spec, so they cannot drift.
 */
export function eventDataJsonSchema(def: EventTypeDef): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, f] of Object.entries(def.fields)) {
    const base: Record<string, unknown> =
      f.type === "string[]"
        ? { type: "array", items: { type: "string" } }
        : f.type === "datetime"
          ? { type: "string", format: "date-time" }
          : { type: f.type };
    if (f.enum) base["enum"] = [...f.enum];
    if (f.nullable) base["type"] = [base["type"], "null"];
    base["description"] = f.description;
    properties[key] = base;
  }
  return {
    type: "object",
    title: def.label,
    description: def.description,
    properties,
    required: Object.keys(def.fields),
    additionalProperties: true,
  };
}

/** The catalog endpoint's entry for one type. */
export interface EventTypeInfo {
  type: string;
  version: number;
  label: string;
  description: string;
  category: EventCategory;
  defaultSeverity: AlertSeverity;
  carriesCost: boolean;
  schema: Record<string, unknown>;
}

export function eventTypeInfo(def: EventTypeDef): EventTypeInfo {
  return {
    type: def.type,
    version: def.version,
    label: def.label,
    description: def.description,
    category: def.category,
    defaultSeverity: def.defaultSeverity,
    carriesCost: def.carriesCost === true,
    schema: eventDataJsonSchema(def),
  };
}

/** What the settings form's pickers offer: `GET /event-subscriptions/options`. */
export interface EventSubscriptionOptions {
  accounts: Array<{ id: string; name: string; pluginId: string }>;
  environments: string[];
  sinks: Array<{
    accountId: string;
    accountName: string;
    pluginId: string;
    pluginName: string;
    resourceTypeId: string;
    resourceTypeName: string;
    resourceId: string;
    resourceName: string;
  }>;
  /** False when the caller lacks `costs:read`: cost types are shown but not selectable. */
  canSubscribeToCost: boolean;
}

// --- The envelope ---

/** What every destination receives: the webhook body, the EventBridge detail, the Pub/Sub data. */
export interface InfrawrenchEvent<TData = Record<string, unknown>> {
  /** `evt_…`, unique per event and stable across retries and redeliveries. */
  id: string;
  type: string;
  version: number;
  /** ISO instant the event happened. */
  createdAt: string;
  organizationId: string;
  severity: AlertSeverity;
  /** The account the event is about; null when it spans several or none. */
  accountId: string | null;
  /**
   * The environment the event is about: the `env`/`environment` tag of the
   * resource it concerns. Null when it has none or the event spans several.
   */
  environment: string | null;
  /** One line for a human, e.g. a chat-ops relay. */
  title: string;
  /** Deep link into Infrawrench, when there is a page for it. */
  url: string | null;
  /** True only for "Send test event". */
  test: boolean;
  data: TData;
}

// --- Built-in catalog ---

interface FieldExtras {
  nullable?: boolean;
  enum?: readonly string[];
}

function field<T extends EventFieldType>(type: T) {
  return <const X extends FieldExtras = {}>(description: string, extra?: X) =>
    ({ type, description, ...extra }) as { type: T; description: string } & X;
}

const str = field("string");
const num = field("number");
const int = field("integer");
const time = field("datetime");
const list = field("string[]");

export const TEST_EVENT = defineEventType({
  type: "infrawrench.test",
  version: 1,
  label: "Test event",
  description: "Sent by Send test event. Never raised by anything else.",
  category: "system",
  defaultSeverity: "info",
  internal: true,
  fields: {
    message: str("Fixed text saying this is a test."),
    subscriptionId: str("The subscription the test was sent to."),
  },
});

export const COST_ANOMALY_DETECTED = defineEventType({
  type: "cost.anomaly.detected",
  version: 1,
  label: "Cost anomaly detected",
  description:
    "A provider or service spent well outside its baseline, or a new source of spend appeared.",
  category: "cost",
  defaultSeverity: "warning",
  carriesCost: true,
  fields: {
    anomalyId: str("Cost anomaly id."),
    day: str("The day (YYYY-MM-DD, UTC) the spend landed on."),
    kind: str("Spike against a baseline, or a source with no prior spend.", {
      enum: ["spike", "new_source"],
    }),
    dimension: str("What `dimensionKey` names.", { enum: ["provider", "service"] }),
    dimensionKey: str("The provider id or service name."),
    actual: num("Spend on `day`, in `currency`."),
    baseline: num("Mean daily spend over the baseline window, in `currency`."),
    currency: str("ISO 4217 currency code."),
    hints: list("What the change timeline and audit log say happened around then."),
  },
});

export const BUDGET_THRESHOLD_CROSSED = defineEventType({
  type: "budget.threshold.crossed",
  version: 1,
  label: "Budget threshold crossed",
  description:
    "A budget's actual or forecast spend (or usage) reached one of its alert thresholds.",
  category: "cost",
  defaultSeverity: "warning",
  carriesCost: true,
  fields: {
    budgetId: str("Budget id."),
    budgetName: str("Budget name."),
    periodKey: str("The budget period the threshold fired in."),
    periodStart: str("First day of the period (YYYY-MM-DD); null for a calendar month.", {
      nullable: true,
    }),
    periodEnd: str("Last day of the period (YYYY-MM-DD); null for a calendar month.", {
      nullable: true,
    }),
    thresholdType: str("Whether actual or forecast crossed.", { enum: ["actual", "forecast"] }),
    thresholdPercent: num("The threshold, as a percent of the limit."),
    measure: str("A spend budget or a usage budget.", { enum: ["spend", "usage"] }),
    observed: num("The observed figure: cents for spend, units for usage."),
    limit: num("The budget's limit, in the same unit as `observed`."),
    currency: str("ISO 4217 code for a spend budget.", { nullable: true }),
  },
});

export const POSTURE_FINDING_DETECTED = defineEventType({
  type: "posture.finding.detected",
  version: 1,
  label: "Posture finding (critical or high)",
  description:
    "A critical or high severity posture check started failing on a resource. Each finding is sent once.",
  category: "security",
  defaultSeverity: "warning",
  fields: {
    resourceId: str("Infrawrench resource id."),
    resourceName: str("Resource display name."),
    resourceTypeId: str("Resource type id."),
    pluginId: str("Provider plugin id."),
    externalId: str("Provider-native id.", { nullable: true }),
    ruleId: str("The posture rule that matched."),
    title: str("Short rule title."),
    findingSeverity: str("The finding's own severity.", { enum: ["critical", "high"] }),
    category: str("Posture category."),
    reason: str("Why the resource fails the rule."),
  },
});

export const DRIFT_DETECTED = defineEventType({
  type: "drift.detected",
  version: 1,
  label: "Drift detected",
  description: "Resources changed outside Infrawrench since the last drift window.",
  category: "operations",
  defaultSeverity: "info",
  fields: {
    since: time("Start of the window the changes were observed in."),
    changeCount: int("Changes in the window."),
    created: int("Resources that appeared."),
    updated: int("Resources whose fields changed."),
    deleted: int("Resources that disappeared."),
    accountIds: list("Accounts the changes touched."),
  },
});

const incidentFields = {
  incidentId: str("Incident id."),
  title: str("Incident title."),
  incidentSeverity: str("Declared severity.", { enum: ["sev1", "sev2", "sev3", "sev4"] }),
  status: str("Status after this change."),
  summary: str("Summary, if one was given.", { nullable: true }),
  startedAt: time("When the incident started."),
  resolvedAt: time("When it was resolved.", { nullable: true }),
  declaredByName: str("Who declared it.", { nullable: true }),
  affectedResourceIds: list("Resources named as affected."),
} as const;

export const INCIDENT_DECLARED = defineEventType({
  type: "incident.declared",
  version: 1,
  label: "Incident declared",
  description: "Someone declared an incident.",
  category: "reliability",
  defaultSeverity: "critical",
  fields: incidentFields,
});

export const INCIDENT_MITIGATED = defineEventType({
  type: "incident.mitigated",
  version: 1,
  label: "Incident mitigated",
  description: "A declared incident was marked mitigated.",
  category: "reliability",
  defaultSeverity: "warning",
  fields: incidentFields,
});

export const INCIDENT_RESOLVED = defineEventType({
  type: "incident.resolved",
  version: 1,
  label: "Incident resolved",
  description: "A declared incident was resolved.",
  category: "reliability",
  defaultSeverity: "info",
  fields: incidentFields,
});

const jitFields = {
  requestId: str("Just-in-time access request id."),
  accountId: str("The account the role is granted through."),
  pluginId: str("Provider plugin id."),
  scopeId: str("Scope the role applies to (project, subscription, account)."),
  roleId: str("The provider role."),
  principalId: str("Provider principal receiving the role.", { nullable: true }),
  requesterUserId: str("Infrawrench user who asked."),
  actorName: str("Who caused this change; null for the expiry sweep.", { nullable: true }),
  durationMinutes: int("Requested duration.", { nullable: true }),
} as const;

export const JIT_ACCESS_REQUESTED = defineEventType({
  type: "jit_access.requested",
  version: 1,
  label: "JIT access requested",
  description: "A member asked for a time-boxed cloud role.",
  category: "access",
  defaultSeverity: "info",
  fields: jitFields,
});

export const JIT_ACCESS_APPROVED = defineEventType({
  type: "jit_access.approved",
  version: 1,
  label: "JIT access approved",
  description: "An approver approved a just-in-time access request.",
  category: "access",
  defaultSeverity: "warning",
  fields: jitFields,
});

export const JIT_ACCESS_DENIED = defineEventType({
  type: "jit_access.denied",
  version: 1,
  label: "JIT access denied",
  description: "An approver denied a just-in-time access request.",
  category: "access",
  defaultSeverity: "info",
  fields: jitFields,
});

export const JIT_ACCESS_EXPIRED = defineEventType({
  type: "jit_access.expired",
  version: 1,
  label: "JIT access expired",
  description: "A granted role reached the end of its window and was removed.",
  category: "access",
  defaultSeverity: "info",
  fields: jitFields,
});

export const SLO_BURN_ALERT = defineEventType({
  type: "slo.burn_alert",
  version: 1,
  label: "SLO burn alert",
  description: "An SLO started or stopped burning its error budget, or exhausted it.",
  category: "reliability",
  defaultSeverity: "warning",
  fields: {
    sloId: str("SLO id."),
    sloName: str("SLO name."),
    status: str("What changed.", { enum: ["fast_burn", "slow_burn", "recovered", "exhausted"] }),
    targetPercent: num("The SLO target, e.g. 99.9."),
    windowDays: int("The SLO window in days."),
    sli: num("Current SLI percent over the window.", { nullable: true }),
    budgetRemaining: num("Fraction of the error budget left (negative when overspent).", {
      nullable: true,
    }),
    burnRate1h: num("Burn rate over the last hour.", { nullable: true }),
    burnRate3d: num("Burn rate over the last three days.", { nullable: true }),
  },
});

const metricFields = {
  ruleId: str("Metric alert rule id."),
  ruleName: str("Rule name."),
  metricKey: str("The metric the rule watches."),
  comparator: str("How `threshold` is compared."),
  threshold: num("The rule's threshold."),
  forMinutes: int("How long the condition must hold."),
  resourceId: str("The resource the metric belongs to."),
  resourceName: str("Resource display name."),
  observed: num("The value that tripped the rule; null on resolve.", { nullable: true }),
  alertEventId: str("Metric alert event id (shared by a firing and its resolve)."),
} as const;

export const METRIC_ALERT_FIRED = defineEventType({
  type: "metric_alert.fired",
  version: 1,
  label: "Metric alert fired",
  description: "A metric threshold alert started firing on a resource.",
  category: "reliability",
  defaultSeverity: "warning",
  fields: metricFields,
});

export const METRIC_ALERT_RESOLVED = defineEventType({
  type: "metric_alert.resolved",
  version: 1,
  label: "Metric alert resolved",
  description: "A firing metric alert went back within its threshold.",
  category: "reliability",
  defaultSeverity: "info",
  fields: metricFields,
});

const syncFields = {
  accountId: str("The account whose sync is failing."),
  accountName: str("Account display name."),
  resourceTypeId: str("The resource type the failing sync lists."),
  incidentId: str("Sync incident id (shared by failing and recovered)."),
} as const;

export const ACCOUNT_SYNC_FAILING = defineEventType({
  type: "account.sync.failing",
  version: 1,
  label: "Account sync failing",
  description: "An account's sync kept failing past the org's paging threshold.",
  category: "operations",
  defaultSeverity: "warning",
  fields: {
    ...syncFields,
    error: str("The provider's last error."),
    failureCount: int("Failures in the window."),
    windowMinutes: int("The window the failures were counted in."),
  },
});

export const ACCOUNT_SYNC_RECOVERED = defineEventType({
  type: "account.sync.recovered",
  version: 1,
  label: "Account sync recovered",
  description: "A failing account sync succeeded again.",
  category: "operations",
  defaultSeverity: "info",
  fields: syncFields,
});

// --- Subscriptions ---

export type EventDestinationKind = "webhook" | "publish";

/** Where a subscription's events go. Exactly one shape per kind. */
export type EventDestination =
  | { kind: "webhook"; url: string }
  | {
      kind: "publish";
      /** A connected account. */
      accountId: string;
      /** A resource type the plugin flags `eventSink` (EventBridge rule, Pub/Sub topic). */
      resourceTypeId: string;
      /** The picked resource's Infrawrench id. */
      resourceId: string;
    };

/**
 * What a subscription takes. Every list is "any of"; an empty list does not
 * filter. `minSeverity` null means every severity.
 *
 * **Absent facts never match**, the routing rule's stance: an
 * `accountIds` filter does not catch an event with no account, and an
 * `environments` filter does not catch one with no environment.
 */
export interface EventSubscriptionFilters {
  eventTypes: string[];
  minSeverity: AlertSeverity | null;
  accountIds: string[];
  environments: string[];
}

export interface EventSubscription extends EventSubscriptionFilters {
  id: string;
  name: string;
  enabled: boolean;
  destination: EventDestination;
  /** Human label for a publish destination: "AWS / prod / EventBridge rule infra-events". */
  destinationLabel: string;
  /** Last four characters of the signing secret (webhooks only). */
  secretHint: string | null;
  /** A rerolled secret still accepted until this instant. */
  previousSecretExpiresAt: string | null;
  /** Set when the subscription was turned off automatically. */
  disabledReason: string | null;
  disabledAt: string | null;
  consecutiveFailures: number;
  failingSince: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Create/update body. `destination` is immutable after create except for the webhook URL. */
export interface EventSubscriptionInput extends EventSubscriptionFilters {
  name: string;
  enabled: boolean;
  destination: EventDestination;
}

/** Returned once, on create and reroll. Never readable again. */
export interface EventSubscriptionSecret {
  subscription: EventSubscription;
  /** `iwhsec_…`. Shown once. Null for publish destinations, which are not signed. */
  secret: string | null;
}

export type EventDeliveryState = "pending" | "retrying" | "succeeded" | "dead" | "skipped";

export interface EventDeliveryAttempt {
  at: string;
  /** HTTP status for a webhook; null when the request never completed or for publish. */
  status: number | null;
  durationMs: number;
  error: string | null;
}

export interface EventDelivery {
  id: string;
  subscriptionId: string;
  eventId: string;
  eventType: string;
  state: EventDeliveryState;
  attemptCount: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
  /** Last response status (webhook). */
  responseStatus: number | null;
  /** First 1 KB of the last response body, or the provider's summary for publish. */
  responseExcerpt: string | null;
  error: string | null;
  test: boolean;
  /** Set on a manual redelivery: the delivery it copied. */
  redeliveryOf: string | null;
  attempts: EventDeliveryAttempt[];
  createdAt: string;
  /** The envelope as sent. */
  payload: InfrawrenchEvent;
}

// --- Matching ---

/** The facts a subscription filters on, taken from an envelope. */
export type EventFacts = Pick<InfrawrenchEvent, "type" | "severity" | "accountId" | "environment">;

export function eventMatchesFilters(filters: EventSubscriptionFilters, event: EventFacts): boolean {
  if (filters.eventTypes.length > 0 && !filters.eventTypes.includes(event.type)) return false;
  if (filters.minSeverity && SEVERITY_RANK[event.severity] < SEVERITY_RANK[filters.minSeverity]) {
    return false;
  }
  if (filters.accountIds.length > 0) {
    if (!event.accountId || !filters.accountIds.includes(event.accountId)) return false;
  }
  if (filters.environments.length > 0) {
    if (!event.environment) return false;
    const env = event.environment.toLowerCase();
    if (!filters.environments.some((e) => e.toLowerCase() === env)) return false;
  }
  return true;
}

/** True when a subscription could receive spend: an explicit cost type, or "all events". */
export function filtersIncludeCostEvents(
  filters: Pick<EventSubscriptionFilters, "eventTypes">,
): boolean {
  if (filters.eventTypes.length === 0) return true;
  return filters.eventTypes.some((t) => getEventType(t)?.carriesCost === true);
}

// --- Delivery policy ---

/**
 * Wait before attempt N+1 after attempt N failed (index 0 = after the first
 * failure). Eight attempts spread over about a day and a half, so a receiver
 * down for a deploy or an overnight outage still gets everything.
 */
export const EVENT_RETRY_DELAYS_MS: readonly number[] = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000,
];

/** Attempts before a delivery is given up (`dead`). */
export const EVENT_MAX_ATTEMPTS = EVENT_RETRY_DELAYS_MS.length + 1;

/** Delay after `attempt` (1-based) failed, or null when it was the last. */
export function eventRetryDelayMs(attempt: number): number | null {
  if (attempt < 1 || attempt >= EVENT_MAX_ATTEMPTS) return null;
  return EVENT_RETRY_DELAYS_MS[attempt - 1] ?? null;
}

/**
 * Auto-disable: a subscription whose deliveries have failed without a single
 * success for this long, across at least {@link AUTO_DISABLE_MIN_FAILURES}
 * attempts, is turned off and the org's admins are emailed. Both bounds, so a
 * burst of failures in one bad minute does not disable anything, and neither
 * does one failure three days ago.
 */
export const AUTO_DISABLE_AFTER_MS = 3 * 24 * 60 * 60_000;
export const AUTO_DISABLE_MIN_FAILURES = 20;

export function shouldAutoDisable(
  state: { consecutiveFailures: number; failingSince: Date | null },
  now: Date,
): boolean {
  if (!state.failingSince) return false;
  return (
    state.consecutiveFailures >= AUTO_DISABLE_MIN_FAILURES &&
    now.getTime() - state.failingSince.getTime() >= AUTO_DISABLE_AFTER_MS
  );
}

// --- Signing ---

export const EVENT_SIGNATURE_HEADER = "Infrawrench-Signature";
export const EVENT_ID_HEADER = "Infrawrench-Event-Id";
export const EVENT_TYPE_HEADER = "Infrawrench-Event-Type";
export const EVENT_DELIVERY_HEADER = "Infrawrench-Delivery-Id";
/** Reject signatures older than this when verifying; the docs snippet uses it too. */
export const EVENT_SIGNATURE_TOLERANCE_SECONDS = 300;
export const EVENT_SECRET_PREFIX = "iwhsec_";
/** How long the previous secret keeps signing after a reroll. */
export const EVENT_SECRET_ROLLOVER_MS = 24 * 60 * 60_000;

/** The exact bytes that are HMAC'd: `<unix seconds>.<raw body>`. */
export function eventSignedContent(timestampSeconds: number, body: string): string {
  return `${timestampSeconds}.${body}`;
}

/** `t=<unix>,v1=<hex>[,v1=<hex>]`: one `v1` per active secret, newest first. */
export function formatEventSignatureHeader(timestampSeconds: number, signatures: string[]): string {
  return [`t=${timestampSeconds}`, ...signatures.map((s) => `v1=${s}`)].join(",");
}

export function parseEventSignatureHeader(
  header: string,
): { timestamp: number; signatures: string[] } | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.trim().split("=", 2);
    if (!k || v === undefined) continue;
    if (k === "t" && /^\d+$/.test(v)) timestamp = Number(v);
    else if (k === "v1" && /^[0-9a-f]{64}$/.test(v)) signatures.push(v);
  }
  return timestamp === null || signatures.length === 0 ? null : { timestamp, signatures };
}

// --- Validation ---

export const EVENT_SUBSCRIPTION_LIMITS = {
  maxPerOrg: 25,
  maxNameLength: 120,
  maxUrlLength: 2048,
  maxFilterValues: 100,
} as const;

/**
 * Shape checks shared by the API, the form and the Terraform docs. Returns a
 * user-facing message or null. Network policy (is the host reachable) is the
 * server's job, at save and at send.
 */
export function validateEventSubscriptionInput(input: EventSubscriptionInput): string | null {
  const name = input.name.trim();
  if (!name) return "Give the subscription a name.";
  if (name.length > EVENT_SUBSCRIPTION_LIMITS.maxNameLength) {
    return `Keep the name under ${EVENT_SUBSCRIPTION_LIMITS.maxNameLength} characters.`;
  }
  for (const t of input.eventTypes) {
    const def = getEventType(t);
    if (!def || def.internal) return `Unknown event type "${t}".`;
  }
  if (input.minSeverity !== null && !isAlertSeverity(input.minSeverity)) {
    return "Minimum severity must be info, warning or critical.";
  }
  for (const listValue of [input.eventTypes, input.accountIds, input.environments]) {
    if (listValue.length > EVENT_SUBSCRIPTION_LIMITS.maxFilterValues) {
      return `A filter takes at most ${EVENT_SUBSCRIPTION_LIMITS.maxFilterValues} values.`;
    }
  }
  if (input.environments.some((e) => !e.trim())) return "Environment names cannot be blank.";
  const d = input.destination;
  if (d.kind === "webhook") {
    let url: URL;
    try {
      url = new URL(d.url);
    } catch {
      return "Enter a full https:// URL.";
    }
    if (url.protocol !== "https:") return "Webhook URLs must use https.";
    if (url.username || url.password) return "Put credentials in your receiver, not the URL.";
    if (d.url.length > EVENT_SUBSCRIPTION_LIMITS.maxUrlLength) return "That URL is too long.";
    return null;
  }
  if (d.kind === "publish") {
    if (!d.accountId || !d.resourceTypeId || !d.resourceId) {
      return "Pick an account and a resource to publish to.";
    }
    return null;
  }
  return "Unknown destination.";
}
