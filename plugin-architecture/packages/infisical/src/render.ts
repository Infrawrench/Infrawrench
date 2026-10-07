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

function overview(resource: ResourceInstance, title: string, skip: string[] = []): SectionNode {
  const fields = Object.fromEntries(
    Object.entries(resource.fields).filter(([key]) => !skip.includes(key)),
  );
  const items: KVItem[] = labeledFieldItems(fields, RESOURCE_TYPES, resource.resourceTypeId).map(
    (item) => (/ ID$/.test(item.key) ? { ...item, copyable: true } : item),
  );
  return { kind: "section", title, children: [{ kind: "key-value-list", items }] };
}

function isExpired(value: unknown): boolean {
  const at = Date.parse(str(value));
  return Number.isFinite(at) && at <= Date.now();
}

function expiresSoon(value: unknown, days = 30): boolean {
  const at = Date.parse(str(value));
  return Number.isFinite(at) && at - Date.now() < days * 86_400_000;
}

export function statusOf(resource: ResourceInstance): { status: ResourceStatus; label?: string } {
  const f = resource.fields;
  switch (resource.resourceTypeId) {
    case "secret-sync": {
      const s = str(f["syncStatus"]);
      if (s === "failed") return { status: "error", label: "Sync failed" };
      if (s === "running" || s === "pending") return { status: "provisioning", label: "Syncing" };
      if (f["isAutoSyncEnabled"] === false) return { status: "degraded", label: "Auto-sync off" };
      return { status: s === "succeeded" ? "healthy" : "info", ...(s ? { label: s } : {}) };
    }
    case "integration":
      if (f["isActive"] === false) return { status: "degraded", label: "Inactive" };
      if (f["isSynced"] === false && str(f["syncMessage"]))
        return { status: "error", label: "Sync failed" };
      return { status: "healthy" };
    case "dynamic-secret": {
      const s = str(f["status"]).toLowerCase();
      if (s.includes("fail") || s.includes("error"))
        return { status: "error", label: str(f["status"]) };
      return { status: "healthy" };
    }
    case "machine-identity":
      if (str(f["lockedOut"])) return { status: "error", label: "Locked out" };
      return { status: "healthy" };
    case "certificate":
    case "certificate-authority": {
      const s = str(f["status"]).toLowerCase();
      if (s === "revoked" || str(f["revokedAt"])) return { status: "error", label: "Revoked" };
      if (isExpired(f["notAfter"])) return { status: "error", label: "Expired" };
      if (s && s !== "active") return { status: "provisioning", label: str(f["status"]) };
      if (expiresSoon(f["notAfter"])) return { status: "degraded", label: "Expires soon" };
      return { status: "healthy" };
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

export function renderDetail(resource: ResourceInstance, siteUrl: string): DetailViewSchema {
  const schema = buildDetail(resource, siteUrl);
  return withMetricsCapability(
    schema,
    RESOURCE_TYPES,
    resource.resourceTypeId,
    METRICS_DEFAULT_RANGE_MS,
  );
}

function dashboardLink(siteUrl: string, projectId: string): ActionNode {
  return {
    kind: "action",
    label: "Open in Infisical",
    action: {
      type: "open-url",
      url: projectId ? `${siteUrl}/projects/secret-management/${projectId}/overview` : siteUrl,
    },
  };
}

function buildDetail(resource: ResourceInstance, siteUrl: string): DetailViewSchema {
  const f = resource.fields;
  const { status, label } = statusOf(resource);
  const base = {
    title: resource.displayName,
    status: { kind: "status-dot" as const, status, ...(label ? { label } : {}) },
  };

  switch (resource.resourceTypeId) {
    case "project": {
      const sections: SectionNode[] = [overview(resource, "Project")];
      const envs = stashed<Array<{ name?: string; slug?: string }>>(
        resource,
        "__environments__",
        [],
      );
      if (envs.length > 0) {
        sections.push({
          kind: "section",
          title: "Environments",
          children: [
            {
              kind: "table",
              columns: [
                { key: "name", label: "Name" },
                { key: "slug", label: "Slug", mono: true },
              ],
              rows: envs.map((e) => ({ cells: { name: str(e.name), slug: str(e.slug) } })),
            },
          ],
        });
      }
      const identities = stashed<Array<{ name: string; roles: string }>>(
        resource,
        "__identities__",
        [],
      );
      if (identities.length > 0) {
        sections.push({
          kind: "section",
          title: "Machine identities with access",
          children: [
            {
              kind: "table",
              columns: [
                { key: "name", label: "Identity" },
                { key: "roles", label: "Roles" },
              ],
              rows: identities.map((i) => ({ cells: { name: i.name, roles: i.roles || DASH } })),
            },
          ],
        });
      }
      return {
        ...base,
        subtitle: joinSubtitle("Infisical project", str(f["type"])),
        sections,
        logs: { defaultTailLines: 100 },
        headerActions: [REFRESH, dashboardLink(siteUrl, str(f["projectId"]))],
      };
    }
    case "environment":
      return {
        ...base,
        subtitle: joinSubtitle("Environment", str(f["projectName"])),
        sections: [
          overview(resource, "Environment"),
          {
            kind: "section",
            title: "Use it",
            children: [
              {
                kind: "text",
                variant: "mono",
                copyable: true,
                content: `infisical run --projectId=${str(f["projectId"])} --env=${str(f["slug"])} -- <command>`,
              },
            ],
          },
        ],
        childTables: [
          {
            typeId: "secret",
            title: "Secrets",
            columns: [
              {
                key: "key",
                label: "Key",
                source: { kind: "field", fieldKey: "key" },
                format: "mono",
              },
              {
                key: "path",
                label: "Folder",
                source: { kind: "field", fieldKey: "path" },
                format: "mono",
              },
              { key: "comment", label: "Comment", source: { kind: "field", fieldKey: "comment" } },
              { key: "version", label: "Version", source: { kind: "field", fieldKey: "version" } },
            ],
            onRowClick: "edit",
          },
        ],
        logs: { defaultTailLines: 100 },
        headerActions: [REFRESH, dashboardLink(siteUrl, str(f["projectId"]))],
      };
    case "folder":
      return {
        ...base,
        subtitle: joinSubtitle("Folder", str(f["environment"])),
        sections: [overview(resource, "Folder")],
        headerActions: [REFRESH],
      };
    case "secret":
      return {
        ...base,
        subtitle: joinSubtitle("Secret", str(f["environment"]), str(f["path"])),
        sections: [
          overview(resource, "Secret"),
          {
            kind: "section",
            title: "Value",
            children: [
              {
                kind: "text",
                variant: "muted",
                content:
                  "The value is not stored in Infrawrench. Reveal it from Outputs, or reference the Value output from another resource. Edit to set a new value.",
              },
            ],
          },
        ],
        logs: { defaultTailLines: 50 },
        headerActions: [REFRESH],
      };
    case "dynamic-secret": {
      const leases = stashed<
        Array<{ id?: string; externalEntityId?: string; expireAt?: string; status?: string }>
      >(resource, "__leases__", []);
      const headerActions: ActionNode[] = [REFRESH];
      if (leases.length > 0) {
        headerActions.push({
          kind: "action",
          label: "Revoke lease…",
          variant: "danger",
          action: {
            type: "prompt-nosql-command",
            command: "revoke-lease",
            title: "Revoke a lease",
            description: "Deletes the credentials the lease minted at the provider.",
            fields: [
              {
                key: "leaseId",
                label: "Lease",
                kind: "select",
                required: true,
                options: leases.map((l) => ({
                  id: str(l.id),
                  label: `${str(l.externalEntityId) || str(l.id)} (expires ${str(l.expireAt) || "?"})`,
                })),
              },
            ],
            submitLabel: "Revoke",
            danger: true,
          },
        });
      }
      const sections: SectionNode[] = [overview(resource, "Dynamic secret", ["projectSlug"])];
      sections.push({
        kind: "section",
        title: `Active leases (${leases.length})`,
        children:
          leases.length === 0
            ? [
                {
                  kind: "text",
                  variant: "muted",
                  content: "No active leases. Use Get credentials to mint one.",
                },
              ]
            : [
                {
                  kind: "table",
                  columns: [
                    { key: "entity", label: "Credential", mono: true },
                    { key: "expires", label: "Expires" },
                    { key: "status", label: "Status", width: "narrow" },
                  ],
                  rows: leases.map((l) => ({
                    cells: {
                      entity: str(l.externalEntityId) || str(l.id),
                      expires: str(l.expireAt) || DASH,
                      status: str(l.status) || "active",
                    },
                  })),
                },
              ],
      });
      return {
        ...base,
        subtitle: joinSubtitle("Dynamic secret", str(f["type"]), str(f["environment"])),
        sections,
        headerActions,
      };
    }
    case "secret-sync": {
      const headerActions: ActionNode[] = [
        REFRESH,
        {
          kind: "action",
          label: "Sync now",
          action: { type: "plugin-action", actionId: "sync", successMessage: "Sync queued." },
        },
      ];
      if (f["canImport"] === true) {
        headerActions.push({
          kind: "action",
          label: "Import from destination…",
          action: {
            type: "prompt-nosql-command",
            command: "import",
            title: "Import secrets from the destination",
            description: "Copies secrets that exist at the destination into the source folder.",
            fields: [
              {
                key: "importBehavior",
                label: "On conflict",
                kind: "select",
                required: true,
                defaultValue: "prioritize-source",
                options: [
                  { id: "prioritize-source", label: "Keep Infisical's value" },
                  { id: "prioritize-destination", label: "Take the destination's value" },
                ],
              },
            ],
            submitLabel: "Import",
          },
        });
      }
      headerActions.push({
        kind: "action",
        label: "Remove synced secrets",
        variant: "danger",
        action: {
          type: "plugin-action",
          actionId: "remove",
          destructive: true,
          confirmMessage: "Delete every secret this sync wrote at the destination?",
          successMessage: "Removal queued.",
        },
      });
      return {
        ...base,
        subtitle: joinSubtitle("Secret sync", str(f["destination"])),
        sections: [overview(resource, "Secret sync")],
        headerActions,
      };
    }
    case "integration":
      return {
        ...base,
        subtitle: joinSubtitle("Native integration", str(f["integration"])),
        sections: [
          overview(resource, "Integration"),
          {
            kind: "section",
            children: [
              {
                kind: "text",
                variant: "muted",
                content: "Native integrations are deprecated in favour of secret syncs.",
              },
            ],
          },
        ],
        headerActions: [
          REFRESH,
          {
            kind: "action",
            label: "Sync now",
            action: { type: "plugin-action", actionId: "sync", successMessage: "Sync queued." },
          },
        ],
      };
    case "machine-identity":
      return renderIdentity(resource, base);
    case "certificate-authority":
      return {
        ...base,
        subtitle: joinSubtitle("Certificate authority", str(f["caType"])),
        sections: [overview(resource, "Certificate authority")],
        headerActions: [REFRESH],
      };
    case "certificate": {
      const revoked = str(f["revokedAt"]) !== "" || str(f["status"]).toLowerCase() === "revoked";
      const headerActions: ActionNode[] = [REFRESH];
      if (!revoked) {
        headerActions.push(
          {
            kind: "action",
            label: "Renew",
            action: {
              type: "plugin-action",
              actionId: "renew",
              confirmMessage: "Issue a renewed certificate with the same profile?",
              successMessage: "Renewal requested.",
            },
          },
          {
            kind: "action",
            label: "Revoke…",
            variant: "danger",
            action: {
              type: "prompt-nosql-command",
              command: "revoke",
              title: "Revoke certificate",
              description: "Revocation is permanent and is published in the CA's CRL.",
              fields: [
                {
                  key: "reason",
                  label: "Reason",
                  kind: "select",
                  required: true,
                  defaultValue: "UNSPECIFIED",
                  options: [
                    { id: "UNSPECIFIED", label: "Unspecified" },
                    { id: "KEY_COMPROMISE", label: "Key compromise" },
                    { id: "CA_COMPROMISE", label: "CA compromise" },
                    { id: "AFFILIATION_CHANGED", label: "Affiliation changed" },
                    { id: "SUPERSEDED", label: "Superseded" },
                    { id: "CESSATION_OF_OPERATION", label: "Cessation of operation" },
                    { id: "CERTIFICATE_HOLD", label: "Certificate hold" },
                    { id: "PRIVILEGE_WITHDRAWN", label: "Privilege withdrawn" },
                  ],
                },
              ],
              submitLabel: "Revoke",
              danger: true,
            },
          },
        );
      }
      return {
        ...base,
        subtitle: joinSubtitle("Certificate", str(f["serialNumber"])),
        sections: [overview(resource, "Certificate")],
        headerActions,
      };
    }
    default:
      return {
        ...base,
        sections: [overview(resource, "Resource")],
        headerActions: [REFRESH],
      };
  }
}

function renderIdentity(
  resource: ResourceInstance,
  base: Pick<DetailViewSchema, "title" | "status">,
): DetailViewSchema {
  const f = resource.fields;
  const ua = stashed<{
    clientId?: string;
    accessTokenTTL?: number;
    accessTokenMaxTTL?: number;
  } | null>(resource, "__universalAuth__", null);
  const secrets = stashed<
    Array<{
      id?: string;
      description?: string;
      clientSecretPrefix?: string;
      createdAt?: string;
      clientSecretNumUses?: number;
    }>
  >(resource, "__clientSecrets__", []);
  const projects = stashed<Array<{ id: string; label: string }>>(resource, "__projects__", []);

  const sections: SectionNode[] = [overview(resource, "Machine identity")];
  const uaChildren: SchemaNode[] = ua?.clientId
    ? [
        {
          kind: "key-value-list",
          items: [
            { key: "Client ID", value: ua.clientId, copyable: true },
            { key: "Access token TTL", value: `${str(ua.accessTokenTTL)} s` },
            { key: "Access token max TTL", value: `${str(ua.accessTokenMaxTTL)} s` },
          ],
        },
        secrets.length === 0
          ? { kind: "text", variant: "muted", content: "No active client secrets." }
          : {
              kind: "table",
              columns: [
                { key: "prefix", label: "Secret", mono: true },
                { key: "description", label: "Description" },
                { key: "uses", label: "Uses", width: "narrow" },
                { key: "created", label: "Created" },
              ],
              rows: secrets.map((s) => ({
                cells: {
                  prefix: `${str(s.clientSecretPrefix)}…`,
                  description: str(s.description) || DASH,
                  uses: str(s.clientSecretNumUses ?? 0),
                  created: str(s.createdAt) || DASH,
                },
              })),
            },
      ]
    : [
        {
          kind: "text",
          variant: "muted",
          content: "Universal Auth is not enabled on this identity.",
        },
      ];
  sections.push({ kind: "section", title: "Universal Auth", children: uaChildren });

  const headerActions: ActionNode[] = [REFRESH];
  if (!ua?.clientId) {
    headerActions.push({
      kind: "action",
      label: "Enable Universal Auth",
      action: {
        type: "plugin-action",
        actionId: "enable-universal-auth",
        successMessage: "Universal Auth enabled. Use Get credentials to mint a client secret.",
      },
    });
  } else {
    headerActions.push({
      kind: "action",
      label: "Token settings…",
      action: {
        type: "prompt-nosql-command",
        command: "configure-universal-auth",
        title: "Universal Auth settings",
        fields: [
          {
            key: "accessTokenTTL",
            label: "Access token TTL (seconds)",
            kind: "number",
            required: false,
            minValue: 1,
            defaultValue: str(ua.accessTokenTTL),
          },
          {
            key: "accessTokenMaxTTL",
            label: "Access token max TTL (seconds)",
            kind: "number",
            required: false,
            minValue: 1,
            defaultValue: str(ua.accessTokenMaxTTL),
          },
          {
            key: "trustedIps",
            label: "Trusted IPs",
            kind: "string-list",
            required: false,
            addLabel: "+ Add CIDR",
            description:
              "Leave empty to keep the current allow list. Applies to logins and token use.",
          },
        ],
        submitLabel: "Save",
      },
    });
    if (str(f["lockedOut"])) {
      headerActions.push({
        kind: "action",
        label: "Clear lockouts",
        action: {
          type: "plugin-action",
          actionId: "clear-lockouts",
          successMessage: "Lockouts cleared.",
        },
      });
    }
    if (secrets.length > 0) {
      headerActions.push({
        kind: "action",
        label: "Revoke client secret…",
        variant: "danger",
        action: {
          type: "prompt-nosql-command",
          command: "revoke-client-secret",
          title: "Revoke a client secret",
          fields: [
            {
              key: "clientSecretId",
              label: "Client secret",
              kind: "select",
              required: true,
              options: secrets.map((s) => ({
                id: str(s.id),
                label: `${str(s.clientSecretPrefix)}… ${str(s.description)}`.trim(),
              })),
            },
          ],
          submitLabel: "Revoke",
          danger: true,
        },
      });
    }
  }
  if (projects.length > 0) {
    headerActions.push(
      {
        kind: "action",
        label: "Add to project…",
        action: {
          type: "prompt-nosql-command",
          command: "add-to-project",
          title: "Give this identity access to a project",
          fields: [
            {
              key: "projectId",
              label: "Project",
              kind: "select",
              required: true,
              options: projects,
              defaultValue: projects[0]?.id ?? "",
            },
            {
              key: "role",
              label: "Project role",
              kind: "select",
              required: true,
              defaultValue: "viewer",
              options: [
                { id: "admin", label: "Admin" },
                { id: "member", label: "Developer" },
                { id: "viewer", label: "Viewer" },
                { id: "no-access", label: "No access" },
              ],
              description: "Custom project roles can be assigned in Infisical.",
            },
          ],
          submitLabel: "Add",
        },
      },
      {
        kind: "action",
        label: "Remove from project…",
        variant: "danger",
        action: {
          type: "prompt-nosql-command",
          command: "remove-from-project",
          title: "Remove this identity from a project",
          fields: [
            {
              key: "projectId",
              label: "Project",
              kind: "select",
              required: true,
              options: projects,
            },
          ],
          submitLabel: "Remove",
          danger: true,
        },
      },
    );
  }
  return {
    ...base,
    subtitle: joinSubtitle("Machine identity", str(f["role"])),
    sections,
    logs: { defaultTailLines: 100 },
    headerActions,
  };
}
