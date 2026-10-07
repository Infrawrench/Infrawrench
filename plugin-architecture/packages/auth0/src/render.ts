import type {
  ActionNode,
  CreateFieldConfig,
  DetailViewSchema,
  ResourceInstance,
  ResourceStatus,
  SectionNode,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { joinSubtitle, labeledFieldItems, withMetricsCapability } from "@infrawrench/plugin-base";
import { RESOURCE_TYPES } from "./resources.js";

const METRICS_DEFAULT_RANGE_MS = 30 * 24 * 60 * 60 * 1000;

type Option = { id: string; label: string; description?: string; category?: string };

function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function stashed<T>(resource: ResourceInstance, key: string, fallback: T): T {
  const raw = resource.resolvedOutputs[key];
  if (!raw) return fallback;
  try {
    return (JSON.parse(raw) as T) ?? fallback;
  } catch {
    return fallback;
  }
}

const REFRESH: ActionNode = {
  kind: "action",
  label: "Refresh",
  action: { type: "refresh-resource" },
};

function overview(resource: ResourceInstance, title: string): SectionNode {
  const items = labeledFieldItems(resource.fields, RESOURCE_TYPES, resource.resourceTypeId).map(
    (item) => (/ ID$/.test(item.key) ? { ...item, copyable: true } : item),
  );
  return { kind: "section", title, children: [{ kind: "key-value-list", items }] };
}

function action(
  label: string,
  actionId: string,
  opts: { confirm?: string; success?: string; danger?: boolean } = {},
): ActionNode {
  return {
    kind: "action",
    label,
    ...(opts.danger ? { variant: "danger" as const } : {}),
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
  fields: CreateFieldConfig[],
  opts: { danger?: boolean; description?: string } = {},
): ActionNode {
  return {
    kind: "action",
    label,
    ...(opts.danger ? { variant: "danger" as const } : {}),
    action: {
      type: "prompt-nosql-command",
      command,
      title,
      fields,
      ...(opts.description ? { description: opts.description } : {}),
      submitLabel: label.replace(/…$/, ""),
      ...(opts.danger ? { danger: true } : {}),
    },
  };
}

function picker(key: string, label: string, options: Option[]): CreateFieldConfig {
  return {
    key,
    label,
    kind: "policy-picker",
    required: true,
    policies: options.map((o) => ({
      id: o.id,
      label: o.label,
      ...(o.description ? { description: o.description } : {}),
      ...(o.category ? { category: o.category } : {}),
    })),
  };
}

function listTable(title: string, column: string, rows: string[]): SectionNode {
  return {
    kind: "section",
    title: `${title} (${rows.length})`,
    children: [
      {
        kind: "table",
        columns: [{ key: "v", label: column }],
        rows: rows.map((v) => ({ cells: { v } })),
      },
    ],
  };
}

export function statusOf(resource: ResourceInstance): { status: ResourceStatus; label?: string } {
  const f = resource.fields;
  switch (resource.resourceTypeId) {
    case "user":
      if (f["blocked"] === true) return { status: "error", label: "Blocked" };
      if (f["emailVerified"] !== true) return { status: "degraded", label: "Email unverified" };
      return { status: "healthy" };
    case "action": {
      const s = str(f["status"]);
      if (s === "failed") return { status: "error", label: "Build failed" };
      if (s === "building" || s === "pending" || s === "retrying")
        return { status: "provisioning", label: s };
      if (f["deployed"] !== true) return { status: "degraded", label: "Not deployed" };
      if (f["allChangesDeployed"] !== true)
        return { status: "degraded", label: "Undeployed changes" };
      return { status: "healthy" };
    }
    case "log-stream": {
      const s = str(f["status"]);
      if (s === "suspended") return { status: "error", label: "Suspended" };
      if (s === "paused") return { status: "degraded", label: "Paused" };
      return { status: "healthy" };
    }
    case "custom-domain": {
      const s = str(f["status"]);
      if (s === "ready") return { status: "healthy" };
      if (s === "failed") return { status: "error", label: "Failed" };
      return { status: "provisioning", label: "Pending verification" };
    }
    default:
      return { status: "healthy" };
  }
}

export function renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
  const { status, label } = statusOf(resource);
  return {
    id: resource.id,
    label: resource.displayName,
    status: { kind: "status-dot", status, ...(label ? { label } : {}) },
  };
}

export function renderDetail(resource: ResourceInstance, domain: string): DetailViewSchema {
  return withMetricsCapability(
    build(resource, domain),
    RESOURCE_TYPES,
    resource.resourceTypeId,
    METRICS_DEFAULT_RANGE_MS,
  );
}

function dashboard(domain: string, path: string): ActionNode {
  // manage.auth0.com/dashboard/{region}/{tenant}/… ; the bare form redirects to the right tenant once signed in.
  const [tenant = "", region = "us"] = domain.split(".");
  const regionPart = /^[a-z]{2}$/.test(region) ? region : "us";
  return {
    kind: "action",
    label: "Open in Auth0",
    action: {
      type: "open-url",
      url: `https://manage.auth0.com/dashboard/${regionPart}/${tenant}${path}`,
    },
  };
}

function build(resource: ResourceInstance, domain: string): DetailViewSchema {
  const f = resource.fields;
  const id = resource.externalId ?? "";
  const { status, label } = statusOf(resource);
  const base = {
    title: resource.displayName,
    status: { kind: "status-dot" as const, status, ...(label ? { label } : {}) },
  };

  switch (resource.resourceTypeId) {
    case "tenant":
      return {
        ...base,
        subtitle: joinSubtitle("Auth0 tenant", str(f["domain"]), str(f["region"]).toUpperCase()),
        sections: [overview(resource, "Tenant")],
        logs: { defaultTailLines: 100 },
        settingsEditor: {
          tabLabel: "Security",
          description:
            "Attack protection and tenant flags. Changes apply immediately to every application.",
        },
        headerActions: [REFRESH, dashboard(domain, "/")],
      };
    case "application":
      return {
        ...base,
        subtitle: joinSubtitle("Application", str(f["appType"])),
        sections: [overview(resource, "Application")],
        logs: { defaultTailLines: 100 },
        headerActions: [
          REFRESH,
          action("Rotate secret", "rotate-secret", {
            confirm: "Issue a new client secret? The current one stops working immediately.",
            success: "Client secret rotated.",
            danger: true,
          }),
          dashboard(domain, `/applications/${id}/settings`),
        ],
      };
    case "api": {
      const scopes = stashed<Array<{ value?: string; description?: string }>>(
        resource,
        "__scopes__",
        [],
      );
      return {
        ...base,
        subtitle: joinSubtitle("API", str(f["identifier"])),
        sections: [
          overview(resource, "API"),
          {
            kind: "section",
            title: `Permissions (${scopes.length})`,
            children: [
              {
                kind: "table",
                columns: [
                  { key: "value", label: "Permission", mono: true },
                  { key: "description", label: "Description" },
                ],
                rows: scopes.map((s) => ({
                  cells: { value: str(s.value), description: str(s.description) },
                })),
              },
            ],
          },
        ],
        headerActions: [
          REFRESH,
          ...(f["isSystem"] === true
            ? []
            : [
                prompt(
                  "Edit permissions…",
                  "set-scopes",
                  "Permissions (scopes)",
                  [
                    {
                      key: "scopes",
                      label: "Permissions",
                      kind: "string-list",
                      required: false,
                      addLabel: "+ Add permission",
                      defaultValue: scopes.map((s) => str(s.value)).join(","),
                    },
                  ],
                  {
                    description:
                      "Replaces the API's permission list. Removing one also removes it from every role.",
                  },
                ),
              ]),
        ],
      };
    }
    case "connection": {
      const enabled = stashed<string[]>(resource, "__enabledClients__", []);
      const clients = stashed<Option[]>(resource, "__clientOptions__", []);
      const names = new Map(clients.map((c) => [c.id, c.label]));
      const connStatus = str(resource.resolvedOutputs["__status__"]);
      const on = new Set(enabled);
      const actions: ActionNode[] = [REFRESH];
      const off = clients.filter((c) => !on.has(c.id));
      if (off.length > 0)
        actions.push(
          prompt("Enable for apps…", "enable-clients", "Enable this connection for applications", [
            picker("clients", "Applications", off),
          ]),
        );
      if (enabled.length > 0) {
        actions.push(
          prompt(
            "Disable for apps…",
            "disable-clients",
            "Disable this connection for applications",
            [
              picker(
                "clients",
                "Applications",
                enabled.map((e) => ({ id: e, label: names.get(e) ?? e })),
              ),
            ],
            { danger: true },
          ),
        );
      }
      return {
        ...base,
        ...(connStatus === "offline"
          ? { status: { kind: "status-dot" as const, status: "error" as const, label: "Offline" } }
          : {}),
        subtitle: joinSubtitle("Connection", str(f["strategy"])),
        sections: [
          overview(resource, "Connection"),
          listTable(
            "Enabled applications",
            "Application",
            enabled.map((e) => names.get(e) ?? e),
          ),
        ],
        logs: { defaultTailLines: 100 },
        headerActions: actions,
      };
    }
    case "user": {
      const roles = stashed<Option[]>(resource, "__roles__", []);
      const options = stashed<Option[]>(resource, "__roleOptions__", []);
      const has = new Set(roles.map((r) => r.id));
      const blocked = f["blocked"] === true;
      const actions: ActionNode[] = [
        REFRESH,
        blocked
          ? action("Unblock", "unblock", { success: "User unblocked." })
          : action("Block", "block", {
              confirm: "Block this user? They cannot sign in until unblocked.",
              success: "User blocked.",
              danger: true,
            }),
      ];
      if (f["emailVerified"] !== true)
        actions.push(
          action("Send verification email", "send-verification", {
            success: "Verification email queued.",
          }),
        );
      actions.push(
        action("Reset MFA", "reset-mfa", {
          confirm: "Delete every authentication method this user enrolled?",
          success: "MFA reset.",
          danger: true,
        }),
      );
      const addable = options.filter((r) => !has.has(r.id));
      if (addable.length > 0)
        actions.push(
          prompt("Assign roles…", "assign-roles", "Assign roles", [
            picker("roles", "Roles", addable),
          ]),
        );
      if (roles.length > 0)
        actions.push(
          prompt(
            "Remove roles…",
            "remove-roles",
            "Remove roles",
            [picker("roles", "Roles", roles)],
            { danger: true },
          ),
        );
      return {
        ...base,
        subtitle: joinSubtitle("User", str(f["connection"])),
        sections: [
          overview(resource, "User"),
          listTable(
            "Roles",
            "Role",
            roles.map((r) => r.label),
          ),
        ],
        logs: { defaultTailLines: 100 },
        headerActions: [...actions, dashboard(domain, `/users/${encodeURIComponent(btoa(id))}`)],
      };
    }
    case "role": {
      const granted = stashed<string[]>(resource, "__granted__", []);
      const options = stashed<Option[]>(resource, "__permissionOptions__", []);
      const has = new Set(granted);
      const addable = options.filter((o) => !has.has(o.id));
      const label = (gid: string) => {
        const bar = gid.lastIndexOf("|");
        return `${gid.slice(bar + 1)} (${gid.slice(0, bar)})`;
      };
      const actions: ActionNode[] = [REFRESH];
      if (addable.length > 0)
        actions.push(
          prompt("Add permissions…", "add-permissions", "Add API permissions", [
            picker("permissions", "Permissions", addable),
          ]),
        );
      if (granted.length > 0) {
        actions.push(
          prompt(
            "Remove permissions…",
            "remove-permissions",
            "Remove API permissions",
            [
              picker(
                "permissions",
                "Permissions",
                granted.map((g) => ({ id: g, label: label(g) })),
              ),
            ],
            { danger: true },
          ),
        );
      }
      return {
        ...base,
        subtitle: "Role",
        sections: [
          overview(resource, "Role"),
          listTable("Permissions", "Permission", granted.map(label)),
        ],
        headerActions: actions,
      };
    }
    case "organization": {
      const members = stashed<Option[]>(resource, "__members__", []);
      const users = stashed<Option[]>(resource, "__userOptions__", []);
      const connections = stashed<Option[]>(resource, "__connectionOptions__", []);
      const enabled = stashed<Option[]>(resource, "__enabledConnections__", []);
      const clients = stashed<Option[]>(resource, "__clientOptions__", []);
      const memberIds = new Set(members.map((m) => m.id));
      const enabledIds = new Set(enabled.map((c) => c.id));
      const actions: ActionNode[] = [REFRESH];
      const addable = users.filter((u) => !memberIds.has(u.id));
      if (addable.length > 0)
        actions.push(
          prompt("Add members…", "add-members", "Add members", [picker("users", "Users", addable)]),
        );
      if (members.length > 0)
        actions.push(
          prompt(
            "Remove members…",
            "remove-members",
            "Remove members",
            [picker("users", "Members", members)],
            { danger: true },
          ),
        );
      if (clients.length > 0) {
        actions.push(
          prompt("Invite…", "invite", "Invite someone to this organization", [
            { key: "email", label: "Email", kind: "text", required: true },
            {
              key: "clientId",
              label: "Application",
              kind: "select",
              required: true,
              options: clients,
              ...(clients[0] ? { defaultValue: clients[0].id } : {}),
            },
            {
              key: "inviter",
              label: "Invited by",
              kind: "text",
              required: false,
              placeholder: "Your name",
            },
          ]),
        );
      }
      const off = connections.filter((c) => !enabledIds.has(c.id));
      if (off.length > 0) {
        actions.push(
          prompt(
            "Enable connection…",
            "enable-connection",
            "Enable a connection for this organization",
            [
              {
                key: "connectionId",
                label: "Connection",
                kind: "select",
                required: true,
                options: off,
                ...(off[0] ? { defaultValue: off[0].id } : {}),
              },
              {
                key: "autoMembership",
                label: "Add users as members on first login",
                kind: "select",
                required: false,
                defaultValue: "false",
                options: [
                  { id: "false", label: "No" },
                  { id: "true", label: "Yes" },
                ],
              },
            ],
          ),
        );
      }
      if (enabled.length > 0) {
        actions.push(
          prompt(
            "Disable connection…",
            "disable-connection",
            "Disable a connection",
            [
              {
                key: "connectionId",
                label: "Connection",
                kind: "select",
                required: true,
                options: enabled,
                ...(enabled[0] ? { defaultValue: enabled[0].id } : {}),
              },
            ],
            { danger: true },
          ),
        );
      }
      return {
        ...base,
        subtitle: joinSubtitle("Organization", str(f["name"])),
        sections: [
          overview(resource, "Organization"),
          listTable(
            "Members",
            "Member",
            members.map((m) => m.label),
          ),
          listTable(
            "Enabled connections",
            "Connection",
            enabled.map((c) => c.label),
          ),
        ],
        logs: { defaultTailLines: 100 },
        headerActions: actions,
      };
    }
    case "action": {
      const code = str(resource.resolvedOutputs["__code__"]);
      const bound = f["bound"] === true;
      return {
        ...base,
        subtitle: joinSubtitle("Action", str(f["trigger"])),
        sections: [
          overview(resource, "Action"),
          {
            kind: "section",
            title: "Code",
            children: [
              { kind: "text", variant: "mono", content: code || "(empty)", copyable: true },
            ],
          },
        ],
        headerActions: [
          REFRESH,
          prompt("Edit code…", "edit-code", "Edit action code", [
            {
              key: "code",
              label: "Code",
              kind: "code",
              codeLanguage: "javascript",
              required: true,
              defaultValue: code,
            },
            {
              key: "deploy",
              label: "After saving",
              kind: "select",
              required: false,
              defaultValue: "true",
              options: [
                { id: "true", label: "Deploy the new version" },
                { id: "false", label: "Save as a draft" },
              ],
            },
          ]),
          action("Deploy", "deploy", { success: "Deploy started." }),
          bound
            ? action("Remove from flow", "unbind", {
                confirm: "Remove this action from its trigger's flow?",
                success: "Removed from flow.",
                danger: true,
              })
            : action("Add to flow", "bind", {
                confirm: "Add this action to the end of its trigger's flow? Deploy it first.",
                success: "Added to flow.",
              }),
        ],
      };
    }
    case "log-stream": {
      const s = str(f["status"]);
      return {
        ...base,
        subtitle: joinSubtitle("Log stream", str(f["type"])),
        sections: [overview(resource, "Log stream")],
        headerActions: [
          REFRESH,
          s === "active"
            ? action("Pause", "pause", { success: "Stream paused." })
            : action(s === "suspended" ? "Resume (clear suspension)" : "Resume", "resume", {
                success: "Stream resumed.",
              }),
        ],
      };
    }
    case "custom-domain": {
      const methods = stashed<Array<{ name?: string; record?: string; domain?: string }>>(
        resource,
        "__verification__",
        [],
      );
      const error = str(resource.resolvedOutputs["__verificationError__"]);
      const rows = methods.map((m) => ({
        cells: {
          type: str(m.name).toUpperCase(),
          name: str(m.domain) || str(f["domain"]),
          value: str(m.record),
        },
      }));
      if (f["originDomainName"]) {
        rows.push({
          cells: { type: "CNAME", name: str(f["domain"]), value: str(f["originDomainName"]) },
        });
      }
      return {
        ...base,
        subtitle: joinSubtitle("Custom domain", str(f["type"])),
        sections: [
          overview(resource, "Custom domain"),
          {
            kind: "section",
            title: "DNS records to publish",
            children: [
              {
                kind: "table",
                columns: [
                  { key: "type", label: "Type", width: "narrow" },
                  { key: "name", label: "Name", mono: true },
                  { key: "value", label: "Value", mono: true },
                ],
                rows,
              },
              ...(error
                ? [{ kind: "text" as const, variant: "muted" as const, content: error }]
                : []),
            ],
          },
        ],
        headerActions: [
          REFRESH,
          ...(str(f["status"]) === "ready"
            ? []
            : [action("Verify", "verify", { success: "Verification requested." })]),
        ],
      };
    }
    default:
      return { ...base, sections: [overview(resource, "Resource")], headerActions: [REFRESH] };
  }
}
