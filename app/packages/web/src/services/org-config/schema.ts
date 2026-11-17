/**
 * Effect schema for the org config document: what `POST /config/plan` and
 * `POST /config/apply` validate their bodies against.
 *
 * The *types* it describes live in `@infrawrench/client-core` (`org-config.ts`)
 * so the CLI and the settings section share one definition; the assertions at
 * the bottom fail the build if the schema drifts from the type. This is the
 * `@infrawrench/ui/cost/config` convention, applied one package over because
 * the document is a server contract rather than an editor contract.
 *
 * Where a section's payload is already validated elsewhere (cost filters,
 * budget thresholds, tag policies, widget configs) this schema reuses the
 * existing request schemas (`@infrawrench/api-contract/schemas`) rather than
 * restating them, so a config document can never smuggle in a shape the
 * hand-editing route would have refused.
 *
 * Every object in the document is closed: it is decoded with
 * `STRICT_PARSE_OPTIONS`, so an unknown key anywhere (a typo'd section, a
 * misspelt field) is refused rather than silently dropped. Dashboard widget
 * configs are records here and checked against their own schema on apply.
 */
import { Effect, Schema } from "effect";
import {
  BudgetPeriod,
  BudgetThreshold,
  CostFilter,
  RequiredTag,
  STRICT_PARSE_OPTIONS,
  decodeForm,
  maxLength,
  minLength,
  pattern,
  tagValueRequiresKey,
  trimmed,
} from "@infrawrench/api-contract/schemas";
import {
  ORG_CONFIG_KEY_MAX_LENGTH,
  ORG_CONFIG_KEY_PATTERN,
  ORG_CONFIG_SECTIONS,
  ORG_CONFIG_VERSION,
  COST_ANOMALY_SMS_MODES,
  DRIFT_ALERT_LIMITS,
  EXPIRY_ALERT_LIMITS,
  EXTENDED_SUPPORT_LIMITS,
  IDLE_FINDING_LIMITS,
  METRIC_ALERT_LIMITS,
  PROBE_LIMITS,
  SLO_LIMITS,
  SAVINGS_FINDING_KINDS,
  SAVINGS_FINDING_SORT_FIELDS,
  SAVINGS_FINDING_STATUS_FILTERS,
  SAVINGS_VIEW_LIMITS,
  type OrgConfigAllocationRule,
  type OrgConfigBudget,
  type OrgConfigCostCentre,
  type OrgConfigCustomGraph,
  type OrgConfigDashboard,
  type OrgConfigDashboardCard,
  type OrgConfigDocument,
  type OrgConfigMetricAlert,
  type OrgConfigProbe,
  type OrgConfigSavingsView,
  type OrgConfigSavingsViewFilter,
  type OrgConfigSection,
  type OrgConfigSlo,
  type OrgConfigWorkflow,
  type OrgConfigWorkflowTrigger,
} from "@infrawrench/client-core";
import {
  BUDGET_LIMITS,
  TAG_POLICY_LIMITS,
  DASHBOARD_WIDGET_KINDS,
  COST_ANOMALY_LIMITS,
} from "@infrawrench/ui/cost/config";

/** Bounds on the free-text blobs the document carries verbatim. */
const ORG_CONFIG_LIMITS = {
  /** Matches `services/custom-graphs.ts` / the workflow editor's own cap. */
  maxSourceBytes: 128 * 1024,
  maxNameLength: 200,
  maxDescriptionLength: 2000,
  /** A governance rail on a single document, not a product tier. */
  maxEntitiesPerSection: 500,
  maxCardsPerDashboard: 200,
} as const;

/** A string of `min` to `max` characters, as sent. */
const bounded = (min: number, max: number) => Schema.String.check(minLength(min), maxLength(max));

/** A whole number between `min` and `max`. */
const intBetween = (min: number, max: number) =>
  Schema.Int.check(Schema.isBetween({ minimum: min, maximum: max }));

const key = Schema.String.check(
  maxLength(ORG_CONFIG_KEY_MAX_LENGTH),
  pattern(ORG_CONFIG_KEY_PATTERN, {
    message: "keys are lowercase alphanumerics separated by single hyphens",
  }),
);

