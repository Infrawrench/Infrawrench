import type {
  ActionNode,
  DetailViewSchema,
  KVItem,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
  TableRow,
} from "@infrawrench/plugin-base";
import { joinSubtitle, withMetricsCapability } from "@infrawrench/plugin-base";
import { CLOUD_UI_BASE } from "./api.js";
import {
  ACCESS_KEY,
  CAPACITY_KEY,
  CONNECTIVITY_KEY,
  NAMESPACE_IDS_KEY,
  REGIONS_KEY,
  REPLICAS_KEY,
  SEARCH_ATTRIBUTES_KEY,
  permissionName,
  searchAttributeTypeName,
  stateName,
} from "./mappers.js";
import { METRICS_WINDOW_MS } from "./metrics.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import type { TcCapacityInfo, TcRegion } from "./types.js";

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

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

function muted(content: string): SchemaNode {
  return { kind: "text", variant: "muted", content };
}

function parseJson<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function openUrl(label: string, url: string): ActionNode {
  return { kind: "action", label, action: { type: "open-url", url } };
}

export function stateStatus(state: string): ResourceStatus {
  switch (state) {
    case "active":
    case "fulfilled":
    case "ok":
      return "healthy";
    case "activating":
    case "updating":
    case "deleting":
    case "adding":
    case "removing":
      return "provisioning";
    case "activation failed":
    case "update failed":
    case "delete failed":
    case "failed":
    case "error internal":
    case "error user configuration":
      return "error";
    case "suspended":
    case "expired":
    case "deleted":
      return "degraded";
    default:
      return "unknown";
  }
}

function renderAccount(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const regions = parseJson<TcRegion[]>(r.resolvedOutputs[REGIONS_KEY], []);
  return {
    title: r.displayName,
    subtitle: "Temporal Cloud account",
    status: {
      kind: "status-dot",
      status: stateStatus(str(f["state"]) || "active"),
      label: "Account",
    },
    sections: [
      section("Account", [
        kv([
          ["Account ID", f["accountId"], true],
          ["State", f["state"]],
          ["API key identity", f["identity"]],
          ["Key role", f["identityRole"]],
          ["Namespaces", f["namespaceCount"]],
          ["Legacy metrics endpoint", f["metricsUri"], true],
        ]),
        muted(
          "Costs come from Temporal Cloud billing reports, which need the Owner or Finance Admin role. With any other role, the last 90 days are estimated from usage at this account's rates (editable).",
        ),
      ]),
      ...(regions.length > 0
        ? [
            section("Regions", [
              {
                kind: "table" as const,
                columns: [
                  { key: "id", label: "Region", width: "wide" as const },
                  { key: "provider", label: "Cloud" },
                  { key: "location", label: "Location" },
                ],
                rows: regions.map<TableRow>((x) => ({
                  cells: {
                    id: str(x.id),
                    provider: str(x.cloudProvider).replace(/^CLOUD_PROVIDER_/, ""),
                    location: str(x.location),
                  },
                })),
              },
            ]),
          ]
        : []),
    ],
    headerActions: [
      openUrl("Open in Temporal Cloud", `${CLOUD_UI_BASE}/namespaces`),
      openUrl("Usage and billing", `${CLOUD_UI_BASE}/billing`),
    ],
  };
}

interface Replica {
  region?: string;
  isPrimary?: boolean;
  state?: string;
}

