import type {
  ActionNode,
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

export const ENRICH_NODES = "__nodes";
export const ENRICH_PROPERTIES = "__properties";
export const ENRICH_SHARDS = "__shards";
export const ENRICH_PERMISSIONS = "__permissions";
export const ENRICH_COLLECTIONS = "__collectionNames";

function parseJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string" || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

export function resourceStatus(resource: ResourceInstance): ResourceStatus {
  const f = resource.fields;
  const s = String(f["status"] ?? f["activityStatus"] ?? "");
  switch (resource.resourceTypeId) {
    case "cluster":
      if (s === "HEALTHY") return "healthy";
      if (s === "DEGRADED") return "degraded";
      if (s === "UNAVAILABLE") return "error";
      return "unknown";
    case "tenant":
      if (s === "ACTIVE") return "healthy";
      if (s === "OFFLOADING" || s === "ONLOADING") return "provisioning";
      return "info";
    case "backup":
      if (s === "SUCCESS") return "healthy";
      if (s === "FAILED") return "error";
      if (s === "CANCELED" || s === "CANCELLING") return "info";
      return "provisioning";
    case "db-user":
      return f["active"] === false ? "info" : "healthy";
    case "collection":
      return Number(f["vectorQueueLength"] ?? 0) > 0 ? "provisioning" : "healthy";
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

function headerActions(resource: ResourceInstance): ActionNode[] {
  const f = resource.fields;
  const out: ActionNode[] = [];
  switch (resource.resourceTypeId) {
    case "cluster": {
      const collections = parseJson<string[]>(f[ENRICH_COLLECTIONS], []);
      out.push({
        kind: "action",
        label: "Back up now",
        action: {
          type: "prompt-nosql-command",
          command: "createBackup",
          title: "Back up the cluster",
          description:
            "Writes a backup through the cluster's backup module. Leave collections empty to include every collection.",
          fields: [
            {
              key: "id",
              label: "Backup ID",
              kind: "text",
              required: true,
              placeholder: `backup-${new Date().toISOString().slice(0, 10)}`,
              description: "Lowercase letters, digits, hyphens and underscores",
            },
            {
              key: "include",
              label: "Collections",
              kind: "policy-picker",
              required: false,
              policies: collections.map((c) => ({ id: c, label: c })),
            },
          ],
          submitLabel: "Start backup",
        },
      });
      break;
    }
    case "backup":
      if (f["status"] === "SUCCESS") {
        out.push(
          action("Restore", "restore", {
            confirm:
              "Restore this backup? Collections in it must not exist on the cluster, so delete or rename them first.",
            success: "Restore started.",
            danger: true,
          }),
        );
      } else if (!["FAILED", "CANCELED", "CANCELLING"].includes(String(f["status"] ?? ""))) {
        out.push(
          action("Cancel", "cancel", {
            confirm: "Cancel this backup?",
            success: "Cancellation requested.",
            danger: true,
          }),
        );
      }
      break;
    case "db-user":
      out.push(
        action("Rotate API key", "rotate-key", {
          confirm: "Rotate this user's API key? The current key stops working at once.",
          success: "Key rotated. The new key is in the API Key output.",
          danger: true,
        }),
      );
      out.push(
        f["active"] === false
          ? action("Activate", "activate", { success: "User activated." })
          : action("Deactivate", "deactivate", {
              confirm:
                "Deactivate this user? Requests with its key are refused until it is activated.",
              success: "User deactivated.",
              danger: true,
            }),
      );
      break;
    case "tenant":
      if (f["activityStatus"] !== "ACTIVE") {
        out.push(action("Activate", "activate", { success: "Tenant activating." }));
      } else {
        out.push(
          action("Deactivate", "deactivate", {
            confirm: "Deactivate this tenant? It stops answering queries until it is activated.",
            success: "Tenant deactivated.",
          }),
        );
      }
      break;
  }
  out.push({
    kind: "action",
    label: "Open Weaviate Cloud console",
    action: { type: "open-url", url: "https://console.weaviate.cloud/" },
  });
  out.push({ kind: "action", label: "Refresh", action: { type: "refresh-resource" } });
  return out;
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
  const nodes = parseJson<Array<Record<string, string>>>(f[ENRICH_NODES], []);
  if (nodes.length) {
    out.push(
      table(
        "Nodes",
        [
          { key: "name", label: "Node", mono: true },
          { key: "status", label: "Status" },
          { key: "version", label: "Version" },
          { key: "objects", label: "Objects" },
          { key: "shards", label: "Shards" },
          { key: "mode", label: "Mode" },
        ],
        nodes,
      ),
    );
  }
  const props = parseJson<Array<Record<string, string>>>(f[ENRICH_PROPERTIES], []);
  if (props.length) {
    out.push(
      table(
        "Properties",
        [
          { key: "name", label: "Property", mono: true },
          { key: "type", label: "Type" },
          { key: "tokenization", label: "Tokenization" },
          { key: "indexes", label: "Indexes" },
        ],
        props,
      ),
    );
  }
  const shards = parseJson<Array<Record<string, string>>>(f[ENRICH_SHARDS], []);
  if (shards.length) {
    out.push(
      table(
        "Shards",
        [
          { key: "node", label: "Node", mono: true },
          { key: "name", label: "Shard", mono: true },
          { key: "objects", label: "Objects" },
          { key: "indexing", label: "Vector indexing" },
          { key: "queue", label: "Queue" },
        ],
        shards,
      ),
    );
  }
  const perms = parseJson<Array<Record<string, string>>>(f[ENRICH_PERMISSIONS], []);
  if (perms.length) {
    out.push(
      table(
        "Permissions",
        [
          { key: "action", label: "Action", mono: true },
          { key: "scope", label: "Applies to" },
        ],
        perms,
      ),
    );
  }
  if (resource.resourceTypeId === "cluster") {
    out.push({
      kind: "section",
      title: "Cluster management",
      children: [
        {
          kind: "text",
          variant: "muted",
          content:
            "Weaviate Cloud has no public management API, so creating, resizing, upgrading and deleting clusters happens in the Weaviate Cloud console. Everything inside the cluster (collections, tenants, aliases, backups, users and roles) is managed here.",
        },
      ],
    });
  }
  return out;
}

export function renderWeaviateDetail(
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
      f["version"],
      f["region"],
      f["collection"],
    ),
    status: { kind: "status-dot", status: resourceStatus(resource) },
    sections,
    headerActions: headerActions(resource),
  };
}

export function renderWeaviateSidebarItem(resource: ResourceInstance): SidebarItemSchema {
  return {
    id: resource.id,
    label: resource.displayName,
    status: { kind: "status-dot", status: resourceStatus(resource) },
  };
}
