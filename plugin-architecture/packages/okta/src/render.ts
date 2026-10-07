import type {
  ActionNode,
  DetailViewSchema,
  ResourceInstance,
  ResourceStatus,
  SectionNode,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { joinSubtitle, labeledFieldItems, withMetricsCapability } from "@infrawrench/plugin-base";
import { RESOURCE_TYPES } from "./resources.js";

const DASH = "—";
const METRICS_DEFAULT_RANGE_MS = 24 * 60 * 60 * 1000;

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
  opts: { confirm?: string; success?: string; danger?: boolean; destructive?: boolean } = {},
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
      ...(opts.destructive ? { destructive: true } : {}),
    },
  };
}

function prompt(
  label: string,
  command: string,
  title: string,
  key: string,
  fieldLabel: string,
  options: Array<{ id: string; label: string }>,
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
      fields: [
        {
          key,
          label: fieldLabel,
          kind: "select",
          required: true,
          options,
          ...(options[0] ? { defaultValue: options[0].id } : {}),
        },
      ],
      submitLabel: label.replace(/…$/, ""),
      ...(danger ? { danger: true } : {}),
    },
  };
}

function lifecycleActions(resource: ResourceInstance, noun: string): ActionNode[] {
  const active = resource.fields["status"] === "ACTIVE";
  return [
    active
      ? action("Deactivate", "deactivate", {
          confirm: `Deactivate this ${noun}?`,
          success: `${noun} deactivated.`,
          danger: true,
        })
      : action("Activate", "activate", { success: `${noun} activated.` }),
  ];
}

