import type {
  ActionNode,
  DetailViewSchema,
  KVItem,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { formatBytes, joinSubtitle } from "@infrawrench/plugin-base";
import { T } from "./resource-types.js";

export const ENRICH = { flux: "__flux", runs: "__runs" } as const;

function str(resource: ResourceInstance, key: string): string {
  const v = resource.fields[key];
  return v === undefined || v === null ? "" : String(v);
}

function num(resource: ResourceInstance, key: string): number | undefined {
  const v = resource.fields[key];
  const n = typeof v === "number" ? v : Number(v);
  return v === undefined || v === "" || !Number.isFinite(n) ? undefined : n;
}

export function statusOf(raw: string): ResourceStatus {
  const s = raw.toLowerCase();
  if (!s) return "unknown";
  if (["active", "success", "ok"].includes(s)) return "healthy";
  if (["inactive", "canceled"].includes(s)) return "degraded";
  if (/fail|error|crit/.test(s)) return "error";
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

const refresh = () => action("Refresh", { type: "refresh-resource" });

function toggle(resource: ResourceInstance, what: string): ActionNode {
  return str(resource, "status") === "inactive"
    ? action("Activate", {
        type: "plugin-action",
        actionId: "activate",
        successMessage: `${what} activated.`,
      })
    : action("Deactivate", {
        type: "plugin-action",
        actionId: "deactivate",
        successMessage: `${what} deactivated.`,
      });
}

function status(resource: ResourceInstance) {
  const s = str(resource, "status");
  return {
    kind: "status-dot" as const,
    status: s ? statusOf(s) : "healthy",
    ...(s ? { label: s } : {}),
  };
}

function renderTask(resource: ResourceInstance): DetailViewSchema {
  const flux = resource.resolvedOutputs[ENRICH.flux] ?? "";
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(
      "Task",
      str(resource, "every") ? `every ${str(resource, "every")}` : str(resource, "cron"),
    ),
    status: status(resource),
    sections: [
      section("Schedule", [
        kv([
          ["Status", str(resource, "status")],
          ["Every", str(resource, "every")],
          ["Cron", str(resource, "cron")],
          ["Offset", str(resource, "offset")],
          ["Last run", str(resource, "lastRunStatus")],
          ["Last error", str(resource, "lastRunError")],
          ["Latest completed", str(resource, "latestCompleted")],
        ]),
      ]),
      ...(flux
        ? [
            section("Flux", [
              { kind: "text" as const, content: flux, variant: "mono" as const, copyable: true },
            ]),
          ]
        : []),
    ],
    headerActions: [
      refresh(),
      toggle(resource, "Task"),
      action("Run now", {
        type: "plugin-action",
        actionId: "run",
        successMessage: "Run requested.",
      }),
      action("Edit Flux", {
        type: "prompt-nosql-command",
        command: "set-flux",
        title: "Edit the task's Flux",
        description:
          "Replaces the task's script. The `option task = {…}` block sets its name and schedule unless Every or Cron are set on the task.",
        fields: [
          {
            key: "flux",
            label: "Flux",
            kind: "code",
            codeLanguage: "plaintext",
            required: true,
            defaultValue: flux,
          },
        ],
        submitLabel: "Save",
      }),
    ],
    logs: { defaultTailLines: 100 },
  };
}

function simple(
  resource: ResourceInstance,
  subtitle: string,
  items: Array<[string, string]>,
  extra: ActionNode[] = [],
): DetailViewSchema {
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(subtitle, str(resource, "region")),
    status: status(resource),
    sections: [section(subtitle, [kv(items.map(([l, k]) => [l, str(resource, k)]))])],
    headerActions: [refresh(), ...extra],
  };
}