function namespaceActions(r: ResourceInstance): ActionNode[] {
  const f = r.fields;
  const id = r.externalId ?? "";
  const name = str(f["name"]) || id.split(".")[0] || id;
  const regions = str(f["regions"])
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const active = str(f["region"]) || regions[0] || "";
  const attributes = parseJson<Record<string, string>>(
    r.resolvedOutputs[SEARCH_ATTRIBUTES_KEY],
    {},
  );
  const allRegions = parseJson<TcRegion[]>(r.resolvedOutputs[REGIONS_KEY], []);
  const ruleOptions = parseJson<Array<{ id: string; label: string }>>(
    r.resolvedOutputs["__ruleOptions__"],
    [],
  );
  const attachedRules = parseJson<string[]>(r.resolvedOutputs[CONNECTIVITY_KEY], []);
  const actions: ActionNode[] = [
    openUrl("Open in Temporal Cloud", `${CLOUD_UI_BASE}/namespaces/${encodeURIComponent(id)}`),
    {
      kind: "action",
      label: "Add search attribute",
      action: {
        type: "prompt-nosql-command",
        command: "add-search-attribute",
        title: "Add custom search attribute",
        description:
          "Custom search attributes filter workflows in visibility queries. They cannot be removed once added, only renamed. Limits per namespace: 40 Keyword, 20 each of Int, Double, Bool and Datetime, 5 each of Text and KeywordList.",
        fields: [
          {
            key: "name",
            label: "Name",
            kind: "text",
            required: true,
            placeholder: "CustomerId",
            description: "Up to 64 characters: letters, digits, spaces and . , : - _ / @",
          },
          {
            key: "type",
            label: "Type",
            kind: "select",
            required: true,
            defaultValue: "SEARCH_ATTRIBUTE_TYPE_KEYWORD",
            options: [
              ["SEARCH_ATTRIBUTE_TYPE_KEYWORD", "Keyword"],
              ["SEARCH_ATTRIBUTE_TYPE_TEXT", "Text"],
              ["SEARCH_ATTRIBUTE_TYPE_INT", "Int"],
              ["SEARCH_ATTRIBUTE_TYPE_DOUBLE", "Double"],
              ["SEARCH_ATTRIBUTE_TYPE_BOOL", "Bool"],
              ["SEARCH_ATTRIBUTE_TYPE_DATETIME", "Datetime"],
              ["SEARCH_ATTRIBUTE_TYPE_KEYWORD_LIST", "KeywordList"],
            ].map(([value, label]) => ({ id: value as string, label: label as string })),
          },
        ],
        submitLabel: "Add",
      },
    },
  ];
  if (Object.keys(attributes).length > 0) {
    actions.push({
      kind: "action",
      label: "Rename search attribute",
      action: {
        type: "prompt-nosql-command",
        command: "rename-search-attribute",
        title: "Rename custom search attribute",
        description:
          "Workflows keep their values; queries and code that use the old name must switch to the new one.",
        fields: [
          {
            key: "existing",
            label: "Search attribute",
            kind: "select",
            required: true,
            options: Object.keys(attributes)
              .sort()
              .map((n) => ({ id: n, label: `${n} (${searchAttributeTypeName(attributes[n])})` })),
          },
          { key: "newName", label: "New name", kind: "text", required: true },
        ],
        submitLabel: "Rename",
      },
    });
  }
  if (regions.length > 1) {
    actions.push({
      kind: "action",
      label: "Fail over",
      variant: "danger",
      action: {
        type: "prompt-nosql-command",
        command: "failover",
        title: "Fail over namespace",
        description: `Moves the active region of ${id} from ${active} to the replica you pick. Clients reconnect to the new active region; in-flight work continues from replicated state, and anything not yet replicated may be delayed. Type the namespace name to confirm.`,
        descriptionVariant: "error",
        danger: true,
        fields: [
          {
            key: "region",
            label: "New active region",
            kind: "select",
            required: true,
            options: regions.filter((x) => x !== active).map((x) => ({ id: x, label: x })),
          },
          {
            key: "confirm",
            label: `Type "${name}" to confirm`,
            kind: "text",
            required: true,
          },
        ],
        submitLabel: "Fail over",
      },
    });
    actions.push({
      kind: "action",
      label: "Remove replica",
      variant: "danger",
      action: {
        type: "prompt-nosql-command",
        command: "remove-region",
        title: "Remove replica region",
        description:
          "Stops replicating the namespace to a passive region. The namespace loses high availability until a replica is added again.",
        descriptionVariant: "error",
        danger: true,
        fields: [
          {
            key: "region",
            label: "Replica",
            kind: "select",
            required: true,
            options: regions.filter((x) => x !== active).map((x) => ({ id: x, label: x })),
          },
        ],
        submitLabel: "Remove",
      },
    });
  } else if (allRegions.length > 0) {
    actions.push({
      kind: "action",
      label: "Add replica region",
      action: {
        type: "prompt-nosql-command",
        command: "add-region",
        title: "Add a replica region",
        description:
          "Replicates the namespace to a second region for high availability, so it can fail over. Replication is billed: actions and storage are charged for the replica too.",
        fields: [
          {
            key: "region",
            label: "Replica region",
            kind: "region-picker",
            required: true,
            regions: allRegions
              .filter((x) => x.id && !regions.includes(x.id))
              .map((x) => ({
                id: x.id ?? "",
                label: `${x.location ?? x.id} (${x.id})`,
                location: str(x.cloudProvider).replace(/^CLOUD_PROVIDER_/, ""),
              })),
          },
        ],
        submitLabel: "Add replica",
      },
    });
  }
  if (ruleOptions.length > 0) {
    actions.push({
      kind: "action",
      label: "Connectivity rules",
      action: {
        type: "prompt-nosql-command",
        command: "set-connectivity-rules",
        title: "Connectivity rules",
        description:
          "Which connectivity rules apply to this namespace. With none, the namespace is reachable over the public internet. Clients on a connection no attached rule allows are refused.",
        fields: [
          {
            key: "rules",
            label: "Rules",
            kind: "policy-picker",
            required: false,
            defaultValue: JSON.stringify(attachedRules),
            policies: ruleOptions.map((o) => ({ id: o.id, label: o.label })),
          },
        ],
        submitLabel: "Save",
      },
    });
  }
  return actions;
}

