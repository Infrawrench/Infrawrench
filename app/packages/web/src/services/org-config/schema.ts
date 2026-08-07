/**
 * Zod schema for the org config document — what `POST /config/plan` and
 * `POST /config/apply` validate their bodies against.
 *
 * The *types* it describes live in `@infrawrench/client-core` (`org-config.ts`)
 * so the CLI and the settings section share one definition; the assertions at
 * the bottom fail the build if the schema drifts from the type. This is the
 * `@infrawrench/ui/cost/config` convention, applied one package over because
 * the document is a server contract rather than an editor contract.
 *
 * Where a section's payload is already validated elsewhere — cost filters,
 * budget thresholds, tag policies, widget configs — this schema reuses the
 * existing zod objects rather than restating them, so a config document can
 * never smuggle in a shape the hand-editing route would have refused.
 */
import { z } from "zod";
import {
  ORG_CONFIG_KEY_MAX_LENGTH,
  ORG_CONFIG_KEY_PATTERN,
  ORG_CONFIG_SECTIONS,
  ORG_CONFIG_VERSION,
  COST_ANOMALY_SMS_MODES,
  DRIFT_ALERT_LIMITS,
  EXPIRY_ALERT_LIMITS,
  METRIC_ALERT_LIMITS,
  PROBE_LIMITS,
  type OrgConfigAllocationRule,
  type OrgConfigBudget,
  type OrgConfigCostCentre,
  type OrgConfigCustomGraph,
  type OrgConfigDashboard,
  type OrgConfigDashboardCard,
  type OrgConfigDocument,
  type OrgConfigMetricAlert,
  type OrgConfigProbe,
  type OrgConfigSection,
  type OrgConfigWorkflow,
  type OrgConfigWorkflowTrigger,
} from "@infrawrench/client-core";
import {
  budgetThresholdSchema,
  costFilterSchema,
  requiredTagSchema,
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

const key = z
  .string()
  .max(ORG_CONFIG_KEY_MAX_LENGTH)
  .regex(ORG_CONFIG_KEY_PATTERN, "keys are lowercase alphanumerics separated by single hyphens");

const name = z.string().trim().min(1).max(ORG_CONFIG_LIMITS.maxNameLength);
const description = z.string().max(ORG_CONFIG_LIMITS.maxDescriptionLength).nullish();
const source = z.string().max(ORG_CONFIG_LIMITS.maxSourceBytes);
const collection = <T extends z.ZodTypeAny>(item: T) =>
  z.array(item).max(ORG_CONFIG_LIMITS.maxEntitiesPerSection);

/* -------------------------------- budgets --------------------------------- */

const budgetSchema = z
  .object({
    key,
    name,
    amountCents: z.number().int().positive(),
    currency: z.string().length(3).default("USD"),
    filters: z.array(costFilterSchema).default([]),
    thresholds: z.array(budgetThresholdSchema).min(1).max(10),
  })
  .strict();

/* ------------------------------ custom graphs ------------------------------ */

const customGraphSchema = z.object({ key, name, description, source }).strict();

/* -------------------------------- workflows -------------------------------- */

const workflowTriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }).strict(),
  z
    .object({
      kind: z.literal("cron"),
      expression: z.string().min(1).max(200),
      timezone: z.string().max(100).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("git"),
      provider: z.string().max(50).optional(),
      repo: z.string().max(300).optional(),
      branch: z.string().max(300).optional(),
      events: z.array(z.string().max(50)).max(20).optional(),
      installationId: z.number().int().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("budget"),
      budgetKey: key,
      percent: z.number().positive().optional(),
      metric: z.enum(["actual", "forecast"]).optional(),
    })
    .strict(),
]);

const workflowMetricSchema = z
  .object({
    key: z.string().min(1).max(100),
    label: z.string().min(1).max(200),
    unit: z.string().max(50).nullish(),
    type: z.string().max(50).optional(),
  })
  .strict();

const workflowSchema = z
  .object({
    key,
    name,
    description,
    source,
    trigger: workflowTriggerSchema.default({ kind: "manual" }),
    metrics: z.array(workflowMetricSchema).max(50).default([]),
    enabled: z.boolean().default(true),
  })
  .strict();

/* -------------------------------- dashboards ------------------------------- */

const gridSpan = z.number().int().min(1).max(12).optional();

const dashboardCardSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("widget"),
      widgetKind: z.enum(DASHBOARD_WIDGET_KINDS),
      title: z.string().max(ORG_CONFIG_LIMITS.maxNameLength).default(""),
      // Validated against `widgetConfigSchemaFor(kind)` on apply, once the
      // budget/graph reference has been resolved back into it — the kinds that
      // carry one would fail their own schema while the id is lifted out.
      config: z.record(z.unknown()).default({}),
      budgetKey: key.optional(),
      graphKey: key.optional(),
      width: gridSpan,
      height: gridSpan,
    })
    .strict(),
  z.object({ kind: z.literal("workflow"), workflowKey: key }).strict(),
  z
    .object({
      kind: z.literal("resource"),
      pluginId: z.string().min(1).max(100),
      resourceTypeId: z.string().min(1).max(100),
      externalId: z.string().min(1).max(1000),
      account: z.string().min(1).max(200),
      width: gridSpan,
      height: gridSpan,
    })
    .strict(),
]);

