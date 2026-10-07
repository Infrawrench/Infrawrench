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
} from "@infrawrench/plugin-base";
import { formatBytes, joinSubtitle } from "@infrawrench/plugin-base";
import { ON_OFF_TIMEZONES, ORG_ROLES, PROJECT_ROLES } from "./catalog.js";
import { T, resetPasswordAction } from "./resource-types.js";

export const ENRICH = {
  schedule: "__schedule",
  auditLog: "__auditLog",
  clusters: "__clusters",
  projects: "__projects",
  backupSchedule: "__backupSchedule",
} as const;

export const CONSOLE_URL = "https://cloud.couchbase.com";

interface Pick {
  id: string;
  label: string;
  description?: string;
}

function enriched<V>(resource: ResourceInstance, key: string): V | undefined {
  const raw = resource.resolvedOutputs[key];
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as V;
  } catch {
    return undefined;
  }
}

function str(resource: ResourceInstance, key: string): string {
  const v = resource.fields[key];
  return v === undefined || v === null ? "" : String(v);
}

function num(resource: ResourceInstance, key: string): number | undefined {
  const v = resource.fields[key];
  const n = typeof v === "number" ? v : Number(v);
  return v === undefined || v === "" || !Number.isFinite(n) ? undefined : n;
}

function bool(resource: ResourceInstance, key: string): boolean | undefined {
  const v = resource.fields[key];
  if (v === undefined || v === "") return undefined;
  return v === true || v === "true";
}

export function statusOf(raw: string): ResourceStatus {
  const s = raw.toLowerCase();
  if (!s) return "unknown";
  if (["healthy", "active", "ready", "running", "verified", "linked"].includes(s)) return "healthy";
  if (/failed|offline|rejected|unrecognized/.test(s)) return "error";
  if (/deploying|scaling|upgrading|rebalancing|peering|turningon|pending|draft/.test(s))
    return "provisioning";
  if (/degraded|turnedoff|turningoff|destroying|paused|pausing|expired/.test(s)) return "degraded";
  return "info";
}

