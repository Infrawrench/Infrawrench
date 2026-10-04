import type {
  ResourceInstance,
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldBool, fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

const list = (raw: string): string[] =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** `ns: write, other: read` → namespace_accesses entries. */
function namespaceAccesses(raw: string): TerraformValue[] {
  const out: TerraformValue[] = [];
  for (const entry of list(raw)) {
    const idx = entry.lastIndexOf(":");
    if (idx < 0) continue;
    const ns = entry.slice(0, idx).trim();
    const permission = entry.slice(idx + 1).trim();
    if (!ns || !["read", "write", "admin"].includes(permission)) continue;
    out.push(tf.map({ namespace_id: tf.str(ns), permission: tf.str(permission) }));
  }
  return out;
}

function mapNamespace(r: ResourceInstance): TerraformExportResult | null {
  const name = fieldString(r, "name");
  const regions = list(fieldString(r, "regions"));
  const retention = fieldNumber(r, "retentionDays");
  if (!name || regions.length === 0 || retention === undefined) return null;
  const attributes: Record<string, TerraformValue> = {
    name: tf.str(name),
    regions: tf.list(regions.map((x) => tf.str(x))),
    retention_days: tf.num(retention),
    api_key_auth: tf.bool(fieldBool(r, "apiKeyAuth")),
    namespace_lifecycle: tf.map({
      enable_delete_protection: tf.bool(fieldBool(r, "deleteProtection")),
    }),
  };
  const description = fieldString(r, "description");
  if (description) attributes["description"] = tf.str(description);
  const codec = fieldString(r, "codecServerEndpoint");
  if (codec) attributes["codec_server"] = tf.map({ endpoint: tf.str(codec) });
  if (fieldBool(r, "mtlsAuth")) {
    attributes["accepted_client_ca"] = tf.ref("var.temporal_cloud_accepted_client_ca");
  }
  return {
    resource: {
      type: "temporalcloud_namespace",
      name,
      attributes,
      importId: r.externalId,
      comments: [
        ...(fieldBool(r, "mtlsAuth")
          ? ["mTLS namespace: set var.temporal_cloud_accepted_client_ca to the base64 CA bundle."]
          : []),
        "Custom search attributes are managed with temporalcloud_namespace_search_attribute;",
        "import them separately before applying.",
      ],
    },
  };
}

function mapNexusEndpoint(r: ResourceInstance): TerraformExportResult | null {
  const name = fieldString(r, "name");
  const target = fieldString(r, "targetNamespace");
  const queue = fieldString(r, "taskQueue");
  if (!name || !target || !queue) return null;
  const attributes: Record<string, TerraformValue> = {
    name: tf.str(name),
    worker_target: tf.map({ namespace_id: tf.str(target), task_queue: tf.str(queue) }),
    allowed_caller_namespaces: tf.list(
      list(fieldString(r, "allowedCallers")).map((x) => tf.str(x)),
    ),
  };
  const description = fieldString(r, "description");
  if (description) attributes["description"] = tf.str(description);
  return {
    resource: { type: "temporalcloud_nexus_endpoint", name, attributes, importId: r.externalId },
  };
}

function mapServiceAccount(r: ResourceInstance): TerraformExportResult | null {
  const name = fieldString(r, "name");
  if (!name) return null;
  const attributes: Record<string, TerraformValue> = { name: tf.str(name) };
  const description = fieldString(r, "description");
  if (description) attributes["description"] = tf.str(description);
  const scoped = fieldString(r, "scopedNamespace");
  if (scoped) {
    const permission = fieldString(r, "namespaceAccess").split(":").pop()?.trim() || "read";
    attributes["namespace_scoped_access"] = tf.map({
      namespace_id: tf.str(scoped),
      permission: tf.str(permission),
    });
  } else {
    const role = fieldString(r, "accountRole");
    if (role) attributes["account_access"] = tf.str(role);
    const accesses = namespaceAccesses(fieldString(r, "namespaceAccess"));
    if (accesses.length > 0 && role !== "admin") {
      attributes["namespace_accesses"] = tf.list(accesses);
    }
  }
  return {
    resource: { type: "temporalcloud_service_account", name, attributes, importId: r.externalId },
  };
}

function mapUser(r: ResourceInstance): TerraformExportResult | null {
  const email = fieldString(r, "email");
  const role = fieldString(r, "accountRole");
  if (!email || !role) return null;
  const attributes: Record<string, TerraformValue> = {
    email: tf.str(email),
    account_access: tf.str(role),
  };
  const accesses = namespaceAccesses(fieldString(r, "namespaceAccess"));
  if (accesses.length > 0 && role !== "admin" && role !== "owner") {
    attributes["namespace_accesses"] = tf.list(accesses);
  }
  return {
    resource: {
      type: "temporalcloud_user",
      name: email.split("@")[0] ?? email,
      attributes,
      importId: r.externalId,
      ...(role === "owner"
        ? { comments: ["Owners can only be imported; the provider cannot change them."] }
        : {}),
    },
  };
}

function mapConnectivityRule(r: ResourceInstance): TerraformExportResult | null {
  const type = fieldString(r, "type").toLowerCase();
  if (type !== "public" && type !== "private") return null;
  const attributes: Record<string, TerraformValue> = { connectivity_type: tf.str(type) };
  if (type === "public") {
    attributes["enable_stable_ips"] = tf.bool(fieldBool(r, "stableIps"));
  } else {
    const region = fieldString(r, "region");
    if (region) attributes["region"] = tf.str(region);
    const connection = fieldString(r, "connectionId");
    if (connection) attributes["connection_id"] = tf.str(connection);
    const project = fieldString(r, "gcpProjectId");
    if (project) attributes["gcp_project_id"] = tf.str(project);
  }
  return {
    resource: {
      type: "temporalcloud_connectivity_rule",
      name: r.displayName || r.externalId || "rule",
      attributes,
      importId: r.externalId,
    },
  };
}

/**
 * Terraform mapping for Temporal Cloud: provider `temporalio/temporalcloud`.
 *
 * Attribute names verified against the provider's docs
 * (temporalio/terraform-provider-temporalcloud `docs/resources/*.md`, v1.9.0,
 * 2026-10). Nested settings (`namespace_lifecycle`, `codec_server`,
 * `worker_target`, `namespace_accesses`) are attributes, not blocks, so they
 * are written as `= { … }` maps. The provider takes `api_key`.
 *
 * Export sinks are not mapped: their import id format is not documented and
 * the bucket credentials they assume live outside this inventory. API keys are
 * credentials rather than configuration.
 */
export const temporalTerraformExport: TerraformExportCapability = {
  provider: { name: "temporalcloud", source: "temporalio/temporalcloud", version: "~> 1.0" },
  providerConfig: { api_key: tf.ref("var.temporal_cloud_api_key") },
  variables: [
    { name: "temporal_cloud_api_key", description: "Temporal Cloud API key", sensitive: true },
    {
      name: "temporal_cloud_accepted_client_ca",
      description: "Base64-encoded CA certificate bundle for mTLS namespaces",
    },
  ],
  supportedResourceTypeIds: [
    "namespace",
    "nexus-endpoint",
    "service-account",
    "user",
    "connectivity-rule",
  ],
  mapResource(resource): TerraformExportResult | null {
    switch (resource.resourceTypeId) {
      case "namespace":
        return mapNamespace(resource);
      case "nexus-endpoint":
        return mapNexusEndpoint(resource);
      case "service-account":
        return mapServiceAccount(resource);
      case "user":
        return mapUser(resource);
      case "connectivity-rule":
        return mapConnectivityRule(resource);
      default:
        return null;
    }
  },
};
