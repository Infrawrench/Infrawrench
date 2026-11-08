/**
 * Org config as code: `/api/org/:orgId/config/*`, the endpoint definitions.
 *
 * The document schemas here **publish** the shape so generated SDKs (and the
 * `infrawrench config` CLI's readers) can build a document without
 * reverse-engineering it. They do not validate requests:
 * `services/org-config/schema.ts` (Zod) does, with the plain-words first
 * problem the CLI prints ("Invalid config document at budgets.0.key: ..."),
 * plus the checks a schema cannot express (version, duplicate keys, two
 * defaults). So `plan` and `apply` are served with `handleRaw` and hand the
 * raw body to that validator, and the payload here is documentation.
 *
 * Every route needs `config:read` (export/plan) or `config:write` (apply) at
 * the gate, **and** the per-section permission for each section involved,
 * checked in the handler.
 */
import { Effect, Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import {
  DASHBOARD_WIDGET_KINDS,
  ORG_CONFIG_KEY_MAX_LENGTH,
  ORG_CONFIG_KEY_PATTERN,
  ORG_CONFIG_SECTIONS,
  ORG_CONFIG_VERSION,
} from "@infrawrench/client-core";
import { CostFilterOperator, CostFilterValues, maxLength, minLength, pattern } from "../schemas";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Forbidden, PaymentRequired } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { JsonObject, OrgParams } from "../http/schemas/common";

/* ------------------------------- primitives ------------------------------- */

const KEY_DESCRIPTION =
  "Stable slug identifying this entity across organizations. Derived from the name on " +
  "export; it is what an apply matches on, so renaming an entity while keeping its key " +
  "is a rename rather than a delete-and-create.";

/** A document key; `description` says what it refers to where it is a reference. */
const configKey = (description: string = KEY_DESCRIPTION) =>
  Schema.String.annotate({ description, examples: ["monthly-cloud-spend"] }).check(
    maxLength(ORG_CONFIG_KEY_MAX_LENGTH),
    pattern(ORG_CONFIG_KEY_PATTERN),
  );

const ConfigKey = configKey();

/** zod's `.default(value)`: optional on the wire, `value` when absent, documented as the default. */
const withDefault = <T, E>(schema: Schema.Codec<T, E>, value: T & E) =>
  Schema.withDecodingDefaultKey<Schema.Codec<T, E>>(Effect.succeed(value))(
    schema.annotate({ default: value }),
  );

/**
 * {@link withDefault} for a named component: the Zod spec documented no
 * default beside the `$ref`, and annotating the component would fork it.
 */
const withRefDefault = <S extends Schema.Top>(schema: S, value: S["Type"]) =>
  schema.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)));

/** zod's `.nullish()`. */
const nullish = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema));

const Int = Schema.Int;
const Num = Schema.Finite;
const Str = Schema.String;
const Bool = Schema.Boolean;

const intBetween = (minimum: number, maximum: number) =>
  Int.check(Schema.isBetween({ minimum, maximum }));

const CardSize = Schema.optionalKey(intBetween(1, 12));

const accountName = (description: string) => Str.annotate({ description });

/* -------------------------------- sections -------------------------------- */

export const OrgConfigSection = Schema.Literals(ORG_CONFIG_SECTIONS).annotate({
  identifier: "OrgConfigSection",
});

const OrgConfigCostFilter = Schema.Struct({
  dimension: Str,
  op: CostFilterOperator,
  values: CostFilterValues,
  tagKey: Schema.optionalKey(Str),
}).annotate({ identifier: "OrgConfigCostFilter" });

const OrgConfigBudget = Schema.Struct({
  key: ConfigKey,
  name: Str,
  amountCents: Int.check(Schema.isGreaterThan(0)),
  currency: withDefault(Str.check(minLength(3), maxLength(3)), "USD"),
  filters: withDefault(Schema.Array(OrgConfigCostFilter), []),
  thresholds: Schema.Array(
    Schema.Struct({
      type: Schema.Literals(["actual", "forecast"]),
      percent: intBetween(1, 1000),
    }),
  ).check(minLength(1), maxLength(10)),
}).annotate({ identifier: "OrgConfigBudget" });

