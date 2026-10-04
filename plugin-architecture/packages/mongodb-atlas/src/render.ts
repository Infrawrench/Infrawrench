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
  StatusDotNode,
  TableRow,
} from "@infrawrench/plugin-base";
import {
  joinSubtitle,
  resourceTypeDisplayName,
  withMetricsCapability,
} from "@infrawrench/plugin-base";
import type { InvoiceSummary } from "./cost-data.js";
import { COST_METRICS_WINDOW_MS, DEFAULT_METRICS_WINDOW_MS } from "./metrics.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { TIERS_BY_PROVIDER, isDedicatedTier, tierLabel } from "./tiers.js";

/** Keys under which `getResource` stashes extra data for the renderer. */
export const INVOICE_SUMMARY_KEY = "__invoiceSummary__";
export const RECENT_INVOICES_KEY = "__recentInvoices__";
export const AVAILABLE_TIERS_KEY = "__availableTiers__";

const ATLAS_URL = "https://cloud.mongodb.com";

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

function usd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function bytes(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function kv(items: Array<[string, unknown, boolean?]>): SchemaNode {
  const list: KVItem[] = [];
  for (const [key, value, copyable] of items) {
    const text = typeof value === "boolean" ? (value ? "Yes" : "No") : str(value);
    if (text === "") continue;
    list.push({ key, value: text, ...(copyable ? { copyable: true } : {}) });
  }
  return { kind: "key-value-list", items: list };
}

function section(title: string, children: SchemaNode[]): SectionNode {
  return { kind: "section", title, children };
}

function parseJson<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function openInAtlas(url: string): ActionNode {
  return {
    kind: "action",
    label: "Open in Atlas",
    variant: "ghost",
    action: { type: "open-url", url },
  };
}

function pluginAction(
  label: string,
  actionId: string,
  opts: { confirm?: string; success?: string; variant?: ActionNode["variant"] } = {},
): ActionNode {
  return {
    kind: "action",
    label,
    ...(opts.variant ? { variant: opts.variant } : {}),
    action: {
      type: "plugin-action",
      actionId,
      ...(opts.confirm ? { confirmMessage: opts.confirm } : {}),
      ...(opts.success ? { successMessage: opts.success } : {}),
    },
  };
}

function prompt(
  label: string,
  command: string,
  title: string,
  description: string,
  fields: CreateFieldConfig[],
  submitLabel: string,
): ActionNode {
  return {
    kind: "action",
    label,
    variant: "ghost",
    action: { type: "prompt-nosql-command", command, title, description, fields, submitLabel },
  };
}

export function stateStatus(state: string, paused?: unknown): ResourceStatus {
  if (paused === true) return "info";
  switch (state) {
    case "IDLE":
      return "healthy";
    case "CREATING":
    case "UPDATING":
      return "provisioning";
    case "REPAIRING":
      return "degraded";
    case "DELETING":
      return "unknown";
    default:
      return "unknown";
  }
}

function stateLabel(state: string, paused?: unknown): string {
  if (paused === true) return "Paused";
  switch (state) {
    case "IDLE":
      return "Available";
    case "CREATING":
      return "Creating";
    case "UPDATING":
      return "Updating";
    case "REPAIRING":
      return "Repairing";
    case "DELETING":
      return "Deleting";
    default:
      return state || "Unknown";
  }
}

export const ADD_ACCESS_ENTRY_FIELDS: CreateFieldConfig[] = [
  {
    key: "entry",
    label: "IP address or CIDR block",
    kind: "text",
    required: true,
    placeholder: "203.0.113.7 or 10.0.0.0/16",
    description:
      "A single address is stored as a /32. Use 0.0.0.0/0 only if you mean anyone on the internet.",
  },
  {
    key: "comment",
    label: "Comment",
    kind: "text",
    required: false,
    placeholder: "Office VPN",
  },
  {
    key: "expiresInHours",
    label: "Keep for",
    kind: "select",
    required: true,
    defaultValue: "",
    options: [
      { id: "", label: "Permanently" },
      { id: "6", label: "6 hours" },
      { id: "24", label: "1 day" },
      { id: "168", label: "1 week" },
    ],
    description: "Temporary entries are removed by Atlas when they expire.",
  },
];

export const SNAPSHOT_FIELDS: CreateFieldConfig[] = [
  {
    key: "description",
    label: "Description",
    kind: "text",
    required: true,
    defaultValue: "On-demand snapshot from Infrawrench",
  },
  {
    key: "retentionInDays",
    label: "Keep for (days)",
    kind: "number",
    required: true,
    defaultValue: "7",
    minValue: 1,
    maxValue: 365,
  },
];

function tierOptions(r: ResourceInstance): Array<{ id: string; label: string }> {
  const live = parseJson<string[]>(r.resolvedOutputs[AVAILABLE_TIERS_KEY]);
  const provider = str(r.fields["provider"]);
  const tiers = (live && live.length > 0 ? live : (TIERS_BY_PROVIDER[provider] ?? [])).filter(
    isDedicatedTier,
  );
  return tiers.map((t) => ({ id: t, label: tierLabel(t) }));
}

function renderOrganization(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const orgId = str(f["orgId"]);
  const summary = parseJson<InvoiceSummary>(r.resolvedOutputs[INVOICE_SUMMARY_KEY]);
  const recent = parseJson<Array<{ month: string; status: string; cents: number }>>(
    r.resolvedOutputs[RECENT_INVOICES_KEY],
  );
  const sections: SectionNode[] = [
    section("Organization", [
      kv([
        ["Name", f["name"]],
        ["Organization ID", orgId, true],
        ["Projects", f["projectCount"]],
      ]),
    ]),
  ];
  if (summary) {
    const table = (
      label: string,
      rows: Array<{ name: string; cents: number; extra?: string }>,
    ): SchemaNode => ({
      kind: "table",
      columns: [
        { key: "name", label, width: "wide" },
        ...(rows.some((x) => x.extra) ? [{ key: "extra", label: "Project" }] : []),
        { key: "amount", label: "Charges" },
      ],
      rows: rows.slice(0, 15).map<TableRow>((x) => ({
        cells: { name: x.name, ...(x.extra ? { extra: x.extra } : {}), amount: usd(x.cents) },
      })),
    });
    sections.push(
      section(`Pending invoice (${summary.month})`, [
        kv([["Month to date", usd(summary.totalCents)]]),
        table(
          "Service",
          summary.byService.map((x) => ({ name: x.service, cents: x.cents })),
        ),
      ]),
      section("By project", [
        table(
          "Project",
          summary.byProject.map((x) => ({ name: x.project, cents: x.cents })),
        ),
      ]),
    );
    if (summary.byCluster.length > 0) {
      sections.push(
        section("By cluster", [
          table(
            "Cluster",
            summary.byCluster.map((x) => ({ name: x.cluster, cents: x.cents, extra: x.project })),
          ),
        ]),
      );
    }
  } else {
    sections.push(
      section("Charges", [
        {
          kind: "text",
          variant: "muted",
          content:
            "Invoice details need the Organization Billing Viewer role (or Billing Admin or Owner) on the service account or API key.",
        },
      ]),
    );
  }
  if (recent && recent.length > 0) {
    sections.push(
      section("Recent invoices", [
        {
          kind: "table",
          columns: [
            { key: "month", label: "Month" },
            { key: "status", label: "Status" },
            { key: "amount", label: "Amount billed" },
          ],
          rows: recent.map<TableRow>((x) => ({
            cells: { month: x.month, status: x.status.toLowerCase(), amount: usd(x.cents) },
          })),
        },
      ]),
    );
  }
  return {
    title: r.displayName,
    subtitle: "Atlas organization",
    status: { kind: "status-dot", status: "healthy", label: "Organization" },
    sections,
    headerActions: orgId ? [openInAtlas(`${ATLAS_URL}/v2#/org/${orgId}/billing/overview`)] : [],
  };
}

function renderProject(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const groupId = str(f["groupId"]);
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Project", groupId),
    status: { kind: "status-dot", status: "healthy", label: "Project" },
    sections: [
      section("Project", [
        kv([
          ["Name", f["name"]],
          ["Project ID", groupId, true],
          ["Clusters", f["clusterCount"]],
          ["Created", f["created"]],
          ["Tags", f["tags"]],
        ]),
      ]),
    ],
    headerActions: [
      prompt(
        "+ Add IP access entry",
        "add-ip-access-entry",
        "Add IP access list entry",
        "Allow an address or range to connect to this project's clusters.",
        ADD_ACCESS_ENTRY_FIELDS,
        "Add entry",
      ),
      ...(groupId ? [openInAtlas(`${ATLAS_URL}/v2/${groupId}#/overview`)] : []),
    ],
  };
}

