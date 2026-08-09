import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, JsonObject } from "../common";
import type { BuildContext } from "../context";
import {
  DASHBOARD_WIDGET_KINDS,
  ORG_CONFIG_KEY_MAX_LENGTH,
  ORG_CONFIG_KEY_PATTERN,
  ORG_CONFIG_SECTIONS,
  ORG_CONFIG_VERSION,
} from "@infrawrench/client-core";

/**
 * Org config as code. The schemas here mirror
 * `web/src/services/org-config/schema.ts` — that file is what actually
 * validates a request; this one publishes the same shape so generated SDKs can
 * build a document without reverse-engineering it.
 */

const ConfigKey = z
  .string()
  .max(ORG_CONFIG_KEY_MAX_LENGTH)
  .regex(ORG_CONFIG_KEY_PATTERN)
  .openapi({
    description:
      "Stable slug identifying this entity across organizations. Derived from the name on " +
      "export; it is what an apply matches on, so renaming an entity while keeping its key " +
      "is a rename rather than a delete-and-create.",
    example: "monthly-cloud-spend",
  });

const Section = z.enum(ORG_CONFIG_SECTIONS).openapi("OrgConfigSection");

const CostFilter = strict({
  dimension: z.string(),
  op: z.enum(["in", "not_in"]),
  values: z.array(z.string()).min(1),
  tagKey: z.string().optional(),
}).openapi("OrgConfigCostFilter");

const ConfigBudget = strict({
  key: ConfigKey,
  name: z.string(),
  amountCents: z.number().int().positive(),
  currency: z.string().length(3).default("USD"),
  filters: z.array(CostFilter).default([]),
  thresholds: z
    .array(
      strict({ type: z.enum(["actual", "forecast"]), percent: z.number().int().min(1).max(1000) }),
    )
    .min(1)
    .max(10),
}).openapi("OrgConfigBudget");

const ConfigCustomGraph = strict({
  key: ConfigKey,
  name: z.string(),
  description: z.string().nullish(),
  source: z.string().openapi({ description: "The graph's TypeScript source." }),
}).openapi("OrgConfigCustomGraph");

const ConfigWorkflowTrigger = z
  .union([
    strict({ kind: z.literal("manual") }),
    strict({ kind: z.literal("cron"), expression: z.string(), timezone: z.string().optional() }),
    strict({
      kind: z.literal("git"),
      provider: z.string().optional(),
      repo: z.string().optional(),
      branch: z.string().optional(),
      events: z.array(z.string()).optional(),
      installationId: z.number().int().optional(),
    }),
    strict({
      kind: z.literal("budget"),
      budgetKey: ConfigKey.openapi({
        description: "`key` of an entry in this document's `budgets` (never a row id).",
      }),
      percent: z.number().positive().optional(),
      metric: z.enum(["actual", "forecast"]).optional(),
    }),
  ])
  .openapi("OrgConfigWorkflowTrigger");

const ConfigWorkflow = strict({
  key: ConfigKey,
  name: z.string(),
  description: z.string().nullish(),
  source: z.string().openapi({ description: "The workflow's TypeScript source." }),
  trigger: ConfigWorkflowTrigger.default({ kind: "manual" }),
  metrics: z
    .array(
      strict({
        key: z.string(),
        label: z.string(),
        unit: z.string().nullish(),
        type: z.string().optional(),
      }),
    )
    .default([]),
  enabled: z.boolean().default(true),
}).openapi("OrgConfigWorkflow", {
  description:
    "A workflow. The git-webhook signing secret is deliberately absent — it is write-only, " +
    "so a document can neither leak nor set one.",
});

const ConfigDashboardCard = z
  .union([
    strict({
      kind: z.literal("widget"),
      widgetKind: z.enum(DASHBOARD_WIDGET_KINDS),
      title: z.string().default(""),
      config: JsonObject.default({}),
      budgetKey: ConfigKey.optional(),
      graphKey: ConfigKey.optional(),
      width: z.number().int().min(1).max(12).optional(),
      height: z.number().int().min(1).max(12).optional(),
    }),
    strict({ kind: z.literal("workflow"), workflowKey: ConfigKey }),
    strict({
      kind: z.literal("resource"),
      pluginId: z.string(),
      resourceTypeId: z.string(),
      externalId: z.string(),
      account: z.string().openapi({ description: "Display name of the owning account." }),
      width: z.number().int().min(1).max(12).optional(),
      height: z.number().int().min(1).max(12).optional(),
    }),
  ])
  .openapi("OrgConfigDashboardCard", {
    description:
      "One card. Position is the index in the dashboard's `cards` array — the grid order all " +
      "three card kinds share.",
  });