const OrgConfigCustomGraph = Schema.Struct({
  key: ConfigKey,
  name: Str,
  description: nullish(Str),
  source: Str.annotate({ description: "The graph's TypeScript source." }),
}).annotate({ identifier: "OrgConfigCustomGraph" });

const OrgConfigWorkflowTrigger = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("manual") }),
  Schema.Struct({
    kind: Schema.Literal("cron"),
    expression: Str,
    timezone: Schema.optionalKey(Str),
  }),
  Schema.Struct({
    kind: Schema.Literal("git"),
    provider: Schema.optionalKey(Str),
    repo: Schema.optionalKey(Str),
    branch: Schema.optionalKey(Str),
    events: Schema.optionalKey(Schema.Array(Str)),
    installationId: Schema.optionalKey(Int),
  }),
  Schema.Struct({
    kind: Schema.Literal("budget"),
    budgetKey: configKey("`key` of an entry in this document's `budgets` (never a row id)."),
    percent: Schema.optionalKey(Num.check(Schema.isGreaterThan(0))),
    metric: Schema.optionalKey(Schema.Literals(["actual", "forecast"])),
  }),
]).annotate({
  identifier: "OrgConfigWorkflowTrigger",
  // The Zod spec stated the workflow's default on the component itself.
  default: { kind: "manual" },
});

const OrgConfigWorkflow = Schema.Struct({
  key: ConfigKey,
  name: Str,
  description: nullish(Str),
  source: Str.annotate({ description: "The workflow's TypeScript source." }),
  trigger: withRefDefault(OrgConfigWorkflowTrigger, { kind: "manual" }),
  metrics: withDefault(
    Schema.Array(
      Schema.Struct({
        key: Str,
        label: Str,
        unit: nullish(Str),
        type: Schema.optionalKey(Str),
      }),
    ),
    [],
  ),
  enabled: withDefault(Bool, true),
}).annotate({
  identifier: "OrgConfigWorkflow",
  description:
    "A workflow. The git-webhook signing secret is deliberately absent; it is write-only, " +
    "so a document can neither leak nor set one.",
});

const OrgConfigDashboardCard = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("widget"),
    widgetKind: Schema.Literals(DASHBOARD_WIDGET_KINDS),
    title: withDefault(Str, ""),
    config: withRefDefault(JsonObject, {}),
    budgetKey: Schema.optionalKey(ConfigKey),
    graphKey: Schema.optionalKey(ConfigKey),
    width: CardSize,
    height: CardSize,
  }),
  Schema.Struct({ kind: Schema.Literal("workflow"), workflowKey: ConfigKey }),
  Schema.Struct({
    kind: Schema.Literal("resource"),
    pluginId: Str,
    resourceTypeId: Str,
    externalId: Str,
    account: accountName("Display name of the owning account."),
    width: CardSize,
    height: CardSize,
  }),
]).annotate({
  identifier: "OrgConfigDashboardCard",
  description:
    "One card. Position is the index in the dashboard's `cards` array; the grid order all " +
    "three card kinds share.",
});

const OrgConfigDashboard = Schema.Struct({
  key: ConfigKey,
  name: Str,
  isDefault: withDefault(Bool, false),
  defaultForRoles: Schema.optionalKey(
    Schema.Array(Str).annotate({
      description:
        "Role names (case-insensitive) whose members land on this dashboard unless they picked " +
        "their own. Omitted leaves role defaults untouched; `[]` clears the roles defaulting " +
        "here. A role may be named by one dashboard only.",
    }),
  ),
  cards: withDefault(Schema.Array(OrgConfigDashboardCard), []),
}).annotate({ identifier: "OrgConfigDashboard" });

const Comparator = Schema.Literals([">", ">=", "<", "<="]);

const OrgConfigMetricAlert = Schema.Struct({
  key: ConfigKey,
  name: Str,
  pluginId: withDefault(Schema.NullOr(Str), null),
  resourceTypeId: withDefault(Schema.NullOr(Str), null),
  tagKey: withDefault(Schema.NullOr(Str), null),
  tagValue: withDefault(Schema.NullOr(Str), null),
  metricKey: Str,
  comparator: Comparator,
  threshold: Num,
  forMinutes: withDefault(Int, 15),
  cooldownMinutes: withDefault(Int, 60),
  enabled: withDefault(Bool, true),
}).annotate({ identifier: "OrgConfigMetricAlert" });