function renderCluster(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const groupId = str(f["groupId"]);
  const name = str(f["name"]);
  const tier = str(f["instanceSize"]);
  const dedicated = f["dedicated"] === true;
  const paused = f["paused"] === true;
  const actions: ActionNode[] = [];
  if (dedicated) {
    actions.push(
      paused
        ? pluginAction("Resume", "resume", { success: "Resuming the cluster" })
        : pluginAction("Pause", "pause", {
            confirm:
              "Pause this cluster? Connections are refused until it is resumed. Storage and backups are still billed, and Atlas resumes it automatically after 30 days.",
            success: "Pausing the cluster",
          }),
    );
    const options = tierOptions(r);
    if (options.length > 0 && !paused) {
      actions.push(
        prompt(
          "Scale tier",
          "scale-tier",
          "Scale cluster tier",
          f["autoScalingCompute"] === true
            ? "Compute auto-scaling is on, so Atlas may move the tier again within its limits. Atlas resizes one node at a time with no downtime."
            : "Atlas resizes one node at a time with no downtime.",
          [
            {
              key: "instanceSize",
              label: "Tier",
              kind: "select",
              required: true,
              defaultValue: tier,
              options,
            },
          ],
          "Scale",
        ),
      );
    }
    if (f["backupEnabled"] === true) {
      actions.push(
        prompt(
          "Take snapshot",
          "take-snapshot",
          "Take on-demand snapshot",
          "Atlas takes the snapshot now and keeps it for the number of days you choose.",
          SNAPSHOT_FIELDS,
          "Take snapshot",
        ),
      );
    }
  }
  if (groupId && name) {
    actions.push(
      openInAtlas(`${ATLAS_URL}/v2/${groupId}#/clusters/detail/${encodeURIComponent(name)}`),
    );
  }
  const autoscale =
    f["autoScalingCompute"] === true
      ? `On${f["minInstanceSize"] || f["maxInstanceSize"] ? ` (${str(f["minInstanceSize"])} to ${str(f["maxInstanceSize"])})` : ""}`
      : "Off";
  return {
    title: r.displayName,
    subtitle: joinSubtitle(tier, str(f["provider"]), str(f["region"])),
    status: {
      kind: "status-dot",
      status: stateStatus(str(f["stateName"]), f["paused"]),
      label: stateLabel(str(f["stateName"]), f["paused"]),
    },
    sections: [
      section("Cluster", [
        kv([
          ["Tier", tier],
          ["Cloud", f["provider"]],
          ["Region", f["regions"] || f["region"]],
          ["Type", f["clusterType"]],
          ["MongoDB version", f["mongoDBVersion"]],
          ["Electable nodes", f["nodeCount"]],
          ["Shards", f["shardCount"]],
          ["Storage (GB)", f["diskSizeGB"]],
          ["Project", f["projectName"]],
          ["Created", f["createDate"]],
          ["Tags", f["tags"]],
        ]),
      ]),
      section("Scaling and protection", [
        kv([
          ["Compute auto-scaling", autoscale],
          ["Storage auto-scaling", f["autoScalingDisk"]],
          ["Termination protection", f["terminationProtectionEnabled"]],
          ["Cloud backup", f["backupEnabled"]],
          ["Continuous backup", f["pitEnabled"]],
        ]),
      ]),
      section("Connect", [
        kv([
          ["Connection string (SRV)", r.resolvedOutputs["standardSrv"] ?? f["standardSrv"], true],
          ["Connection string", r.resolvedOutputs["standard"], true],
        ]),
        {
          kind: "text",
          variant: "muted",
          content:
            "The MongoDB tab browses this cluster's data through a connection user Infrawrench creates. The project's IP access list must allow Infrawrench's address.",
        },
      ]),
    ],
    headerActions: actions,
  };
}

