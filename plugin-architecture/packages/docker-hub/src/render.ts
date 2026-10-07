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
import {
  camelToTitle,
  formatBytes,
  joinSubtitle,
  withMetricsCapability,
} from "@infrawrench/plugin-base";
import { RESOURCE_TYPES } from "./resource-types.js";

/** Key under which `getResource` stashes an organization's teams for the grant prompt. */
export const TEAMS_KEY = "__teams__";

export const COMMANDS = { grantTeam: "grant-team-access" } as const;

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

function parseJson<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

const SIZE_FIELDS = new Set(["storageBytes", "storageSize", "sizeBytes"]);

function fieldsNode(r: ResourceInstance, skip: string[] = []): SchemaNode {
  const def = RESOURCE_TYPES.find((t) => t.id === r.resourceTypeId);
  const labels = new Map(def?.fields.map((x) => [x.key, x.label]) ?? []);
  const items: KVItem[] = [];
  for (const [key, value] of Object.entries(r.fields)) {
    if (skip.includes(key) || value === "") continue;
    let label = labels.get(key) ?? camelToTitle(key);
    let text = typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
    if (SIZE_FIELDS.has(key) && typeof value === "number") {
      label = label.replace(/ \(bytes\)$/, "");
      text = formatBytes(value);
    }
    items.push({ key: label, value: text });
  }
  return { kind: "key-value-list", items };
}

function section(title: string, children: SchemaNode[]): SectionNode {
  return { kind: "section", title, children };
}

function openUrl(label: string, url: string): ActionNode {
  return { kind: "action", label, action: { type: "open-url", url } };
}

function pluginAction(
  label: string,
  actionId: string,
  successMessage: string,
  confirm?: string,
): ActionNode {
  return {
    kind: "action",
    label,
    action: {
      type: "plugin-action",
      actionId,
      successMessage,
      ...(confirm ? { confirmMessage: confirm } : {}),
    },
  };
}

function toggleActions(r: ResourceInstance, what: string): ActionNode[] {
  return r.fields["active"] === false
    ? [pluginAction("Reactivate", "activate", `${what} reactivated`)]
    : [
        pluginAction(
          "Deactivate",
          "deactivate",
          `${what} deactivated`,
          `Deactivate this ${what.toLowerCase()}? Anything using it stops authenticating until you reactivate it.`,
        ),
      ];
}

function tokenStatus(r: ResourceInstance): { status: ResourceStatus; label: string } {
  const expires = str(r.fields["expiresAt"]);
  if (r.fields["active"] === false) return { status: "degraded", label: "Inactive" };
  if (expires && Date.parse(expires) < Date.now()) return { status: "error", label: "Expired" };
  return {
    status: "healthy",
    label: r.fields["neverExpires"] === true ? "Never expires" : "Active",
  };
}