const OrgConfigProbe = Schema.Struct({
  key: ConfigKey,
  name: Str,
  url: Str,
  method: withDefault(Str, "GET"),
  intervalSeconds: withDefault(Int, 60),
  timeoutMs: withDefault(Int, 10_000),
  failureThreshold: withDefault(Int, 3),
  enabled: withDefault(Bool, true),
}).annotate({ identifier: "OrgConfigProbe" });

const OrgConfigSlo = Schema.Struct({
  key: ConfigKey,
  name: Str,
  description: withDefault(Schema.NullOr(Str), null),
  sliKind: Schema.Literals(["probe_availability", "probe_latency", "metric_threshold"]),
  probeKey: Schema.optionalKey(
    configKey("`probe_*`: key of a probe in this document's `probes` or the organization's."),
  ),
  latencyThresholdMs: Schema.optionalKey(intBetween(1, 60_000)),
  resource: Schema.optionalKey(
    Schema.Struct({
      pluginId: Str,
      resourceTypeId: Str,
      externalId: Str,
      account: accountName("Account display name."),
    }).annotate({
      description:
        "`metric_threshold`: the resource, resolved against the organization's inventory on apply.",
    }),
  ),
  metricKey: Schema.optionalKey(Str),
  comparator: Schema.optionalKey(Schema.Literals(["<", "<=", ">", ">="])),
  threshold: Schema.optionalKey(Num),
  targetPercent: Num.check(Schema.isBetween({ minimum: 50, maximum: 99.999 })),
  windowDays: withDefault(Schema.Literals([7, 28, 30]), 30),
  alertsEnabled: withDefault(Bool, true),
  suggestFreeze: withDefault(Bool, true),
  enabled: withDefault(Bool, true),
}).annotate({ identifier: "OrgConfigSlo" });

const OrgConfigCostCentre = Schema.Struct({
  key: ConfigKey,
  name: Str,
  description: nullish(Str),
  rules: withDefault(
    Schema.Array(
      Schema.Struct({
        priority: Int.check(Schema.isGreaterThanOrEqualTo(0)),
        match: withDefault(
          Schema.Struct({
            tagKey: Schema.optionalKey(Str),
            tagValue: Schema.optionalKey(Str),
            account: Schema.optionalKey(accountName("Account display name.")),
            pluginId: Schema.optionalKey(Str),
            service: Schema.optionalKey(Str),
          }),
          {},
        ),
      }),
    ),
    [],
  ),
}).annotate({ identifier: "OrgConfigCostCentre" });

const OrgConfigAlertSettings = Schema.Struct({
  costAnomaly: Schema.optionalKey(
    Schema.Struct({
      sigmas: Num,
      minDeltaCents: Int,
      newSourceMinCents: Int,
      smsAlerts: Schema.Literals(["off", "new_source", "all"]),
    }),
  ),
  drift: Schema.optionalKey(
    Schema.Struct({
      notifyCreated: Bool,
      notifyUpdated: Bool,
      notifyDeleted: Bool,
      cooldownMinutes: Int,
      minChanges: Int,
      accounts: Schema.Array(Str).annotate({
        description: "Account display names; empty means every account.",
      }),
    }),
  ),
  expiry: Schema.optionalKey(Schema.Struct({ enabled: Bool, leadDays: Int })),
  posture: Schema.optionalKey(Schema.Struct({ enabled: Bool })),
  idleFindings: Schema.optionalKey(
    Schema.Struct({
      enabled: Bool,
      lookbackDays: intBetween(7, 42),
      rules: Schema.Record(
        Str,
        Schema.Struct({
          enabled: Schema.optionalKey(Bool),
          thresholds: Schema.optionalKey(Schema.Record(Str, Num)),
        }),
      ).annotate({ description: "Idle rule overrides keyed by `pluginId:ruleId`." }),
    }),
  ),
  digest: Schema.optionalKey(
    Schema.Struct({
      enabled: Bool,
      timezone: Str,
      sendDay: intBetween(1, 7),
      sendHour: intBetween(0, 23),
      narrativeEnabled: Bool,
      recipients: Schema.Array(Str),
    }),
  ),
}).annotate({
  identifier: "OrgConfigAlertSettings",
  description:
    "Org-wide notification tuning. Cooldown claims (`lastNotifiedAt`, `lastSentWeekStart`) are " +
    "deliberately absent: they are poller state, and resetting one from an apply would re-open " +
    "a quiet period and page people twice.",
});