export function statusOf(resource: ResourceInstance): { status: ResourceStatus; label?: string } {
  const f = resource.fields;
  const s = str(f["status"]);
  switch (resource.resourceTypeId) {
    case "user":
      switch (s) {
        case "ACTIVE":
          return { status: "healthy" };
        case "STAGED":
        case "PROVISIONED":
        case "RECOVERY":
          return { status: "provisioning", label: s.toLowerCase() };
        case "LOCKED_OUT":
          return { status: "error", label: "Locked out" };
        case "PASSWORD_EXPIRED":
          return { status: "degraded", label: "Password expired" };
        case "SUSPENDED":
        case "DEPROVISIONED":
          return { status: "degraded", label: s.toLowerCase() };
        default:
          return { status: "info" };
      }
    case "domain": {
      const v = str(f["validationStatus"]);
      if (v === "VERIFIED" || v === "COMPLETED") return { status: "healthy" };
      if (v === "IN_PROGRESS" || v === "NOT_STARTED")
        return { status: "provisioning", label: "Awaiting DNS" };
      return { status: "info" };
    }
    case "api-token": {
      const at = Date.parse(str(f["expiresAt"]));
      if (Number.isFinite(at) && at <= Date.now()) return { status: "error", label: "Expired" };
      if (Number.isFinite(at) && at - Date.now() < 7 * 86_400_000)
        return { status: "degraded", label: "Expires soon" };
      return { status: "healthy" };
    }
    case "event-hook":
      if (s !== "ACTIVE") return { status: "degraded", label: "Inactive" };
      if (str(f["verificationStatus"]) !== "VERIFIED")
        return { status: "provisioning", label: "Unverified" };
      return { status: "healthy" };
    case "org":
    case "group":
      return { status: "healthy" };
    default:
      if (s === "ACTIVE") return { status: "healthy" };
      if (s === "INACTIVE") return { status: "degraded", label: "Inactive" };
      return { status: "info" };
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

export function renderDetail(resource: ResourceInstance, orgUrl: string): DetailViewSchema {
  return withMetricsCapability(
    build(resource, orgUrl),
    RESOURCE_TYPES,
    resource.resourceTypeId,
    METRICS_DEFAULT_RANGE_MS,
  );
}

function adminUrl(orgUrl: string, path: string): string {
  const url = new URL(orgUrl);
  const host = url.host.replace(/^([^.]+)\./, "$1-admin.");
  return `${url.protocol}//${host}${path}`;
}

function build(resource: ResourceInstance, orgUrl: string): DetailViewSchema {
  const f = resource.fields;
  const id = resource.externalId ?? "";
  const { status, label } = statusOf(resource);
  const base = {
    title: resource.displayName,
    status: { kind: "status-dot" as const, status, ...(label ? { label } : {}) },
  };
  const open = (path: string): ActionNode => ({
    kind: "action",
    label: "Open in Okta",
    action: { type: "open-url", url: adminUrl(orgUrl, path) },
  });

  switch (resource.resourceTypeId) {
    case "org":
      return {
        ...base,
        subtitle: joinSubtitle("Okta org", str(f["subdomain"])),
        sections: [overview(resource, "Organization")],
        logs: { defaultTailLines: 200 },
        headerActions: [REFRESH, open("/admin/dashboard")],
      };
    case "user": {
      const groups = stashed<Array<{ id: string; label: string; type: string }>>(
        resource,
        "__groups__",
        [],
      );
      const options = stashed<Array<{ id: string; label: string }>>(
        resource,
        "__groupOptions__",
        [],
      );
      const member = new Set(groups.map((g) => g.id));
      const s = str(f["status"]);
      const actions: ActionNode[] = [REFRESH];
      if (s === "STAGED" || s === "PROVISIONED")
        actions.push(action("Activate", "activate", { success: "Activation email sent." }));
      if (s === "DEPROVISIONED")
        actions.push(action("Reactivate", "reactivate", { success: "Activation email sent." }));
      if (s === "SUSPENDED")
        actions.push(action("Unsuspend", "unsuspend", { success: "User unsuspended." }));
      if (s === "LOCKED_OUT")
        actions.push(action("Unlock", "unlock", { success: "User unlocked." }));
      if (s === "ACTIVE" || s === "PASSWORD_EXPIRED" || s === "LOCKED_OUT" || s === "RECOVERY") {
        actions.push(
          action("Reset password", "reset-password", {
            confirm: "Email this user a password reset link?",
            success: "Reset email sent.",
          }),
          action("Expire password", "expire-password", {
            confirm: "Force a password change at next sign-in?",
            success: "Password expired.",
          }),
          action("Reset MFA", "reset-factors", {
            confirm: "Remove every enrolled MFA factor for this user?",
            success: "Factors reset.",
            danger: true,
          }),
          action("Sign out everywhere", "clear-sessions", {
            confirm: "End all sessions and revoke OAuth tokens for this user?",
            success: "Sessions cleared.",
            danger: true,
          }),
          action("Suspend", "suspend", {
            confirm: "Suspend this user? They cannot sign in until unsuspended.",
            success: "User suspended.",
            danger: true,
          }),
        );
      }
      if (s !== "DEPROVISIONED") {
        actions.push(
          action("Deactivate", "deactivate", {
            confirm: "Deactivate this user and unassign every app?",
            success: "User deactivated.",
            danger: true,
            destructive: true,
          }),
        );
      }
      const addable = options.filter((g) => !member.has(g.id));
      if (addable.length > 0)
        actions.push(
          prompt(
            "Add to group…",
            "add-to-group",
            "Add to an Okta group",
            "groupId",
            "Group",
            addable,
          ),
        );
      const removable = groups.filter((g) => g.type === "OKTA_GROUP");
      if (removable.length > 0)
        actions.push(
          prompt(
            "Remove from group…",
            "remove-from-group",
            "Remove from an Okta group",
            "groupId",
            "Group",
            removable,
            true,
          ),
        );
      return {
        ...base,
        subtitle: joinSubtitle("Okta user", str(f["email"])),
        sections: [
          overview(resource, "User"),
          {
            kind: "section",
            title: `Groups (${groups.length})`,
            children: [
              {
                kind: "table",
                columns: [
                  { key: "name", label: "Group" },
                  { key: "type", label: "Type", width: "narrow" },
                ],
                rows: groups.map((g) => ({ cells: { name: g.label, type: g.type } })),
              },
            ],
          },
        ],
        logs: { defaultTailLines: 100 },
        headerActions: [...actions, open(`/admin/user/profile/view/${id}`)],
      };
    }
    case "group": {
      const members = stashed<Array<{ id: string; label: string; status: string }>>(
        resource,
        "__members__",
        [],
      );
      const candidates = stashed<Array<{ id: string; label: string }>>(
        resource,
        "__candidates__",
        [],
      );
      const editable = f["type"] === "OKTA_GROUP";
      const actions: ActionNode[] = [REFRESH];
      if (editable && candidates.length > 0)
        actions.push(
          prompt(
            "Add member…",
            "add-member",
            "Add a user to this group",
            "userId",
            "User",
            candidates,
          ),
        );
      if (editable && members.length > 0)
        actions.push(
          prompt(
            "Remove member…",
            "remove-member",
            "Remove a user from this group",
            "userId",
            "User",
            members,
            true,
          ),
        );
      return {
        ...base,
        subtitle: joinSubtitle("Okta group", str(f["type"])),
        sections: [
          overview(resource, "Group"),
          {
            kind: "section",
            title: `Members${members.length >= 600 ? " (first 600)" : ` (${members.length})`}`,
            children: [
              {
                kind: "table",
                columns: [
                  { key: "login", label: "Login" },
                  { key: "status", label: "Status", width: "narrow" },
                ],
                rows: members.map((m) => ({ cells: { login: m.label, status: m.status } })),
              },
            ],
          },
        ],
        logs: { defaultTailLines: 100 },
        headerActions: [...actions, open(`/admin/group/${id}`)],
      };
    }
    case "app": {
      const assigned = stashed<Array<{ id: string; label: string }>>(resource, "__assigned__", []);
      const options = stashed<Array<{ id: string; label: string }>>(
        resource,
        "__groupOptions__",
        [],
      );
      const has = new Set(assigned.map((g) => g.id));
      const actions: ActionNode[] = [REFRESH, ...lifecycleActions(resource, "app")];
      const addable = options.filter((g) => !has.has(g.id));
      if (addable.length > 0)
        actions.push(
          prompt(
            "Assign group…",
            "assign-group",
            "Assign a group to this app",
            "groupId",
            "Group",
            addable,
          ),
        );
      if (assigned.length > 0)
        actions.push(
          prompt(
            "Unassign group…",
            "unassign-group",
            "Unassign a group",
            "groupId",
            "Group",
            assigned,
            true,
          ),
        );
      return {
        ...base,
        subtitle: joinSubtitle("Okta app", str(f["signOnMode"])),
        sections: [
          overview(resource, "Application"),
          {
            kind: "section",
            title: `Assigned groups (${assigned.length})`,
            children: [
              {
                kind: "table",
                columns: [{ key: "name", label: "Group" }],
                rows: assigned.map((g) => ({ cells: { name: g.label } })),
              },
            ],
          },
        ],
        logs: { defaultTailLines: 100 },
        headerActions: [...actions, open(`/admin/app/${str(f["name"])}/instance/${id}`)],
      };
    }
    case "authorization-server": {
      const scopes = stashed<
        Array<{
          id?: string;
          name?: string;
          description?: string;
          system?: boolean;
          default?: boolean;
        }>
      >(resource, "__scopes__", []);
      const policies = stashed<Array<{ name: string; status: string; priority?: number }>>(
        resource,
        "__policies__",
        [],
      );
      const custom = scopes.filter((s) => !s.system);
      const actions: ActionNode[] = [
        REFRESH,
        ...lifecycleActions(resource, "authorization server"),
        action("Rotate signing keys", "rotate-keys", {
          confirm: "Rotate the signing key now? Clients that cache JWKS must refresh.",
          success: "Signing key rotated.",
        }),
        {
          kind: "action",
          label: "Add scope…",
          action: {
            type: "prompt-nosql-command",
            command: "add-scope",
            title: "Add a custom scope",
            fields: [
              {
                key: "name",
                label: "Name",
                kind: "text",
                required: true,
                placeholder: "invoices:read",
              },
              { key: "description", label: "Description", kind: "text", required: false },
            ],
            submitLabel: "Add scope",
          },
        },
      ];
      if (custom.length > 0) {
        actions.push(
          prompt(
            "Delete scope…",
            "delete-scope",
            "Delete a custom scope",
            "scopeId",
            "Scope",
            custom.map((s) => ({ id: str(s.id), label: str(s.name) })),
            true,
          ),
        );
      }
      return {
        ...base,
        subtitle: joinSubtitle("Authorization server", str(f["audiences"])),
        sections: [
          overview(resource, "Authorization server"),
          {
            kind: "section",
            title: `Scopes (${scopes.length})`,
            children: [
              {
                kind: "table",
                columns: [
                  { key: "name", label: "Scope", mono: true },
                  { key: "description", label: "Description" },
                  { key: "kind", label: "Kind", width: "narrow" },
                ],
                rows: scopes.map((s) => ({
                  cells: {
                    name: str(s.name),
                    description: str(s.description) || DASH,
                    kind: s.system ? "system" : s.default ? "default" : "custom",
                  },
                })),
              },
            ],
          },
          {
            kind: "section",
            title: "Access policies",
            children: [
              {
                kind: "table",
                columns: [
                  { key: "priority", label: "#", width: "narrow" },
                  { key: "name", label: "Policy" },
                  { key: "status", label: "Status", width: "narrow" },
                ],
                rows: policies.map((p) => ({
                  cells: { priority: str(p.priority), name: p.name, status: p.status },
                })),
              },
            ],
          },
        ],
        logs: { defaultTailLines: 100 },
        headerActions: [...actions, open(`/admin/oauth2/as/${id}`)],
      };
    }
    case "policy": {
      const rules = stashed<
        Array<{ id?: string; name?: string; status?: string; priority?: number; system?: boolean }>
      >(resource, "__rules__", []);
      const actions: ActionNode[] = [REFRESH];
      if (f["system"] !== true || f["status"] !== "ACTIVE")
        actions.push(...lifecycleActions(resource, "policy"));
      const editableRules = rules
        .filter((r) => !r.system)
        .map((r) => ({ id: str(r.id), label: `${str(r.name)} (${str(r.status)})` }));
      if (editableRules.length > 0) {
        actions.push(
          prompt(
            "Activate rule…",
            "activate-rule",
            "Activate a rule",
            "ruleId",
            "Rule",
            editableRules,
          ),
          prompt(
            "Deactivate rule…",
            "deactivate-rule",
            "Deactivate a rule",
            "ruleId",
            "Rule",
            editableRules,
            true,
          ),
        );
      }
      return {
        ...base,
        subtitle: joinSubtitle("Policy", str(f["type"])),
        sections: [
          overview(resource, "Policy"),
          {
            kind: "section",
            title: `Rules (${rules.length})`,
            children: [
              {
                kind: "table",
                columns: [
                  { key: "priority", label: "#", width: "narrow" },
                  { key: "name", label: "Rule" },
                  { key: "status", label: "Status", width: "narrow" },
                ],
                rows: rules.map((r) => ({
                  cells: { priority: str(r.priority), name: str(r.name), status: str(r.status) },
                })),
              },
            ],
          },
        ],
        logs: { defaultTailLines: 100 },
        headerActions: actions,
      };
    }
    case "network-zone":
      return {
        ...base,
        subtitle: joinSubtitle("Network zone", str(f["type"]), str(f["usage"])),
        sections: [overview(resource, "Network zone")],
        headerActions: [
          REFRESH,
          ...(f["system"] === true ? [] : lifecycleActions(resource, "zone")),
        ],
      };
    case "api-token":
      return {
        ...base,
        subtitle: joinSubtitle("API token", str(f["clientName"])),
        sections: [overview(resource, "API token")],
        headerActions: [REFRESH],
      };
    case "event-hook": {
      const actions: ActionNode[] = [REFRESH, ...lifecycleActions(resource, "event hook")];
      if (str(f["verificationStatus"]) !== "VERIFIED") {
        actions.push(action("Verify endpoint", "verify", { success: "Endpoint verified." }));
      }
      return {
        ...base,
        subtitle: joinSubtitle("Event hook", str(f["uri"])),
        sections: [overview(resource, "Event hook")],
        headerActions: actions,
      };
    }
    case "domain": {
      const records = stashed<
        Array<{ fqdn?: string; recordType?: string; values?: string[]; expiration?: string }>
      >(resource, "__dnsRecords__", []);
      const verified = ["VERIFIED", "COMPLETED"].includes(str(f["validationStatus"]));
      return {
        ...base,
        subtitle: joinSubtitle("Custom domain", str(f["certificateSourceType"])),
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
                rows: records.map((r) => ({
                  cells: {
                    type: str(r.recordType),
                    name: str(r.fqdn),
                    value: (r.values ?? []).join(", "),
                  },
                })),
              },
            ],
          },
        ],
        headerActions: [
          REFRESH,
          ...(verified ? [] : [action("Verify", "verify", { success: "Verification started." })]),
        ],
      };
    }
    case "trusted-origin":
      return {
        ...base,
        subtitle: joinSubtitle("Trusted origin", str(f["origin"])),
        sections: [overview(resource, "Trusted origin")],
        headerActions: [REFRESH, ...lifecycleActions(resource, "trusted origin")],
      };
    default:
      return { ...base, sections: [overview(resource, "Resource")], headerActions: [REFRESH] };
  }
}