export function renderDockerHubDetail(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  switch (r.resourceTypeId) {
    case "dockerhub-namespace": {
      const org = f["kind"] === "organization";
      const name = str(f["name"]);
      const schema: DetailViewSchema = {
        title: name,
        subtitle: joinSubtitle(org ? "Organization" : "Personal namespace", f["fullName"]),
        status: { kind: "status-dot", status: "healthy", label: org ? "Organization" : "User" },
        sections: [
          section("Namespace", [
            fieldsNode(
              r,
              org
                ? []
                : [
                    "members",
                    "teams",
                    "restrictedImages",
                    "allowOfficialImages",
                    "allowVerifiedPublishers",
                  ],
            ),
          ]),
          ...(org
            ? [
                section("Image access", [
                  {
                    kind: "text",
                    variant: "muted",
                    content:
                      "Restrict Images (Business subscriptions) limits what members may pull to the sources allowed here. Change it with Edit.",
                  } as SchemaNode,
                ]),
              ]
            : []),
        ],
        headerActions: [
          openUrl(
            "Open in Docker Hub",
            org ? `https://app.docker.com/admin/orgs/${name}` : `https://hub.docker.com/u/${name}`,
          ),
        ],
        ...(org ? { logs: { defaultTailLines: 100 } } : {}),
      };
      return withMetricsCapability(schema, RESOURCE_TYPES, r.resourceTypeId);
    }
    case "dockerhub-repository": {
      const id = r.externalId ?? `${str(f["namespace"])}/${str(f["name"])}`;
      const teams =
        parseJson<Array<{ id: number; name: string }>>(r.resolvedOutputs[TEAMS_KEY]) ?? [];
      const actions: ActionNode[] = [
        openUrl("Open in Docker Hub", `https://hub.docker.com/r/${id}`),
      ];
      if (teams.length > 0) {
        actions.push({
          kind: "action",
          label: "Grant team access",
          action: {
            type: "prompt-nosql-command",
            command: COMMANDS.grantTeam,
            title: "Grant a team access to this repository",
            description:
              "Sets the team's permission on this repository, replacing any it already had.",
            submitLabel: "Grant",
            fields: [
              {
                key: "teamId",
                label: "Team",
                kind: "select",
                required: true,
                options: teams.map((t) => ({ id: String(t.id), label: t.name })),
              },
              {
                key: "permission",
                label: "Permission",
                kind: "select",
                required: true,
                defaultValue: "read",
                options: [
                  { id: "read", label: "Read-only", description: "Pull" },
                  { id: "write", label: "Read & Write", description: "Pull and push" },
                  { id: "admin", label: "Admin", description: "Pull, push, settings and delete" },
                ],
              },
            ],
          },
        });
      }
      const schema: DetailViewSchema = {
        title: id,
        subtitle: joinSubtitle(
          "Repository",
          f["isPrivate"] === true ? "private" : "public",
          f["contentTypes"],
        ),
        status: {
          kind: "status-dot",
          status: f["isPrivate"] === true ? "healthy" : "info",
          label: f["isPrivate"] === true ? "Private" : "Public",
        },
        sections: [
          section("Repository", [
            fieldsNode(r, ["fullDescription"]),
            {
              kind: "key-value-list",
              items: [
                {
                  key: "Pull",
                  value: `docker pull ${str(r.resolvedOutputs["image"]) || id}`,
                  copyable: true,
                },
              ],
            },
          ]),
          ...(f["fullDescription"]
            ? [
                section("Overview", [
                  {
                    kind: "text",
                    variant: "mono",
                    content: str(f["fullDescription"]),
                  } as SchemaNode,
                ]),
              ]
            : []),
        ],
        headerActions: actions,
        artifactRegistry: { format: "docker", supportsTags: true },
      };
      return withMetricsCapability(schema, RESOURCE_TYPES, r.resourceTypeId);
    }
    case "dockerhub-tag":
      return {
        title: r.displayName,
        subtitle: joinSubtitle("Tag", f["platforms"]),
        status: {
          kind: "status-dot",
          status: f["status"] === "inactive" ? "degraded" : "healthy",
          label: f["status"] === "inactive" ? "Inactive (no push or pull for a month)" : "Active",
        },
        sections: [
          section("Tag", [
            fieldsNode(r),
            {
              kind: "key-value-list",
              items: [
                ...(r.resolvedOutputs["image"]
                  ? [{ key: "Image", value: r.resolvedOutputs["image"], copyable: true }]
                  : []),
                ...(r.resolvedOutputs["pinned"]
                  ? [{ key: "Pinned", value: r.resolvedOutputs["pinned"], copyable: true }]
                  : []),
              ],
            },
          ]),
        ],
      };
    case "dockerhub-access-token":
      return {
        title: r.displayName,
        subtitle: joinSubtitle("Personal access token", f["scopes"]),
        status: { kind: "status-dot", ...tokenStatus(r) },
        sections: [section("Token", [fieldsNode(r)])],
        headerActions: toggleActions(r, "Token"),
      };
    case "dockerhub-org-access-token":
      return {
        title: r.displayName,
        subtitle: joinSubtitle("Organization access token", f["organization"]),
        status: { kind: "status-dot", ...tokenStatus(r) },
        sections: [section("Token", [fieldsNode(r)])],
        headerActions: toggleActions(r, "Token"),
      };
    case "dockerhub-invite":
      return {
        title: r.displayName,
        subtitle: joinSubtitle("Invite", f["organization"]),
        status: { kind: "status-dot", status: "provisioning", label: "Pending" },
        sections: [section("Invite", [fieldsNode(r)])],
        headerActions: [pluginAction("Resend", "resend", "Invite resent")],
      };
    case "dockerhub-member":
      return {
        title: r.displayName,
        subtitle: joinSubtitle("Member", f["organization"], f["role"]),
        sections: [section("Member", [fieldsNode(r)])],
      };
    default:
      return {
        title: r.displayName,
        subtitle: joinSubtitle("Team", f["organization"]),
        sections: [section("Team", [fieldsNode(r)])],
      };
  }
}

export function renderDockerHubSidebar(r: ResourceInstance): SidebarItemSchema {
  let status: ResourceStatus | undefined;
  if (r.resourceTypeId === "dockerhub-repository")
    status = r.fields["isPrivate"] === true ? undefined : "info";
  if (
    r.resourceTypeId === "dockerhub-access-token" ||
    r.resourceTypeId === "dockerhub-org-access-token"
  ) {
    status = tokenStatus(r).status;
  }
  return {
    id: r.id,
    label: r.displayName || r.externalId || r.id,
    ...(status ? { status: { kind: "status-dot", status } } : {}),
  };
}
