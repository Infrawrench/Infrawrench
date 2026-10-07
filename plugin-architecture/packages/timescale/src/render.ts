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
import { REGIONS, SIZE_OPTIONS, sizeLabel } from "./catalog.js";
import { T } from "./resource-types.js";

/**
 * Keys under `resolvedOutputs` that `enrichDetail` fills with JSON for the
 * synchronous renderer. Every renderer copes with their absence.
 */
export const ENRICH = {
  vpcs: "__vpcs",
  exporters: "__exporters",
  allowLists: "__allowLists",
  backupRegions: "__backupRegions",
  peerings: "__peerings",
} as const;

export const CONSOLE_URL = "https://console.cloud.tigerdata.com";

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
  if (["ready", "active"].includes(s)) return "healthy";
  if (
    /queued|configuring|resuming|creating|resizing|upgrading|optimizing|pending|initiat|provision/.test(
      s,
    )
  ) {
    return "provisioning";
  }
  if (/error|failed|unstable/.test(s)) return "error";
  if (/paused|pausing|deleting|deleted/.test(s)) return "degraded";
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
    title?: string;
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
      title: opts.title ?? label,
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

function computeLabel(resource: ResourceInstance): string | undefined {
  const raw = str(resource, "computeSize");
  const m = /^(\d+)\/(\d+)$/.exec(raw);
  if (m) return sizeLabel(Number(m[1]), Number(m[2]));
  return str(resource, "cpuMillis") ? undefined : "Shared";
}