const dashboardSchema = z
  .object({
    key,
    name,
    isDefault: z.boolean().default(false),
    cards: z.array(dashboardCardSchema).max(ORG_CONFIG_LIMITS.maxCardsPerDashboard).default([]),
  })
  .strict();

/* ------------------------------- metric alerts ----------------------------- */

const selectorPart = (max: number) => z.string().trim().min(1).max(max).nullable().default(null);

const metricAlertSchema = z
  .object({
    key,
    name: z.string().trim().min(1).max(METRIC_ALERT_LIMITS.maxNameLength),
    pluginId: selectorPart(100),
    resourceTypeId: selectorPart(100),
    tagKey: selectorPart(METRIC_ALERT_LIMITS.maxTagLength),
    tagValue: selectorPart(METRIC_ALERT_LIMITS.maxTagLength),
    metricKey: z.string().trim().min(1).max(METRIC_ALERT_LIMITS.maxMetricKeyLength),
    comparator: z.enum([">", ">=", "<", "<="]),
    threshold: z.number().finite(),
    forMinutes: z
      .number()
      .int()
      .min(METRIC_ALERT_LIMITS.minForMinutes)
      .max(METRIC_ALERT_LIMITS.maxForMinutes)
      .default(15),
    cooldownMinutes: z
      .number()
      .int()
      .min(METRIC_ALERT_LIMITS.minCooldownMinutes)
      .max(METRIC_ALERT_LIMITS.maxCooldownMinutes)
      .default(60),
    enabled: z.boolean().default(true),
  })
  .strict();

/* ---------------------------------- probes --------------------------------- */

const probeSchema = z
  .object({
    key,
    name,
    url: z.string().min(1).max(2000),
    method: z.string().min(1).max(10).default("GET"),
    intervalSeconds: z
      .number()
      .int()
      .min(PROBE_LIMITS.minIntervalSeconds)
      .max(PROBE_LIMITS.maxIntervalSeconds)
      .default(60),
    timeoutMs: z
      .number()
      .int()
      .min(PROBE_LIMITS.minTimeoutMs)
      .max(PROBE_LIMITS.maxTimeoutMs)
      .default(10_000),
    failureThreshold: z
      .number()
      .int()
      .min(PROBE_LIMITS.minFailureThreshold)
      .max(PROBE_LIMITS.maxFailureThreshold)
      .default(3),
    enabled: z.boolean().default(true),
  })
  .strict();

/* ------------------------------- cost centres ------------------------------ */

const allocationRuleSchema = z
  .object({
    priority: z.number().int().min(0).max(100_000),
    match: z
      .object({
        tagKey: z.string().min(1).max(TAG_POLICY_LIMITS.maxKeyLength).optional(),
        tagValue: z.string().max(TAG_POLICY_LIMITS.maxValueLength).optional(),
        account: z.string().min(1).max(200).optional(),
        pluginId: z.string().min(1).max(100).optional(),
        service: z.string().min(1).max(300).optional(),
      })
      .strict()
      .refine((m) => !m.tagValue?.trim() || !!m.tagKey?.trim(), {
        message: "tagValue requires tagKey",
        path: ["tagValue"],
      })
      .default({}),
  })
  .strict();

const costCentreSchema = z
  .object({
    key,
    name,
    description,
    rules: z.array(allocationRuleSchema).max(200).default([]),
  })
  .strict();

/* ------------------------------ alert settings ----------------------------- */

const alertSettingsSchema = z
  .object({
    costAnomaly: z
      .object({
        sigmas: z.number().min(COST_ANOMALY_LIMITS.sigmasMin).max(COST_ANOMALY_LIMITS.sigmasMax),
        minDeltaCents: z
          .number()
          .int()
          .min(COST_ANOMALY_LIMITS.minDeltaCentsMin)
          .max(COST_ANOMALY_LIMITS.minDeltaCentsMax),
        newSourceMinCents: z
          .number()
          .int()
          .min(COST_ANOMALY_LIMITS.newSourceMinCentsMin)
          .max(COST_ANOMALY_LIMITS.newSourceMinCentsMax),
        smsAlerts: z.enum(COST_ANOMALY_SMS_MODES),
      })
      .strict()
      .optional(),
    drift: z
      .object({
        notifyCreated: z.boolean(),
        notifyUpdated: z.boolean(),
        notifyDeleted: z.boolean(),
        cooldownMinutes: z
          .number()
          .int()
          .min(DRIFT_ALERT_LIMITS.cooldownMinutes.min)
          .max(DRIFT_ALERT_LIMITS.cooldownMinutes.max),
        minChanges: z
          .number()
          .int()
          .min(DRIFT_ALERT_LIMITS.minChanges.min)
          .max(DRIFT_ALERT_LIMITS.minChanges.max),
        accounts: z.array(z.string().min(1).max(200)).max(DRIFT_ALERT_LIMITS.maxAccountIds),
      })
      .strict()
      .optional(),
    expiry: z
      .object({
        enabled: z.boolean(),
        leadDays: z
          .number()
          .int()
          .min(EXPIRY_ALERT_LIMITS.leadDays.min)
          .max(EXPIRY_ALERT_LIMITS.leadDays.max),
      })
      .strict()
      .optional(),
    posture: z.object({ enabled: z.boolean() }).strict().optional(),
    digest: z
      .object({
        enabled: z.boolean(),
        timezone: z.string().min(1).max(100),
        sendDay: z.number().int().min(1).max(7),
        sendHour: z.number().int().min(0).max(23),
        narrativeEnabled: z.boolean(),
        recipients: z.array(z.string().min(3).max(320)).max(100),
      })
      .strict()
      .optional(),
  })
  .strict();

