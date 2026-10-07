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
import { joinSubtitle } from "@infrawrench/plugin-base";
import { T } from "./resource-types.js";

/** `resolvedOutputs` keys `enrichDetail` fills with JSON picker options. */
export const ENRICH = {
  databases: "__databases",
  pcuGroups: "__pcuGroups",
  roles: "__roles",
} as const;

export const PORTAL_URL = "https://astra.datastax.com";

/** Every permission a custom role can grant (the DevOps API `PolicyAction` enum). */
export const POLICY_ACTIONS = [
  "db-all-keyspace-create",
  "db-all-keyspace-describe",
  "db-cql",
  "db-graphql",
  "db-keyspace-alter",
  "db-keyspace-authorize",
  "db-keyspace-create",
  "db-keyspace-describe",
  "db-keyspace-drop",
  "db-keyspace-grant",
  "db-keyspace-modify",
  "db-rest",
  "db-table-alter",
  "db-table-authorize",
  "db-table-create",
  "db-table-describe",
  "db-table-drop",
  "db-table-grant",
  "db-table-modify",
  "db-table-select",
  "org-audits-read",
  "org-billing-read",
  "org-billing-write",
  "org-db-addpeering",
  "org-db-create",
  "org-db-expand",
  "org-db-managemigratorproxy",
  "org-db-passwordreset",
  "org-db-suspend",
  "org-db-terminate",
  "org-db-view",
  "org-external-auth-read",
  "org-external-auth-write",
  "org-notification-write",
  "org-read",
  "org-role-delete",
  "org-role-read",
  "org-role-write",
  "org-token-read",
  "org-token-write",
  "org-user-read",
  "org-user-write",
  "org-write",
];

export function policyOptions() {
  return POLICY_ACTIONS.map((a) => ({
    id: a,
    label: a,
    category: a.startsWith("org-")
      ? "Organization"
      : a.startsWith("db-table")
        ? "Tables"
        : "Databases and keyspaces",
  }));
}

interface Pick {
  id: string;
  label: string;
  description?: string;
}

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
  if (["active", "accepted", "created", "running"].includes(s)) return "healthy";
  if (
    /pending|preparing|prepared|initializing|resuming|unparking|resizing|placing|creating/.test(s)
  ) {
    return "provisioning";
  }
  if (/error|failed|rejected|unknown/.test(s)) return "error";
  if (/hibernat|park|terminat|suspend|maintenance/.test(s)) return "degraded";
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
      title: label,
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

const refresh = () => action("Refresh", { type: "refresh-resource" });

function status(resource: ResourceInstance) {
  const s = str(resource, "status");
  return { kind: "status-dot" as const, status: statusOf(s), ...(s ? { label: s } : {}) };
}

function portal(resource: ResourceInstance, path = ""): ActionNode {
  const org = str(resource, "orgId");
  return action("Open Astra Portal", {
    type: "open-url",
    url: org ? `${PORTAL_URL}/org/${org}${path}` : PORTAL_URL,
  });
}

function renderDatabase(resource: ResourceInstance): DetailViewSchema {
  const statusValue = str(resource, "status").toUpperCase();
  const headerActions: ActionNode[] = [refresh()];
  if (statusValue === "HIBERNATED") {
    headerActions.push(
      action("Resume", {
        type: "plugin-action",
        actionId: "resume",
        successMessage: "Resume requested; the database is active again in a few minutes.",
      }),
    );
  }
  if (statusValue === "PARKED") {
    headerActions.push(
      action("Unpark", {
        type: "plugin-action",
        actionId: "unpark",
        successMessage: "Unpark requested.",
      }),
    );
  }
  headerActions.push(
    prompt("Secure connect bundle", "secure-bundle", {
      description:
        "Generates download links for the secure connect bundle CQL drivers use. The links expire after about five minutes.",
      fields: [
        {
          key: "all",
          label: "Regions",
          kind: "select",
          required: false,
          options: [
            { id: "false", label: "Primary region" },
            { id: "true", label: "Every region" },
          ],
          defaultValue: "false",
        },
      ],
      submitLabel: "Generate links",
    }),
    portal(resource, `/database/${resource.externalId ?? ""}`),
  );
  const used = num(resource, "usedStorageGb");
  const total = num(resource, "totalStorageGb");
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(
      str(resource, "dbType") === "vector" ? "Vector database" : "Serverless database",
      str(resource, "cloud"),
      str(resource, "region"),
    ),
    status: status(resource),
    sections: [
      section("Database", [
        kv([
          ["Database ID", str(resource, "databaseId")],
          ["Status", str(resource, "status")],
          ["Type", str(resource, "dbType")],
          ["Tier", str(resource, "tier")],
          ["Cloud", str(resource, "cloud")],
          ["Regions", str(resource, "regions")],
          ["Default keyspace", str(resource, "keyspace")],
          ["Keyspaces", str(resource, "keyspaces")],
          ["Created", str(resource, "createdAt")],
          ["Message", str(resource, "message")],
        ]),
      ]),
      section("Capacity", [
        kv([
          [
            "Storage used",
            used !== undefined ? `${used} GB${total ? ` of ${total} GB` : ""}` : undefined,
          ],
          ["Nodes", num(resource, "nodeCount")],
          ["Replication factor", num(resource, "replicationFactor")],
          ["PCU groups", str(resource, "pcuGroupIds")],
        ]),
      ]),
      section("Connectivity", [
        kv([
          ["API endpoint", str(resource, "dataEndpointUrl")],
          ["Access list enforced", bool(resource, "accessListEnabled")],
          ["Access list entries", num(resource, "accessListEntries")],
          ["CQL console", str(resource, "cqlshUrl")],
          ["Grafana", str(resource, "grafanaUrl")],
        ]),
      ]),
    ],
    headerActions,
  };
}