function regionLabel(id: string): string {
  const r = REGIONS.find((x) => x.id === id);
  return r ? `${r.id} (${r.location})` : id;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

interface PickItem {
  id: string;
  label: string;
  region?: string;
  type?: string;
}

function serviceActions(resource: ResourceInstance): ActionNode[] {
  const status = str(resource, "status").toUpperCase();
  const region = str(resource, "region");
  const headerActions: ActionNode[] = [action("Refresh", { type: "refresh-resource" })];
  if (status === "PAUSED" || status === "PAUSING") {
    headerActions.push(
      action("Resume", {
        type: "plugin-action",
        actionId: "resume",
        successMessage: "Resume requested.",
      }),
    );
  } else {
    headerActions.push(
      action("Pause", {
        type: "plugin-action",
        actionId: "pause",
        confirmMessage:
          "Pause this service? It stops accepting connections and compute billing stops until you resume it. Storage is still billed.",
        successMessage: "Pause requested.",
      }),
    );
  }
  headerActions.push(
    prompt("Set password", "set-password", {
      title: "Set the tsdbadmin password",
      description:
        "Sets a new password for tsdbadmin and keeps it for the PostgreSQL tab and the connection string outputs. Leave blank to generate one. Clients using the old password stop connecting.",
      fields: [
        {
          key: "password",
          label: "New password (optional)",
          kind: "password",
          required: false,
          placeholder: "Leave blank to generate one",
        },
      ],
      submitLabel: "Set password",
    }),
    prompt("Fork", "fork", {
      title: "Fork this service",
      description:
        "Creates an independent copy of this service from a snapshot. Region, type and storage are inherited; the fork starts without HA replicas.",
      fields: [
        {
          key: "name",
          label: "Name",
          kind: "text",
          required: false,
          placeholder: "Defaults to standard-fork-<name>",
        },
        {
          key: "strategy",
          label: "Data as of",
          kind: "select",
          required: true,
          options: [
            { id: "NOW", label: "Now (takes a fresh snapshot)" },
            { id: "LAST_SNAPSHOT", label: "Last snapshot (fastest)" },
            { id: "PITR", label: "A point in time (recovery fork)" },
          ],
          defaultValue: "NOW",
        },
        {
          key: "targetTime",
          label: "Point in time (UTC)",
          kind: "datetime",
          required: true,
          showWhen: { fieldKey: "strategy", fieldValue: "PITR" },
        },
        {
          key: "computeSize",
          label: "Compute",
          kind: "select",
          required: false,
          options: [{ id: "", label: "Same as this service" }, ...SIZE_OPTIONS],
          defaultValue: "",
        },
        {
          key: "environment",
          label: "Environment",
          kind: "select",
          required: false,
          options: [
            { id: "DEV", label: "Development" },
            { id: "PROD", label: "Production" },
          ],
          defaultValue: "DEV",
        },
      ],
      submitLabel: "Fork",
    }),
  );

  const vpcs = enriched<PickItem[]>(resource, ENRICH.vpcs);
  const vpcId = str(resource, "vpcId");
  if (vpcId) {
    headerActions.push(
      action("Detach from VPC", {
        type: "plugin-action",
        actionId: "detach-vpc",
        confirmMessage:
          "Detach this service from its VPC? Clients that reach it over VPC peering lose access.",
        successMessage: "Detach requested.",
      }),
    );
  } else if (!region.startsWith("az-")) {
    const options = (vpcs ?? []).filter((v) => !v.region || v.region === region);
    headerActions.push(
      prompt("Attach to VPC", "attach-vpc", {
        description:
          "Moves the service into a Tiger Cloud VPC so peered AWS VPCs can reach it privately. Only VPCs in the service's region are listed.",
        ...(options.length === 0
          ? {
              blockedReason: `There is no Tiger Cloud VPC in ${region || "this region"} yet. Create one under the project first.`,
            }
          : {}),
        fields: [
          {
            key: "vpcId",
            label: "VPC",
            kind: "select",
            required: true,
            options: options.map((v) => ({ id: v.id, label: v.label })),
          },
        ],
        submitLabel: "Attach",
      }),
    );
  }

  const exporters = enriched<PickItem[]>(resource, ENRICH.exporters);
  if (exporters) {
    const inRegion = exporters.filter((e) => !e.region || e.region === region);
    const attached = [str(resource, "metricExporterId"), str(resource, "logExporterId")].filter(
      Boolean,
    );
    const attachable = inRegion.filter((e) => !attached.includes(e.id));
    headerActions.push(
      prompt("Attach exporter", "attach-exporter", {
        description:
          "Starts sending this service's metrics or logs to an exporter. A service sends to one metric exporter and one log exporter at a time. The first log exporter restarts the service once.",
        ...(attachable.length === 0
          ? {
              blockedReason:
                "No unattached exporter in this service's region. Create one under the project first.",
            }
          : {}),
        fields: [
          {
            key: "exporterId",
            label: "Exporter",
            kind: "select",
            required: true,
            options: attachable.map((e) => ({
              id: e.id,
              label: e.label,
              ...(e.type ? { description: e.type } : {}),
            })),
          },
        ],
        submitLabel: "Attach",
      }),
    );
    if (attached.length) {
      headerActions.push(
        prompt("Detach exporter", "detach-exporter", {
          description: "Stops sending data to the exporter. The exporter itself is kept.",
          fields: [
            {
              key: "exporterId",
              label: "Exporter",
              kind: "select",
              required: true,
              options: attached.map((id) => ({
                id,
                label: exporters.find((e) => e.id === id)?.label ?? id,
              })),
            },
          ],
          submitLabel: "Detach",
        }),
      );
    }
  }

  const allowLists = enriched<PickItem[]>(resource, ENRICH.allowLists);
  if (allowLists) {
    headerActions.push(
      prompt("IP allow list", "set-allow-list", {
        description:
          "Restricts which public IP ranges can connect. A service has at most one IP allow list; picking one replaces whichever is attached, and picking none removes the restriction. The API does not report which list is attached, so the current one is not preselected.",
        fields: [
          {
            key: "allowListId",
            label: "IP allow list",
            kind: "select",
            required: false,
            options: [
              { id: "", label: "None (any address)" },
              ...allowLists.map((a) => ({ id: a.id, label: a.label })),
            ],
            defaultValue: "",
          },
        ],
        submitLabel: "Save",
      }),
    );
  }

  const backupRegions = enriched<string[]>(resource, ENRICH.backupRegions);
  if (backupRegions) {
    const addable = REGIONS.filter((r) => r.id !== region && !backupRegions.includes(r.id));
    headerActions.push(
      prompt("Cross-region backups", "backup-regions", {
        description:
          "Copies this service's backups to other regions. Removing a region deletes the copies stored there.",
        fields: [
          {
            key: "add",
            label: "Start copying to",
            kind: "select",
            required: false,
            options: [
              { id: "", label: "No change" },
              ...addable.map((r) => ({ id: r.id, label: regionLabel(r.id) })),
            ],
            defaultValue: "",
          },
          {
            key: "remove",
            label: "Stop copying to",
            kind: "select",
            required: false,
            options: [
              { id: "", label: "No change" },
              ...backupRegions.map((r) => ({ id: r, label: regionLabel(r) })),
            ],
            defaultValue: "",
          },
        ],
        submitLabel: "Apply",
      }),
    );
  }

  if (bool(resource, "dataTiering") === false) {
    headerActions.push(
      action("Enable tiered storage", {
        type: "plugin-action",
        actionId: "enable-tiering",
        confirmMessage:
          "Turn on tiered storage? Tiering policies can then move older chunks to low-cost object storage, where they stay queryable but read-only. Turning it off later needs Tiger Data support.",
        successMessage: "Tiered storage enabled.",
      }),
    );
  }
  headerActions.push(action("Open Tiger Console", { type: "open-url", url: CONSOLE_URL }));
  return headerActions;
}

function renderService(resource: ResourceInstance): DetailViewSchema {
  const ha = str(resource, "haReplicas");
  const sync = str(resource, "syncReplicas");
  const haLabel =
    ha === "0"
      ? "None"
      : ha === "1"
        ? "1 replica (high availability)"
        : ha === "2"
          ? `2 replicas${sync === "1" ? ", 1 synchronous" : ""}`
          : ha;
  const storage = num(resource, "storageUsedMb");
  const memUsed = num(resource, "memoryUsedMb");
  const sections: SectionNode[] = [
    section("Service", [
      kv([
        ["Service ID", str(resource, "serviceId")],
        ["Type", str(resource, "serviceType")],
        ["Status", str(resource, "status")],
        ["Region", regionLabel(str(resource, "region"))],
        ["Environment", str(resource, "environment")],
        ["Created", str(resource, "createdAt")],
        ["Forked from", str(resource, "forkedFrom")],
      ]),
    ]),
    section("Compute and storage", [
      kv([
        ["Compute", computeLabel(resource)],
        ["HA replicas", haLabel],
        ["Read replica sets", num(resource, "readReplicaSets")],
        [
          "CPU in use",
          num(resource, "cpuUsedMillis") !== undefined
            ? `${num(resource, "cpuUsedMillis")} millicores`
            : undefined,
        ],
        ["Memory in use", memUsed !== undefined ? formatBytes(memUsed * 1024 * 1024) : undefined],
        ["Storage used", storage !== undefined ? formatBytes(storage * 1024 * 1024) : undefined],
        ["Tiered storage", bool(resource, "dataTiering")],
        [
          "Backup retention",
          num(resource, "backupRetentionDays") !== undefined
            ? `${num(resource, "backupRetentionDays")} days`
            : undefined,
        ],
      ]),
    ]),
    section("Connectivity", [
      kv([
        ["Host", str(resource, "host")],
        ["Port", num(resource, "port")],
        ["Database", "tsdb"],
        ["User", "tsdbadmin"],
        [
          "Connection pooler",
          str(resource, "poolerHost")
            ? `${str(resource, "poolerHost")}:${str(resource, "poolerPort")}`
            : bool(resource, "poolerEnabled") === false
              ? "Off"
              : undefined,
        ],
        ["VPC", str(resource, "vpcId")],
        ["VPC host", str(resource, "vpcHost")],
        ["Metric exporter", str(resource, "metricExporterId")],
        ["Log exporter", str(resource, "logExporterId")],
      ]),
    ]),
  ];
  if (str(resource, "environment") === "PROD" && ha === "0") {
    sections.push(
      section("Availability", [
        {
          kind: "text",
          variant: "body",
          content:
            "This production service has no HA replica, so maintenance restarts and node failures take it offline. Edit the service and set HA replicas to 1 to make those a switchover of a few seconds.",
        },
      ]),
    );
  }
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(
      str(resource, "serviceType") === "TIMESCALEDB" ? "TimescaleDB service" : "PostgreSQL service",
      str(resource, "region"),
    ),
    status: {
      kind: "status-dot",
      status: statusOf(str(resource, "status")),
      label: str(resource, "status"),
    },
    sections,
    headerActions: serviceActions(resource),
    logs: { defaultTailLines: 200 },
  };
}