function kv(items: Array<[string, string | number | boolean | undefined]>): SchemaNode {
  const out: KVItem[] = [];
  for (const [key, value] of items) {
    if (value === undefined || value === "") continue;
    out.push({ key, value: typeof value === "boolean" ? (value ? "Yes" : "No") : String(value) });
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

function prompt(
  label: string,
  command: string,
  opts: {
    description?: string;
    fields: CreateFieldConfig[];
    submitLabel?: string;
    danger?: boolean;
    blockedReason?: string;
  },
): ActionNode {
  return action(
    label,
    {
      type: "prompt-nosql-command",
      command,
      title: label,
      ...(opts.blockedReason
        ? { description: opts.blockedReason, descriptionVariant: "error" as const, blocked: true }
        : opts.description
          ? { description: opts.description }
          : {}),
      fields: opts.fields,
      ...(opts.submitLabel ? { submitLabel: opts.submitLabel } : {}),
      ...(opts.danger ? { danger: true } : {}),
    },
    opts.danger ? "danger" : undefined,
  );
}

const refresh = () => action("Refresh", { type: "refresh-resource" });
const consoleLink = () => action("Open Capella", { type: "open-url", url: CONSOLE_URL });

function status(resource: ResourceInstance, key = "state") {
  const s = str(resource, key);
  return { kind: "status-dot" as const, status: statusOf(s), ...(s ? { label: s } : {}) };
}

function onOff(resource: ResourceInstance, what: string): ActionNode {
  const s = str(resource, "state");
  if (s === "turnedOff" || s === "turningOff" || s === "turningOffFailed") {
    return action("Turn on", {
      type: "plugin-action",
      actionId: "turn-on",
      successMessage: `${what} is turning on.`,
    });
  }
  return action("Turn off", {
    type: "plugin-action",
    actionId: "turn-off",
    confirmMessage: `Turn this ${what.toLowerCase()} off? It stops serving requests; compute stops billing while storage still bills.`,
    successMessage: `${what} is turning off.`,
  });
}

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function scheduleAction(resource: ResourceInstance): ActionNode {
  const current = enriched<{
    timezone?: string;
    days?: Array<{
      day?: string;
      state?: string;
      from?: { hour?: number };
      to?: { hour?: number };
    }>;
  }>(resource, ENRICH.schedule);
  const onDays = (current?.days ?? []).filter((d) => d.state !== "off").map((d) => d.day ?? "");
  const custom = current?.days?.find((d) => d.state === "custom");
  return prompt("On/off schedule", "set-schedule", {
    description:
      "Turns the cluster (and its App Service) on and off on a weekly schedule. Days not picked stay off all day. Capella needs the cluster on a paid plan.",
    fields: [
      {
        key: "timezone",
        label: "Timezone",
        kind: "select",
        required: true,
        options: ON_OFF_TIMEZONES.map((t) => ({ id: t, label: t })),
        defaultValue: current?.timezone ?? "US/Eastern",
      },
      {
        key: "days",
        label: "Days the cluster runs",
        kind: "policy-picker",
        required: true,
        policies: DAYS.map((d) => ({ id: d, label: d[0]!.toUpperCase() + d.slice(1) })),
        defaultValue: JSON.stringify(onDays.length ? onDays : DAYS.slice(0, 5)),
      },
      {
        key: "fromHour",
        label: "On from (hour)",
        kind: "number",
        required: true,
        minValue: 0,
        maxValue: 23,
        defaultValue: String(custom?.from?.hour ?? 8),
      },
      {
        key: "toHour",
        label: "Off at (hour, 24 for midnight)",
        kind: "number",
        required: true,
        minValue: 1,
        maxValue: 24,
        defaultValue: String(custom?.to?.hour ?? 20),
      },
    ],
    submitLabel: "Save schedule",
  });
}

function renderCluster(resource: ResourceInstance): DetailViewSchema {
  const free = bool(resource, "freeTier") === true;
  const headerActions: ActionNode[] = [refresh(), onOff(resource, "Cluster")];
  if (!free) {
    headerActions.push(scheduleAction(resource));
    if (enriched(resource, ENRICH.schedule)) {
      headerActions.push(
        action("Remove schedule", {
          type: "plugin-action",
          actionId: "remove-schedule",
          confirmMessage: "Remove the on/off schedule? The cluster stays in its current state.",
          successMessage: "Schedule removed.",
        }),
      );
    }
    const audit = enriched<{ auditEnabled?: boolean }>(resource, ENRICH.auditLog);
    headerActions.push(
      prompt("Audit logging", "set-audit", {
        description: "Turns Couchbase Server audit logging on or off for this cluster.",
        fields: [
          {
            key: "enabled",
            label: "Audit logging",
            kind: "select",
            required: true,
            options: [
              { id: "true", label: "On" },
              { id: "false", label: "Off" },
            ],
            defaultValue: audit?.auditEnabled ? "true" : "false",
          },
        ],
        submitLabel: "Save",
      }),
    );
  }
  headerActions.push(
    prompt("Load sample data", "load-sample", {
      description: "Creates a bucket filled with one of Couchbase's sample datasets.",
      fields: [
        {
          key: "name",
          label: "Sample",
          kind: "select",
          required: true,
          options: [
            { id: "travel-sample", label: "travel-sample" },
            { id: "gamesim-sample", label: "gamesim-sample" },
            { id: "beer-sample", label: "beer-sample" },
          ],
          defaultValue: "travel-sample",
        },
      ],
      submitLabel: "Load",
    }),
    consoleLink(),
  );
  const used = num(resource, "memoryUsedMb");
  const total = num(resource, "memoryTotalMb");
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(
      free ? "Free tier cluster" : "Operational cluster",
      str(resource, "cloud").toUpperCase(),
      str(resource, "region"),
    ),
    status: status(resource),
    sections: [
      section("Cluster", [
        kv([
          ["Cluster ID", str(resource, "clusterId")],
          ["State", str(resource, "state")],
          ["Couchbase Server", str(resource, "version")],
          ["Configuration", str(resource, "configurationType")],
          ["Availability", str(resource, "availability")],
          ["Support plan", str(resource, "supportPlan")],
          ["Deletion protection", bool(resource, "deletionProtection")],
          ["Description", str(resource, "description")],
          ["Created", str(resource, "createdAt")],
        ]),
      ]),
      section("Capacity", [
        kv([
          ["Service groups", str(resource, "serviceGroups")],
          ["Total nodes", num(resource, "totalNodes")],
          [
            "Bucket memory",
            used !== undefined && total !== undefined
              ? `${formatBytes(used * 1048576)} of ${formatBytes(total * 1048576)} allocated`
              : undefined,
          ],
        ]),
      ]),
      section("Connectivity", [
        kv([
          ["Connection string", str(resource, "connectionString")],
          ["Cloud", str(resource, "cloud")],
          ["Region", str(resource, "region")],
          ["CIDR", str(resource, "cidr")],
          ["App Service", str(resource, "appServiceId")],
        ]),
      ]),
    ],
    headerActions,
  };
}

function renderBucket(resource: ResourceInstance): DetailViewSchema {
  const schedule = enriched<{
    weeklySchedule?: {
      dayOfWeek?: string;
      startAt?: number;
      incrementalEvery?: number;
      retentionTime?: string;
    };
  }>(resource, ENRICH.backupSchedule);
  const w = schedule?.weeklySchedule;
  const headerActions: ActionNode[] = [
    refresh(),
    action("Back up now", {
      type: "plugin-action",
      actionId: "backup",
      successMessage: "Backup started.",
    }),
    prompt("Backup schedule", "set-backup-schedule", {
      description:
        "A weekly full backup with incrementals in between, kept for the retention you pick.",
      fields: [
        {
          key: "dayOfWeek",
          label: "Full backup on",
          kind: "select",
          required: true,
          options: [
            "sunday",
            "monday",
            "tuesday",
            "wednesday",
            "thursday",
            "friday",
            "saturday",
          ].map((d) => ({ id: d, label: d })),
          defaultValue: w?.dayOfWeek ?? "sunday",
        },
        {
          key: "startAt",
          label: "Start hour (UTC)",
          kind: "number",
          required: true,
          minValue: 0,
          maxValue: 23,
          defaultValue: String(w?.startAt ?? 2),
        },
        {
          key: "incrementalEvery",
          label: "Incremental every (hours)",
          kind: "select",
          required: true,
          options: ["1", "2", "4", "6", "8", "12", "24"].map((h) => ({ id: h, label: h })),
          defaultValue: String(w?.incrementalEvery ?? 24),
        },
        {
          key: "retentionTime",
          label: "Retention",
          kind: "select",
          required: true,
          options: [
            "30days",
            "60days",
            "90days",
            "180days",
            "1year",
            "2years",
            "3years",
            "4years",
            "5years",
          ].map((r) => ({ id: r, label: r })),
          defaultValue: w?.retentionTime ?? "30days",
        },
        {
          key: "costOptimizedRetention",
          label: "Cost-optimized retention",
          kind: "select",
          required: true,
          options: [
            { id: "false", label: "No" },
            { id: "true", label: "Yes" },
          ],
          defaultValue: "false",
        },
      ],
      submitLabel: "Save",
    }),
  ];
  if (bool(resource, "flushEnabled")) {
    headerActions.push(
      action(
        "Flush",
        {
          type: "plugin-action",
          actionId: "flush",
          confirmMessage: "Delete every document in this bucket? This cannot be undone.",
          successMessage: "Flush requested.",
          destructive: true,
        },
        "danger",
      ),
    );
  }
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Bucket", str(resource, "type"), str(resource, "storageBackend")),
    status: { kind: "status-dot", status: "healthy" },
    sections: [
      section("Bucket", [
        kv([
          [
            "Memory quota",
            num(resource, "memoryAllocationInMb") !== undefined
              ? `${num(resource, "memoryAllocationInMb")} MB`
              : undefined,
          ],
          ["Replicas", str(resource, "replicas")],
          ["Minimum durability", str(resource, "durabilityLevel")],
          [
            "Max TTL",
            num(resource, "timeToLiveInSeconds")
              ? `${num(resource, "timeToLiveInSeconds")} s`
              : "None",
          ],
          ["Eviction", str(resource, "evictionPolicy")],
          ["Conflict resolution", str(resource, "conflictResolution")],
          ["Flush enabled", bool(resource, "flushEnabled")],
        ]),
      ]),
      section("Usage", [
        kv([
          ["Items", num(resource, "itemCount")],
          ["Ops/sec", num(resource, "opsPerSecond")],
          [
            "Disk used",
            num(resource, "diskUsedMib") !== undefined
              ? formatBytes((num(resource, "diskUsedMib") ?? 0) * 1048576)
              : undefined,
          ],
          [
            "Memory used",
            num(resource, "memoryUsedMib") !== undefined
              ? formatBytes((num(resource, "memoryUsedMib") ?? 0) * 1048576)
              : undefined,
          ],
          [
            "Backup schedule",
            w
              ? `Full on ${w.dayOfWeek} at ${w.startAt}:00 UTC, incremental every ${w.incrementalEvery} h, kept ${w.retentionTime}`
              : undefined,
          ],
        ]),
      ]),
    ],
    headerActions,
  };
}