function renderRegion(resource: ResourceInstance): DetailViewSchema {
  const groups = enriched<Pick[]>(resource, ENRICH.pcuGroups) ?? [];
  const current = str(resource, "pcuGroupId");
  const headerActions: ActionNode[] = [refresh()];
  headerActions.push(
    prompt(current ? "Move to another PCU group" : "Assign PCU group", "assign-pcu", {
      description: current
        ? "Moves this region onto another PCU group in the same cloud region."
        : "Runs this region on provisioned capacity from a PCU group in the same cloud region.",
      ...(groups.filter((g) => g.id !== current).length === 0
        ? { blockedReason: "There is no other PCU group in this cloud region. Create one first." }
        : {}),
      fields: [
        {
          key: "pcuGroupId",
          label: "PCU group",
          kind: "select",
          required: true,
          options: groups.filter((g) => g.id !== current),
        },
      ],
      submitLabel: current ? "Move" : "Assign",
    }),
  );
  if (current) {
    headerActions.push(
      action("Remove from PCU group", {
        type: "plugin-action",
        actionId: "unassign-pcu",
        confirmMessage: "Return this region to on-demand serverless capacity?",
        successMessage: "Removed from the PCU group.",
      }),
    );
  }
  headerActions.push(
    prompt("Private link principals", "allow-principals", {
      description:
        "The cloud principals (for AWS, IAM ARNs) allowed to create private endpoints into this region. Saving creates the private link service if there is none yet.",
      fields: [
        {
          key: "principals",
          label: "Allowed principals",
          kind: "string-list",
          required: true,
          placeholder: "arn:aws:iam::123456789012:root",
          ...(str(resource, "allowedPrincipals")
            ? { defaultValue: str(resource, "allowedPrincipals") }
            : {}),
        },
      ],
      submitLabel: "Save",
    }),
  );
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Region", str(resource, "cloud"), str(resource, "region")),
    status: status(resource),
    sections: [
      section("Region", [
        kv([
          ["Region", str(resource, "region")],
          ["Cloud", str(resource, "cloud")],
          ["Status", str(resource, "status")],
          ["Datacenter ID", str(resource, "datacenterId")],
          ["Tier", str(resource, "tier")],
          ["Classification", str(resource, "classification")],
          ["PCU group", current],
          ["API endpoint", str(resource, "dataEndpointUrl")],
          ["Private link service", str(resource, "privateLinkService")],
          ["Private link principals", str(resource, "allowedPrincipals")],
        ]),
      ]),
    ],
    headerActions,
  };
}

function renderSimple(
  resource: ResourceInstance,
  subtitle: string,
  items: Array<[string, string]>,
): DetailViewSchema {
  return {
    title: resource.displayName,
    subtitle,
    status: status(resource),
    sections: [section(subtitle, [kv(items.map(([label, key]) => [label, str(resource, key)]))])],
    headerActions: [refresh()],
  };
}