// ---------------------------------------------------------------------------
// Other types
// ---------------------------------------------------------------------------

function renderReplica(resource: ResourceInstance): DetailViewSchema {
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Read replica set", str(resource, "region")),
    status: {
      kind: "status-dot",
      status: statusOf(str(resource, "status")),
      label: str(resource, "status"),
    },
    sections: [
      section("Read replica set", [
        kv([
          ["Primary service", str(resource, "serviceId")],
          ["Status", str(resource, "status")],
          ["Nodes", num(resource, "nodes")],
          ["Compute per node", computeLabel(resource)],
          ["Environment", str(resource, "environment")],
          ["Host", str(resource, "host")],
          ["Port", num(resource, "port")],
          [
            "Connection pooler",
            str(resource, "poolerHost") ||
              (bool(resource, "poolerEnabled") === false ? "Off" : undefined),
          ],
        ]),
      ]),
    ],
    headerActions: [action("Refresh", { type: "refresh-resource" })],
  };
}

function renderProject(resource: ResourceInstance): DetailViewSchema {
  return {
    title: resource.displayName,
    subtitle: "Tiger Cloud project",
    status: { kind: "status-dot", status: "healthy" },
    sections: [
      section("Project", [
        kv([
          ["Project ID", str(resource, "projectId")],
          ["Services", num(resource, "services")],
          ["Plan", str(resource, "planType")],
        ]),
      ]),
    ],
    headerActions: [
      action("Refresh", { type: "refresh-resource" }),
      action("Open Tiger Console", { type: "open-url", url: CONSOLE_URL }),
    ],
  };
}

