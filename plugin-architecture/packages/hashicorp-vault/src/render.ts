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
import { camelToTitle, joinSubtitle, withMetricsCapability } from "@infrawrench/plugin-base";
import { ttlText } from "./mappers.js";
import { RESOURCE_TYPES } from "./resource-types.js";

export const COMMANDS = { editPolicy: "edit-policy" } as const;

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const TTL_FIELDS = new Set(["defaultLeaseTtl", "maxLeaseTtl"]);

function fieldsNode(r: ResourceInstance, skip: string[] = []): SchemaNode {
  const def = RESOURCE_TYPES.find((t) => t.id === r.resourceTypeId);
  const labels = new Map(def?.fields.map((x) => [x.key, x.label]) ?? []);
  const items: KVItem[] = [];
  for (const [key, value] of Object.entries(r.fields)) {
    if (skip.includes(key) || value === "") continue;
    let text = typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
    if (TTL_FIELDS.has(key) && typeof value === "number") text = ttlText(value) ?? text;
    items.push({ key: labels.get(key) ?? camelToTitle(key), value: text });
  }
  return { kind: "key-value-list", items };
}

function section(title: string, children: SchemaNode[]): SectionNode {
  return { kind: "section", title, children };
}

function pluginAction(
  label: string,
  actionId: string,
  successMessage: string,
  opts: { confirm?: string; destructive?: boolean; variant?: ActionNode["variant"] } = {},
): ActionNode {
  return {
    kind: "action",
    label,
    ...(opts.variant ? { variant: opts.variant } : {}),
    action: {
      type: "plugin-action",
      actionId,
      successMessage,
      ...(opts.confirm ? { confirmMessage: opts.confirm } : {}),
      ...(opts.destructive ? { destructive: true } : {}),
    },
  };
}

const openUrl = (label: string, url: string): ActionNode => ({
  kind: "action",
  label,
  action: { type: "open-url", url },
});

function clusterStatus(f: ResourceInstance["fields"]): { status: ResourceStatus; label: string } {
  if (f["initialized"] === false) return { status: "error", label: "Not initialized" };
  if (f["sealed"] === true) return { status: "error", label: "Sealed" };
  if (f["standby"] === true) return { status: "info", label: "Standby" };
  return { status: "healthy", label: "Active" };
}

export function expiryStatus(iso: unknown, soonDays = 14): ResourceStatus | undefined {
  const t = Date.parse(str(iso));
  if (!Number.isFinite(t)) return undefined;
  if (t < Date.now()) return "error";
  if (t - Date.now() < soonDays * 86_400_000) return "degraded";
  return "healthy";
}

