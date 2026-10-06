import type {
  ActionNode,
  DetailViewSchema,
  ResourceInstance,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { joinSubtitle, labeledFieldItems } from "@infrawrench/plugin-base";
import { resourceTypes } from "./resource-types.js";

const REFRESH: ActionNode = {
  kind: "action",
  label: "Refresh",
  action: { type: "refresh-resource" },
};

function str(r: ResourceInstance, k: string): string {
  const v = r.fields[k];
  return v === undefined || v === null ? "" : String(v);
}

function json<T>(r: ResourceInstance, k: string): T | undefined {
  const raw = r.fields[k];
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function action(
  label: string,
  actionId: string,
  confirm?: string,
  destructive = false,
): ActionNode {
  return {
    kind: "action",
    label,
    action: {
      type: "plugin-action",
      actionId,
      ...(confirm ? { confirmMessage: confirm } : {}),
      ...(destructive ? { destructive: true } : {}),
    },
  };
}

export function clusterHealth(
  state: string,
  op: string,
): "healthy" | "degraded" | "error" | "provisioning" | "unknown" {
  if (state === "CREATION_FAILED" || /FAILED/.test(op)) return "error";
  if (state === "CREATING" || state === "LOCKED" || /RUNNING/.test(op)) return "provisioning";
  if (state === "CREATED") return "healthy";
  return "unknown";
}

export function renderDetail(r: ResourceInstance): DetailViewSchema {
  const items = labeledFieldItems(
    Object.fromEntries(Object.entries(r.fields).filter(([k]) => !k.startsWith("_"))),
    resourceTypes,
    r.resourceTypeId,
  ).map((i) => (i.key === "SQL Host" ? { ...i, copyable: true } : i));
  const schema: DetailViewSchema = {
    title: r.displayName,
    subtitle: resourceTypes.find((t) => t.id === r.resourceTypeId)?.displayName ?? r.resourceTypeId,
    status: { kind: "status-dot", status: "info" },
    sections: [
      { kind: "section", title: "Details", children: [{ kind: "key-value-list", items }] },
    ],
    headerActions: [REFRESH],
  };

  if (r.resourceTypeId === "crdb-cluster") {
    const id = String(r.externalId ?? "");
    const upgrade = str(r, "upgradeStatus");
    schema.subtitle = joinSubtitle(str(r, "plan"), str(r, "cloudProvider"), str(r, "regions"));
    schema.status = {
      kind: "status-dot",
      status: clusterHealth(str(r, "state"), str(r, "operationStatus")),
      label: str(r, "state"),
    };
    schema.headerActions!.push({
      kind: "action",
      label: "Open in CockroachDB Cloud",
      action: { type: "open-url", url: `https://cockroachlabs.cloud/cluster/${id}/overview` },
      variant: "ghost",
    });
    const versions =
      json<Array<{ version: string; allowed_upgrades: string[] }>>(r, "_versions") ?? [];
    const current = versions.find((v) => str(r, "version").startsWith(v.version));
    const targets = current?.allowed_upgrades ?? [];
    if (upgrade === "UPGRADE_AVAILABLE" && targets.length) {
      schema.headerActions!.push({
        kind: "action",
        label: "Upgrade CockroachDB",
        action: {
          type: "prompt-nosql-command",
          command: "upgrade",
          title: "Upgrade the cluster's major version",
          description:
            "Multi-node clusters upgrade with a rolling restart; single-node clusters are briefly unavailable. You can roll back until the upgrade is finalized (automatically after 72 hours).",
          submitLabel: "Upgrade",
          fields: [
            {
              key: "version",
              label: "Version",
              kind: "select",
              required: true,
              options: targets.map((v) => ({ id: v, label: v })),
              defaultValue: targets[targets.length - 1]!,
            },
          ],
        },
      });
    }
    if (upgrade === "PENDING_FINALIZATION") {
      schema.headerActions!.push(
        action(
          "Finalize upgrade",
          "finalize-upgrade",
          "Finalize the upgrade? After this the cluster cannot be rolled back.",
        ),
        action(
          "Roll back upgrade",
          "rollback-upgrade",
          "Roll the cluster back to its previous version?",
        ),
      );
    }
    const folders = json<Array<{ id: string; name: string }>>(r, "_folders") ?? [];
    schema.headerActions!.push({
      kind: "action",
      label: "Move to folder",
      action: {
        type: "prompt-nosql-command",
        command: "move-to-folder",
        title: "Move cluster",
        submitLabel: "Move",
        fields: [
          {
            key: "folderId",
            label: "Folder",
            kind: "select",
            required: false,
            options: [
              { id: "", label: "Top level" },
              ...folders.map((f) => ({ id: f.id, label: f.name })),
            ],
            defaultValue: str(r, "folderId"),
          },
        ],
      },
    });
    if (str(r, "plan") === "ADVANCED") {
      schema.headerActions!.push(action("Enable Prometheus endpoint", "enable-prometheus"));
    }
    const nodes =
      json<Array<{ name: string; region_name: string; status: string }>>(r, "_nodes") ?? [];
    if (nodes.length) {
      schema.sections.push({
        kind: "section",
        title: "Nodes",
        children: [
          {
            kind: "table",
            columns: [
              { key: "name", label: "Node", mono: true },
              { key: "region", label: "Region" },
              { key: "status", label: "Status", width: "narrow" },
            ],
            rows: nodes.map((n) => ({
              cells: { name: n.name, region: n.region_name, status: n.status },
            })),
          },
        ],
      });
    }
    schema.customTabs = [
      {
        id: "access",
        label: "Access",
        childResourceTypeIds: ["crdb-sql-user", "crdb-allowlist-entry", "crdb-egress-rule"],
      },
      { id: "backups", label: "Backups", childResourceTypeIds: ["crdb-backup", "crdb-restore"] },
      {
        id: "operations",
        label: "Operations",
        childResourceTypeIds: ["crdb-log-export", "crdb-metric-export", "crdb-blackout-window"],
      },
    ];
  }

  if (r.resourceTypeId === "crdb-backup") {
    schema.headerActions!.push(
      action(
        "Restore cluster to this backup",
        "restore-cluster",
        "Restore the whole cluster to this backup? Data written since it was taken is lost.",
        true,
      ),
    );
  }

  if (r.resourceTypeId === "crdb-organization") {
    const inv = json<{
      period_start: string;
      status?: string;
      totals: Array<{ amount?: number; currency?: string }>;
      balances: Array<{ amount?: number; currency?: string }>;
    }>(r, "_latestInvoice");
    if (inv) {
      schema.sections.push({
        kind: "section",
        title: "Latest invoice",
        children: [
          {
            kind: "key-value-list",
            items: [
              {
                key: "Period",
                value: `${inv.period_start.slice(0, 10)} (${(inv.status ?? "").toLowerCase()})`,
              },
              ...inv.totals.map((t) => ({
                key: `Total (${t.currency ?? ""})`,
                value: (t.amount ?? 0).toFixed(2),
              })),
              ...inv.balances.map((b) => ({
                key: `Balance (${b.currency ?? ""})`,
                value: (b.amount ?? 0).toFixed(2),
              })),
            ],
          },
        ],
      });
    }
  }

  if (r.resourceTypeId === "crdb-log-export" || r.resourceTypeId === "crdb-metric-export") {
    const s = str(r, "status");
    schema.status = {
      kind: "status-dot",
      status:
        s === "ENABLED"
          ? str(r, "deliveryStatus") === "DELIVERY_UNHEALTHY"
            ? "degraded"
            : "healthy"
          : /FAIL|ERROR/.test(s)
            ? "error"
            : "provisioning",
      label: s,
    };
  }

  if (r.resourceTypeId === "crdb-restore") {
    const s = str(r, "status");
    schema.status = {
      kind: "status-dot",
      status: s === "SUCCESS" ? "healthy" : s === "FAILED" ? "error" : "provisioning",
      label: s,
    };
  }
  return schema;
}

export function renderSidebarItem(r: ResourceInstance): SidebarItemSchema {
  if (r.resourceTypeId === "crdb-cluster") {
    return {
      id: r.id,
      label: r.displayName,
      status: {
        kind: "status-dot",
        status: clusterHealth(str(r, "state"), str(r, "operationStatus")),
      },
    };
  }
  return { id: r.id, label: r.displayName, status: { kind: "status-dot", status: "info" } };
}