const name = trimmed([minLength(1), maxLength(ORG_CONFIG_LIMITS.maxNameLength)]);
const description = Schema.optionalKey(
  Schema.NullOr(Schema.String.check(maxLength(ORG_CONFIG_LIMITS.maxDescriptionLength))),
);
const source = Schema.String.check(maxLength(ORG_CONFIG_LIMITS.maxSourceBytes));
const collection = <S extends Schema.Top>(item: S) =>
  Schema.mutable(Schema.Array(item)).check(maxLength(ORG_CONFIG_LIMITS.maxEntitiesPerSection));

/* -------------------------------- budgets --------------------------------- */

const budgetSchema = Schema.Struct({
  key,
  name,
  amountCents: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  currency: bounded(3, 3).pipe(Schema.withDecodingDefaultKey(Effect.succeed("USD"))),
  filters: Schema.mutable(Schema.Array(CostFilter)).pipe(
    Schema.withDecodingDefaultKey(Effect.sync(() => [])),
  ),
  thresholds: Schema.mutable(Schema.Array(BudgetThreshold)).check(minLength(1), maxLength(10)),
  measure: Schema.optionalKey(Schema.Literal("usage")),
  usageUnit: Schema.optionalKey(
    trimmed([minLength(1), maxLength(BUDGET_LIMITS.maxUsageUnitLength)]),
  ),
  usageAmount: Schema.optionalKey(
    Schema.Finite.check(
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(BUDGET_LIMITS.maxUsageAmount),
    ),
  ),
  period: Schema.optionalKey(BudgetPeriod),
  parentKey: Schema.optionalKey(key),
});

/* ------------------------------ custom graphs ------------------------------ */

const customGraphSchema = Schema.Struct({ key, name, description, source });

/* -------------------------------- workflows -------------------------------- */

const workflowTriggerSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("manual") }),
  Schema.Struct({
    kind: Schema.Literal("cron"),
    expression: bounded(1, 200),
    timezone: Schema.optionalKey(Schema.String.check(maxLength(100))),
  }),
  Schema.Struct({
    kind: Schema.Literal("git"),
    provider: Schema.optionalKey(Schema.String.check(maxLength(50))),
    repo: Schema.optionalKey(Schema.String.check(maxLength(300))),
    branch: Schema.optionalKey(Schema.String.check(maxLength(300))),
    events: Schema.optionalKey(
      Schema.mutable(Schema.Array(Schema.String.check(maxLength(50)))).check(maxLength(20)),
    ),
    installationId: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  }),
  Schema.Struct({
    kind: Schema.Literal("budget"),
    budgetKey: key,
    percent: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThan(0))),
    metric: Schema.optionalKey(Schema.Literals(["actual", "forecast"])),
  }),
]);

const workflowMetricSchema = Schema.Struct({
  key: bounded(1, 100),
  label: bounded(1, 200),
  unit: Schema.optionalKey(Schema.NullOr(Schema.String.check(maxLength(50)))),
  type: Schema.optionalKey(Schema.String.check(maxLength(50))),
});

const workflowSchema = Schema.Struct({
  key,
  name,
  description,
  source,
  trigger: workflowTriggerSchema.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({ kind: "manual" } as const)),
  ),
  metrics: Schema.mutable(Schema.Array(workflowMetricSchema))
    .check(maxLength(50))
    .pipe(Schema.withDecodingDefaultKey(Effect.sync(() => []))),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
});

/* -------------------------------- dashboards ------------------------------- */

const gridSpan = Schema.optionalKey(intBetween(1, 12));

const dashboardCardSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("widget"),
    widgetKind: Schema.Literals(DASHBOARD_WIDGET_KINDS),
    title: Schema.String.check(maxLength(ORG_CONFIG_LIMITS.maxNameLength)).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed("")),
    ),
    // Validated against `widgetConfigFor(kind)` on apply, once the
    // budget/graph reference has been resolved back into it: the kinds that
    // carry one would fail their own schema while the id is lifted out.
    config: Schema.Record(Schema.String, Schema.Unknown).pipe(
      Schema.withDecodingDefaultKey(Effect.sync(() => ({}))),
    ),
    budgetKey: Schema.optionalKey(key),
    graphKey: Schema.optionalKey(key),
    width: gridSpan,
    height: gridSpan,
  }),
  Schema.Struct({ kind: Schema.Literal("workflow"), workflowKey: key }),
  Schema.Struct({
    kind: Schema.Literal("resource"),
    pluginId: bounded(1, 100),
    resourceTypeId: bounded(1, 100),
    externalId: bounded(1, 1000),
    account: bounded(1, 200),
    width: gridSpan,
    height: gridSpan,
  }),
]);