function renderFlex(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const groupId = str(f["groupId"]);
  const name = str(f["name"]);
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Flex", str(f["provider"]), str(f["region"])),
    status: {
      kind: "status-dot",
      status: stateStatus(str(f["stateName"])),
      label: stateLabel(str(f["stateName"])),
    },
    sections: [
      section("Flex cluster", [
        kv([
          ["Cloud", f["provider"]],
          ["Region", f["region"]],
          ["MongoDB version", f["mongoDBVersion"]],
          ["Storage (GB)", f["diskSizeGB"]],
          ["Backup", f["backupEnabled"]],
          ["Termination protection", f["terminationProtectionEnabled"]],
          ["Project", f["projectName"]],
          ["Created", f["createDate"]],
          ["Connection string (SRV)", f["standardSrv"], true],
        ]),
      ]),
    ],
    headerActions:
      groupId && name
        ? [openInAtlas(`${ATLAS_URL}/v2/${groupId}#/clusters/detail/${encodeURIComponent(name)}`)]
        : [],
  };
}

function genericStatus(r: ResourceInstance): StatusDotNode {
  const f = r.fields;
  switch (r.resourceTypeId) {
    case "serverless-instance":
      return {
        kind: "status-dot",
        status: stateStatus(str(f["stateName"])),
        label: stateLabel(str(f["stateName"])),
      };
    case "backup-snapshot": {
      const s = str(f["status"]);
      return {
        kind: "status-dot",
        status:
          s === "completed"
            ? "healthy"
            : s === "failed"
              ? "error"
              : s === "queued" || s === "inProgress"
                ? "provisioning"
                : "unknown",
        label: s || "Unknown",
      };
    }
    case "alert": {
      const s = str(f["status"]);
      const sev = str(f["severity"]);
      return {
        kind: "status-dot",
        status:
          s === "OPEN"
            ? sev === "CRITICAL" || sev === "ERROR"
              ? "error"
              : "degraded"
            : s === "TRACKING"
              ? "info"
              : "healthy",
        label: f["acknowledgedUntil"]
          ? `${s.toLowerCase()} (acknowledged)`
          : s.toLowerCase() || "unknown",
      };
    }
    case "alert-configuration":
      return {
        kind: "status-dot",
        status: f["enabled"] === true ? "healthy" : "unknown",
        label: f["enabled"] === true ? "Enabled" : "Disabled",
      };
    case "search-index": {
      const s = str(f["status"]);
      return {
        kind: "status-dot",
        status:
          s === "READY"
            ? "healthy"
            : s === "FAILED"
              ? "error"
              : s === "STALE"
                ? "degraded"
                : s === "BUILDING" || s === "PENDING"
                  ? "provisioning"
                  : "unknown",
        label: s.toLowerCase() || "unknown",
      };
    }
    case "online-archive": {
      const s = str(f["state"]);
      return {
        kind: "status-dot",
        status:
          s === "ACTIVE"
            ? "healthy"
            : s === "ORPHANED"
              ? "degraded"
              : s === "PAUSED" || s === "PAUSING"
                ? "info"
                : s === "PENDING"
                  ? "provisioning"
                  : "unknown",
        label: s.toLowerCase() || "unknown",
      };
    }
    case "private-endpoint-service": {
      const s = str(f["status"]);
      return {
        kind: "status-dot",
        status:
          s === "AVAILABLE"
            ? "healthy"
            : s === "FAILED"
              ? "error"
              : s === "INITIATING" || s === "WAITING_FOR_USER"
                ? "provisioning"
                : "unknown",
        label: s.toLowerCase().replace(/_/g, " ") || "unknown",
      };
    }
    default:
      return {
        kind: "status-dot",
        status: "healthy",
        label: resourceTypeDisplayName(RESOURCE_TYPES, r.resourceTypeId),
      };
  }
}