const OrgConfigSavingsView = Schema.Struct({
  key: ConfigKey,
  name: Str,
  description: Schema.NullOr(Str),
  status: Schema.Literals(["open", "ready", "in_progress", "completed", "archived", "all"]),
  filter: Schema.Struct({
    kinds: Schema.optionalKey(
      Schema.Array(Schema.Literals(["orphan", "oversized", "extended_support", "seat"])),
    ),
    pluginIds: Schema.optionalKey(Schema.Array(Str)),
    accounts: Schema.optionalKey(
      Schema.Array(Str).annotate({
        description: "Account display names; resolved to ids on apply.",
      }),
    ),
    regions: Schema.optionalKey(Schema.Array(Str)),
    tags: Schema.optionalKey(
      Schema.Array(Schema.Struct({ key: Str, values: Schema.optionalKey(Schema.Array(Str)) })),
    ),
    minMonthlySavings: Schema.optionalKey(Num.check(Schema.isGreaterThanOrEqualTo(0))),
    detectedFrom: Schema.optionalKey(Str),
    detectedTo: Schema.optionalKey(Str),
    search: Schema.optionalKey(Str),
  }),
  sort: Schema.Struct({
    field: Schema.Literals(["savings", "detected", "name", "status_changed"]),
    direction: Schema.Literals(["asc", "desc"]),
  }),
}).annotate({
  identifier: "OrgConfigSavingsView",
  description:
    "A saved view over the savings findings list. Per-object sharing is not carried; a view " +
    "an apply creates is owned by the applying user.",
});

/* -------------------------------- document -------------------------------- */

export const OrgConfigDocument = Schema.Struct({
  version: withDefault(Int.check(Schema.isGreaterThanOrEqualTo(1)), ORG_CONFIG_VERSION),
  exportedAt: Schema.optionalKey(Str),
  exportedFrom: Schema.optionalKey(Schema.Struct({ organizationId: Str, organizationName: Str })),
  budgets: Schema.optionalKey(Schema.Array(OrgConfigBudget)),
  customGraphs: Schema.optionalKey(Schema.Array(OrgConfigCustomGraph)),
  workflows: Schema.optionalKey(Schema.Array(OrgConfigWorkflow)),
  dashboards: Schema.optionalKey(Schema.Array(OrgConfigDashboard)),
  metricAlerts: Schema.optionalKey(Schema.Array(OrgConfigMetricAlert)),
  probes: Schema.optionalKey(Schema.Array(OrgConfigProbe)),
  slos: Schema.optionalKey(Schema.Array(OrgConfigSlo)),
  costCentres: Schema.optionalKey(Schema.Array(OrgConfigCostCentre)),
  tagPolicy: Schema.optionalKey(
    Schema.Struct({
      requiredTags: Schema.Array(
        Schema.Struct({ key: Str, allowedValues: Schema.optionalKey(Schema.Array(Str)) }),
      ),
      enforceOnCreate: Bool,
    }),
  ),
  alertSettings: Schema.optionalKey(OrgConfigAlertSettings),
  savingsViews: Schema.optionalKey(Schema.Array(OrgConfigSavingsView)),
}).annotate({
  identifier: "OrgConfigDocument",
  description:
    "An organization's configuration. Every section is optional; a document that omits one " +
    "leaves it entirely alone, in both apply modes.",
});

const OrgConfigChange = Schema.Struct({
  section: OrgConfigSection,
  key: Str,
  name: Str,
  action: Schema.Literals(["create", "update", "delete", "unchanged"]),
  fields: Schema.optionalKey(
    Schema.Array(Str).annotate({ description: "Fields that differ, on an update." }),
  ),
}).annotate({ identifier: "OrgConfigChange" });

const OrgConfigUnresolved = Schema.Struct({
  section: OrgConfigSection,
  key: Str,
  detail: Str,
}).annotate({
  identifier: "OrgConfigUnresolved",
  description:
    "Something the document asked for that this organization could not satisfy; a pin for a " +
    "resource nobody has synced, an account name that does not exist here. Not fatal: the " +
    "affected card, clause or deletion is dropped and the rest of the document still applies.",
});