const dashboardSchema = Schema.Struct({
  key,
  name,
  isDefault: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  defaultForRoles: Schema.optionalKey(
    Schema.mutable(Schema.Array(trimmed([minLength(1), maxLength(200)]))).check(maxLength(100)),
  ),
  cards: Schema.mutable(Schema.Array(dashboardCardSchema))
    .check(maxLength(ORG_CONFIG_LIMITS.maxCardsPerDashboard))
    .pipe(Schema.withDecodingDefaultKey(Effect.sync(() => []))),
});

/* ------------------------------- metric alerts ----------------------------- */

const selectorPart = (max: number) =>
  Schema.NullOr(trimmed([minLength(1), maxLength(max)])).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  );

const metricAlertSchema = Schema.Struct({
  key,
  name: trimmed([minLength(1), maxLength(METRIC_ALERT_LIMITS.maxNameLength)]),
  pluginId: selectorPart(100),
  resourceTypeId: selectorPart(100),
  tagKey: selectorPart(METRIC_ALERT_LIMITS.maxTagLength),
  tagValue: selectorPart(METRIC_ALERT_LIMITS.maxTagLength),
  metricKey: trimmed([minLength(1), maxLength(METRIC_ALERT_LIMITS.maxMetricKeyLength)]),
  comparator: Schema.Literals([">", ">=", "<", "<="]),
  threshold: Schema.Finite,
  forMinutes: intBetween(METRIC_ALERT_LIMITS.minForMinutes, METRIC_ALERT_LIMITS.maxForMinutes).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(15)),
  ),
  cooldownMinutes: intBetween(
    METRIC_ALERT_LIMITS.minCooldownMinutes,
    METRIC_ALERT_LIMITS.maxCooldownMinutes,
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed(60))),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
});

/* ---------------------------------- probes --------------------------------- */

const probeSchema = Schema.Struct({
  key,
  name,
  url: bounded(1, 2000),
  method: bounded(1, 10).pipe(Schema.withDecodingDefaultKey(Effect.succeed("GET"))),
  intervalSeconds: intBetween(
    PROBE_LIMITS.minIntervalSeconds,
    PROBE_LIMITS.maxIntervalSeconds,
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed(60))),
  timeoutMs: intBetween(PROBE_LIMITS.minTimeoutMs, PROBE_LIMITS.maxTimeoutMs).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(10_000)),
  ),
  failureThreshold: intBetween(
    PROBE_LIMITS.minFailureThreshold,
    PROBE_LIMITS.maxFailureThreshold,
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed(3))),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
});

/* ----------------------------------- SLOs ---------------------------------- */

const sloSchema = Schema.Struct({
  key,
  name,
  description: Schema.NullOr(Schema.String.check(maxLength(SLO_LIMITS.maxDescriptionLength))).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  sliKind: Schema.Literals(["probe_availability", "probe_latency", "metric_threshold"]),
  probeKey: Schema.optionalKey(key),
  latencyThresholdMs: Schema.optionalKey(
    intBetween(SLO_LIMITS.minLatencyThresholdMs, SLO_LIMITS.maxLatencyThresholdMs),
  ),
  resource: Schema.optionalKey(
    Schema.Struct({
      pluginId: bounded(1, 100),
      resourceTypeId: bounded(1, 100),
      externalId: Schema.String.check(maxLength(1000)),
      account: bounded(1, ORG_CONFIG_LIMITS.maxNameLength),
    }),
  ),
  metricKey: Schema.optionalKey(trimmed([minLength(1), maxLength(SLO_LIMITS.maxMetricKeyLength)])),
  comparator: Schema.optionalKey(Schema.Literals(["<", "<=", ">", ">="])),
  threshold: Schema.optionalKey(Schema.Finite),
  targetPercent: Schema.Finite.check(
    Schema.isBetween({
      minimum: SLO_LIMITS.minTargetPercent,
      maximum: SLO_LIMITS.maxTargetPercent,
    }),
  ),
  windowDays: Schema.Literals([7, 28, 30]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed<7 | 28 | 30>(30)),
  ),
  alertsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  suggestFreeze: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
});

/* ------------------------------- cost centres ------------------------------ */

