import type {
  ActionNode,
  CreateFieldConfig,
  DetailViewSchema,
  KVItem,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
  TableRow,
} from "@infrawrench/plugin-base";
import { joinSubtitle } from "@infrawrench/plugin-base";
import { parseAlerts, parseRuleSpec } from "./mappers.js";
import { EVICTION_OPTIONS, PERSISTENCE_OPTIONS, T } from "./resource-types.js";

/**
 * Keys under `resolvedOutputs` that `enrichDetail` fills with JSON for the
 * synchronous renderer: picker options and side tables that need an API call.
 * Every renderer copes with their absence (the rendering contract tests and a
 * failed enrichment both hit that path).
 */
export const ENRICH = {
  versions: "__versions",
  backup: "__backup",
  tags: "__tags",
  plans: "__plans",
  supportedAlerts: "__supportedAlerts",
  maintenance: "__maintenance",
  cidr: "__cidr",
  invitations: "__invitations",
  pricing: "__pricing",
  psc: "__psc",
  paymentMethods: "__paymentMethods",
  tasks: "__tasks",
  users: "__users",
  ruleOptions: "__ruleOptions",
  databaseOptions: "__databaseOptions",
  roleOptions: "__roleOptions",
  creationScript: "__creationScript",
  deletionScript: "__deletionScript",
  upgrade: "__upgrade",
} as const;

