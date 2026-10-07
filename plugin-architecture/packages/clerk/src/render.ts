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

const METRICS_DEFAULT_RANGE_MS = 14 * 24 * 60 * 60 * 1000;
const DASHBOARD = "https://dashboard.clerk.com";

type Option = { id: string; label: string; description?: string };

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

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text || "{}"), null, 2);
  } catch {
    return text;
  }
}

const REFRESH: ActionNode = {
  kind: "action",
  label: "Refresh",
  action: { type: "refresh-resource" },
};
const OPEN: ActionNode = {
  kind: "action",
  label: "Open Clerk Dashboard",
  action: { type: "open-url", url: DASHBOARD },
};

function overview(resource: ResourceInstance, title: string, skip: string[] = []): SectionNode {
  const fields = Object.fromEntries(
    Object.entries(resource.fields).filter(([key]) => !skip.includes(key)),
  );
  const items = labeledFieldItems(fields, RESOURCE_TYPES, resource.resourceTypeId).map((item) =>
    / ID$/.test(item.key) ? { ...item, copyable: true } : item,
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

function select(key: string, label: string, options: Option[]): CreateFieldConfig {
  return {
    key,
    label,
    kind: "select",
    required: true,
    options,
    ...(options[0] ? { defaultValue: options[0].id } : {}),
  };
}

function prompt(
  label: string,
  command: string,
  title: string,
  fields: CreateFieldConfig[],
  danger = false,
): ActionNode {
  return {
    kind: "action",
    label,
    ...(danger ? { variant: "danger" as const } : {}),
    action: {
      type: "prompt-nosql-command",
      command,
      title,
      fields,
      submitLabel: label.replace(/…$/, ""),
      ...(danger ? { danger: true } : {}),
    },
  };
}

export function statusOf(resource: ResourceInstance): { status: ResourceStatus; label?: string } {
  const f = resource.fields;
  switch (resource.resourceTypeId) {
    case "user":
      if (f["banned"] === true) return { status: "error", label: "Banned" };
      if (f["locked"] === true) return { status: "degraded", label: "Locked" };
      return { status: "healthy" };
    case "enterprise-connection": {
      if (f["active"] !== true) return { status: "degraded", label: "Inactive" };
      const at = Date.parse(str(f["idpCertificateExpiresAt"]));
      if (Number.isFinite(at) && at <= Date.now())
        return { status: "error", label: "IdP certificate expired" };
      return { status: "healthy" };
    }
    case "invitation":
      return {
        status: str(f["status"]) === "pending" ? "provisioning" : "info",
        label: str(f["status"]),
      };
    case "instance":
      return { status: "healthy", label: str(f["environmentType"]) };
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

export function renderDetail(resource: ResourceInstance): DetailViewSchema {
  return withMetricsCapability(
    build(resource),
    RESOURCE_TYPES,
    resource.resourceTypeId,
    METRICS_DEFAULT_RANGE_MS,
  );
}

function table(
  title: string,
  columns: Array<[string, string]>,
  rows: Array<Record<string, string>>,
): SectionNode {
  return {
    kind: "section",
    title: `${title} (${rows.length})`,
    children: [
      {
        kind: "table",
        columns: columns.map(([key, label]) => ({ key, label })),
        rows: rows.map((cells) => ({ cells })),
      },
    ],
  };
}

function build(resource: ResourceInstance): DetailViewSchema {
  const f = resource.fields;
  const { status, label } = statusOf(resource);
  const base = {
    title: resource.displayName,
    status: { kind: "status-dot" as const, status, ...(label ? { label } : {}) },
  };

  switch (resource.resourceTypeId) {
    case "instance":
      return {
        ...base,
        subtitle: joinSubtitle("Clerk instance", str(f["environmentType"])),
        sections: [overview(resource, "Instance")],
        settingsEditor: {
          tabLabel: "Restrictions",
          description:
            "Sign-up restrictions, organization defaults and bot protection for this instance.",
        },
        headerActions: [
          REFRESH,
          action("Enable webhooks", "enable-webhooks", {
            confirm: "Create the Svix app that delivers this instance's webhooks? Do this once.",
            success: "Webhooks enabled. Use Get credentials to open the webhooks dashboard.",
          }),
          OPEN,
        ],
      };
    case "user": {
      const sessions = stashed<
        Array<{ id: string; lastActive: string; expires: string; client: string }>
      >(resource, "__sessions__", []);
      const memberships = stashed<Array<{ id: string; label: string; role: string }>>(
        resource,
        "__memberships__",
        [],
      );
      const orgs = stashed<Option[]>(resource, "__orgOptions__", []);
      const roles = stashed<Option[]>(resource, "__roleOptions__", []);
      const member = new Set(memberships.map((m) => m.id));
      const actions: ActionNode[] = [
        REFRESH,
        f["banned"] === true
          ? action("Unban", "unban", { success: "User unbanned." })
          : action("Ban", "ban", {
              confirm: "Ban this user? Their sessions end and they cannot sign in.",
              success: "User banned.",
              danger: true,
            }),
      ];
      if (f["locked"] === true)
        actions.push(action("Unlock", "unlock", { success: "User unlocked." }));
      else
        actions.push(
          action("Lock", "lock", {
            confirm: "Lock this user out temporarily?",
            success: "User locked.",
            danger: true,
          }),
        );
      if (f["twoFactorEnabled"] === true) {
        actions.push(
          action("Reset MFA", "disable-mfa", {
            confirm: "Remove every second factor this user enrolled?",
            success: "MFA reset.",
            danger: true,
          }),
        );
      }
      if (sessions.length > 0) {
        actions.push(
          action("Sign out everywhere", "revoke-sessions", {
            confirm: "Revoke all of this user's active sessions?",
            success: "Sessions revoked.",
            danger: true,
          }),
          prompt(
            "Revoke session…",
            "revoke-session",
            "Revoke one session",
            [
              select(
                "sessionId",
                "Session",
                sessions.map((s) => ({
                  id: s.id,
                  label: `${s.id} (active ${s.lastActive || "?"})`,
                })),
              ),
            ],
            true,
          ),
        );
      }
      const joinable = orgs.filter((o) => !member.has(o.id));
      if (joinable.length > 0 && roles.length > 0) {
        actions.push(
          prompt("Add to organization…", "add-to-organization", "Add to an organization", [
            select("organizationId", "Organization", joinable),
            select("role", "Role", roles),
          ]),
        );
      }
      if (memberships.length > 0) {
        actions.push(
          prompt(
            "Remove from organization…",
            "remove-from-organization",
            "Remove from an organization",
            [select("organizationId", "Organization", memberships)],
            true,
          ),
        );
      }
      return {
        ...base,
        subtitle: joinSubtitle("Clerk user", str(f["signInMethods"])),
        sections: [
          overview(resource, "User"),
          table(
            "Active sessions",
            [
              ["id", "Session"],
              ["lastActive", "Last active"],
              ["expires", "Expires"],
            ],
            sessions.map((s) => ({ id: s.id, lastActive: s.lastActive, expires: s.expires })),
          ),
          table(
            "Organizations",
            [
              ["name", "Organization"],
              ["role", "Role"],
            ],
            memberships.map((m) => ({ name: m.label, role: m.role })),
          ),
        ],
        headerActions: actions,
      };
    }
    case "organization": {
      const members = stashed<Array<{ id: string; label: string; role: string }>>(
        resource,
        "__members__",
        [],
      );
      const users = stashed<Option[]>(resource, "__userOptions__", []);
      const roles = stashed<Option[]>(resource, "__roleOptions__", []);
      const invitations = stashed<Array<{ id: string; label: string; role: string }>>(
        resource,
        "__invitations__",
        [],
      );
      const ids = new Set(members.map((m) => m.id));
      const actions: ActionNode[] = [REFRESH];
      const addable = users.filter((u) => !ids.has(u.id));
      if (roles.length > 0) {
        if (addable.length > 0)
          actions.push(
            prompt("Add member…", "add-member", "Add a member", [
              select("userId", "User", addable),
              select("role", "Role", roles),
            ]),
          );
        if (members.length > 0)
          actions.push(
            prompt("Change role…", "change-role", "Change a member's role", [
              select("userId", "Member", members),
              select("role", "Role", roles),
            ]),
          );
        actions.push(
          prompt("Invite…", "invite", "Invite to this organization", [
            { key: "email", label: "Email", kind: "text", required: true },
            select("role", "Role", roles),
          ]),
        );
      }
      if (members.length > 0)
        actions.push(
          prompt(
            "Remove member…",
            "remove-member",
            "Remove a member",
            [select("userId", "Member", members)],
            true,
          ),
        );
      if (invitations.length > 0)
        actions.push(
          prompt(
            "Revoke invitation…",
            "revoke-invitation",
            "Revoke a pending invitation",
            [select("invitationId", "Invitation", invitations)],
            true,
          ),
        );
      return {
        ...base,
        subtitle: joinSubtitle("Organization", str(f["slug"])),
        sections: [
          overview(resource, "Organization"),
          table(
            "Members",
            [
              ["member", "Member"],
              ["role", "Role"],
            ],
            members.map((m) => ({ member: m.label, role: m.role })),
          ),
          table(
            "Pending invitations",
            [
              ["email", "Email"],
              ["role", "Role"],
            ],
            invitations.map((i) => ({ email: i.label, role: i.role })),
          ),
        ],
        headerActions: actions,
      };
    }
    case "domain": {
      const records = stashed<
        Array<{ type: string; host: string; value: string; required: boolean }>
      >(resource, "__records__", []);
      return {
        ...base,
        subtitle: joinSubtitle(f["isSatellite"] === true ? "Satellite domain" : "Primary domain"),
        sections: [
          overview(resource, "Domain", ["dnsRecords"]),
          {
            kind: "section",
            title: "DNS records to publish",
            children: [
              {
                kind: "table",
                columns: [
                  { key: "type", label: "Type", width: "narrow" },
                  { key: "host", label: "Name", mono: true },
                  { key: "value", label: "Value", mono: true },
                  { key: "required", label: "Required", width: "narrow" },
                ],
                rows: records.map((r) => ({
                  cells: {
                    type: r.type,
                    host: r.host,
                    value: r.value,
                    required: r.required ? "yes" : "no",
                  },
                })),
              },
            ],
          },
        ],
        headerActions: [REFRESH, OPEN],
      };
    }
    case "jwt-template":
      return {
        ...base,
        subtitle: joinSubtitle("JWT template", str(f["signingAlgorithm"])),
        sections: [
          overview(resource, "Template", ["claims"]),
          {
            kind: "section",
            title: "Claims",
            children: [
              {
                kind: "text",
                variant: "mono",
                copyable: true,
                content: prettyJson(str(f["claims"])),
              },
            ],
          },
          {
            kind: "section",
            title: "Use it",
            children: [
              {
                kind: "text",
                variant: "mono",
                copyable: true,
                content: `await getToken({ template: "${str(f["name"])}" })`,
              },
            ],
          },
        ],
        headerActions: [REFRESH],
      };
    case "machine": {
      const scoped = stashed<Option[]>(resource, "__scoped__", []);
      const options = stashed<Option[]>(resource, "__machineOptions__", []);
      const has = new Set(scoped.map((s) => s.id));
      const addable = options.filter((m) => !has.has(m.id));
      const actions: ActionNode[] = [REFRESH];
      if (addable.length > 0)
        actions.push(
          prompt(
            "Allow calling…",
            "allow-machine",
            "Let this machine request tokens for another machine",
            [select("machineId", "Machine", addable)],
          ),
        );
      if (scoped.length > 0)
        actions.push(
          prompt(
            "Remove access…",
            "disallow-machine",
            "Stop this machine calling another",
            [select("machineId", "Machine", scoped)],
            true,
          ),
        );
      return {
        ...base,
        subtitle: "Machine",
        sections: [overview(resource, "Machine")],
        headerActions: actions,
      };
    }
    default:
      return {
        ...base,
        subtitle: RESOURCE_TYPES.find((t) => t.id === resource.resourceTypeId)?.displayName ?? "",
        sections: [
          overview(
            resource,
            RESOURCE_TYPES.find((t) => t.id === resource.resourceTypeId)?.displayName ?? "Resource",
          ),
        ],
        headerActions: [REFRESH],
      };
  }
}
