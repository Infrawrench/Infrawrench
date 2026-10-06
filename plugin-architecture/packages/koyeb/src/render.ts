import type {
  ActionNode,
  CreateFieldConfig,
  DetailViewSchema,
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
import { fieldItems, parseJson, pluginAction } from "./kit.js";

/** Detail-only data from `enrichDetail`, as JSON strings in `__` fields. */
export const ENRICH = {
  quotas: "__quotas",
  invoice: "__invoice",
  roles: "__roles",
} as const;

const IN_PROGRESS = new Set([
  "PENDING",
  "PROVISIONING",
  "SCHEDULED",
  "ALLOCATING",
  "STARTING",
  "CANCELING",
  "STOPPING",
]);

export function resourceStatus(resource: ResourceInstance): ResourceStatus {
  const s = String(resource.fields["status"] ?? "").toUpperCase();
  switch (resource.resourceTypeId) {
    case "app":
    case "service":
    case "deployment":
    case "instance":
      if (s === "HEALTHY") return "healthy";
      if (s === "DEGRADED") return "degraded";
      if (s === "UNHEALTHY" || s === "ERROR" || s === "ERRORING") return "error";
      if (
        s === "PAUSED" ||
        s === "SLEEPING" ||
        s === "STOPPED" ||
        s === "CANCELED" ||
        s === "STASHED"
      )
        return "info";
      if (IN_PROGRESS.has(s) || s === "RESUMING" || s === "PAUSING") return "provisioning";
      return "info";
    case "domain":
      if (s === "ACTIVE") return "healthy";
      if (s === "ERROR") return "error";
      return "provisioning";
    case "volume":
    case "snapshot": {
      const v = s.toLowerCase();
      if (v === "attached" || v === "available") return "healthy";
      if (v === "detached") return "info";
      return "provisioning";
    }
    case "organization":
      return s === "ACTIVE" ? "healthy" : s === "WARNING" ? "degraded" : "error";
    default:
      return "info";
  }
}

function prompt(
  label: string,
  command: string,
  description: string,
  fields: CreateFieldConfig[],
  submitLabel: string,
): ActionNode {
  return {
    kind: "action",
    label,
    action: {
      type: "prompt-nosql-command",
      command,
      title: label,
      description,
      fields,
      submitLabel,
    },
  };
}

function headerActions(resource: ResourceInstance): ActionNode[] {
  const f = resource.fields;
  const s = String(f["status"] ?? "");
  const actions: ActionNode[] = [];
  switch (resource.resourceTypeId) {
    case "app":
    case "service":
      if (resource.resourceTypeId === "service" && s !== "PAUSED") {
        actions.push(
          pluginAction("Redeploy", "redeploy", { success: "Redeploy started." }),
          pluginAction("Rebuild Without Cache", "redeploy-no-cache", {
            success: "Rebuild started without the build cache.",
          }),
        );
        if (f["type"] !== "DATABASE") {
          actions.push(
            prompt(
              "Set Instances",
              "scale",
              "Run a fixed number of instances per region. Edit min and max instances to change autoscaling instead.",
              [
                {
                  key: "instances",
                  label: "Instances",
                  kind: "number",
                  required: true,
                  minValue: 0,
                  defaultValue: String(f["minScale"] ?? 1),
                },
              ],
              "Scale",
            ),
          );
        }
      }
      actions.push(
        s === "PAUSED" || s === "PAUSING"
          ? pluginAction("Resume", "resume", { success: "Resume requested." })
          : pluginAction("Pause", "pause", {
              confirm:
                resource.resourceTypeId === "app"
                  ? "Pause every service in this app? Paused services stop billing for compute."
                  : "Pause this service? It stops serving and stops billing for compute.",
              success: "Pause requested.",
              danger: true,
            }),
      );
      break;
    case "deployment":
      if (IN_PROGRESS.has(s)) {
        actions.push(
          pluginAction("Cancel", "cancel", {
            confirm: "Cancel this deployment?",
            success: "Cancellation requested.",
            danger: true,
          }),
        );
      }
      if (f["active"] !== true && (s === "STOPPED" || s === "HEALTHY" || s === "STASHED")) {
        actions.push(
          pluginAction("Redeploy This Version", "rollback", {
            confirm: "Deploy this version's definition (and commit) again?",
            success: "Rollback deployment started.",
          }),
        );
      }
      break;
    case "domain":
      if (f["type"] === "CUSTOM") {
        actions.push(pluginAction("Check DNS", "refresh", { success: "Domain check requested." }));
      }
      break;
    case "volume":
      actions.push(
        prompt(
          "Take Snapshot",
          "snapshot",
          "Snapshot the volume. Snapshots can seed new volumes.",
          [
            {
              key: "name",
              label: "Snapshot name",
              kind: "text",
              required: true,
              defaultValue: `${String(f["name"] ?? "volume")}-snapshot`,
            },
          ],
          "Snapshot",
        ),
      );
      break;
  }
  const url = consoleUrl(resource);
  if (url)
    actions.push({ kind: "action", label: "Open in Koyeb", action: { type: "open-url", url } });
  actions.push({ kind: "action", label: "Refresh", action: { type: "refresh-resource" } });
  return actions;
}

export function consoleUrl(resource: ResourceInstance): string | null {
  const f = resource.fields;
  switch (resource.resourceTypeId) {
    case "service":
      return `https://app.koyeb.com/services/${resource.externalId}`;
    case "app":
      return `https://app.koyeb.com/apps/${resource.externalId}`;
    case "deployment":
    case "instance":
      return f["serviceId"] ? `https://app.koyeb.com/services/${String(f["serviceId"])}` : null;
    case "secret":
      return "https://app.koyeb.com/secrets";
    case "domain":
      return "https://app.koyeb.com/domains";
    case "volume":
    case "snapshot":
      return "https://app.koyeb.com/volumes";
    case "organization":
      return "https://app.koyeb.com/settings";
    default:
      return null;
  }
}

function enrichedSections(resource: ResourceInstance): SectionNode[] {
  const f = resource.fields;
  const out: SectionNode[] = [];
  const quotas = parseJson<Array<{ name: string; used: number; limit: number; unit?: string }>>(
    f[ENRICH.quotas],
    [],
  );
  if (quotas.length) {
    out.push({
      kind: "section",
      title: "Quotas",
      children: [
        {
          kind: "table",
          columns: [
            { key: "name", label: "Limit" },
            { key: "used", label: "Used" },
            { key: "limit", label: "Allowed" },
          ],
          rows: quotas.map((q) => ({
            cells: {
              name: q.name,
              used: `${q.used}${q.unit ? ` ${q.unit}` : ""}`,
              limit: String(q.limit),
            },
          })),
        },
      ],
    });
  }
  const invoice = parseJson<Array<{ label: string; amount: number; quantity?: number }>>(
    f[ENRICH.invoice],
    [],
  );
  if (invoice.length) {
    out.push({
      kind: "section",
      title: "Current Invoice",
      children: [
        {
          kind: "table",
          columns: [
            { key: "label", label: "Item" },
            { key: "quantity", label: "Quantity" },
            { key: "amount", label: "Amount (USD)" },
          ],
          rows: invoice.map((l) => ({
            cells: {
              label: l.label,
              quantity: l.quantity !== undefined ? String(l.quantity) : "",
              amount: l.amount.toFixed(2),
            },
          })),
        },
      ],
    });
  }
  const roles = parseJson<string[]>(f[ENRICH.roles], []);
  if (roles.length) {
    out.push({
      kind: "section",
      title: "Database Roles",
      children: [{ kind: "text", content: roles.join(", "), variant: "mono" }],
    });
  }
  return out;
}

const LOG_TYPES = new Set(["service", "deployment", "instance"]);

export function renderKoyebDetail(
  resource: ResourceInstance,
  resourceTypes: ResourceTypeDefinition[],
): DetailViewSchema {
  const f = resource.fields;
  const sections: SectionNode[] = [
    {
      kind: "section",
      title: "Details",
      children: [{ kind: "key-value-list", items: fieldItems(resource, resourceTypes) }],
    },
  ];
  const outputs = labeledOutputItems(
    resource.resolvedOutputs,
    resourceTypes,
    resource.resourceTypeId,
  ).filter((i) => i.value !== "");
  if (outputs.length) {
    sections.push({
      kind: "section",
      title: "Endpoints",
      children: [{ kind: "key-value-list", items: outputs.map((i) => ({ ...i, copyable: true })) }],
    });
  }
  sections.push(...enrichedSections(resource));
  const hasLogs = LOG_TYPES.has(resource.resourceTypeId) && f["type"] !== "DATABASE";
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(
      resourceTypeDisplayName(resourceTypes, resource.resourceTypeId),
      f["type"] ? String(f["type"]).toLowerCase() : undefined,
      f["appName"],
      f["regions"] || f["region"],
    ),
    status: {
      kind: "status-dot",
      status: resourceStatus(resource),
      ...(f["status"] ? { label: String(f["status"]).toLowerCase() } : {}),
    },
    sections,
    headerActions: headerActions(resource),
    ...(hasLogs ? { logs: { defaultTailLines: 200 } } : {}),
  };
}

export function renderKoyebSidebarItem(resource: ResourceInstance): SidebarItemSchema {
  return {
    id: resource.id,
    label: resource.displayName || resource.id,
    status: { kind: "status-dot", status: resourceStatus(resource) },
  };
}