function enriched<T>(resource: ResourceInstance, key: string): T | undefined {
  const raw = resource.resolvedOutputs[key];
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function str(resource: ResourceInstance, key: string): string {
  const v = resource.fields[key];
  return v === undefined || v === null ? "" : String(v);
}

function numField(resource: ResourceInstance, key: string): number | undefined {
  const v = resource.fields[key];
  const n = typeof v === "number" ? v : Number(v);
  return v === undefined || v === "" || !Number.isFinite(n) ? undefined : n;
}

export function statusOf(raw: string): ResourceStatus {
  const s = raw.toLowerCase();
  if (!s) return "unknown";
  if (["active", "available", "accepted", "connected", "processing-completed"].includes(s)) {
    return "healthy";
  }
  if (/pending|draft|creating|initiating|in-progress|provisioning|import/.test(s)) {
    return "provisioning";
  }
  if (/error|failed|rejected|inactive/.test(s)) return "error";
  if (/deleting|delete/.test(s)) return "degraded";
  return "info";
}

function kv(items: Array<[string, string | number | boolean | undefined]>): SchemaNode {
  const out: KVItem[] = [];
  for (const [key, value] of items) {
    if (value === undefined || value === "") continue;
    out.push({
      key,
      value: typeof value === "boolean" ? (value ? "Yes" : "No") : String(value),
    });
  }
  return { kind: "key-value-list", items: out };
}

function section(title: string, children: SchemaNode[]): SectionNode {
  return { kind: "section", title, children };
}

function action(
  label: string,
  a: ActionNode["action"],
  variant?: ActionNode["variant"],
): ActionNode {
  return { kind: "action", label, action: a, ...(variant ? { variant } : {}) };
}

const CONSOLE = "https://cloud.redis.io";

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/** Alert types per plan, with the ranges Redis Cloud documents for each. */
const ALERTS: Array<{
  name: string;
  label: string;
  min: number;
  max: number;
  def: number;
  plans: Array<"Pro" | "Essentials">;
  unit: string;
}> = [
  {
    name: "dataset-size",
    label: "Dataset size reached (% of limit)",
    min: 1,
    max: 100,
    def: 80,
    plans: ["Pro"],
    unit: "%",
  },
  {
    name: "datasets-size",
    label: "Total plan datasets reached (% of plan)",
    min: 1,
    max: 100,
    def: 80,
    plans: ["Essentials"],
    unit: "%",
  },
  {
    name: "throughput-higher-than",
    label: "Throughput higher than (ops/sec)",
    min: 1,
    max: 10_000_000,
    def: 1000,
    plans: ["Pro", "Essentials"],
    unit: "ops/sec",
  },
  {
    name: "throughput-lower-than",
    label: "Throughput lower than (ops/sec)",
    min: 1,
    max: 10_000_000,
    def: 10,
    plans: ["Pro", "Essentials"],
    unit: "ops/sec",
  },
  {
    name: "latency",
    label: "Latency higher than (ms)",
    min: 1,
    max: 10_000,
    def: 10,
    plans: ["Pro", "Essentials"],
    unit: "ms",
  },
  {
    name: "connections-limit",
    label: "Connections reached (% of plan limit)",
    min: 1,
    max: 100,
    def: 80,
    plans: ["Essentials"],
    unit: "%",
  },
  {
    name: "syncsource-error",
    label: "Replica Of unable to sync (seconds)",
    min: 0,
    max: 1,
    def: 1,
    plans: ["Pro"],
    unit: "s",
  },
  {
    name: "syncsource-lag",
    label: "Replica Of sync lag higher than (seconds)",
    min: 1,
    max: 86_400,
    def: 600,
    plans: ["Pro"],
    unit: "s",
  },
];

export function alertDefinition(name: string) {
  return ALERTS.find((a) => a.name === name);
}

/** Alert types this database can use: its plan's list, narrowed by the Essentials plan's own. */
function alertsFor(resource: ResourceInstance) {
  const plan = str(resource, "plan") === "Essentials" ? "Essentials" : "Pro";
  const supported = enriched<string[]>(resource, ENRICH.supportedAlerts);
  return ALERTS.filter((a) => a.plans.includes(plan) && (!supported || supported.includes(a.name)));
}

/**
 * Suggested dataset size for a database that is mostly empty: room for the
 * current data at no more than 50% utilisation, in 0.1 GB steps, never under
 * Redis Cloud's 0.1 GB floor. Null when the database is not oversized.
 */
export function rightsizeSuggestion(
  usedMb: number | undefined,
  datasetGb: number | undefined,
): { suggestedGb: number; usedPct: number } | null {
  if (usedMb === undefined || !datasetGb) return null;
  const usedPct = (usedMb / (datasetGb * 1024)) * 100;
  if (usedPct >= 25 || datasetGb <= 0.5) return null;
  const suggested = Math.max(0.1, Math.ceil((usedMb / 1024) * 2 * 10) / 10);
  if (suggested >= datasetGb) return null;
  return { suggestedGb: suggested, usedPct: Math.round(usedPct * 10) / 10 };
}

/**
 * Smallest dataset size a resize may set: the data stored plus 10% headroom,
 * in Redis Cloud's 0.1 GB steps, never under its 0.1 GB floor. The inner
 * rounding stops float residue (4 × 1.1 = 4.4000000000000004) from bumping
 * the answer a whole step.
 */
export function minDatasetGb(usedMb: number): number {
  const tenths = Math.round((usedMb / 1024) * 1.1 * 10 * 1e6) / 1e6;
  return Math.max(0.1, Math.ceil(tenths) / 10);
}

function resizeAction(resource: ResourceInstance): ActionNode | null {
  const usedMb = numField(resource, "memoryUsedMb");
  const minGb = minDatasetGb(usedMb ?? 0);
  if (str(resource, "plan") === "Essentials") {
    const plans = enriched<Array<{ id: string; label: string; description?: string }>>(
      resource,
      ENRICH.plans,
    );
    return action("Change plan size", {
      type: "prompt-nosql-command",
      command: "change-plan",
      title: "Change Essentials plan",
      description:
        "Essentials memory is set by the subscription's plan. Only plans compatible with this subscription are listed; plans smaller than the data already stored are refused.",
      ...(plans && plans.length ? {} : { blocked: true, descriptionVariant: "error" as const }),
      fields: [
        {
          key: "planId",
          label: "Plan",
          kind: "select",
          required: true,
          options: plans ?? [],
        },
      ],
      submitLabel: "Change plan",
    });
  }
  const suggestion = rightsizeSuggestion(usedMb, numField(resource, "datasetSizeGb"));
  return action("Resize memory", {
    type: "prompt-nosql-command",
    command: "resize-memory",
    title: "Resize memory",
    description: `Sets the dataset size, the most data the database may hold (replication doubles the memory billed). Currently using ${usedMb ?? "?"} MB. The smallest size accepted here is ${minGb} GB, the data stored plus 10% headroom.`,
    fields: [
      {
        key: "datasetSizeInGb",
        label: "Dataset size (GB)",
        kind: "number",
        required: true,
        minValue: minGb,
        stepValue: 0.1,
        defaultValue: String(
          suggestion?.suggestedGb ?? numField(resource, "datasetSizeGb") ?? minGb,
        ),
      },
      {
        key: "dryRun",
        label: "Validate only (dry run)",
        kind: "select",
        required: false,
        options: [
          { id: "false", label: "Apply the change" },
          { id: "true", label: "Only check the plan, change nothing" },
        ],
        defaultValue: "false",
      },
    ],
    submitLabel: "Resize",
  });
}

function alertsAction(resource: ResourceInstance): ActionNode {
  const current = parseAlerts(resource.fields["alerts"]);
  const fields: CreateFieldConfig[] = alertsFor(resource).map((a) => ({
    key: a.name,
    label: a.label,
    kind: "number",
    required: false,
    minValue: a.min,
    maxValue: a.max,
    placeholder: `Off (default when on: ${a.def})`,
    ...(current[a.name] !== undefined ? { defaultValue: String(current[a.name]) } : {}),
  }));
  return action("Alerts", {
    type: "prompt-nosql-command",
    command: "set-alerts",
    title: "Database alerts",
    description:
      "Redis Cloud emails the account team when a threshold is crossed. Leave a field empty to turn that alert off.",
    fields,
    submitLabel: "Save alerts",
  });
}

function importAction(): ActionNode {
  return action(
    "Import data",
    {
      type: "prompt-nosql-command",
      command: "import",
      title: "Import data",
      description:
        "Loads RDB files or another Redis database into this one. Existing data is overwritten.",
      descriptionVariant: "error",
      danger: true,
      fields: [
        {
          key: "sourceType",
          label: "Source",
          kind: "select",
          required: true,
          options: [
            { id: "redis", label: "Another Redis database" },
            { id: "aws-s3", label: "Amazon S3" },
            { id: "google-blob-storage", label: "Google Cloud Storage" },
            { id: "azure-blob-storage", label: "Azure Blob Storage" },
            { id: "http", label: "HTTP(S) URL" },
            { id: "ftp", label: "FTP" },
          ],
          defaultValue: "aws-s3",
        },
        {
          key: "importFromUri",
          label: "Source URIs",
          kind: "string-list",
          required: true,
          description:
            "One per row: s3://bucket/path/dump.rdb, gs://bucket/dump.rdb, redis://user:password@host:port, …",
        },
      ],
      submitLabel: "Import",
    },
    "danger",
  );
}

function backupAction(resource: ResourceInstance): ActionNode {
  return action("Back up now", {
    type: "prompt-nosql-command",
    command: "backup",
    title: "Back up now",
    description: str(resource, "backupEnabled")
      ? "Runs a backup to the configured remote location. Give a path to back up somewhere else once."
      : "This database has no backup location configured, so a path is required.",
    fields: [
      {
        key: "adhocBackupPath",
        label: "Backup path (optional)",
        kind: "text",
        required: str(resource, "backupEnabled") !== "true",
        placeholder: "s3://bucket/redis-backups",
      },
    ],
    submitLabel: "Back up",
  });
}

function upgradeAction(resource: ResourceInstance): ActionNode | null {
  const versions = enriched<string[]>(resource, ENRICH.versions);
  if (!versions || versions.length === 0) return null;
  return action("Upgrade Redis version", {
    type: "prompt-nosql-command",
    command: "upgrade-version",
    title: "Upgrade Redis version",
    description: `Currently ${str(resource, "redisVersion") || "unknown"}. Upgrades cannot be rolled back.`,
    fields: [
      {
        key: "targetRedisVersion",
        label: "Target version",
        kind: "select",
        required: true,
        options: versions.map((v) => ({ id: v, label: v })),
      },
    ],
    submitLabel: "Upgrade",
  });
}

function tagsAction(resource: ResourceInstance): ActionNode {
  const tags = enriched<Array<{ key?: string; value?: string }>>(resource, ENRICH.tags) ?? [];
  return action("Tags", {
    type: "prompt-nosql-command",
    command: "set-tags",
    title: "Database tags",
    description:
      "Tags appear on the database's rows in the Redis Cloud cost report, so they become cost allocation keys here too. Keys and values must be lowercase.",
    fields: [
      {
        key: "tags",
        label: "Tags",
        kind: "string-list",
        required: false,
        placeholder: "team=payments",
        defaultValue: tags
          .filter((t) => t.key)
          .map((t) => `${t.key}=${t.value ?? ""}`)
          .join(","),
      },
    ],
    submitLabel: "Save tags",
  });
}

function renderDatabase(resource: ResourceInstance): DetailViewSchema {
  const plan = str(resource, "plan");
  const usedMb = numField(resource, "memoryUsedMb");
  const datasetGb = numField(resource, "datasetSizeGb");
  const suggestion = plan === "Pro" ? rightsizeSuggestion(usedMb, datasetGb) : null;
  const alerts = parseAlerts(resource.fields["alerts"]);
  const backup = enriched<{ status?: string; description?: string }>(resource, ENRICH.backup);
  const upgrade = enriched<{
    upgradeStatus?: string;
    targetRedisVersion?: string;
    progress?: number;
  }>(resource, ENRICH.upgrade);
  const sections: SectionNode[] = [
    section("Database", [
      kv([
        ["Plan", plan],
        ["Subscription", str(resource, "subscriptionName") || str(resource, "subscriptionId")],
        ["Status", str(resource, "status")],
        ["Cloud", str(resource, "provider")],
        ["Region", str(resource, "region")],
        ["Protocol", str(resource, "protocol")],
        ["Redis version", str(resource, "redisVersion")],
        ["RESP", str(resource, "respVersion")],
        ["Capabilities", str(resource, "modules")],
      ]),
    ]),
    section("Capacity", [
      kv([
        ["Dataset size", datasetGb !== undefined ? `${datasetGb} GB` : undefined],
        [
          "Memory limit",
          numField(resource, "memoryLimitGb") !== undefined
            ? `${numField(resource, "memoryLimitGb")} GB`
            : undefined,
        ],
        ["Memory used", usedMb !== undefined ? `${usedMb} MB` : undefined],
        [
          "Used of dataset limit",
          numField(resource, "memoryUsedPct") !== undefined
            ? `${numField(resource, "memoryUsedPct")}%`
            : undefined,
        ],
        ["Throughput", str(resource, "throughput")],
        ["Shards", numField(resource, "shards")],
        ["Replication", resource.fields["replication"] as boolean | undefined],
        ["Persistence", str(resource, "dataPersistence")],
        ["Eviction policy", str(resource, "dataEvictionPolicy")],
      ]),
    ]),
    section("Connectivity", [
      kv([
        ["Public endpoint", str(resource, "publicEndpoint")],
        ["Private endpoint", str(resource, "privateEndpoint")],
        ["TLS required", resource.fields["enableTls"] as boolean | undefined],
        ["Default user", resource.fields["defaultUserEnabled"] as boolean | undefined],
        ["Allowed source IPs", str(resource, "sourceIps")],
      ]),
    ]),
    section("Alerts and backup", [
      kv([
        ...Object.entries(alerts).map(([name, value]): [string, string] => {
          const def = alertDefinition(name);
          return [def?.label ?? name, `${value}${def ? ` ${def.unit}` : ""}`];
        }),
        ["Remote backup", resource.fields["backupEnabled"] as boolean | undefined],
        ["Backup interval", str(resource, "backupInterval")],
        ["Last backup request", backup?.status],
        [
          "Version upgrade",
          upgrade?.upgradeStatus
            ? `${upgrade.upgradeStatus}${upgrade.targetRedisVersion ? ` to ${upgrade.targetRedisVersion}` : ""}`
            : undefined,
        ],
      ]),
    ]),
  ];
  if (suggestion) {
    sections.splice(
      2,
      0,
      section("Right-sizing", [
        {
          kind: "text",
          variant: "body",
          content: `Only ${suggestion.usedPct}% of the ${datasetGb} GB dataset limit is in use. A ${suggestion.suggestedGb} GB limit would still leave the data under half full; Resize memory is prefilled with it.`,
        },
      ]),
    );
  }
  if (str(resource, "savingsFlag") === "empty") {
    sections.unshift(
      section("Possibly unused", [
        {
          kind: "text",
          variant: "body",
          content:
            "This paid database holds less than 5 MB. If nothing connects to it, deleting it stops its charges; it also appears under Potential savings.",
        },
      ]),
    );
  }
  const tags = enriched<Array<{ key?: string; value?: string }>>(resource, ENRICH.tags);
  if (tags && tags.length) {
    sections.push(
      section("Tags", [
        kv(tags.filter((t) => t.key).map((t): [string, string] => [t.key!, t.value ?? ""])),
      ]),
    );
  }
  const headerActions: ActionNode[] = [action("Refresh", { type: "refresh-resource" })];
  const resize = resizeAction(resource);
  if (resize) headerActions.push(resize);
  headerActions.push(alertsAction(resource), backupAction(resource), tagsAction(resource));
  const upgradeA = upgradeAction(resource);
  if (upgradeA) headerActions.push(upgradeA);
  headerActions.push(importAction());
  if (plan === "Pro") {
    headerActions.push(
      action(
        "Flush",
        {
          type: "plugin-action",
          actionId: "flush",
          confirmMessage: "Delete every key in this database? This cannot be undone.",
          successMessage: "Flush requested.",
          destructive: true,
        },
        "danger",
      ),
    );
  }
  const subId = str(resource, "subscriptionId");
  headerActions.push(
    action("Open in Redis Cloud", {
      type: "open-url",
      url:
        plan === "Essentials"
          ? `${CONSOLE}/#/databases`
          : `${CONSOLE}/#/subscriptions/subscription/${subId}/bdbs/${resource.externalId ?? ""}`,
    }),
  );
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(`${plan} database`, str(resource, "provider"), str(resource, "region")),
    status: {
      kind: "status-dot",
      status: statusOf(str(resource, "status")),
      label: str(resource, "status"),
    },
    sections,
    headerActions,
    logs: { defaultTailLines: 100 },
  };
}

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

