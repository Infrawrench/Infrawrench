import type {
  ActionNode,
  DetailViewSchema,
  ResourceInstance,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { joinSubtitle, labeledFieldItems, withMetricsCapability } from "@infrawrench/plugin-base";
import type { XInstanceType } from "./api.js";
import { resourceTypes } from "./resource-types.js";

const REFRESH: ActionNode = {
  kind: "action",
  label: "Refresh",
  action: { type: "refresh-resource" },
};
export const METRICS_WINDOW_MS = 3 * 3_600_000;

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

function action(label: string, actionId: string, confirm?: string): ActionNode {
  return {
    kind: "action",
    label,
    action: { type: "plugin-action", actionId, ...(confirm ? { confirmMessage: confirm } : {}) },
  };
}

export function branchHealth(
  statusType: string,
): "healthy" | "degraded" | "error" | "provisioning" | "info" | "unknown" {
  switch (statusType) {
    case "STATUS_TYPE_HEALTHY":
      return "healthy";
    case "STATUS_TYPE_TRANSIENT":
      return "provisioning";
    case "STATUS_TYPE_FAULT":
      return "error";
    case "STATUS_TYPE_HIBERNATED":
      return "info";
    default:
      return "unknown";
  }
}

function statusLabel(statusType: string): string {
  const s = statusType.replace("STATUS_TYPE_", "").toLowerCase();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Unknown";
}

export function renderDetail(r: ResourceInstance): DetailViewSchema {
  const items = labeledFieldItems(
    Object.fromEntries(Object.entries(r.fields).filter(([k]) => !k.startsWith("_"))),
    resourceTypes,
    r.resourceTypeId,
  ).map((i) => (i.key === "Host" || i.key.endsWith("ID") ? { ...i, copyable: true } : i));
  const schema: DetailViewSchema = {
    title: r.displayName,
    subtitle: resourceTypes.find((t) => t.id === r.resourceTypeId)?.displayName ?? r.resourceTypeId,
    status: { kind: "status-dot", status: "info" },
    sections: [
      { kind: "section", title: "Details", children: [{ kind: "key-value-list", items }] },
    ],
    headerActions: [REFRESH],
  };

  if (r.resourceTypeId === "xata-branch") {
    const st = str(r, "statusType");
    const hibernated = st === "STATUS_TYPE_HIBERNATED";
    const [org, project, branch] = String(r.externalId ?? "").split("/");
    schema.subtitle = joinSubtitle("Branch", str(r, "region"), str(r, "instanceType"));
    schema.status = { kind: "status-dot", status: branchHealth(st), label: statusLabel(st) };
    const types = json<XInstanceType[]>(r, "_instanceTypes") ?? [];
    const images = json<Array<{ name: string; fullVersion: string }>>(r, "_images") ?? [];
    schema.headerActions!.push(
      {
        kind: "action",
        label: "Open in Xata",
        action: {
          type: "open-url",
          url: `https://console.xata.io/organizations/${org}/projects/${project}/branches/${branch}`,
        },
        variant: "ghost",
      },
      hibernated
        ? action("Wake", "wake")
        : action(
            "Hibernate",
            "hibernate",
            "Hibernate this branch? Connections fail until it is woken; storage is still billed.",
          ),
      action(
        "Rotate credentials",
        "rotate-credentials",
        "Rotate the branch's database password? Anything still using the old one stops connecting.",
      ),
    );
    if (types.length) {
      schema.headerActions!.push({
        kind: "action",
        label: "Change instance type",
        action: {
          type: "prompt-nosql-command",
          command: "set-instance-type",
          title: "Change instance type",
          description: "The branch restarts on the new instance type.",
          submitLabel: "Change",
          fields: [
            {
              key: "instanceType",
              label: "Instance type",
              kind: "size-picker",
              required: true,
              defaultValue: str(r, "instanceType"),
              sizes: types.map((t) => ({
                id: t.name,
                label: t.name,
                vcpus: t.vcpus,
                memoryMb: t.ram * 1024,
                priceMonthly: Math.round(t.hourlyRate * 730 * 100) / 100,
              })),
            },
          ],
        },
      });
    }
    if (images.length) {
      schema.headerActions!.push({
        kind: "action",
        label: "Change Postgres image",
        action: {
          type: "prompt-nosql-command",
          command: "set-image",
          title: "Change Postgres image",
          description:
            "Moving to a new image restarts the branch. Major-version changes cannot be undone.",
          submitLabel: "Change",
          danger: true,
          fields: [
            {
              key: "image",
              label: "Image",
              kind: "select",
              required: true,
              defaultValue: str(r, "image"),
              options: images.map((i) => ({
                id: i.name,
                label: `Postgres ${i.fullVersion} (${i.name})`,
              })),
            },
          ],
        },
      });
    }
    if (!hibernated) {
      schema.settingsEditor = {
        tabLabel: "Postgres Settings",
        description:
          "Postgres configuration parameters for this branch. Some changes restart the database.",
      };
      schema.sqlEditor = {
        connectionStringOutputKey: "__xata__",
        defaultQuery:
          "select table_schema, table_name from information_schema.tables where table_schema = 'public' limit 50;",
      };
    }
    schema.logs = { defaultTailLines: 200 };
  }

  if (r.resourceTypeId === "xata-organization") {
    const upcoming = json<{
      total?: number;
      amount_due?: number;
      currency?: string;
      target_date?: string;
      hosted_invoice_url?: string;
    }>(r, "_upcoming");
    if (upcoming) {
      schema.sections.push({
        kind: "section",
        title: "Upcoming invoice",
        children: [
          {
            kind: "key-value-list",
            items: [
              {
                key: "Total so far",
                value: `${(upcoming.total ?? upcoming.amount_due ?? 0).toFixed(2)} ${(upcoming.currency ?? "usd").toUpperCase()}`,
              },
              { key: "Bills on", value: upcoming.target_date ?? "" },
            ],
          },
        ],
      });
    }
    const status = str(r, "status");
    schema.status = {
      kind: "status-dot",
      status: status === "enabled" ? "healthy" : "error",
      label: status,
    };
  }

  if (r.resourceTypeId === "xata-invitation") {
    schema.headerActions!.push(action("Resend invitation", "resend"));
  }

  return withMetricsCapability(schema, resourceTypes, r.resourceTypeId, METRICS_WINDOW_MS);
}

export function renderSidebarItem(r: ResourceInstance): SidebarItemSchema {
  if (r.resourceTypeId === "xata-branch") {
    return {
      id: r.id,
      label: r.displayName,
      status: { kind: "status-dot", status: branchHealth(str(r, "statusType")) },
    };
  }
  return { id: r.id, label: r.displayName, status: { kind: "status-dot", status: "info" } };
}