const ConfigDashboard = strict({
  key: ConfigKey,
  name: z.string(),
  isDefault: z.boolean().default(false),
  cards: z.array(ConfigDashboardCard).default([]),
}).openapi("OrgConfigDashboard");

const ConfigMetricAlert = strict({
  key: ConfigKey,
  name: z.string(),
  pluginId: z.string().nullable().default(null),
  resourceTypeId: z.string().nullable().default(null),
  tagKey: z.string().nullable().default(null),
  tagValue: z.string().nullable().default(null),
  metricKey: z.string(),
  comparator: z.enum([">", ">=", "<", "<="]),
  threshold: z.number(),
  forMinutes: z.number().int().default(15),
  cooldownMinutes: z.number().int().default(60),
  enabled: z.boolean().default(true),
}).openapi("OrgConfigMetricAlert");

const ConfigProbe = strict({
  key: ConfigKey,
  name: z.string(),
  url: z.string(),
  method: z.string().default("GET"),
  intervalSeconds: z.number().int().default(60),
  timeoutMs: z.number().int().default(10_000),
  failureThreshold: z.number().int().default(3),
  enabled: z.boolean().default(true),
}).openapi("OrgConfigProbe");

const ConfigCostCentre = strict({
  key: ConfigKey,
  name: z.string(),
  description: z.string().nullish(),
  rules: z
    .array(
      strict({
        priority: z.number().int().min(0),
        match: strict({
          tagKey: z.string().optional(),
          tagValue: z.string().optional(),
          account: z.string().optional().openapi({ description: "Account display name." }),
          pluginId: z.string().optional(),
          service: z.string().optional(),
        }).default({}),
      }),
    )
    .default([]),
}).openapi("OrgConfigCostCentre");

const ConfigAlertSettings = strict({
  costAnomaly: strict({
    sigmas: z.number(),
    minDeltaCents: z.number().int(),
    newSourceMinCents: z.number().int(),
    smsAlerts: z.enum(["off", "new_source", "all"]),
  }).optional(),
  drift: strict({
    notifyCreated: z.boolean(),
    notifyUpdated: z.boolean(),
    notifyDeleted: z.boolean(),
    cooldownMinutes: z.number().int(),
    minChanges: z.number().int(),
    accounts: z
      .array(z.string())
      .openapi({ description: "Account display names; empty means every account." }),
  }).optional(),
  expiry: strict({ enabled: z.boolean(), leadDays: z.number().int() }).optional(),
  posture: strict({ enabled: z.boolean() }).optional(),
  digest: strict({
    enabled: z.boolean(),
    timezone: z.string(),
    sendDay: z.number().int().min(1).max(7),
    sendHour: z.number().int().min(0).max(23),
    narrativeEnabled: z.boolean(),
    recipients: z.array(z.string()),
  }).optional(),
}).openapi("OrgConfigAlertSettings", {
  description:
    "Org-wide notification tuning. Cooldown claims (`lastNotifiedAt`, `lastSentWeekStart`) are " +
    "deliberately absent: they are poller state, and resetting one from an apply would re-open " +
    "a quiet period and page people twice.",
});

const ConfigDocument = strict({
  version: z.number().int().min(1).default(ORG_CONFIG_VERSION),
  exportedAt: z.string().optional(),
  exportedFrom: strict({ organizationId: z.string(), organizationName: z.string() }).optional(),
  budgets: z.array(ConfigBudget).optional(),
  customGraphs: z.array(ConfigCustomGraph).optional(),
  workflows: z.array(ConfigWorkflow).optional(),
  dashboards: z.array(ConfigDashboard).optional(),
  metricAlerts: z.array(ConfigMetricAlert).optional(),
  probes: z.array(ConfigProbe).optional(),
  costCentres: z.array(ConfigCostCentre).optional(),
  tagPolicy: strict({
    requiredTags: z.array(
      strict({ key: z.string(), allowedValues: z.array(z.string()).optional() }),
    ),
    enforceOnCreate: z.boolean(),
  }).optional(),
  alertSettings: ConfigAlertSettings.optional(),
}).openapi("OrgConfigDocument", {
  description:
    "An organization's configuration. Every section is optional — a document that omits one " +
    "leaves it entirely alone, in both apply modes.",
});