function renderSubscription(resource: ResourceInstance): DetailViewSchema {
  const plan = str(resource, "plan");
  const currency = str(resource, "priceCurrency") || "USD";
  const price = numField(resource, "monthlyPrice");
  const sections: SectionNode[] = [
    section("Subscription", [
      kv([
        ["Plan", plan === "Essentials" ? `Essentials · ${str(resource, "planName")}` : plan],
        ["Status", str(resource, "status")],
        ["Cloud", str(resource, "provider")],
        ["Region", str(resource, "region")],
        ["Deployment", str(resource, "deploymentType")],
        ["Memory storage", str(resource, "memoryStorage")],
        ["Databases", numField(resource, "numberOfDatabases")],
        [
          "Shards",
          numField(resource, "shards") !== undefined
            ? `${numField(resource, "shards")}${str(resource, "shardType") ? ` (${str(resource, "shardType")})` : ""}`
            : undefined,
        ],
        [
          "Plan size",
          numField(resource, "planSizeGb") !== undefined
            ? `${numField(resource, "planSizeGb")} GB`
            : undefined,
        ],
        ["List price", price !== undefined ? `${price.toFixed(2)} ${currency} / month` : undefined],
        ["Payment method", str(resource, "paymentMethodType")],
        ["Public endpoint access", resource.fields["publicEndpointAccess"] as boolean | undefined],
        ["Multi-AZ", resource.fields["multiAz"] as boolean | undefined],
        ["Deployment CIDR", str(resource, "deploymentCidr")],
        ["Cloud account", str(resource, "cloudAccountId")],
      ]),
    ]),
  ];
  const pricing = enriched<
    Array<{
      type?: string;
      typeDetails?: string;
      quantity?: number;
      quantityMeasurement?: string;
      pricePerUnit?: number;
      priceCurrency?: string;
      pricePeriod?: string;
    }>
  >(resource, ENRICH.pricing);
  if (pricing && pricing.length) {
    sections.push(
      section("Pricing", [
        {
          kind: "table",
          columns: [
            { key: "item", label: "Item" },
            { key: "qty", label: "Quantity", width: "narrow" },
            { key: "price", label: "Unit price" },
          ],
          rows: pricing.map((p) => ({
            cells: {
              item: joinSubtitle(p.type, p.typeDetails),
              qty: `${p.quantity ?? ""} ${p.quantityMeasurement ?? ""}`.trim(),
              price:
                p.pricePerUnit !== undefined
                  ? `${p.pricePerUnit} ${p.priceCurrency ?? ""} / ${p.pricePeriod ?? ""}`.trim()
                  : "",
            },
          })),
        },
      ]),
    );
  }
  const maintenance = enriched<{
    mode?: string;
    timeZone?: string;
    windows?: Array<{ startHour?: number; durationInHours?: number; days?: string[] }>;
  }>(resource, ENRICH.maintenance);
  if (maintenance) {
    sections.push(
      section("Maintenance windows", [
        kv([
          ["Mode", maintenance.mode],
          ["Time zone", maintenance.timeZone],
          ...(maintenance.windows ?? []).map((w, i): [string, string] => [
            `Window ${i + 1}`,
            `${(w.days ?? []).join(", ")} from ${w.startHour ?? "?"}:00 for ${w.durationInHours ?? "?"}h`,
          ]),
        ]),
      ]),
    );
  }
  const cidr = enriched<{ cidr_ips?: string[]; security_group_ids?: string[] }>(
    resource,
    ENRICH.cidr,
  );
  if (cidr && ((cidr.cidr_ips ?? []).length || (cidr.security_group_ids ?? []).length)) {
    sections.push(
      section("CIDR allow list", [
        kv([
          ["CIDRs", (cidr.cidr_ips ?? []).join(", ")],
          ["Security groups", (cidr.security_group_ids ?? []).join(", ")],
        ]),
      ]),
    );
  }
  const invitations = enriched<
    Array<{
      id?: number;
      name?: string;
      awsAccountId?: string;
      status?: string;
      sharedDate?: string;
    }>
  >(resource, ENRICH.invitations);
  if (invitations && invitations.length) {
    const rows: TableRow[] = invitations.map((inv) => ({
      cells: {
        name: inv.name ?? String(inv.id ?? ""),
        account: inv.awsAccountId ?? "",
        status: inv.status ?? "",
        shared: inv.sharedDate ?? "",
        accept: action("Accept", {
          type: "plugin-action",
          actionId: `tgw-accept:${inv.id}`,
          successMessage: "Invitation accepted.",
        }),
        reject: action(
          "Reject",
          {
            type: "plugin-action",
            actionId: `tgw-reject:${inv.id}`,
            confirmMessage: "Reject this resource share?",
            successMessage: "Invitation rejected.",
          },
          "danger",
        ),
      },
    }));
    sections.push(
      section("Transit Gateway invitations", [
        {
          kind: "table",
          columns: [
            { key: "name", label: "Resource share" },
            { key: "account", label: "AWS account", mono: true },
            { key: "status", label: "Status", width: "narrow" },
            { key: "shared", label: "Shared" },
            { key: "accept", label: "", width: "narrow" },
            { key: "reject", label: "", width: "narrow" },
          ],
          rows,
        },
      ]),
    );
  }
  const psc = enriched<{
    id?: number;
    status?: string;
    connectionHostName?: string;
    serviceAttachmentName?: string;
  }>(resource, ENRICH.psc);
  if (psc) {
    sections.push(
      section("Private Service Connect", [
        kv([
          ["Service", psc.id],
          ["Status", psc.status],
          ["Connection host", psc.connectionHostName],
          ["Service attachment", psc.serviceAttachmentName],
        ]),
      ]),
    );
  }

  const headerActions: ActionNode[] = [action("Refresh", { type: "refresh-resource" })];
  if (plan === "Essentials") {
    const plans = enriched<Array<{ id: string; label: string; description?: string }>>(
      resource,
      ENRICH.plans,
    );
    headerActions.push(
      action("Change plan", {
        type: "prompt-nosql-command",
        command: "change-plan",
        title: "Change Essentials plan",
        description: "Only plans compatible with this subscription's cloud and region are listed.",
        ...(plans && plans.length ? {} : { blocked: true, descriptionVariant: "error" as const }),
        fields: [
          {
            key: "planId",
            label: "Plan",
            kind: "select",
            required: true,
            options: plans ?? [],
            ...(str(resource, "planId") ? { defaultValue: str(resource, "planId") } : {}),
          },
        ],
        submitLabel: "Change plan",
      }),
    );
  } else {
    headerActions.push(
      action("Maintenance windows", {
        type: "prompt-nosql-command",
        command: "set-maintenance",
        title: "Maintenance windows",
        description:
          "Automatic lets Redis Cloud pick the time. Manual restricts maintenance to the window below, in the deployment region's local time (4 to 24 hours long).",
        fields: [
          {
            key: "mode",
            label: "Mode",
            kind: "select",
            required: true,
            options: [
              { id: "automatic", label: "Automatic" },
              { id: "manual", label: "Manual" },
            ],
            defaultValue: maintenance?.mode ?? "automatic",
          },
          {
            key: "days",
            label: "Days",
            kind: "policy-picker",
            required: false,
            policies: [
              "Monday",
              "Tuesday",
              "Wednesday",
              "Thursday",
              "Friday",
              "Saturday",
              "Sunday",
            ].map((d) => ({ id: d, label: d })),
            showWhen: { fieldKey: "mode", fieldValue: "manual" },
          },
          {
            key: "startHour",
            label: "Start hour",
            kind: "number",
            required: false,
            minValue: 0,
            maxValue: 23,
            defaultValue: String(maintenance?.windows?.[0]?.startHour ?? 2),
            showWhen: { fieldKey: "mode", fieldValue: "manual" },
          },
          {
            key: "durationInHours",
            label: "Duration (hours)",
            kind: "number",
            required: false,
            minValue: 4,
            maxValue: 24,
            defaultValue: String(maintenance?.windows?.[0]?.durationInHours ?? 4),
            showWhen: { fieldKey: "mode", fieldValue: "manual" },
          },
        ],
        submitLabel: "Save",
      }),
      action("CIDR allow list", {
        type: "prompt-nosql-command",
        command: "set-cidr",
        title: "CIDR allow list",
        description:
          "For subscriptions deployed in your own cloud account: the address ranges and security groups allowed to reach the databases.",
        fields: [
          {
            key: "cidrIps",
            label: "CIDRs",
            kind: "string-list",
            required: false,
            placeholder: "10.1.1.0/24",
            defaultValue: (cidr?.cidr_ips ?? []).join(","),
          },
          {
            key: "securityGroupIds",
            label: "AWS security groups",
            kind: "string-list",
            required: false,
            placeholder: "sg-0123456789abcdef0",
            defaultValue: (cidr?.security_group_ids ?? []).join(","),
          },
        ],
        submitLabel: "Save",
      }),
    );
    if (/gcp/i.test(str(resource, "provider")) && !psc) {
      headerActions.push(
        action("Set up Private Service Connect", {
          type: "plugin-action",
          actionId: "psc-setup",
          confirmMessage: "Create a Private Service Connect service for this subscription?",
          successMessage: "Private Service Connect setup requested.",
        }),
      );
    }
  }
  headerActions.push(
    action("Open in Redis Cloud", {
      type: "open-url",
      url:
        plan === "Essentials"
          ? `${CONSOLE}/#/subscriptions`
          : `${CONSOLE}/#/subscriptions/subscription/${(resource.externalId ?? "").replace(/^pro-/, "")}`,
    }),
  );
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(
      `${plan} subscription`,
      str(resource, "provider"),
      str(resource, "region"),
    ),
    status: {
      kind: "status-dot",
      status: statusOf(str(resource, "status")),
      label: str(resource, "status"),
    },
    sections,
    childTables: [
      {
        title: "Databases",
        typeId: T.database,
        columns: [
          { key: "name", label: "Name", source: { kind: "display-name" } },
          {
            key: "status",
            label: "Status",
            source: { kind: "field", fieldKey: "status" },
            width: "narrow",
          },
          {
            key: "dataset",
            label: "Dataset (GB)",
            source: { kind: "field", fieldKey: "datasetSizeGb" },
            width: "narrow",
          },
          {
            key: "used",
            label: "Used (MB)",
            source: { kind: "field", fieldKey: "memoryUsedMb" },
            width: "narrow",
          },
          {
            key: "endpoint",
            label: "Public endpoint",
            source: { kind: "field", fieldKey: "publicEndpoint" },
            format: "mono",
          },
        ],
        emptyText: "No databases in this subscription.",
        createLabel: "Create database",
      },
    ],
    headerActions,
  };
}

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