function renderBackup(resource: ResourceInstance): DetailViewSchema {
  const clusters = enriched<Pick[]>(resource, ENRICH.clusters) ?? [];
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Backup", str(resource, "method")),
    status: status(resource, "status"),
    sections: [
      section("Backup", [
        kv([
          ["Bucket", str(resource, "bucketName")],
          ["Status", str(resource, "status")],
          ["Method", str(resource, "method")],
          ["Source", str(resource, "source")],
          ["Taken", str(resource, "createdAt")],
          ["Restorable until", str(resource, "restoreBefore")],
          [
            "Size",
            num(resource, "sizeGb") !== undefined ? `${num(resource, "sizeGb")} GB` : undefined,
          ],
          ["Items", num(resource, "items")],
        ]),
      ]),
    ],
    headerActions: [
      refresh(),
      prompt("Restore", "restore", {
        description:
          "Restores this backup's bucket into a cluster. Documents with the same keys are overwritten when forced.",
        ...(clusters.length === 0 ? { blockedReason: "No cluster to restore into." } : {}),
        fields: [
          {
            key: "targetClusterId",
            label: "Target cluster",
            kind: "select",
            required: true,
            options: clusters,
          },
          {
            key: "services",
            label: "Restore",
            kind: "policy-picker",
            required: true,
            policies: [
              { id: "data", label: "Data" },
              { id: "query", label: "Query (index definitions)" },
            ],
            defaultValue: JSON.stringify(["data"]),
          },
          {
            key: "forceUpdates",
            label: "Overwrite existing documents",
            kind: "select",
            required: true,
            options: [
              { id: "false", label: "No" },
              { id: "true", label: "Yes" },
            ],
            defaultValue: "false",
          },
        ],
        submitLabel: "Restore",
        danger: true,
      }),
    ],
  };
}