const ApplyMode = Schema.Literals(["merge", "replace"]);

const planFields = {
  mode: ApplyMode,
  changes: Schema.Array(OrgConfigChange),
  unresolved: Schema.Array(OrgConfigUnresolved),
  counts: Schema.Struct({ create: Int, update: Int, delete: Int, unchanged: Int }),
};

export const OrgConfigPlan = Schema.Struct(planFields).annotate({ identifier: "OrgConfigPlan" });

export const OrgConfigApplyResult = Schema.Struct({ ...planFields, applied: Bool }).annotate({
  identifier: "OrgConfigApplyResult",
});

const OrgConfigRequest = Schema.Struct({
  document: OrgConfigDocument,
  mode: withDefault(
    ApplyMode.annotate({
      description:
        "`merge` creates and updates what the document names and leaves everything else alone. " +
        "`replace` additionally deletes entities the document does not name, within the sections " +
        "it carries.",
    }),
    "merge",
  ),
}).annotate({ identifier: "OrgConfigRequest" });

/* -------------------------------- endpoints ------------------------------- */

export class OrgConfigGroup extends HttpApiGroup.make("orgConfig")
  .add(
    HttpApiEndpoint.get("export", "/export", {
      params: OrgParams,
      // Read as sent: the handler splits it and names the unknown sections.
      query: {
        sections: Schema.optionalKey(
          Str.annotate({
            description: `Comma-separated subset of sections to export. Defaults to all of: ${ORG_CONFIG_SECTIONS.join(", ")}.`,
            examples: ["budgets,workflows"],
          }),
        ),
      },
      success: OrgConfigDocument,
      error: [BadRequest, Forbidden],
    })
      .annotate(RequiredPermission, "config:read")
      .annotate(OpenApi.Summary, "Export the organization's configuration as one document")
      .annotate(
        OpenApi.Description,
        "Dashboards, workflows, custom graphs, budgets, metric alerts, synthetic probes, SLOs, cost " +
          "centres, the tag policy and the org-wide alert settings, addressed by stable keys rather " +
          "than row ids so the result applies to any organization.\n\n" +
          "Credentials, accounts, resources and workflow signing secrets are never included. " +
          "Ordering is stable, so re-exporting an unchanged organization produces the same bytes; " +
          "commit it to git and the diff is the change.\n\n" +
          "Requires the read permission of every section exported; it refuses rather than silently " +
          "omitting one, because a partial document applied in `replace` mode would delete what the " +
          "exporter could not see.",
      )
      .annotate(SuccessDescription, "The configuration document"),
    HttpApiEndpoint.post("plan", "/plan", {
      params: OrgParams,
      payload: OrgConfigRequest,
      success: OrgConfigPlan,
      error: [BadRequest, Forbidden],
    })
      .annotate(RequiredPermission, "config:read")
      .annotate(OpenApi.Summary, "Preview what applying a document would do")
      .annotate(
        OpenApi.Description,
        "The dry run: validates the document, resolves its cross-references against this " +
          "organization, and returns the create/update/delete/unchanged plan without writing " +
          "anything. Read-only, so a reviewer with read access can run it on a pull request.",
      )
      .annotate(SuccessDescription, "The plan"),
    HttpApiEndpoint.post("apply", "/apply", {
      params: OrgParams,
      payload: OrgConfigRequest,
      success: OrgConfigApplyResult,
      error: [BadRequest, PaymentRequired, Forbidden],
    })
      .annotate(RequiredPermission, "config:write")
      .annotate(OpenApi.Summary, "Apply a configuration document")
      .annotate(
        OpenApi.Description,
        "Applies the document in a single transaction and returns the plan that was executed; " +
          "all or nothing, so a failure never leaves the organization halfway between two " +
          "configurations.\n\n" +
          "Requires the write permission of every section the document carries, so this cannot be " +
          "used to reach past a role that withholds one.",
      )
      .annotate(SuccessDescription, "Applied"),
  )
  .prefix("/api/org/:orgId/config")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Config as Code") {}

export class OrgConfigApi extends withApiDefaults(HttpApi.make("orgConfig").add(OrgConfigGroup)) {}