function renderNamespace(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const state = str(f["state"]);
  const attributes = parseJson<Record<string, string>>(
    r.resolvedOutputs[SEARCH_ATTRIBUTES_KEY],
    {},
  );
  const replicas = parseJson<Replica[]>(r.resolvedOutputs[REPLICAS_KEY], []);
  const capacity = parseJson<TcCapacityInfo | null>(r.resolvedOutputs[CAPACITY_KEY], null);
  const sections: SectionNode[] = [
    section("Namespace", [
      kv([
        ["Namespace ID", f["namespaceId"], true],
        ["Description", f["description"]],
        ["State", state],
        ["Retention", f["retentionDays"] !== undefined ? `${str(f["retentionDays"])} days` : ""],
        ["Delete protection", f["deleteProtection"]],
        ["Tags", f["tags"]],
        ["Project", f["projectId"]],
        ["Created", f["createdAt"]],
        ["Modified", f["modifiedAt"]],
      ]),
    ]),
    section("Connect", [
      kv([
        ["gRPC endpoint (API key)", f["grpcAddress"], true],
        ["gRPC endpoint (mTLS)", f["mtlsGrpcAddress"], true],
        ["Web UI", f["webAddress"], true],
        ["API key authentication", f["apiKeyAuth"]],
        ["mTLS authentication", f["mtlsAuth"]],
        ["Codec server", f["codecServerEndpoint"]],
      ]),
    ]),
    section("Regions", [
      kv([
        ["Active region", f["region"]],
        ["High availability", f["multiRegion"]],
      ]),
      ...(replicas.length > 0
        ? [
            {
              kind: "table" as const,
              columns: [
                { key: "region", label: "Region", width: "wide" as const },
                { key: "role", label: "Role" },
                { key: "state", label: "State" },
              ],
              rows: replicas.map<TableRow>((x) => ({
                cells: {
                  region: str(x.region),
                  role: x.isPrimary || x.region === f["region"] ? "Active" : "Replica",
                  state: stateName(x.state) || "",
                },
              })),
            },
          ]
        : []),
    ]),
    section("Capacity", [
      kv([
        ["Capacity mode", f["capacityMode"]],
        ["Actions per second limit", f["apsLimit"]],
        ["Average actions/s (7 days)", capacity?.stats?.aps?.mean?.toFixed(2)],
        ["p90 actions/s (7 days)", capacity?.stats?.aps?.p90?.toFixed(2)],
        ["p99 actions/s (7 days)", capacity?.stats?.aps?.p99?.toFixed(2)],
        [
          "Provisioned capacity options",
          (capacity?.modeOptions?.provisioned?.validTruValues ?? []).join(", "),
        ],
      ]),
    ]),
    section("Custom search attributes", [
      ...(Object.keys(attributes).length > 0
        ? [
            {
              kind: "table" as const,
              columns: [
                { key: "name", label: "Name", width: "wide" as const },
                { key: "type", label: "Type" },
              ],
              rows: Object.keys(attributes)
                .sort()
                .map<TableRow>((n) => ({
                  cells: { name: n, type: searchAttributeTypeName(attributes[n]) },
                })),
            },
          ]
        : [muted("No custom search attributes. Add one with the button above.")]),
    ]),
    section("Metrics", [
      muted(
        "Metrics come from the Temporal Cloud OpenMetrics endpoint, which reports only the latest minute; history builds up while the namespace is pinned to a dashboard. Schedule-to-start latency is not published, so backlog, tasks with no poller and schedule start delay stand in for it.",
      ),
    ]),
  ];
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Namespace", f["region"]),
    status: { kind: "status-dot", status: stateStatus(state), label: state || "Namespace" },
    sections,
    headerActions: namespaceActions(r),
  };
}