function rolesPrompt(resource: ResourceInstance): ActionNode {
  const projects = enriched<Pick[]>(resource, ENRICH.projects) ?? [];
  const orgRoles = str(resource, "organizationRoles")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return prompt("Change roles", "set-roles", {
    description: "Sets the organization roles and adds or changes a role on one project.",
    fields: [
      {
        key: "organizationRoles",
        label: "Organization roles",
        kind: "policy-picker",
        required: true,
        policies: ORG_ROLES.map((r) => ({ id: r, label: r })),
        defaultValue: JSON.stringify(orgRoles),
      },
      {
        key: "projectId",
        label: "Project (optional)",
        kind: "select",
        required: false,
        options: [{ id: "", label: "No project change" }, ...projects],
        defaultValue: "",
      },
      {
        key: "projectRoles",
        label: "Project roles",
        kind: "policy-picker",
        required: false,
        policies: PROJECT_ROLES.map((r) => ({ id: r, label: r })),
        description: "Leave empty to remove the user from that project.",
      },
    ],
    submitLabel: "Save",
  });
}

function revoke(what: string): ActionNode {
  return action(
    what === "user" ? "Remove from organization" : "Revoke",
    {
      type: "plugin-action",
      actionId: "revoke",
      confirmMessage:
        what === "user"
          ? "Remove this user from the organization?"
          : "Revoke this API key? Anything using it stops working.",
      successMessage: "Done.",
      destructive: true,
    },
    "danger",
  );
}

function simple(
  resource: ResourceInstance,
  subtitle: string,
  items: Array<[string, string]>,
  statusKey?: string,
  extra: ActionNode[] = [],
): DetailViewSchema {
  return {
    title: resource.displayName,
    subtitle,
    status: statusKey ? status(resource, statusKey) : { kind: "status-dot", status: "healthy" },
    sections: [section(subtitle, [kv(items.map(([l, k]) => [l, str(resource, k)]))])],
    headerActions: [refresh(), ...extra],
  };
}

