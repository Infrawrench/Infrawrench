import type {
  ActionNode,
  DetailViewSchema,
  KVItem,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { camelToTitle, joinSubtitle } from "@infrawrench/plugin-base";
import { RESOURCE_TYPES } from "./resource-types.js";

/** Key under which `getResource` stashes the workplace roles for the role prompt. */
export const ROLES_KEY = "__roles__";

export const COMMANDS = { cloneConfig: "clone-config", setRole: "set-role" } as const;

const DASHBOARD = "https://dashboard.doppler.com";
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

function fieldsNode(r: ResourceInstance): SchemaNode {
  const def = RESOURCE_TYPES.find((t) => t.id === r.resourceTypeId);
  const labels = new Map(def?.fields.map((x) => [x.key, x.label]) ?? []);
  const items: KVItem[] = [];
  for (const [key, value] of Object.entries(r.fields)) {
    if (value === "") continue;
    items.push({
      key: labels.get(key) ?? camelToTitle(key),
      value: typeof value === "boolean" ? (value ? "Yes" : "No") : String(value),
    });
  }
  return { kind: "key-value-list", items };
}

const action = (
  label: string,
  actionId: string,
  successMessage: string,
  confirm?: string,
): ActionNode => ({
  kind: "action",
  label,
  action: {
    type: "plugin-action",
    actionId,
    successMessage,
    ...(confirm ? { confirmMessage: confirm } : {}),
  },
});

const open = (label: string, url: string): ActionNode => ({
  kind: "action",
  label,
  action: { type: "open-url", url },
});

function tokenStatus(r: ResourceInstance): { status: ResourceStatus; label: string } {
  const t = Date.parse(str(r.fields["expiresAt"]));
  if (Number.isFinite(t) && t < Date.now()) return { status: "error", label: "Expired" };
  if (r.fields["neverExpires"] === true) return { status: "degraded", label: "Never expires" };
  return { status: "healthy", label: "Valid" };
}

export function renderDopplerDetail(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const base = {
    title: r.displayName,
    sections: [{ kind: "section" as const, title: "Details", children: [fieldsNode(r)] }],
  };
  switch (r.resourceTypeId) {
    case "doppler-workplace":
      return {
        ...base,
        subtitle: "Workplace",
        status: { kind: "status-dot", status: "healthy", label: "Connected" },
        headerActions: [open("Open in Doppler", DASHBOARD)],
        logs: { defaultTailLines: 100 },
      };
    case "doppler-project":
      return {
        ...base,
        subtitle: joinSubtitle("Project", f["slug"]),
        headerActions: [open("Open in Doppler", DASHBOARD)],
      };
    case "doppler-config": {
      const locked = f["locked"] === true;
      return {
        ...base,
        subtitle: joinSubtitle("Config", f["project"], f["environment"]),
        status: {
          kind: "status-dot",
          status: locked ? "info" : "healthy",
          label: locked ? "Locked" : f["root"] === true ? "Root config" : "Branch config",
        },
        kvBrowser: {
          namespaceLabel: `${str(f["project"])} / ${str(f["name"])}`,
          helpText:
            "Values are shown raw, with ${REFERENCES} unexpanded. Restricted secrets can't be read back. Saving a key writes it to this config immediately.",
        },
        logs: { defaultTailLines: 100 },
        headerActions: [
          locked
            ? action("Unlock", "unlock", "Config unlocked")
            : action(
                "Lock",
                "lock",
                "Config locked",
                "Lock this config? It can't be renamed or deleted until unlocked.",
              ),
          {
            kind: "action",
            label: "Clone",
            action: {
              type: "prompt-nosql-command",
              command: COMMANDS.cloneConfig,
              title: `Clone ${str(f["name"])}`,
              description:
                "Creates a branch config in the same environment with a copy of every secret.",
              submitLabel: "Clone",
              fields: [
                {
                  key: "name",
                  label: "New config name",
                  kind: "text",
                  required: true,
                  placeholder: `${str(f["environment"]) || "dev"}_copy`,
                  description: "Must start with the environment slug and an underscore.",
                },
              ],
            },
          },
        ],
      };
    }
    case "doppler-secret":
      return {
        ...base,
        subtitle: joinSubtitle(
          "Secret",
          `${str(f["project"])}/${str(f["config"])}`,
          f["visibility"],
        ),
      };
    case "doppler-service-token":
    case "doppler-service-account-token":
      return {
        ...base,
        subtitle:
          r.resourceTypeId === "doppler-service-token" ? "Service token" : "Service account token",
        status: { kind: "status-dot", ...tokenStatus(r) },
      };
    case "doppler-webhook": {
      const enabled = f["enabled"] !== false;
      return {
        ...base,
        subtitle: joinSubtitle("Webhook", f["project"]),
        status: {
          kind: "status-dot",
          status: enabled ? "healthy" : "degraded",
          label: enabled ? "Enabled" : "Disabled",
        },
        headerActions: [
          enabled
            ? action("Disable", "disable", "Webhook disabled")
            : action("Enable", "enable", "Webhook enabled"),
        ],
      };
    }
    case "doppler-sync":
      return {
        ...base,
        subtitle: joinSubtitle("Secrets sync", f["integrationType"]),
        status: {
          kind: "status-dot",
          status: f["enabled"] === false ? "degraded" : "healthy",
          label: f["enabled"] === false ? "Disabled" : "Syncing",
        },
      };
    case "doppler-user": {
      let roles: Array<{ identifier?: string; name?: string }> = [];
      try {
        roles = JSON.parse(r.resolvedOutputs[ROLES_KEY] ?? "[]") as typeof roles;
      } catch {
        roles = [];
      }
      return {
        ...base,
        subtitle: joinSubtitle("User", f["access"]),
        headerActions:
          roles.length > 0
            ? [
                {
                  kind: "action",
                  label: "Change role",
                  action: {
                    type: "prompt-nosql-command",
                    command: COMMANDS.setRole,
                    title: `Change ${r.displayName}'s workplace role`,
                    submitLabel: "Save",
                    fields: [
                      {
                        key: "role",
                        label: "Workplace role",
                        kind: "select",
                        required: true,
                        defaultValue: str(f["access"]),
                        options: roles
                          .filter((x) => x.identifier)
                          .map((x) => ({ id: x.identifier!, label: x.name ?? x.identifier! })),
                      },
                    ],
                  },
                },
              ]
            : [],
      };
    }
    default:
      return { ...base, subtitle: def(r.resourceTypeId) };
  }
}

const def = (typeId: string) =>
  RESOURCE_TYPES.find((t) => t.id === typeId)?.displayName ?? "Doppler";

export function renderDopplerSidebar(r: ResourceInstance): SidebarItemSchema {
  let status: ResourceStatus | undefined;
  if (
    r.resourceTypeId === "doppler-service-token" ||
    r.resourceTypeId === "doppler-service-account-token"
  )
    status = tokenStatus(r).status;
  if (r.resourceTypeId === "doppler-config" && r.fields["locked"] === true) status = "info";
  return {
    id: r.id,
    label: r.displayName || r.externalId || r.id,
    ...(status ? { status: { kind: "status-dot", status } } : {}),
  };
}