function accessActions(r: ResourceInstance): ActionNode[] {
  const namespaces = parseJson<string[]>(r.resolvedOutputs[NAMESPACE_IDS_KEY], []);
  if (namespaces.length === 0) return [];
  return [
    {
      kind: "action",
      label: "Namespace access",
      action: {
        type: "prompt-nosql-command",
        command: "set-namespace-access",
        title: "Set namespace access",
        description:
          "Grant, change or remove this identity's permission on one namespace. Admins and owners already have access to every namespace.",
        fields: [
          {
            key: "namespace",
            label: "Namespace",
            kind: "select",
            required: true,
            options: namespaces.map((n) => ({ id: n, label: n })),
          },
          {
            key: "permission",
            label: "Permission",
            kind: "select",
            required: true,
            defaultValue: "read",
            options: [
              { id: "read", label: "Read" },
              { id: "write", label: "Write" },
              { id: "admin", label: "Admin" },
              { id: "none", label: "No access" },
            ],
          },
        ],
        submitLabel: "Save",
      },
    },
  ];
}

function accessTable(r: ResourceInstance): SchemaNode[] {
  const access = parseJson<Record<string, { permission?: string }>>(
    r.resolvedOutputs[ACCESS_KEY],
    {},
  );
  const entries = Object.entries(access);
  if (entries.length === 0) return [muted("No namespace-level permissions.")];
  return [
    {
      kind: "table",
      columns: [
        { key: "namespace", label: "Namespace", width: "wide" },
        { key: "permission", label: "Permission" },
      ],
      rows: entries
        .sort(([a], [b]) => a.localeCompare(b))
        .map<TableRow>(([ns, a]) => ({
          cells: { namespace: ns, permission: permissionName(a.permission) },
        })),
    },
  ];
}

function renderUser(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("User", f["accountRole"]),
    status: { kind: "status-dot", status: stateStatus(str(f["state"])), label: str(f["state"]) },
    sections: [
      section("User", [
        kv([
          ["Email", f["email"], true],
          ["Account role", f["accountRole"]],
          ["Custom roles", f["customRoles"]],
          ["State", f["state"]],
          ["Invited", f["invitedAt"]],
          ["Invitation expires", f["inviteExpiresAt"]],
          ["Created", f["createdAt"]],
        ]),
      ]),
      section("Namespace access", accessTable(r)),
    ],
    headerActions: accessActions(r),
  };
}

function renderServiceAccount(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Service account", f["scope"]),
    status: { kind: "status-dot", status: stateStatus(str(f["state"])), label: str(f["state"]) },
    sections: [
      section("Service account", [
        kv([
          ["Name", f["name"]],
          ["Description", f["description"]],
          ["Scope", f["scope"]],
          ["Scoped namespace", f["scopedNamespace"]],
          ["Account role", f["accountRole"]],
          ["State", f["state"]],
          ["Created", f["createdAt"]],
        ]),
        muted(
          "Create API keys for a service account in Temporal Cloud; each key's secret is shown once.",
        ),
      ]),
      section("Namespace access", accessTable(r)),
    ],
    headerActions: accessActions(r),
  };
}

function renderApiKey(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const disabled = f["disabled"] === true;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("API key", f["ownerType"]),
    status: {
      kind: "status-dot",
      status: disabled ? "unknown" : stateStatus(str(f["state"])),
      label: disabled ? "Disabled" : str(f["state"]),
    },
    sections: [
      section("API key", [
        kv([
          ["Key ID", r.externalId, true],
          ["Name", f["displayName"]],
          ["Description", f["description"]],
          ["Owner", f["owner"]],
          ["Owner type", f["ownerType"]],
          ["Disabled", f["disabled"]],
          ["Expires", f["expiresAt"]],
          ["Created", f["createdAt"]],
        ]),
        muted(
          "Disabling a key refuses it at once without deleting it; enable it again to restore access. Temporal Cloud never shows the secret again after creation.",
        ),
      ]),
    ],
    headerActions: [
      disabled
        ? {
            kind: "action",
            label: "Enable",
            action: { type: "plugin-action", actionId: "enable", successMessage: "Key enabled." },
          }
        : {
            kind: "action",
            label: "Disable",
            variant: "danger",
            action: {
              type: "plugin-action",
              actionId: "disable",
              confirmMessage:
                "Disable this API key? Every client using it is refused until you enable it again.",
              successMessage: "Key disabled.",
            },
          },
    ],
  };
}