function renderPeering(resource: ResourceInstance): DetailViewSchema {
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("VPC peering", str(resource, "provider"), str(resource, "region")),
    status: {
      kind: "status-dot",
      status: statusOf(str(resource, "status")),
      label: str(resource, "status"),
    },
    sections: [
      section("Peering", [
        kv([
          ["Status", str(resource, "status")],
          ["Subscription", str(resource, "subscriptionId")],
          ["AWS account", str(resource, "awsAccountId")],
          ["VPC", str(resource, "vpcId")],
          ["VPC CIDRs", str(resource, "vpcCidrs")],
          ["Google Cloud project", str(resource, "gcpProject")],
          ["Google Cloud network", str(resource, "gcpNetwork")],
          ["Redis project", str(resource, "redisProject")],
          ["Redis network", str(resource, "redisNetwork")],
          ["Cloud peering ID", str(resource, "cloudPeeringId")],
        ]),
        ...(str(resource, "status").toLowerCase().includes("pending")
          ? [
              {
                kind: "text" as const,
                variant: "muted" as const,
                content: /gcp/i.test(str(resource, "provider"))
                  ? "Finish the peering from Google Cloud: create the reverse peering to the Redis project and network above (gcloud compute networks peerings create)."
                  : "Accept the peering request in the AWS VPC console of the account above, then add a route to the Redis deployment CIDR.",
              },
            ]
          : []),
      ]),
    ],
    headerActions: [action("Refresh", { type: "refresh-resource" })],
  };
}