function renderVpc(resource: ResourceInstance): DetailViewSchema {
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("VPC", str(resource, "region")),
    status: { kind: "status-dot", status: "healthy" },
    sections: [
      section("VPC", [
        kv([
          ["VPC ID", str(resource, "vpcId")],
          ["CIDR", str(resource, "cidr")],
          ["Region", regionLabel(str(resource, "region"))],
        ]),
      ]),
      section("Peering", [
        {
          kind: "text",
          variant: "muted",
          content:
            "After creating a peering here, accept the peering connection request in your AWS account and add a route to this VPC's CIDR in your route tables.",
        },
      ]),
    ],
    headerActions: [action("Refresh", { type: "refresh-resource" })],
  };
}

function renderPeering(resource: ResourceInstance): DetailViewSchema {
  const error = str(resource, "errorMessage");
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("VPC peering", str(resource, "peerRegion")),
    status: {
      kind: "status-dot",
      status: error ? "error" : statusOf(str(resource, "status")),
      label: str(resource, "status"),
    },
    sections: [
      section("Peering", [
        kv([
          ["Peer AWS account", str(resource, "peerAccountId")],
          ["Peer VPC", str(resource, "peerVpcId")],
          ["Peer region", str(resource, "peerRegion")],
          ["Tiger VPC", str(resource, "vpcId")],
          ["Peering connection", str(resource, "provisionedId")],
          ["Status", str(resource, "status")],
          ["Error", error],
        ]),
      ]),
    ],
    headerActions: [action("Refresh", { type: "refresh-resource" })],
  };
}