const allocationRuleSchema = Schema.Struct({
  priority: intBetween(0, 100_000),
  match: Schema.Struct({
    tagKey: Schema.optionalKey(bounded(1, TAG_POLICY_LIMITS.maxKeyLength)),
    tagValue: Schema.optionalKey(Schema.String.check(maxLength(TAG_POLICY_LIMITS.maxValueLength))),
    account: Schema.optionalKey(bounded(1, 200)),
    pluginId: Schema.optionalKey(bounded(1, 100)),
    service: Schema.optionalKey(bounded(1, 300)),
  })
    .check(tagValueRequiresKey)
    .pipe(Schema.withDecodingDefaultKey(Effect.sync(() => ({})))),
});

const costCentreSchema = Schema.Struct({
  key,
  name,
  description,
  rules: Schema.mutable(Schema.Array(allocationRuleSchema))
    .check(maxLength(200))
    .pipe(Schema.withDecodingDefaultKey(Effect.sync(() => []))),
});

/* ------------------------------ alert settings ----------------------------- */

const alertSettingsSchema = Schema.Struct({
  costAnomaly: Schema.optionalKey(
    Schema.Struct({
      sigmas: Schema.Finite.check(
        Schema.isBetween({
          minimum: COST_ANOMALY_LIMITS.sigmasMin,
          maximum: COST_ANOMALY_LIMITS.sigmasMax,
        }),
      ),
      minDeltaCents: intBetween(
        COST_ANOMALY_LIMITS.minDeltaCentsMin,
        COST_ANOMALY_LIMITS.minDeltaCentsMax,
      ),
      newSourceMinCents: intBetween(
        COST_ANOMALY_LIMITS.newSourceMinCentsMin,
        COST_ANOMALY_LIMITS.newSourceMinCentsMax,
      ),
      smsAlerts: Schema.Literals(COST_ANOMALY_SMS_MODES),
      feedbackTuning: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  drift: Schema.optionalKey(
    Schema.Struct({
      notifyCreated: Schema.Boolean,
      notifyUpdated: Schema.Boolean,
      notifyDeleted: Schema.Boolean,
      cooldownMinutes: intBetween(
        DRIFT_ALERT_LIMITS.cooldownMinutes.min,
        DRIFT_ALERT_LIMITS.cooldownMinutes.max,
      ),
      minChanges: intBetween(DRIFT_ALERT_LIMITS.minChanges.min, DRIFT_ALERT_LIMITS.minChanges.max),
      accounts: Schema.mutable(Schema.Array(bounded(1, 200))).check(
        maxLength(DRIFT_ALERT_LIMITS.maxAccountIds),
      ),
    }),
  ),
  expiry: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.Boolean,
      leadDays: intBetween(EXPIRY_ALERT_LIMITS.leadDays.min, EXPIRY_ALERT_LIMITS.leadDays.max),
    }),
  ),
  posture: Schema.optionalKey(Schema.Struct({ enabled: Schema.Boolean })),
  extendedSupport: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.Boolean,
      leadDays: intBetween(
        EXTENDED_SUPPORT_LIMITS.leadDays.min,
        EXTENDED_SUPPORT_LIMITS.leadDays.max,
      ),
    }),
  ),
  // Metric-based idle rules: the same bounds `PUT /idle-findings/settings`
  // enforces; unknown rule and threshold keys are rejected at apply time,
  // against the loaded plugins' declarations.
  idleFindings: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.Boolean,
      lookbackDays: intBetween(
        IDLE_FINDING_LIMITS.minLookbackDays,
        IDLE_FINDING_LIMITS.maxLookbackDays,
      ),
      rules: Schema.Record(
        bounded(3, 130),
        Schema.Struct({
          enabled: Schema.optionalKey(Schema.Boolean),
          thresholds: Schema.optionalKey(Schema.Record(bounded(1, 64), Schema.Finite)),
        }),
      ).pipe(Schema.withDecodingDefaultKey(Effect.sync(() => ({})))),
    }),
  ),
  digest: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.Boolean,
      timezone: bounded(1, 100),
      sendDay: intBetween(1, 7),
      sendHour: intBetween(0, 23),
      narrativeEnabled: Schema.Boolean,
      recipients: Schema.mutable(Schema.Array(bounded(3, 320))).check(maxLength(100)),
    }),
  ),
});

/* ------------------------------ savings views ------------------------------ */