export function renderInfluxDetail(resource: ResourceInstance): DetailViewSchema {
  switch (resource.resourceTypeId) {
    case T.org:
      return simple(resource, "Organization", [
        ["Organization ID", "orgId"],
        ["Storage engine", "storageEngine"],
        ["Buckets allowed", "maxBuckets"],
        ["Longest retention (days)", "maxRetentionDays"],
        ["Tasks allowed", "maxTasks"],
        ["Checks allowed", "maxChecks"],
        ["Write limit (KB/s)", "writeKBs"],
        ["Read limit (KB/s)", "readKBs"],
        ["Series cardinality limit", "cardinality"],
      ]);
    case T.bucket: {
      const bytes = num(resource, "storageBytes");
      const days = num(resource, "retentionDays");
      return {
        title: resource.displayName,
        subtitle: joinSubtitle("Bucket", str(resource, "region")),
        status: { kind: "status-dot", status: "healthy" },
        sections: [
          section("Bucket", [
            kv([
              ["Bucket ID", str(resource, "bucketId")],
              [
                "Retention",
                days === undefined ? undefined : days === 0 ? "Forever" : `${days} days`,
              ],
              ["Schema", str(resource, "schemaType")],
              ["Storage", bytes !== undefined ? formatBytes(bytes) : undefined],
              ["Description", str(resource, "description")],
              ["Created", str(resource, "createdAt")],
            ]),
          ]),
          section("Querying", [
            {
              kind: "text",
              variant: "muted",
              content:
                "The query tab runs InfluxQL against this bucket (SELECT … FROM measurement), or Flux when the text contains a pipe (from(bucket: …) |> range(…)).",
            },
          ]),
        ],
        headerActions: [refresh()],
      };
    }
    case T.token:
      return simple(
        resource,
        "API token",
        [
          ["Token ID", "tokenId"],
          ["Status", "status"],
          ["Permissions", "permissions"],
          ["User", "user"],
          ["Created", "createdAt"],
        ],
        [toggle(resource, "Token")],
      );
    case T.task:
      return renderTask(resource);
    case T.check:
      return simple(
        resource,
        "Check",
        [
          ["Type", "kind"],
          ["Status", "status"],
          ["Every", "every"],
          ["Last run", "lastRunStatus"],
          ["Last error", "lastRunError"],
          ["Description", "description"],
        ],
        [toggle(resource, "Check")],
      );
    case T.rule:
      return simple(
        resource,
        "Notification rule",
        [
          ["Type", "kind"],
          ["Status", "status"],
          ["Every", "every"],
          ["Endpoint", "endpointId"],
          ["Description", "description"],
        ],
        [toggle(resource, "Notification rule")],
      );
    case T.endpoint:
      return simple(
        resource,
        "Notification endpoint",
        [
          ["Type", "kind"],
          ["Status", "status"],
          ["URL", "url"],
          ["Description", "description"],
        ],
        [toggle(resource, "Endpoint")],
      );
    case T.dashboard:
      return simple(resource, "Dashboard", [
        ["Cells", "cells"],
        ["Description", "description"],
        ["Updated", "updatedAt"],
      ]);
    case T.telegraf:
      return simple(resource, "Telegraf configuration", [
        ["Buckets", "buckets"],
        ["Description", "description"],
      ]);
    case T.dedicatedDatabase:
      return simple(resource, "Dedicated database", [
        ["Cluster", "clusterId"],
        ["Retention (days)", "retentionDays"],
        ["Max tables", "maxTables"],
        ["Max columns per table", "maxColumnsPerTable"],
        ["Partition template", "partitionTemplate"],
      ]);
    case T.dedicatedToken:
      return simple(resource, "Dedicated database token", [
        ["Token ID", "tokenId"],
        ["Permissions", "permissions"],
        ["Created", "createdAt"],
        ["Expires", "expiresAt"],
      ]);
    default:
      return { title: resource.displayName, sections: [section("Details", [kv([])])] };
  }
}

export function renderInfluxSidebar(resource: ResourceInstance): SidebarItemSchema {
  const s = str(resource, "status");
  return {
    id: resource.id,
    label: resource.displayName || resource.id,
    status: { kind: "status-dot", status: s ? statusOf(s) : "healthy" },
  };
}