function genericActions(r: ResourceInstance): ActionNode[] {
  const f = r.fields;
  switch (r.resourceTypeId) {
    case "alert": {
      if (str(f["status"]) !== "OPEN") return [];
      if (f["acknowledgedUntil"]) {
        return [
          pluginAction("Unacknowledge", "unacknowledge", { success: "Acknowledgement cleared" }),
        ];
      }
      return [
        prompt(
          "Acknowledge",
          "acknowledge",
          "Acknowledge alert",
          "Atlas stops notifying about this alert until the acknowledgement ends.",
          [
            {
              key: "hours",
              label: "Acknowledge for",
              kind: "select",
              required: true,
              defaultValue: "24",
              options: [
                { id: "1", label: "1 hour" },
                { id: "4", label: "4 hours" },
                { id: "24", label: "1 day" },
                { id: "168", label: "1 week" },
              ],
            },
            { key: "comment", label: "Comment", kind: "text", required: false },
          ],
          "Acknowledge",
        ),
      ];
    }
    case "alert-configuration":
      return [
        f["enabled"] === true
          ? pluginAction("Disable", "disable", {
              confirm:
                "Disable this alert configuration? It stops raising alerts until you enable it again.",
            })
          : pluginAction("Enable", "enable"),
      ];
    case "online-archive": {
      const s = str(f["state"]);
      if (s === "ACTIVE") {
        return [
          pluginAction("Pause", "pause", { confirm: "Pause archiving for this collection?" }),
        ];
      }
      if (s === "PAUSED") return [pluginAction("Resume", "resume")];
      return [];
    }
    default:
      return [];
  }
}