const ConfigChange = strict({
  section: Section,
  key: z.string(),
  name: z.string(),
  action: z.enum(["create", "update", "delete", "unchanged"]),
  fields: z
    .array(z.string())
    .optional()
    .openapi({ description: "Fields that differ, on an update." }),
}).openapi("OrgConfigChange");

const ConfigUnresolved = strict({
  section: Section,
  key: z.string(),
  detail: z.string(),
}).openapi("OrgConfigUnresolved", {
  description:
    "Something the document asked for that this organization could not satisfy — a pin for a " +
    "resource nobody has synced, an account name that does not exist here. Not fatal: the " +
    "affected card, clause or deletion is dropped and the rest of the document still applies.",
});

const ConfigPlan = strict({
  mode: z.enum(["merge", "replace"]),
  changes: z.array(ConfigChange),
  unresolved: z.array(ConfigUnresolved),
  counts: strict({
    create: z.number().int(),
    update: z.number().int(),
    delete: z.number().int(),
    unchanged: z.number().int(),
  }),
}).openapi("OrgConfigPlan");

const ConfigApplyResult = ConfigPlan.extend({
  applied: z.boolean(),
}).openapi("OrgConfigApplyResult");

const ConfigRequest = strict({
  document: ConfigDocument,
  mode: z
    .enum(["merge", "replace"])
    .default("merge")
    .openapi({
      description:
        "`merge` creates and updates what the document names and leaves everything else alone. " +
        "`replace` additionally deletes entities the document does not name, within the sections " +
        "it carries.",
    }),
}).openapi("OrgConfigRequest");

const ExportQuery = strict({
  sections: z
    .string()
    .optional()
    .openapi({
      description: `Comma-separated subset of sections to export. Defaults to all of: ${ORG_CONFIG_SECTIONS.join(", ")}.`,
      example: "budgets,workflows",
    }),
});

export function registerOrgConfigPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/config/export",
    tags: ["Config as Code"],
    summary: "Export the organization's configuration as one document",
    description:
      "Dashboards, workflows, custom graphs, budgets, metric alerts, synthetic probes, cost " +
      "centres, the tag policy and the org-wide alert settings, addressed by stable keys rather " +
      "than row ids so the result applies to any organization.\n\n" +
      "Credentials, accounts, resources and workflow signing secrets are never included. " +
      "Ordering is stable, so re-exporting an unchanged organization produces the same bytes — " +
      "commit it to git and the diff is the change.\n\n" +
      "Requires the read permission of every section exported; it refuses rather than silently " +
      "omitting one, because a partial document applied in `replace` mode would delete what the " +
      "exporter could not see.",
    request: { params: OrgIdParam, query: ExportQuery },
    responses: {
      200: {
        description: "The configuration document",
        content: { "application/json": { schema: ConfigDocument } },
      },
      400: ErrorResponses[400],
      403: ErrorResponses[403],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/config/plan",
    tags: ["Config as Code"],
    summary: "Preview what applying a document would do",
    description:
      "The dry run: validates the document, resolves its cross-references against this " +
      "organization, and returns the create/update/delete/unchanged plan without writing " +
      "anything. Read-only, so a reviewer with read access can run it on a pull request.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: ConfigRequest } }, required: true },
    },
    responses: {
      200: { description: "The plan", content: { "application/json": { schema: ConfigPlan } } },
      400: ErrorResponses[400],
      403: ErrorResponses[403],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/config/apply",
    tags: ["Config as Code"],
    summary: "Apply a configuration document",
    description:
      "Applies the document in a single transaction and returns the plan that was executed — " +
      "all or nothing, so a failure never leaves the organization halfway between two " +
      "configurations.\n\n" +
      "Requires the write permission of every section the document carries, so this cannot be " +
      "used to reach past a role that withholds one.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: ConfigRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Applied",
        content: { "application/json": { schema: ConfigApplyResult } },
      },
      400: ErrorResponses[400],
      402: ErrorResponses[402],
      403: ErrorResponses[403],
    },
  });
}