function renderSnapshot(resource: ResourceInstance): DetailViewSchema {
  const dbs = (enriched<Pick[]>(resource, ENRICH.databases) ?? []).filter(
    (d) => d.id !== str(resource, "databaseId"),
  );
  return {
    title: resource.displayName,
    subtitle: "Snapshot",
    status: { kind: "status-dot", status: "healthy" },
    sections: [
      section("Snapshot", [
        kv([
          ["Snapshot ID", str(resource, "snapshotId")],
          ["Database", str(resource, "databaseId")],
          ["Taken", str(resource, "createdAt")],
        ]),
      ]),
    ],
    headerActions: [
      refresh(),
      prompt("Clone into a database", "clone", {
        description:
          "Replaces the data in another database with this snapshot. Everything currently in the target database is overwritten.",
        ...(dbs.length === 0 ? { blockedReason: "There is no other database to clone into." } : {}),
        fields: [
          {
            key: "targetDatabaseId",
            label: "Target database",
            kind: "select",
            required: true,
            options: dbs,
          },
        ],
        submitLabel: "Clone",
        danger: true,
      }),
    ],
  };
}

function renderPcuGroup(resource: ResourceInstance): DetailViewSchema {
  const s = str(resource, "status").toUpperCase();
  const headerActions: ActionNode[] = [refresh()];
  if (s === "PARKED") {
    headerActions.push(
      action("Unpark", {
        type: "plugin-action",
        actionId: "unpark",
        successMessage: "Unpark requested.",
      }),
    );
  } else {
    headerActions.push(
      action("Park", {
        type: "plugin-action",
        actionId: "park",
        confirmMessage:
          "Park this PCU group? Its databases stop serving requests until it is unparked, and burst capacity stops billing.",
        successMessage: "Park requested.",
      }),
    );
  }
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("PCU group", str(resource, "cloud"), str(resource, "region")),
    status: status(resource),
    sections: [
      section("Capacity", [
        kv([
          ["Status", str(resource, "status")],
          ["Instance type", str(resource, "instanceType")],
          ["Provision type", str(resource, "provisionType")],
          ["Reserved PCUs", num(resource, "reserved")],
          ["Minimum PCUs", num(resource, "min")],
          ["Maximum PCUs", num(resource, "max")],
          ["Databases", str(resource, "datacenters") || "None"],
          ["Description", str(resource, "description")],
          ["Created", str(resource, "createdAt")],
        ]),
      ]),
    ],
    headerActions,
  };
}