const HIDDEN_GENERIC = new Set(["groupId", "hasAtlasAdmin"]);

function renderGeneric(r: ResourceInstance): DetailViewSchema {
  const typeDef = RESOURCE_TYPES.find((t) => t.id === r.resourceTypeId);
  const labels = new Map((typeDef?.fields ?? []).map((x) => [x.key, x.label]));
  const items: Array<[string, unknown, boolean?]> = [];
  for (const field of typeDef?.fields ?? []) {
    if (HIDDEN_GENERIC.has(field.key)) continue;
    let value: unknown = r.fields[field.key];
    if (field.key === "storageSizeBytes") value = bytes(value);
    items.push([labels.get(field.key) ?? field.key, value, field.key.endsWith("Id")]);
  }
  items.push(["Project ID", r.fields["groupId"], true]);
  const typeName = typeDef?.displayName ?? r.resourceTypeId;
  return {
    title: r.displayName,
    subtitle: joinSubtitle(typeName, str(r.fields["clusterName"]), str(r.fields["projectName"])),
    status: genericStatus(r),
    sections: [section(typeName, [kv(items)])],
    headerActions: genericActions(r),
  };
}

export function renderAtlasDetail(r: ResourceInstance): DetailViewSchema {
  let schema: DetailViewSchema;
  let window = DEFAULT_METRICS_WINDOW_MS;
  switch (r.resourceTypeId) {
    case "organization":
      schema = renderOrganization(r);
      window = COST_METRICS_WINDOW_MS;
      break;
    case "project":
      schema = renderProject(r);
      break;
    case "cluster":
      schema = renderCluster(r);
      break;
    case "flex-cluster":
      schema = renderFlex(r);
      break;
    default:
      schema = renderGeneric(r);
  }
  return withMetricsCapability(schema, RESOURCE_TYPES, r.resourceTypeId, window);
}

export function renderAtlasSidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  const detail =
    r.resourceTypeId === "cluster" ||
    r.resourceTypeId === "flex-cluster" ||
    r.resourceTypeId === "serverless-instance"
      ? {
          kind: "status-dot" as const,
          status: stateStatus(str(f["stateName"]), f["paused"]),
          label: stateLabel(str(f["stateName"]), f["paused"]),
        }
      : genericStatus(r);
  return { id: r.id, label: r.displayName, status: detail };
}