const isoDay = Schema.String.check(
  pattern(/^\d{4}-\d{2}-\d{2}$/, { message: "dates are YYYY-MM-DD" }),
);
const filterValues = Schema.mutable(Schema.Array(trimmed([minLength(1), maxLength(200)]))).check(
  maxLength(SAVINGS_VIEW_LIMITS.maxFilterValues),
);

const savingsViewFilterSchema = Schema.Struct({
  kinds: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.Literals(SAVINGS_FINDING_KINDS)))),
  pluginIds: Schema.optionalKey(filterValues),
  accounts: Schema.optionalKey(filterValues),
  regions: Schema.optionalKey(filterValues),
  tags: Schema.optionalKey(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          key: trimmed([minLength(1), maxLength(200)]),
          values: Schema.optionalKey(filterValues),
        }),
      ),
    ).check(maxLength(SAVINGS_VIEW_LIMITS.maxTagTerms)),
  ),
  minMonthlySavings: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  detectedFrom: Schema.optionalKey(isoDay),
  detectedTo: Schema.optionalKey(isoDay),
  search: Schema.optionalKey(Schema.String.check(maxLength(SAVINGS_VIEW_LIMITS.maxSearchLength))),
});

const savingsViewSchema = Schema.Struct({
  key,
  name: trimmed([minLength(1), maxLength(SAVINGS_VIEW_LIMITS.maxNameLength)]),
  description: Schema.NullOr(
    Schema.String.check(maxLength(SAVINGS_VIEW_LIMITS.maxDescriptionLength)),
  ),
  status: Schema.Literals(SAVINGS_FINDING_STATUS_FILTERS),
  filter: savingsViewFilterSchema,
  sort: Schema.Struct({
    field: Schema.Literals(SAVINGS_FINDING_SORT_FIELDS),
    direction: Schema.Literals(["asc", "desc"]),
  }),
});

/* -------------------------------- document --------------------------------- */

const orgConfigDocumentSchema = Schema.Struct({
  // Accepted rather than required-equal so a future v2 reader can say
  // something better than "unrecognized key"; the service refuses anything
  // it does not know how to apply.
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(ORG_CONFIG_VERSION)),
  ),
  exportedAt: Schema.optionalKey(Schema.String.check(maxLength(64))),
  exportedFrom: Schema.optionalKey(
    Schema.Struct({
      organizationId: Schema.String.check(maxLength(200)),
      organizationName: Schema.String.check(maxLength(300)),
    }),
  ),
  budgets: Schema.optionalKey(collection(budgetSchema)),
  customGraphs: Schema.optionalKey(collection(customGraphSchema)),
  workflows: Schema.optionalKey(collection(workflowSchema)),
  dashboards: Schema.optionalKey(collection(dashboardSchema)),
  metricAlerts: Schema.optionalKey(collection(metricAlertSchema)),
  probes: Schema.optionalKey(collection(probeSchema)),
  slos: Schema.optionalKey(collection(sloSchema)),
  costCentres: Schema.optionalKey(collection(costCentreSchema)),
  tagPolicy: Schema.optionalKey(
    Schema.Struct({
      requiredTags: Schema.mutable(Schema.Array(RequiredTag)).check(
        maxLength(TAG_POLICY_LIMITS.maxRequiredTags),
      ),
      enforceOnCreate: Schema.Boolean,
    }),
  ),
  alertSettings: Schema.optionalKey(alertSettingsSchema),
  savingsViews: Schema.optionalKey(collection(savingsViewSchema)),
});

/** The document after parsing: every collection defaulted, ids resolved later. */
export type ParsedOrgConfigDocument = typeof orgConfigDocumentSchema.Type;

/* -------------------------------- validation ------------------------------- */

/** A caller-correctable problem (bad document, unusable reference). */
export class OrgConfigError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = "OrgConfigError";
  }
}

/**
 * Validate an inbound document, reporting the first problem in plain words.
 *
 * Three checks the schema cannot express on its own, all of which would
 * otherwise silently do the wrong thing rather than fail: a document from a
 * newer server, duplicate keys within a section (the second would quietly
 * overwrite the first on apply), and two dashboards both claiming to be the
 * default (an org with two defaults resolves "the" default at random).
 */