function renderTransitGateway(resource: ResourceInstance): DetailViewSchema {
  const attached = !!str(resource, "attachmentId");
  const headerActions: ActionNode[] = [action("Refresh", { type: "refresh-resource" })];
  headerActions.push(
    attached
      ? action(
          "Detach",
          {
            type: "plugin-action",
            actionId: "tgw-detach",
            confirmMessage:
              "Remove the attachment between this subscription and the transit gateway?",
            successMessage: "Detach requested.",
            destructive: true,
          },
          "danger",
        )
      : action("Attach", {
          type: "plugin-action",
          actionId: "tgw-attach",
          confirmMessage: "Create an attachment from this subscription to the transit gateway?",
          successMessage: "Attachment requested. Accept it in the AWS console.",
        }),
  );
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Transit Gateway", str(resource, "awsAccountId")),
    status: {
      kind: "status-dot",
      status: statusOf(str(resource, "attachmentStatus") || str(resource, "status")),
      label: str(resource, "attachmentStatus") || str(resource, "status"),
    },
    sections: [
      section("Transit Gateway", [
        kv([
          ["Status", str(resource, "status")],
          ["Transit gateway", str(resource, "awsTgwId")],
          ["AWS account", str(resource, "awsAccountId")],
          ["Attachment", str(resource, "attachmentId")],
          ["Attachment status", str(resource, "attachmentStatus")],
          ["Routed CIDRs", str(resource, "cidrs")],
        ]),
      ]),
    ],
    headerActions,
  };
}