export function renderCapellaDetail(resource: ResourceInstance): DetailViewSchema {
  switch (resource.resourceTypeId) {
    case T.project:
      return simple(
        resource,
        "Project",
        [
          ["Project ID", "projectId"],
          ["Description", "description"],
          ["Created", "createdAt"],
        ],
        undefined,
        [consoleLink()],
      );
    case T.cluster:
      return renderCluster(resource);
    case T.appService:
      return simple(
        resource,
        "App Service",
        [
          ["State", "state"],
          ["Cluster", "clusterId"],
          ["Version", "version"],
          ["Plan", "plan"],
          ["Nodes", "nodes"],
          ["Node size", "compute"],
          ["Created", "createdAt"],
        ],
        "state",
        [onOff(resource, "App Service"), consoleLink()],
      );
    case T.bucket:
      return renderBucket(resource);
    case T.scope:
      return simple(resource, "Scope", [
        ["Bucket", "bucketName"],
        ["Collections", "collections"],
      ]);
    case T.collection:
      return simple(resource, "Collection", [
        ["Scope", "scope"],
        ["Bucket", "bucketName"],
        ["Max TTL", "maxTTL"],
      ]);
    case T.credential:
      return simple(
        resource,
        "Database credential",
        [
          ["Username", "name"],
          ["Access", "access"],
          ["User roles", "userRoles"],
          ["Created", "createdAt"],
        ],
        undefined,
        [
          prompt(resetPasswordAction.label, resetPasswordAction.command, {
            ...(resetPasswordAction.description
              ? { description: resetPasswordAction.description }
              : {}),
            fields: resetPasswordAction.fields,
            submitLabel: "Reset",
          }),
        ],
      );
    case T.cidr:
      return simple(
        resource,
        "Allowed CIDR",
        [
          ["CIDR", "cidr"],
          ["Comment", "comment"],
          ["Status", "status"],
          ["Type", "type"],
          ["Expires", "expiresAt"],
        ],
        "status",
      );
    case T.backup:
      return renderBackup(resource);
    case T.replication: {
      const s = str(resource, "status");
      return simple(
        resource,
        "XDCR replication",
        [
          ["Source", "sourceCluster"],
          ["Target", "targetCluster"],
          ["Status", "status"],
          ["Direction", "direction"],
          ["Created", "createdAt"],
        ],
        "status",
        [
          s === "paused"
            ? action("Resume", {
                type: "plugin-action",
                actionId: "resume",
                successMessage: "Replication resumed.",
              })
            : action("Pause", {
                type: "plugin-action",
                actionId: "pause",
                successMessage: "Replication paused.",
              }),
        ],
      );
    }
    case T.networkPeer:
      return simple(
        resource,
        "Network peer",
        [
          ["State", "state"],
          ["Reason", "reasoning"],
          ["Peer", "peerDetails"],
          ["Created", "createdAt"],
        ],
        "state",
      );
    case T.privateEndpoint:
      return simple(
        resource,
        "Private endpoint",
        [
          ["Endpoint", "endpointId"],
          ["Service", "serviceName"],
          ["Status", "status"],
          ["Private DNS", "dns"],
        ],
        "status",
      );
    case T.user:
      return simple(
        resource,
        "Organization user",
        [
          ["Email", "email"],
          ["Status", "status"],
          ["Organization roles", "organizationRoles"],
          ["Project roles", "projectRoles"],
          ["Last login", "lastLogin"],
        ],
        "status",
        [rolesPrompt(resource), revoke("user")],
      );
    case T.apiKey:
      return simple(
        resource,
        "API key",
        [
          ["Key ID", "keyId"],
          ["Organization roles", "organizationRoles"],
          ["Project roles", "projectRoles"],
          ["Allowed CIDRs", "allowedCidrs"],
          ["Expires", "expiresAt"],
          ["Created", "createdAt"],
        ],
        undefined,
        [
          action("Rotate", {
            type: "prompt-nosql-command",
            command: "rotate",
            title: "Rotate API key",
            description:
              "Issues a new secret for this key; the old one stops working. The new token is shown once.",
            fields: [],
            submitLabel: "Rotate",
          }),
          revoke("key"),
        ],
      );
    default:
      return { title: resource.displayName, sections: [section("Details", [kv([])])] };
  }
}

export function renderCapellaSidebar(resource: ResourceInstance): SidebarItemSchema {
  const s = str(resource, "state") || str(resource, "status");
  return {
    id: resource.id,
    label: resource.displayName || resource.id,
    status: { kind: "status-dot", status: s ? statusOf(s) : "healthy" },
  };
}
