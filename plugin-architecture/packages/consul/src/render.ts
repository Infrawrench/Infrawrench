import type {
  ActionNode,
  DetailViewSchema,
  KVItem,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
  TableNode,
} from "@infrawrench/plugin-base";
import { camelToTitle, joinSubtitle, withMetricsCapability } from "@infrawrench/plugin-base";
import { RESOURCE_TYPES } from "./resource-types.js";

export const COMMANDS = { editRules: "edit-rules" } as const;

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

function fieldsNode(r: ResourceInstance, skip: string[] = []): SchemaNode {
  const def = RESOURCE_TYPES.find((t) => t.id === r.resourceTypeId);
  const labels = new Map(def?.fields.map((x) => [x.key, x.label]) ?? []);
  const items: KVItem[] = [];
  for (const [key, value] of Object.entries(r.fields)) {
    if (value === "" || skip.includes(key)) continue;
    items.push({
      key: labels.get(key) ?? camelToTitle(key),
      value: typeof value === "boolean" ? (value ? "Yes" : "No") : String(value),
    });
  }
  return { kind: "key-value-list", items };
}

const section = (title: string, children: SchemaNode[]): SectionNode => ({
  kind: "section",
  title,
  children,
});
const openUrl = (label: string, url: string): ActionNode => ({
  kind: "action",
  label,
  action: { type: "open-url", url },
});

function stashedTable(
  r: ResourceInstance,
  key: string,
  cols: Array<[string, string]>,
): TableNode | null {
  let rows: Array<Record<string, string>> = [];
  try {
    rows = JSON.parse(r.resolvedOutputs[key] ?? "[]") as Array<Record<string, string>>;
  } catch {
    return null;
  }
  if (!Array.isArray(rows) || !rows.length) return null;
  return {
    kind: "table",
    columns: cols.map(([k, label]) => ({ key: k, label })),
    rows: rows.map((row) => ({ cells: Object.fromEntries(cols.map(([k]) => [k, str(row[k])])) })),
  };
}

function healthOf(
  f: ResourceInstance["fields"],
  crit = "critical",
  warn = "warning",
): { status: ResourceStatus; label: string } {
  if (Number(f[crit] ?? 0) > 0) return { status: "error", label: `${str(f[crit])} critical` };
  if (Number(f[warn] ?? 0) > 0) return { status: "degraded", label: `${str(f[warn])} warning` };
  return { status: "healthy", label: "Passing" };
}

function checkStatus(s: string): ResourceStatus {
  return s === "passing"
    ? "healthy"
    : s === "warning"
      ? "degraded"
      : s === "critical"
        ? "error"
        : "unknown";
}