function renderExportSink(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const enabled = f["enabled"] === true;
  const health = str(f["health"]);
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Export sink", f["destination"]),
    status: {
      kind: "status-dot",
      status: !enabled ? "unknown" : health ? stateStatus(health) : "info",
      label: !enabled ? "Disabled" : health || "Enabled",
    },
    sections: [
      section("Export sink", [
        kv([
          ["Namespace", f["namespaceId"]],
          ["Destination", f["destination"]],
          ["Bucket", f["bucketName"], true],
          ["Bucket region", f["bucketRegion"]],
          ["IAM role", f["roleName"]],
          ["AWS account", f["awsAccountId"]],
          ["KMS key", f["kmsArn"]],
          ["GCP project", f["gcpProjectId"]],
          ["Service account", f["serviceAccountId"]],
          ["Health", health],
          ["Error", f["errorMessage"]],
          ["Last export", f["latestExportAt"]],
          ["Last health check", f["lastHealthCheckAt"]],
        ]),
      ]),
    ],
    headerActions: [
      {
        kind: "action",
        label: "Validate access",
        action: {
          type: "plugin-action",
          actionId: "validate",
          successMessage: "Temporal Cloud can write to this destination.",
        },
      },
      enabled
        ? {
            kind: "action",
            label: "Disable",
            action: {
              type: "plugin-action",
              actionId: "disable",
              confirmMessage: "Stop exporting workflow histories to this sink?",
            },
          }
        : {
            kind: "action",
            label: "Enable",
            action: { type: "plugin-action", actionId: "enable" },
          },
    ],
  };
}

function renderNexusEndpoint(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: "Nexus endpoint",
    status: { kind: "status-dot", status: stateStatus(str(f["state"])), label: str(f["state"]) },
    sections: [
      section("Nexus endpoint", [
        kv([
          ["Endpoint ID", r.externalId, true],
          ["Name", f["name"], true],
          ["Target namespace", f["targetNamespace"]],
          ["Target task queue", f["taskQueue"]],
          ["Allowed callers", f["allowedCallers"]],
          ["Description", f["description"]],
          ["Created", f["createdAt"]],
        ]),
      ]),
    ],
    headerActions: [openUrl("Open in Temporal Cloud", `${CLOUD_UI_BASE}/nexus`)],
  };
}

function renderConnectivityRule(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Connectivity rule", f["type"]),
    status: { kind: "status-dot", status: stateStatus(str(f["state"])), label: str(f["state"]) },
    sections: [
      section("Connectivity rule", [
        kv([
          ["Rule ID", r.externalId, true],
          ["Type", f["type"]],
          ["Region", f["region"]],
          ["Connection ID", f["connectionId"], true],
          ["GCP project", f["gcpProjectId"]],
          ["Stable IPs", f["stableIps"]],
          ["Attached to", f["namespaces"]],
          ["Created", f["createdAt"]],
        ]),
        muted("Attach the rule to namespaces from each namespace's Connectivity rules button."),
      ]),
    ],
  };
}

export function renderTemporalDetail(r: ResourceInstance): DetailViewSchema {
  let schema: DetailViewSchema;
  switch (r.resourceTypeId) {
    case "account":
      schema = renderAccount(r);
      break;
    case "namespace":
      schema = renderNamespace(r);
      break;
    case "export-sink":
      schema = renderExportSink(r);
      break;
    case "user":
      schema = renderUser(r);
      break;
    case "service-account":
      schema = renderServiceAccount(r);
      break;
    case "api-key":
      schema = renderApiKey(r);
      break;
    case "nexus-endpoint":
      schema = renderNexusEndpoint(r);
      break;
    case "connectivity-rule":
      schema = renderConnectivityRule(r);
      break;
    default:
      schema = {
        title: r.displayName,
        sections: [section("Details", [kv(Object.entries(r.fields).map(([k, v]) => [k, v]))])],
      };
  }
  return withMetricsCapability(schema, RESOURCE_TYPES, r.resourceTypeId, METRICS_WINDOW_MS);
}

export function renderTemporalSidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  const item = (status: ResourceStatus, label: string): SidebarItemSchema => ({
    id: r.id,
    label: r.displayName || r.id,
    status: { kind: "status-dot", status, label },
  });
  switch (r.resourceTypeId) {
    case "namespace":
      return item(stateStatus(str(f["state"])), str(f["region"]) || str(f["state"]));
    case "export-sink":
      return f["enabled"] === true
        ? item(stateStatus(str(f["health"])), str(f["health"]) || "Enabled")
        : item("unknown", "Disabled");
    case "api-key":
      return f["disabled"] === true
        ? item("unknown", "Disabled")
        : item(stateStatus(str(f["state"])), str(f["owner"]) || "Key");
    case "user":
    case "service-account":
      return item(stateStatus(str(f["state"])), str(f["accountRole"]) || str(f["scope"]));
    default:
      return item(stateStatus(str(f["state"]) || "active"), str(f["state"]) || "");
  }
}