function renderPsc(resource: ResourceInstance): DetailViewSchema {
  const creation = resource.resolvedOutputs[ENRICH.creationScript];
  const deletion = resource.resolvedOutputs[ENRICH.deletionScript];
  const sections: SectionNode[] = [
    section("Endpoint", [
      kv([
        ["Status", str(resource, "status")],
        ["PSC service", str(resource, "pscServiceId")],
        ["Service status", str(resource, "serviceStatus")],
        ["Connection host", str(resource, "connectionHostName")],
        ["Project", str(resource, "gcpProjectId")],
        ["VPC network", str(resource, "gcpVpcName")],
        ["Subnet", str(resource, "gcpVpcSubnetName")],
        ["Endpoint name prefix", str(resource, "endpointConnectionName")],
      ]),
    ]),
  ];
  if (creation) {
    sections.push(
      section("Creation script", [
        {
          kind: "text",
          variant: "muted",
          content:
            "Run in Cloud Shell or with gcloud authenticated to the project above, then accept the endpoint.",
        },
        { kind: "text", variant: "mono", content: creation, copyable: true },
      ]),
    );
  }
  if (deletion) {
    sections.push(
      section("Deletion script", [
        { kind: "text", variant: "mono", content: deletion, copyable: true },
      ]),
    );
  }
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Private Service Connect", str(resource, "gcpProjectId")),
    status: {
      kind: "status-dot",
      status: statusOf(str(resource, "status")),
      label: str(resource, "status"),
    },
    sections,
    headerActions: [
      action("Refresh", { type: "refresh-resource" }),
      action("Accept endpoint", {
        type: "plugin-action",
        actionId: "psc-accept",
        confirmMessage: "Tell Redis Cloud the endpoint has been created in Google Cloud?",
        successMessage: "Endpoint accepted.",
      }),
    ],
  };
}

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