export function renderConsulDetail(r: ResourceInstance, address: string): DetailViewSchema {
  const f = r.fields;
  const ui = `${address}/ui/${encodeURIComponent(str(f["datacenter"]) || "_")}`;
  const base = (subtitle: string, extra: Partial<DetailViewSchema> = {}): DetailViewSchema =>
    withMetricsCapability(
      {
        title: r.displayName || "Consul",
        subtitle,
        sections: [section("Details", [fieldsNode(r)])],
        ...extra,
      },
      RESOURCE_TYPES,
      r.resourceTypeId,
    );
  switch (r.resourceTypeId) {
    case "consul-cluster":
      return base(
        joinSubtitle("Consul", f["version"] ? `v${str(f["version"])}` : "", f["datacenter"]),
        {
          status: {
            kind: "status-dot",
            ...(!f["leader"]
              ? { status: "error" as const, label: "No leader" }
              : f["healthy"] === false
                ? { status: "degraded" as const, label: "Autopilot unhealthy" }
                : healthOf(f, "criticalChecks", "warningChecks")),
          },
          kvBrowser: {
            namespaceLabel: "Key/value store",
            defaultPageSize: 200,
            helpText:
              "Keys are listed in full under the prefix you type (folders end in /). Values are read and written as text.",
          },
          headerActions: [openUrl("Open Consul UI", `${address}/ui/`)],
        },
      );
    case "consul-node":
      return base(joinSubtitle("Node", f["address"], f["datacenter"]), {
        status: { kind: "status-dot", ...healthOf(f) },
        sections: [
          section("Details", [fieldsNode(r)]),
          ...[
            stashedTable(r, "__services__", [
              ["service", "Service"],
              ["id", "Instance"],
              ["port", "Port"],
              ["tags", "Tags"],
            ]),
          ]
            .filter((t): t is TableNode => t !== null)
            .map((t) => section("Services", [t])),
        ],
        headerActions: [
          openUrl(
            "Open in Consul UI",
            `${address}/ui/${encodeURIComponent(str(f["datacenter"]))}/nodes/${encodeURIComponent(str(f["name"]))}`,
          ),
        ],
      });
    case "consul-service":
      return base(joinSubtitle("Service", f["kind"], f["namespace"]), {
        status: { kind: "status-dot", ...healthOf(f) },
        sections: [
          section("Details", [fieldsNode(r)]),
          ...[
            stashedTable(r, "__instances__", [
              ["node", "Node"],
              ["address", "Address"],
              ["id", "Instance"],
              ["health", "Health"],
              ["tags", "Tags"],
            ]),
          ]
            .filter((t): t is TableNode => t !== null)
            .map((t) => section("Instances", [t])),
        ],
        headerActions: [
          openUrl("Open in Consul UI", `${ui}/services/${encodeURIComponent(str(f["name"]))}`),
        ],
      });
    case "consul-check":
      return base(joinSubtitle("Health check", f["node"], f["serviceName"]), {
        status: {
          kind: "status-dot",
          status: checkStatus(str(f["status"])),
          label: str(f["status"]) || "unknown",
        },
        sections: [
          section("Details", [fieldsNode(r, ["output"])]),
          ...(f["output"]
            ? [
                section("Output", [
                  { kind: "text" as const, content: str(f["output"]), variant: "mono" as const },
                ]),
              ]
            : []),
        ],
      });
    case "consul-intention":
      return base("Intention", {
        status: {
          kind: "status-dot",
          status: f["action"] === "deny" ? "error" : "healthy",
          label: f["permissions"] ? "L7 permissions" : str(f["action"]) || "allow",
        },
      });
    case "consul-config-entry":
      return base(joinSubtitle("Config entry", f["kind"]), {
        manifestEditor: { language: "json", resourceKind: "Entry" },
      });
    case "consul-acl-policy": {
      const rules = r.resolvedOutputs["rules"] ?? "";
      return base("ACL policy", {
        sections: [
          section("Details", [fieldsNode(r)]),
          ...(rules
            ? [
                section("Rules", [
                  {
                    kind: "text" as const,
                    content: rules,
                    variant: "mono" as const,
                    copyable: true,
                  },
                ]),
              ]
            : []),
        ],
        headerActions:
          f["builtIn"] === true
            ? []
            : [
                {
                  kind: "action",
                  label: "Edit rules",
                  action: {
                    type: "prompt-nosql-command",
                    command: COMMANDS.editRules,
                    title: `Edit ${r.displayName}`,
                    description:
                      "Saving replaces the rules. Tokens carrying the policy pick up the change at once.",
                    submitLabel: "Save rules",
                    fields: [
                      {
                        key: "rules",
                        label: "Rules (HCL)",
                        kind: "code",
                        codeLanguage: "hcl",
                        required: true,
                        defaultValue: rules,
                      },
                    ],
                  },
                },
              ],
      });
    }
    case "consul-session":
      return base(joinSubtitle("Session", f["node"]), {
        headerActions: f["ttl"]
          ? [
              {
                kind: "action",
                label: "Renew",
                action: {
                  type: "plugin-action",
                  actionId: "renew",
                  successMessage: "Session renewed",
                },
              },
            ]
          : [],
      });
    case "consul-peering": {
      const s = str(f["state"]);
      return base("Cluster peering", {
        status: {
          kind: "status-dot",
          status:
            s === "ACTIVE"
              ? "healthy"
              : s === "FAILING" || s === "TERMINATED"
                ? "error"
                : "provisioning",
          label: s || "unknown",
        },
      });
    }
    default:
      return base(camelToTitle(r.resourceTypeId.replace(/^consul-/, "")));
  }
}

export function renderConsulSidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  let status: ResourceStatus | undefined;
  if (r.resourceTypeId === "consul-node" || r.resourceTypeId === "consul-service")
    status = healthOf(f).status;
  if (r.resourceTypeId === "consul-check") status = checkStatus(str(f["status"]));
  return {
    id: r.id,
    label: r.displayName || r.externalId || r.id,
    ...(status ? { status: { kind: "status-dot", status } } : {}),
  };
}