export function parseOrgConfigDocument(raw: unknown): ParsedOrgConfigDocument {
  const parsed = decodeForm(orgConfigDocumentSchema, raw, STRICT_PARSE_OPTIONS);
  if (!parsed.success) {
    const where = parsed.path.length > 0 ? ` at ${parsed.path.map(String).join(".")}` : "";
    throw new OrgConfigError(`Invalid config document${where}: ${parsed.message}`);
  }
  if (parsed.data.version > ORG_CONFIG_VERSION) {
    throw new OrgConfigError(
      `This document is version ${parsed.data.version}; this deployment understands up to ${ORG_CONFIG_VERSION}. Upgrade the server or export again from it.`,
    );
  }
  for (const section of ORG_CONFIG_SECTIONS) {
    const entries = parsed.data[section as keyof ParsedOrgConfigDocument];
    if (!Array.isArray(entries)) continue;
    const seen = new Set<string>();
    for (const entry of entries as Array<{ key: string }>) {
      if (seen.has(entry.key)) {
        throw new OrgConfigError(`Duplicate key "${entry.key}" in ${section}.`);
      }
      seen.add(entry.key);
    }
  }
  const defaults = (parsed.data.dashboards ?? []).filter((d) => d.isDefault);
  if (defaults.length > 1) {
    throw new OrgConfigError(
      `Only one dashboard can be the default; ${defaults.map((d) => d.key).join(", ")} all claim it.`,
    );
  }
  // A role lands on one dashboard, so naming it twice is a contradiction the
  // document has to resolve, not something apply should pick a winner for.
  const roleClaims = new Map<string, string>();
  for (const dashboard of parsed.data.dashboards ?? []) {
    for (const role of dashboard.defaultForRoles ?? []) {
      const lower = role.toLowerCase();
      const other = roleClaims.get(lower);
      if (other && other !== dashboard.key) {
        throw new OrgConfigError(
          `The role "${role}" is the default for both ${other} and ${dashboard.key}; a role can have one default dashboard.`,
        );
      }
      roleClaims.set(lower, dashboard.key);
    }
  }
  return parsed.data;
}

/** Which sections a document actually carries: what apply checks permissions on. */
export function orgConfigDocumentSections(doc: ParsedOrgConfigDocument): OrgConfigSection[] {
  return ORG_CONFIG_SECTIONS.filter((s) => doc[s as keyof ParsedOrgConfigDocument] !== undefined);
}

/* ------------------------------ drift guards ------------------------------- */

/** `| undefined` on a property is ignored: `exactOptionalPropertyTypes` tells them apart, JSON cannot. */
type Normalize<T> = T extends object ? { [K in keyof T]: Normalize<Exclude<T[K], undefined>> } : T;

type Exact<A, B> = [Normalize<A>] extends [Normalize<B>]
  ? [Normalize<B>] extends [Normalize<A>]
    ? true
    : never
  : never;

/**
 * Compile-time proof the schema still parses to exactly the shared client-core
 * types. Drift is a build error rather than a document that validates here and
 * fails to type-check in the CLI.
 *
 * The tuple is *instantiated* below rather than merely declared: `Exact` widens
 * to `never` on a mismatch, and a type alias to `never` is perfectly legal; it
 * is assigning `true` to it that actually fails.
 */
type SchemaMatchesOrgConfigContract = [
  Exact<typeof budgetSchema.Type, OrgConfigBudget>,
  Exact<typeof customGraphSchema.Type, OrgConfigCustomGraph>,
  Exact<typeof workflowTriggerSchema.Type, OrgConfigWorkflowTrigger>,
  Exact<typeof workflowSchema.Type, OrgConfigWorkflow>,
  Exact<typeof dashboardCardSchema.Type, OrgConfigDashboardCard>,
  Exact<typeof dashboardSchema.Type, OrgConfigDashboard>,
  Exact<typeof metricAlertSchema.Type, OrgConfigMetricAlert>,
  Exact<typeof probeSchema.Type, OrgConfigProbe>,
  Exact<typeof sloSchema.Type, OrgConfigSlo>,
  Exact<typeof allocationRuleSchema.Type, OrgConfigAllocationRule>,
  Exact<typeof costCentreSchema.Type, OrgConfigCostCentre>,
  Exact<typeof savingsViewFilterSchema.Type, OrgConfigSavingsViewFilter>,
  Exact<typeof savingsViewSchema.Type, OrgConfigSavingsView>,
  Exact<typeof orgConfigDocumentSchema.Type, OrgConfigDocument>,
];

const schemaMatchesContract: SchemaMatchesOrgConfigContract = [
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
];
void schemaMatchesContract;
