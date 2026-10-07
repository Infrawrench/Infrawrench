import type {
  ActionNode,
  CreateFieldConfig,
  DetailViewSchema,
  KVItem,
  ResourceInstance,
  ResourceStatus,
  ResourceTypeDefinition,
  SectionNode,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import {
  joinSubtitle,
  labeledOutputItems,
  resourceTypeDisplayName,
} from "@infrawrench/plugin-base";

/** Detail-only data from `enrichDetail`, JSON in `__` fields, never shown as fields. */
export const ENRICH_NODES = "__nodes";
export const ENRICH_ALERTS = "__alerts";
export const ENRICH_PACKAGES = "__packages";
export const ENRICH_RELEASES = "__releases";
export const ENRICH_COLLECTIONS = "__collections";
export const ENRICH_HAS_DB_KEY = "__hasDbKey";

function parseJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string" || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

const FAILED = new Set([
  "FAILED_TO_CREATE",
  "FAILED_TO_UPDATE",
  "FAILED_TO_SUSPEND",
  "FAILED_TO_RESUME",
  "FAILED_TO_SYNC",
  "NOT_FOUND",
]);

export function resourceStatus(resource: ResourceInstance): ResourceStatus {
  const s = String(resource.fields["status"] ?? "");
  switch (resource.resourceTypeId) {
    case "cluster":
      if (s === "HEALTHY") return "healthy";
      if (s === "SUSPENDED") return "info";
      if (FAILED.has(s)) return "error";
      if (s === "NOT_READY" || s === "RECOVERY_MODE" || s === "MANUAL_MAINTENANCE")
        return "degraded";
      if (s === "UNKNOWN" || !s) return "unknown";
      return "provisioning";
    case "backup":
    case "backup-restore":
      if (s === "SUCCEEDED") return "healthy";
      if (s === "RUNNING") return "provisioning";
      if (s === "SKIPPED") return "info";
      if (s) return "error";
      return "unknown";
    case "backup-schedule":
      if (s === "ACTIVE") return "healthy";
      if (s === "DISABLED") return "info";
      return s ? "error" : "unknown";
    case "hybrid-environment":
      if (s === "READY") return "healthy";
      if (s === "FAILED_TO_SYNC") return "error";
      return "provisioning";
    case "collection":
      if (s === "green") return "healthy";
      if (s === "yellow" || s === "grey") return "degraded";
      if (s === "red") return "error";
      return "unknown";
    default:
      return "info";
  }
}

function action(
  label: string,
  actionId: string,
  opts: { confirm?: string; success: string; danger?: boolean },
): ActionNode {
  return {
    kind: "action",
    label,
    action: {
      type: "plugin-action",
      actionId,
      ...(opts.confirm ? { confirmMessage: opts.confirm } : {}),
      successMessage: opts.success,
    },
    ...(opts.danger ? { variant: "danger" as const } : {}),
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
    action: { type: "prompt-nosql-command", command, title, description, fields, submitLabel },
  };
}

export interface PackageOption {
  id: string;
  label: string;
  description?: string;
}

function clusterActions(resource: ResourceInstance): ActionNode[] {
  const f = resource.fields;
  const s = String(f["status"] ?? "");
  const out: ActionNode[] = [];
  if (s === "SUSPENDED") {
    out.push(action("Resume", "unsuspend", { success: "Resume requested." }));
  } else {
    out.push(
      action("Restart", "restart", {
        confirm: "Restart every node of this cluster? Requests may fail while nodes come back.",
        success: "Restart requested.",
      }),
    );
    out.push(
      action("Suspend", "suspend", {
        confirm:
          "Suspend this cluster? It stops serving requests and compute billing stops; storage is kept.",
        success: "Suspend requested.",
        danger: true,
      }),
    );
  }
  const packages = parseJson<PackageOption[]>(f[ENRICH_PACKAGES], []);
  if (packages.length) {
    out.push(
      prompt(
        "Resize",
        "resize",
        "Resize cluster",
        "Changes the resource package of every node. Qdrant refuses a downscale that would not fit the data.",
        [
          {
            key: "packageId",
            label: "Package",
            kind: "select",
            required: true,
            defaultValue: String(f["packageId"] ?? packages[0]!.id),
            options: packages,
          },
          {
            key: "nodes",
            label: "Nodes",
            kind: "number",
            required: true,
            minValue: 1,
            defaultValue: String(f["nodes"] ?? 1),
          },
        ],
        "Resize",
      ),
    );
  }
  out.push(
    prompt(
      "Back up now",
      "createBackup",
      "Back up cluster",
      "Takes an on-demand backup. Backups are billed for storage until they expire or are deleted.",
      [
        { key: "name", label: "Name", kind: "text", required: false },
        {
          key: "retentionDays",
          label: "Keep for (days)",
          kind: "number",
          required: true,
          minValue: 1,
          maxValue: 365,
          defaultValue: "7",
        },
      ],
      "Create backup",
    ),
  );
  if (!f[ENRICH_HAS_DB_KEY]) {
    out.push(
      action("Connect Infrawrench", "mint-db-key", {
        confirm:
          "Create a database API key named infrawrench with manage access and keep it in Infrawrench? It lets Infrawrench list collections and fills the API Key output.",
        success: "Database key created. Collections appear on the next refresh.",
      }),
    );
  }
  if (f["jwtRbac"] !== true && s === "HEALTHY") {
    out.push(
      action("Enable JWT RBAC", "enable-jwt", {
        confirm:
          "Enable JWT role-based access control? The cluster restarts, and fine-grained database keys become available.",
        success: "JWT RBAC is being enabled.",
      }),
    );
  }
  return out;
}

function headerActions(resource: ResourceInstance): ActionNode[] {
  let out: ActionNode[] = [];
  const f = resource.fields;
  switch (resource.resourceTypeId) {
    case "cluster":
      out = clusterActions(resource);
      break;
    case "backup":
      if (f["status"] === "SUCCEEDED") {
        out.push(
          action("Restore into cluster", "restore", {
            confirm:
              "Restore this backup into its cluster? The cluster's current data is replaced by the backup.",
            success: "Restore started.",
            danger: true,
          }),
        );
        out.push(
          prompt(
            "Restore as new cluster",
            "createClusterFromBackup",
            "Create cluster from backup",
            "Creates a new cluster with the backup's data and the resources it was taken with.",
            [{ key: "name", label: "Cluster name", kind: "text", required: true }],
            "Create cluster",
          ),
        );
      }
      break;
    case "hybrid-environment":
      out.push(
        action("Generate bootstrap commands", "bootstrap", {
          confirm:
            "Generate the kubectl and helm commands that connect your Kubernetes cluster? Generating again rotates the access key in them.",
          success: "Commands generated. Reveal the Bootstrap Commands output to copy them.",
        }),
      );
      break;
  }
  out.push({
    kind: "action",
    label: "Open in Qdrant Cloud",
    action: { type: "open-url", url: consoleUrl(resource) },
  });
  out.push({ kind: "action", label: "Refresh", action: { type: "refresh-resource" } });
  return out;
}

function consoleUrl(resource: ResourceInstance): string {
  const f = resource.fields;
  const cluster = String(f["clusterId"] ?? "");
  switch (resource.resourceTypeId) {
    case "cluster":
    case "collection":
    case "database-api-key":
    case "backup-schedule":
      return cluster
        ? `https://cloud.qdrant.io/clusters/${cluster}/overview`
        : "https://cloud.qdrant.io/clusters";
    case "backup":
    case "backup-restore":
      return "https://cloud.qdrant.io/backups";
    case "hybrid-environment":
      return "https://cloud.qdrant.io/hybrid-cloud";
    default:
      return "https://cloud.qdrant.io";
  }
}

function detailItems(resource: ResourceInstance, types: ResourceTypeDefinition[]): KVItem[] {
  const def = types.find((t) => t.id === resource.resourceTypeId);
  const items: KVItem[] = [];
  for (const fd of def?.fields ?? []) {
    const v = resource.fields[fd.key];
    if (v === undefined || v === "") continue;
    items.push({ key: fd.label, value: typeof v === "boolean" ? (v ? "Yes" : "No") : String(v) });
  }
  return items;
}

function table(
  title: string,
  columns: Array<{ key: string; label: string; mono?: boolean }>,
  rows: Array<Record<string, string>>,
): SectionNode {
  return {
    kind: "section",
    title,
    children: [
      {
        kind: "table",
        columns: columns.map((c) => ({
          key: c.key,
          label: c.label,
          ...(c.mono ? { mono: true } : {}),
        })),
        rows: rows.map((cells) => ({ cells })),
      },
    ],
  };
}

function extraSections(resource: ResourceInstance): SectionNode[] {
  const f = resource.fields;
  const out: SectionNode[] = [];
  if (resource.resourceTypeId === "cluster" && f["statusReason"]) {
    out.push({
      kind: "section",
      title: "Status",
      children: [{ kind: "text", variant: "muted", content: String(f["statusReason"]) }],
    });
  }
  const alerts = parseJson<Array<Record<string, string>>>(f[ENRICH_ALERTS], []);
  if (alerts.length) {
    out.push(
      table(
        "Firing alerts",
        [
          { key: "severity", label: "Severity" },
          { key: "title", label: "Alert" },
          { key: "description", label: "Details" },
          { key: "at", label: "Last fired", mono: true },
        ],
        alerts,
      ),
    );
  }
  const nodes = parseJson<Array<Record<string, string>>>(f[ENRICH_NODES], []);
  if (nodes.length) {
    out.push(
      table(
        "Nodes",
        [
          { key: "name", label: "Node", mono: true },
          { key: "state", label: "State" },
          { key: "zone", label: "Zone" },
          { key: "version", label: "Version" },
          { key: "note", label: "Note" },
        ],
        nodes,
      ),
    );
  }
  const collections = parseJson<Array<Record<string, string>>>(f[ENRICH_COLLECTIONS], []);
  if (collections.length) {
    out.push(
      table(
        "Collections",
        [
          { key: "name", label: "Collection", mono: true },
          { key: "status", label: "Status" },
          { key: "points", label: "Points" },
        ],
        collections,
      ),
    );
  }
  const releases = parseJson<string[]>(f[ENRICH_RELEASES], []);
  if (releases.length) {
    out.push({
      kind: "section",
      title: "Available Qdrant versions",
      children: [
        {
          kind: "text",
          variant: "muted",
          content: `${releases.join(", ")}. Edit the cluster's Qdrant Version to upgrade.`,
        },
      ],
    });
  }
  if (resource.resourceTypeId === "collection" && !f["status"]) {
    out.push({
      kind: "section",
      title: "Collection details unavailable",
      children: [
        {
          kind: "text",
          variant: "muted",
          content:
            "Run Connect Infrawrench on the cluster so Infrawrench has a database key to read collection details with.",
        },
      ],
    });
  }
  return out;
}

export function renderQdrantDetail(
  resource: ResourceInstance,
  types: ResourceTypeDefinition[],
): DetailViewSchema {
  const f = resource.fields;
  const sections: SectionNode[] = [
    {
      kind: "section",
      title: "Details",
      children: [{ kind: "key-value-list", items: detailItems(resource, types) }],
    },
  ];
  const outputs = labeledOutputItems(
    resource.resolvedOutputs,
    types,
    resource.resourceTypeId,
  ).filter((i) => i.value !== "");
  if (outputs.length) {
    sections.push({
      kind: "section",
      title: "Connection",
      children: [{ kind: "key-value-list", items: outputs.map((i) => ({ ...i, copyable: true })) }],
    });
  }
  sections.push(...extraSections(resource));
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(
      resourceTypeDisplayName(types, resource.resourceTypeId),
      f["cloudProvider"],
      f["region"],
      f["clusterName"],
    ),
    status: { kind: "status-dot", status: resourceStatus(resource) },
    sections,
    headerActions: headerActions(resource),
    ...(resource.resourceTypeId === "cluster" ? { logs: { defaultTailLines: 200 } } : {}),
  };
}

export function renderQdrantSidebarItem(resource: ResourceInstance): SidebarItemSchema {
  return {
    id: resource.id,
    label: resource.displayName,
    status: { kind: "status-dot", status: resourceStatus(resource) },
  };
}