function renderExporter(resource: ResourceInstance): DetailViewSchema {
  const type = str(resource, "exporterType");
  const fields: CreateFieldConfig[] = [];
  if (type === "DATADOG_METRICS") {
    fields.push({ key: "apiKey", label: "New Datadog API key", kind: "password", required: true });
  } else if (type === "PROMETHEUS_METRICS") {
    fields.push({
      key: "password",
      label: "New scrape password",
      kind: "password",
      required: true,
    });
  } else if (type === "AZURE_MONITOR_METRICS") {
    fields.push({
      key: "connectionString",
      label: "New Azure Monitor connection string",
      kind: "password",
      required: true,
    });
  } else if (type.startsWith("CLOUDWATCH")) {
    fields.push(
      {
        key: "awsAuth",
        label: "Authenticate with",
        kind: "select",
        required: true,
        options: [
          { id: "IAM_ROLE", label: "An IAM role Tiger Cloud assumes" },
          { id: "ACCESS_KEY", label: "An access key pair" },
        ],
        defaultValue: "IAM_ROLE",
      },
      {
        key: "roleArn",
        label: "IAM role ARN",
        kind: "text",
        required: true,
        placeholder: "arn:aws:iam::123456789012:role/tiger-exporter",
        showWhen: { fieldKey: "awsAuth", fieldValue: "IAM_ROLE" },
      },
      {
        key: "accessKey",
        label: "Access key ID",
        kind: "text",
        required: true,
        showWhen: { fieldKey: "awsAuth", fieldValue: "ACCESS_KEY" },
      },
      {
        key: "secretKey",
        label: "Secret access key",
        kind: "password",
        required: true,
        showWhen: { fieldKey: "awsAuth", fieldValue: "ACCESS_KEY" },
      },
    );
  }
  const headerActions: ActionNode[] = [action("Refresh", { type: "refresh-resource" })];
  if (fields.length) {
    headerActions.push(
      prompt("Rotate credentials", "rotate-exporter-secret", {
        description:
          "Replaces the secret this exporter uses at its destination. Attached services pick it up without a restart.",
        fields,
        submitLabel: "Save",
      }),
    );
  }
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Exporter", type, str(resource, "region")),
    status: { kind: "status-dot", status: str(resource, "attachedServices") ? "healthy" : "info" },
    sections: [
      section("Exporter", [
        kv([
          ["Destination", type],
          ["Region", str(resource, "region")],
          ["Includes PostgreSQL metrics", bool(resource, "includePgMetrics")],
          ["Datadog site", str(resource, "datadogSite")],
          ["CloudWatch namespace", str(resource, "namespace")],
          ["Log group", str(resource, "logGroup")],
          ["Log stream", str(resource, "logStream")],
          ["AWS region", str(resource, "awsRegion")],
          ["AWS authentication", str(resource, "awsAuth")],
          ["Prometheus username", str(resource, "prometheusUser")],
          ["Scrape endpoint", str(resource, "prometheusEndpoint")],
          ["Attached services", str(resource, "attachedServices") || "None"],
          ["Created", str(resource, "createdAt")],
        ]),
      ]),
    ],
    headerActions,
  };
}

function renderAllowList(resource: ResourceInstance): DetailViewSchema {
  const blocks = str(resource, "cidrBlocks")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    title: resource.displayName,
    subtitle: "IP allow list",
    status: { kind: "status-dot", status: "healthy" },
    sections: [
      section("Allowed ranges", [
        {
          kind: "table",
          columns: [{ key: "cidr", label: "CIDR block", mono: true }],
          rows: blocks.map((cidr) => ({ cells: { cidr } })),
        },
      ]),
      section("Details", [kv([["Created", str(resource, "createdAt")]])]),
    ],
    headerActions: [action("Refresh", { type: "refresh-resource" })],
  };
}

function renderBackup(resource: ResourceInstance): DetailViewSchema {
  const size = num(resource, "sizeBytes");
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Backup", str(resource, "backupType")),
    status: {
      kind: "status-dot",
      status: str(resource, "finishedAt") ? "healthy" : "provisioning",
    },
    sections: [
      section("Backup", [
        kv([
          ["Label", str(resource, "label")],
          ["Type", str(resource, "backupType")],
          ["Started", str(resource, "createdAt")],
          ["Finished", str(resource, "finishedAt")],
          [
            "Duration",
            num(resource, "durationSeconds") !== undefined
              ? `${num(resource, "durationSeconds")} s`
              : undefined,
          ],
          ["Size", size !== undefined ? formatBytes(size) : undefined],
          ["Copies", str(resource, "regions")],
        ]),
      ]),
      section("Restoring", [
        {
          kind: "text",
          variant: "muted",
          content:
            'Backups cannot be restored in place. Use Fork on the service with "A point in time" to create a recovery fork from any moment inside the retention window.',
        },
      ]),
    ],
  };
}

export function renderTimescaleDetail(resource: ResourceInstance): DetailViewSchema {
  switch (resource.resourceTypeId) {
    case T.project:
      return renderProject(resource);
    case T.service:
      return renderService(resource);
    case T.replica:
      return renderReplica(resource);
    case T.vpc:
      return renderVpc(resource);
    case T.peering:
      return renderPeering(resource);
    case T.exporter:
      return renderExporter(resource);
    case T.allowList:
      return renderAllowList(resource);
    case T.backup:
      return renderBackup(resource);
    default:
      return { title: resource.displayName, sections: [section("Details", [kv([])])] };
  }
}

export function renderTimescaleSidebar(resource: ResourceInstance): SidebarItemSchema {
  const status = str(resource, "status");
  return {
    id: resource.id,
    label: resource.displayName || resource.id,
    status: { kind: "status-dot", status: status ? statusOf(status) : "healthy" },
  };
}