export function roleFormFields(
  rules: Array<{ id: string; label: string }>,
  databases: Array<{ id: string; label: string; category?: string }>,
  defaults?: { ruleName?: string; databases?: string[] },
  withName = true,
): CreateFieldConfig[] {
  return [
    ...(withName
      ? [
          {
            key: "name",
            label: "Name",
            kind: "text" as const,
            required: true,
            placeholder: "app-read-only",
          },
        ]
      : []),
    {
      key: "ruleName",
      label: "ACL rule",
      kind: "select",
      required: true,
      options: rules,
      ...(defaults?.ruleName ? { defaultValue: defaults.ruleName } : {}),
    },
    {
      key: "databases",
      label: "Databases",
      kind: "policy-picker",
      required: true,
      policies: databases,
      description: "The rule applies to these databases for every user holding the role.",
      ...(defaults?.databases ? { defaultValue: JSON.stringify(defaults.databases) } : {}),
    },
  ];
}

function renderAclRule(resource: ResourceInstance): DetailViewSchema {
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("ACL rule", resource.fields["isDefault"] === true ? "built-in" : ""),
    status: {
      kind: "status-dot",
      status: statusOf(str(resource, "status")),
      label: str(resource, "status"),
    },
    sections: [
      section("Rule", [
        { kind: "text", variant: "mono", content: str(resource, "rule"), copyable: true },
        kv([
          ["Built-in", resource.fields["isDefault"] as boolean | undefined],
          ["Status", str(resource, "status")],
        ]),
      ]),
    ],
    headerActions: [action("Refresh", { type: "refresh-resource" })],
  };
}

function renderAclRole(resource: ResourceInstance): DetailViewSchema {
  const spec = parseRuleSpec(resource.fields["ruleSpec"]);
  const rules = enriched<Array<{ id: string; label: string }>>(resource, ENRICH.ruleOptions);
  const dbs = enriched<Array<{ id: string; label: string; category?: string }>>(
    resource,
    ENRICH.databaseOptions,
  );
  const headerActions: ActionNode[] = [action("Refresh", { type: "refresh-resource" })];
  if (rules && dbs) {
    headerActions.push(
      action("Edit rule and databases", {
        type: "prompt-nosql-command",
        command: "set-role-rules",
        title: "Rule and databases",
        description:
          "Replaces the role's rule assignment. Users holding the role get the change on their next connection.",
        fields: roleFormFields(
          rules,
          dbs,
          { ...(spec[0] ? { ruleName: spec[0].ruleName, databases: spec[0].databases } : {}) },
          false,
        ),
        submitLabel: "Save",
      }),
    );
  }
  return {
    title: resource.displayName,
    subtitle: "ACL role",
    status: {
      kind: "status-dot",
      status: statusOf(str(resource, "status")),
      label: str(resource, "status"),
    },
    sections: [
      section("Role", [
        kv([
          ["Rules", str(resource, "rules")],
          ["Databases", str(resource, "databases")],
          ["Users", str(resource, "users")],
          ["Status", str(resource, "status")],
        ]),
      ]),
    ],
    headerActions,
  };
}

function renderAclUser(resource: ResourceInstance): DetailViewSchema {
  const roles = enriched<Array<{ id: string; label: string }>>(resource, ENRICH.roleOptions);
  const headerActions: ActionNode[] = [action("Refresh", { type: "refresh-resource" })];
  if (roles && roles.length) {
    headerActions.push(
      action("Change role", {
        type: "prompt-nosql-command",
        command: "set-user-role",
        title: "Change role",
        fields: [
          {
            key: "role",
            label: "Role",
            kind: "select",
            required: true,
            options: roles,
            defaultValue: str(resource, "role"),
          },
        ],
        submitLabel: "Save",
      }),
    );
  }
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("ACL user", str(resource, "role")),
    status: {
      kind: "status-dot",
      status: statusOf(str(resource, "status")),
      label: str(resource, "status"),
    },
    sections: [
      section("User", [
        kv([
          ["Role", str(resource, "role")],
          ["Status", str(resource, "status")],
        ]),
      ]),
    ],
    headerActions,
  };
}