/* -------------------------------- document --------------------------------- */

const orgConfigDocumentSchema = z
  .object({
    // Accepted rather than required-equal so a future v2 reader can say
    // something better than "unrecognized key"; the service refuses anything
    // it does not know how to apply.
    version: z.number().int().min(1).default(ORG_CONFIG_VERSION),
    exportedAt: z.string().max(64).optional(),
    exportedFrom: z
      .object({ organizationId: z.string().max(200), organizationName: z.string().max(300) })
      .strict()
      .optional(),
    budgets: collection(budgetSchema).optional(),
    customGraphs: collection(customGraphSchema).optional(),
    workflows: collection(workflowSchema).optional(),
    dashboards: collection(dashboardSchema).optional(),
    metricAlerts: collection(metricAlertSchema).optional(),
    probes: collection(probeSchema).optional(),
    costCentres: collection(costCentreSchema).optional(),
    tagPolicy: z
      .object({
        requiredTags: z.array(requiredTagSchema).max(TAG_POLICY_LIMITS.maxRequiredTags),
        enforceOnCreate: z.boolean(),
      })
      .strict()
      .optional(),
    alertSettings: alertSettingsSchema.optional(),
  })
  .strict();

/** The document after parsing — every collection defaulted, ids resolved later. */
export type ParsedOrgConfigDocument = z.infer<typeof orgConfigDocumentSchema>;

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
 * Three checks the zod schema cannot express on its own, all of which would
 * otherwise silently do the wrong thing rather than fail: a document from a
 * newer server, duplicate keys within a section (the second would quietly
 * overwrite the first on apply), and two dashboards both claiming to be the
 * default (an org with two defaults resolves "the" default at random).
 */
export function parseOrgConfigDocument(raw: unknown): ParsedOrgConfigDocument {
  const parsed = orgConfigDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
    throw new OrgConfigError(`Invalid config document${where}: ${issue?.message ?? "unknown"}`);
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
  return parsed.data;
}

/** Which sections a document actually carries — what apply checks permissions on. */
export function orgConfigDocumentSections(doc: ParsedOrgConfigDocument): OrgConfigSection[] {
  return ORG_CONFIG_SECTIONS.filter((s) => doc[s as keyof ParsedOrgConfigDocument] !== undefined);
}

/* ------------------------------ drift guards ------------------------------- */

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/**
 * Compile-time proof the schema still parses to exactly the shared client-core
 * types. Drift is a build error rather than a document that validates here and
 * fails to type-check in the CLI.
 *
 * The tuple is *instantiated* below rather than merely declared: `Exact` widens
 * to `never` on a mismatch, and a type alias to `never` is perfectly legal — it
 * is assigning `true` to it that actually fails.
 */
type SchemaMatchesOrgConfigContract = [
  Exact<z.infer<typeof budgetSchema>, OrgConfigBudget>,
  Exact<z.infer<typeof customGraphSchema>, OrgConfigCustomGraph>,
  Exact<z.infer<typeof workflowTriggerSchema>, OrgConfigWorkflowTrigger>,
  Exact<z.infer<typeof workflowSchema>, OrgConfigWorkflow>,
  Exact<z.infer<typeof dashboardCardSchema>, OrgConfigDashboardCard>,
  Exact<z.infer<typeof dashboardSchema>, OrgConfigDashboard>,
  Exact<z.infer<typeof metricAlertSchema>, OrgConfigMetricAlert>,
  Exact<z.infer<typeof probeSchema>, OrgConfigProbe>,
  Exact<z.infer<typeof allocationRuleSchema>, OrgConfigAllocationRule>,
  Exact<z.infer<typeof costCentreSchema>, OrgConfigCostCentre>,
  Exact<z.infer<typeof orgConfigDocumentSchema>, OrgConfigDocument>,
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
];
void schemaMatchesContract;