export function renderVaultDetail(r: ResourceInstance, address: string): DetailViewSchema {
  const f = r.fields;
  const ui = `${address}/ui/vault`;
  switch (r.resourceTypeId) {
    case "vault-cluster":
      return withMetricsCapability(
        {
          title: r.displayName,
          subtitle: joinSubtitle(
            "Vault",
            f["version"] ? `v${str(f["version"])}` : "",
            f["namespace"] ? `namespace ${str(f["namespace"])}` : "",
          ),
          status: { kind: "status-dot", ...clusterStatus(f) },
          sections: [section("Cluster", [fieldsNode(r)])],
          headerActions: [
            openUrl("Open Vault UI", `${address}/ui/`),
            pluginAction("Step down", "step-down", "Leader stepped down", {
              confirm:
                "Make the active node step down? Another node takes over; requests pause briefly during the election.",
            }),
            pluginAction("Seal", "seal", "Vault sealed", {
              confirm:
                "Seal Vault? Every request fails until it is unsealed again with the key shares or the auto-unseal key. Only do this in an emergency.",
              destructive: true,
              variant: "danger",
            }),
          ],
        },
        RESOURCE_TYPES,
        r.resourceTypeId,
      );
    case "vault-mount":
      return {
        title: `${str(f["path"])}/`,
        subtitle: joinSubtitle("Secrets engine", f["type"]),
        sections: [section("Engine", [fieldsNode(r)])],
        headerActions: [
          openUrl("Open in Vault UI", `${ui}/secrets/${encodeURIComponent(str(f["path"]))}`),
        ],
      };
    case "vault-kv-secret":
      return {
        title: str(f["path"]) || r.displayName,
        subtitle: joinSubtitle("KV secret", `${str(f["mount"])}/`),
        status: {
          kind: "status-dot",
          status: f["currentDeleted"] === true ? "degraded" : "healthy",
          label:
            f["currentDeleted"] === true
              ? "Current version deleted"
              : `Version ${str(f["currentVersion"])}`,
        },
        sections: [section("Secret", [fieldsNode(r)])],
        secretVersions: {
          supportsFileUpload: true,
          helpText:
            'Values are JSON objects ({"key": "value"}) or KEY=value lines. Disable soft-deletes a version (restorable); Destroy removes its data for good.',
        },
      };
    case "vault-auth-method":
      return {
        title: `${str(f["path"])}/`,
        subtitle: joinSubtitle("Auth method", f["type"]),
        sections: [section("Auth method", [fieldsNode(r)])],
        headerActions: [
          openUrl("Open in Vault UI", `${ui}/access/${encodeURIComponent(str(f["path"]))}`),
        ],
      };
    case "vault-policy": {
      const hcl = r.resolvedOutputs["policy"];
      const builtIn = f["builtIn"] === true;
      return {
        title: r.displayName,
        subtitle: "ACL policy",
        sections: [
          section("Policy", [fieldsNode(r)]),
          ...(hcl !== undefined
            ? [
                section("HCL", [
                  { kind: "text", variant: "mono", content: hcl, copyable: true } as SchemaNode,
                ]),
              ]
            : []),
        ],
        headerActions:
          hcl !== undefined && str(f["name"]) !== "root"
            ? [
                {
                  kind: "action",
                  label: "Edit policy",
                  action: {
                    type: "prompt-nosql-command",
                    command: COMMANDS.editPolicy,
                    title: `Edit ${r.displayName}`,
                    description: builtIn
                      ? "This is the built-in default policy every token gets. Change it carefully."
                      : "Saving replaces the policy. Tokens that carry it pick up the change on their next request.",
                    submitLabel: "Save policy",
                    fields: [
                      {
                        key: "policy",
                        label: "Policy (HCL)",
                        kind: "code",
                        codeLanguage: "hcl",
                        required: true,
                        defaultValue: hcl,
                      },
                    ],
                  },
                },
              ]
            : [],
      };
    }
    case "vault-pki-role":
      return {
        title: r.displayName,
        subtitle: joinSubtitle("PKI role", `${str(f["mount"])}/`),
        sections: [section("Role", [fieldsNode(r)])],
      };
    case "vault-pki-cert": {
      const status: ResourceStatus =
        f["revoked"] === true ? "info" : (expiryStatus(f["expires"]) ?? "unknown");
      return {
        title: r.displayName,
        subtitle: joinSubtitle("Certificate", f["issuer"]),
        status: {
          kind: "status-dot",
          status,
          label:
            f["revoked"] === true
              ? "Revoked"
              : status === "error"
                ? "Expired"
                : status === "degraded"
                  ? "Expires soon"
                  : "Valid",
        },
        sections: [
          section("Certificate", [fieldsNode(r)]),
          ...(r.resolvedOutputs["certificate"]
            ? [
                section("PEM", [
                  {
                    kind: "text",
                    variant: "mono",
                    content: r.resolvedOutputs["certificate"],
                    copyable: true,
                  } as SchemaNode,
                ]),
              ]
            : []),
        ],
        headerActions:
          f["revoked"] === true
            ? []
            : [
                pluginAction("Revoke", "revoke", "Certificate revoked", {
                  confirm:
                    "Revoke this certificate? It is added to the CRL and clients that check revocation reject it.",
                  destructive: true,
                  variant: "danger",
                }),
              ],
      };
    }
    case "vault-lease":
      return {
        title: r.displayName,
        subtitle: "Lease",
        status: {
          kind: "status-dot",
          status: expiryStatus(f["expireTime"], 1) ?? "unknown",
          label: str(f["expireTime"]) || "No expiry",
        },
        sections: [section("Lease", [fieldsNode(r)])],
        headerActions:
          f["renewable"] === true ? [pluginAction("Renew", "renew", "Lease renewed")] : [],
      };
    case "vault-token":
      return {
        title: r.displayName,
        subtitle: joinSubtitle("Token", f["path"]),
        status: {
          kind: "status-dot",
          status: f["root"] === true ? "degraded" : (expiryStatus(f["expireTime"], 1) ?? "healthy"),
          label:
            f["root"] === true
              ? "Root token"
              : f["neverExpires"] === true
                ? "Never expires"
                : "Valid",
        },
        sections: [section("Token", [fieldsNode(r)])],
        headerActions:
          f["renewable"] === true ? [pluginAction("Renew", "renew", "Token renewed")] : [],
      };
    default:
      return {
        title: r.displayName,
        subtitle: joinSubtitle("Audit device", f["type"]),
        sections: [section("Audit device", [fieldsNode(r)])],
      };
  }
}

export function renderVaultSidebar(r: ResourceInstance): SidebarItemSchema {
  let status: ResourceStatus | undefined;
  if (r.resourceTypeId === "vault-pki-cert")
    status = r.fields["revoked"] === true ? "info" : expiryStatus(r.fields["expires"]);
  if (r.resourceTypeId === "vault-token" && r.fields["root"] === true) status = "degraded";
  return {
    id: r.id,
    label: r.displayName || r.externalId || r.id,
    ...(status ? { status: { kind: "status-dot", status } } : {}),
  };
}