function rolePicker(resource: ResourceInstance, key: string, current: string): CreateFieldConfig {
  const roles = enriched<Array<Pick & { category?: string }>>(resource, ENRICH.roles) ?? [];
  return {
    key,
    label: "Roles",
    kind: "policy-picker",
    required: true,
    policies: roles,
    defaultValue: JSON.stringify(
      current
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  };
}

function renderUser(resource: ResourceInstance): DetailViewSchema {
  return {
    title: resource.displayName,
    subtitle: "Organization user",
    status: status(resource),
    sections: [
      section("User", [
        kv([
          ["Email", str(resource, "email")],
          ["User ID", str(resource, "userId")],
          ["Status", str(resource, "status")],
          ["Roles", str(resource, "roles")],
          ["Organization administrator", bool(resource, "isAdmin")],
        ]),
      ]),
    ],
    headerActions: [
      refresh(),
      prompt("Change roles", "set-roles", {
        description: "Replaces the user's organization roles.",
        fields: [rolePicker(resource, "roles", str(resource, "roleIds"))],
        submitLabel: "Save",
      }),
      action(
        "Remove from organization",
        {
          type: "plugin-action",
          actionId: "revoke",
          confirmMessage: "Remove this user from the organization?",
          successMessage: "User removed.",
          destructive: true,
        },
        "danger",
      ),
    ],
  };
}

function renderRole(resource: ResourceInstance): DetailViewSchema {
  const custom = bool(resource, "custom") === true;
  const perms = str(resource, "permissions")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const headerActions: ActionNode[] = [refresh()];
  if (custom) {
    headerActions.push(
      prompt("Edit permissions", "set-permissions", {
        description: "Replaces the role's permissions and the resources they apply to.",
        fields: [
          {
            key: "permissions",
            label: "Permissions",
            kind: "policy-picker",
            required: true,
            policies: policyOptions(),
            defaultValue: JSON.stringify(perms),
          },
          {
            key: "resources",
            label: "Resources",
            kind: "string-list",
            required: true,
            defaultValue: str(resource, "resources"),
            description:
              "drn:astra:org:<org id>, optionally narrowed, e.g. drn:astra:org:<org id>:db:<db id>.",
          },
        ],
        submitLabel: "Save",
      }),
    );
  }
  return {
    title: resource.displayName,
    subtitle: custom ? "Custom role" : "Default role",
    status: { kind: "status-dot", status: "healthy" },
    sections: [
      section("Role", [
        kv([
          ["Role ID", str(resource, "roleId")],
          ["Description", str(resource, "description")],
          ["Last updated", str(resource, "updatedAt")],
        ]),
      ]),
      section("Permissions", [
        {
          kind: "table",
          columns: [{ key: "perm", label: "Permission", mono: true }],
          rows: perms.map((perm) => ({ cells: { perm } })),
        },
      ]),
      section("Resources", [
        {
          kind: "table",
          columns: [{ key: "drn", label: "Resource", mono: true }],
          rows: str(resource, "resources")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .map((drn) => ({ cells: { drn } })),
        },
      ]),
    ],
    headerActions,
  };
}

function renderToken(resource: ResourceInstance): DetailViewSchema {
  return {
    title: resource.displayName,
    subtitle: "Application token",
    status: { kind: "status-dot", status: "healthy" },
    sections: [
      section("Token", [
        kv([
          ["Client ID", str(resource, "clientId")],
          ["Roles", str(resource, "roles")],
          ["Generated", str(resource, "createdAt")],
          ["Organization administrator", bool(resource, "isAdmin")],
        ]),
      ]),
      section("Secret", [
        {
          kind: "text",
          variant: "muted",
          content:
            "Astra shows a token's secret only when it is generated. Revoke and generate a new one to rotate it.",
        },
      ]),
    ],
    headerActions: [
      refresh(),
      action(
        "Revoke",
        {
          type: "plugin-action",
          actionId: "revoke",
          confirmMessage: "Revoke this token? Anything using it stops working immediately.",
          successMessage: "Token revoked.",
          destructive: true,
        },
        "danger",
      ),
    ],
  };
}

export function renderAstraDetail(resource: ResourceInstance): DetailViewSchema {
  switch (resource.resourceTypeId) {
    case T.database:
      return renderDatabase(resource);
    case T.region:
      return renderRegion(resource);
    case T.keyspace:
      return renderSimple(resource, "Keyspace", [
        ["Database", "databaseId"],
        ["Default keyspace", "isDefault"],
      ]);
    case T.collection:
      return {
        ...renderSimple(resource, "Collection", [
          ["Keyspace", "keyspace"],
          ["Vector dimension", "vectorDimension"],
          ["Similarity metric", "vectorMetric"],
          ["Embedding provider", "vectorize"],
          ["Lexical search", "lexical"],
          ["Reranking", "rerank"],
          ["Default ID type", "defaultIdType"],
          ["Documents (estimated)", "documentCount"],
        ]),
        status: { kind: "status-dot", status: "healthy" },
      };
    case T.accessEntry:
      return {
        ...renderSimple(resource, "Access list entry", [
          ["Address", "address"],
          ["Enabled", "enabled"],
          ["Description", "description"],
          ["Last updated", "updatedAt"],
        ]),
        status: {
          kind: "status-dot",
          status: bool(resource, "enabled") === false ? "degraded" : "healthy",
        },
      };
    case T.cdc:
      return {
        ...renderSimple(resource, "CDC table", [
          ["Keyspace", "keyspace"],
          ["Table", "table"],
          ["Streaming tenants", "tenants"],
          ["Regions", "regions"],
        ]),
        status: { kind: "status-dot", status: "healthy" },
      };
    case T.privateEndpoint:
      return renderSimple(resource, "Private endpoint", [
        ["Endpoint ID", "endpointId"],
        ["Description", "description"],
        ["Status", "status"],
        ["Link ID", "linkId"],
        ["Created", "createdAt"],
      ]);
    case T.snapshot:
      return renderSnapshot(resource);
    case T.pcuGroup:
      return renderPcuGroup(resource);
    case T.tenant:
      return renderSimple(resource, "Streaming tenant", [
        ["Cluster", "clusterName"],
        ["Cloud", "cloud"],
        ["Region", "region"],
        ["Plan", "plan"],
        ["Status", "status"],
        ["Pulsar version", "pulsarVersion"],
        ["Broker URL", "brokerServiceUrl"],
        ["Admin URL", "webServiceUrl"],
        ["WebSocket URL", "websocketUrl"],
        ["Metrics URL", "userMetricsUrl"],
      ]);
    case T.role:
      return renderRole(resource);
    case T.user:
      return renderUser(resource);
    case T.token:
      return renderToken(resource);
    default:
      return { title: resource.displayName, sections: [section("Details", [kv([])])] };
  }
}

export function renderAstraSidebar(resource: ResourceInstance): SidebarItemSchema {
  const s = str(resource, "status");
  return {
    id: resource.id,
    label: resource.displayName || resource.id,
    status: { kind: "status-dot", status: s ? statusOf(s) : "healthy" },
  };
}