function renderCloudAccount(resource: ResourceInstance): DetailViewSchema {
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Cloud account", str(resource, "provider")),
    status: {
      kind: "status-dot",
      status: statusOf(str(resource, "status")),
      label: str(resource, "status"),
    },
    sections: [
      section("Cloud account", [
        kv([
          ["Cloud", str(resource, "provider")],
          ["Status", str(resource, "status")],
          ["Access key ID", str(resource, "accessKeyId")],
          ["Console sign-in", str(resource, "signInLoginUrl")],
          ["Console role", str(resource, "awsConsoleRoleArn")],
          ["Programmatic user", str(resource, "awsUserArn")],
        ]),
      ]),
    ],
    headerActions: [action("Refresh", { type: "refresh-resource" })],
  };
}

function renderAccount(resource: ResourceInstance): DetailViewSchema {
  const sections: SectionNode[] = [
    section("Account", [
      kv([
        ["Account ID", str(resource, "accountId")],
        ["Marketplace", str(resource, "marketplaceStatus")],
        ["API key", str(resource, "keyName")],
        ["Key owner", str(resource, "keyOwner")],
      ]),
    ]),
  ];
  const methods = enriched<
    Array<{
      id?: number;
      type?: string;
      creditCardEndsWith?: string;
      nameOnCard?: string;
      expirationMonth?: number;
      expirationYear?: number;
    }>
  >(resource, ENRICH.paymentMethods);
  if (methods) {
    sections.push(
      section("Payment methods", [
        {
          kind: "table",
          columns: [
            { key: "type", label: "Type" },
            { key: "card", label: "Card", mono: true },
            { key: "name", label: "Name on card" },
            { key: "expires", label: "Expires", width: "narrow" },
          ],
          rows: methods.map((m) => ({
            cells: {
              type: m.type ?? "",
              card: m.creditCardEndsWith ? `•••• ${m.creditCardEndsWith}` : "",
              name: m.nameOnCard ?? "",
              expires:
                m.expirationMonth && m.expirationYear
                  ? `${String(m.expirationMonth).padStart(2, "0")}/${m.expirationYear}`
                  : "",
            },
          })),
        },
      ]),
    );
  }
  const users = enriched<
    Array<{ name?: string; email?: string; role?: string; hasApiKey?: boolean }>
  >(resource, ENRICH.users);
  if (users) {
    sections.push(
      section("Team", [
        {
          kind: "table",
          columns: [
            { key: "name", label: "Name" },
            { key: "email", label: "Email" },
            { key: "role", label: "Role", width: "narrow" },
            { key: "api", label: "API key", width: "narrow" },
          ],
          rows: users.map((u) => ({
            cells: {
              name: u.name ?? "",
              email: u.email ?? "",
              role: u.role ?? "",
              api: u.hasApiKey ? "Yes" : "No",
            },
          })),
        },
      ]),
    );
  }
  const tasks = enriched<
    Array<{
      taskId?: string;
      commandType?: string;
      status?: string;
      description?: string;
      timestamp?: string;
    }>
  >(resource, ENRICH.tasks);
  if (tasks) {
    sections.push(
      section("Recent tasks", [
        {
          kind: "table",
          columns: [
            { key: "time", label: "Time" },
            { key: "command", label: "Operation" },
            { key: "status", label: "Status" },
            { key: "description", label: "Detail", width: "wide" },
          ],
          rows: tasks.slice(0, 25).map((t) => ({
            cells: {
              time: (t.timestamp ?? "").replace("T", " ").slice(0, 19),
              command: t.commandType ?? "",
              status: t.status ?? "",
              description: t.description ?? "",
            },
          })),
        },
      ]),
    );
  }
  return {
    title: resource.displayName,
    subtitle: "Redis Cloud account",
    status: { kind: "status-dot", status: "healthy" },
    sections,
    headerActions: [
      action("Refresh", { type: "refresh-resource" }),
      action("Billing in Redis Cloud", { type: "open-url", url: `${CONSOLE}/#/billing` }),
    ],
    logs: { defaultTailLines: 200 },
  };
}

export function renderRedisCloudDetail(resource: ResourceInstance): DetailViewSchema {
  switch (resource.resourceTypeId) {
    case T.database:
      return renderDatabase(resource);
    case T.subscription:
      return renderSubscription(resource);
    case T.vpcPeering:
      return renderPeering(resource);
    case T.transitGateway:
      return renderTransitGateway(resource);
    case T.pscEndpoint:
      return renderPsc(resource);
    case T.aclRule:
      return renderAclRule(resource);
    case T.aclRole:
      return renderAclRole(resource);
    case T.aclUser:
      return renderAclUser(resource);
    case T.cloudAccount:
      return renderCloudAccount(resource);
    case T.account:
      return renderAccount(resource);
    default:
      return { title: resource.displayName, sections: [] };
  }
}

export function renderRedisCloudSidebar(resource: ResourceInstance): SidebarItemSchema {
  const status = str(resource, "status");
  return {
    id: resource.id,
    label: resource.displayName || resource.id,
    status: {
      kind: "status-dot",
      status: resource.resourceTypeId === T.account ? "healthy" : statusOf(status),
    },
  };
}

export { PERSISTENCE_OPTIONS, EVICTION_OPTIONS };
