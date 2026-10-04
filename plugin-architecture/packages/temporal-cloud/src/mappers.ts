import type { ResourceInstance } from "@infrawrench/plugin-base";
import type {
  TcAccess,
  TcApiKey,
  TcConnectivityRule,
  TcExportSink,
  TcNamespace,
  TcNexusEndpoint,
  TcServiceAccount,
  TcUser,
} from "./types.js";

export const PLUGIN_ID = "temporal-cloud";

/** Keys under which `getResource` stashes data the synchronous renderer needs. */
export const SEARCH_ATTRIBUTES_KEY = "__searchAttributes__";
export const REPLICAS_KEY = "__replicas__";
export const CAPACITY_KEY = "__capacity__";
export const CONNECTIVITY_KEY = "__connectivityRules__";
export const REGIONS_KEY = "__regions__";
export const NAMESPACE_IDS_KEY = "__namespaceIds__";
export const ACCESS_KEY = "__access__";

type FieldValue = string | number | boolean | undefined | null;

export function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, FieldValue>,
  outputs: Record<string, string | undefined> = {},
  parentResourceId?: string,
): ResourceInstance {
  const now = new Date().toISOString();
  const clean: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && v !== "") clean[k] = v;
  }
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(outputs)) if (v) resolved[k] = v;
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields: clean,
    resolvedOutputs: resolved,
    secretStates: [],
    externalId,
    ...(parentResourceId ? { parentResourceId } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

/** `ROLE_FINANCE_ADMIN` → `financeadmin`, the spelling the CLI and Terraform use. */
export function roleName(role: string | undefined): string {
  if (!role || role === "ROLE_UNSPECIFIED") return "";
  return role
    .replace(/^ROLE_/, "")
    .replace(/_/g, "")
    .toLowerCase();
}

export function roleEnum(role: string): string {
  const map: Record<string, string> = {
    owner: "ROLE_OWNER",
    admin: "ROLE_ADMIN",
    developer: "ROLE_DEVELOPER",
    financeadmin: "ROLE_FINANCE_ADMIN",
    read: "ROLE_READ",
    metricsread: "ROLE_METRICS_READ",
  };
  const out = map[role.trim().toLowerCase()];
  if (!out) throw new Error(`Unknown account role "${role}"`);
  return out;
}

/** `PERMISSION_WRITE` → `write`. */
export function permissionName(permission: string | undefined): string {
  if (!permission || permission === "PERMISSION_UNSPECIFIED") return "";
  return permission.replace(/^PERMISSION_/, "").toLowerCase();
}

/** `RESOURCE_STATE_UPDATE_FAILED` → `update failed`. */
export function stateName(state: string | undefined): string {
  if (!state) return "";
  return state
    .replace(/^(RESOURCE_STATE_|STATE_|HEALTH_|REPLICA_STATE_)/, "")
    .replace(/_/g, " ")
    .toLowerCase();
}

export function searchAttributeTypeName(type: string | undefined): string {
  const map: Record<string, string> = {
    SEARCH_ATTRIBUTE_TYPE_TEXT: "Text",
    SEARCH_ATTRIBUTE_TYPE_KEYWORD: "Keyword",
    SEARCH_ATTRIBUTE_TYPE_INT: "Int",
    SEARCH_ATTRIBUTE_TYPE_DOUBLE: "Double",
    SEARCH_ATTRIBUTE_TYPE_BOOL: "Bool",
    SEARCH_ATTRIBUTE_TYPE_DATETIME: "Datetime",
    SEARCH_ATTRIBUTE_TYPE_KEYWORD_LIST: "KeywordList",
  };
  return map[type ?? ""] ?? (type ?? "").replace(/^SEARCH_ATTRIBUTE_TYPE_/, "");
}

export function formatTags(tags: Record<string, string> | undefined): string {
  return Object.entries(tags ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

function accessSummary(access: TcAccess | undefined): string {
  return Object.entries(access?.namespaceAccesses ?? {})
    .map(([ns, a]) => `${ns}: ${permissionName(a.permission) || "none"}`)
    .sort()
    .join(", ");
}

export function mapNamespace(accountId: string, ns: TcNamespace): ResourceInstance {
  const id = ns.namespace ?? ns.spec?.name ?? "";
  const spec = ns.spec ?? {};
  const regions = spec.regions ?? ns.replicas?.map((r) => r.region ?? "").filter(Boolean) ?? [];
  const searchAttributes = spec.searchAttributes ?? {};
  const capacityMode = ns.capacity?.provisioned
    ? `Provisioned (${ns.capacity.provisioned.currentValue ?? "?"} TRU)`
    : ns.capacity?.onDemand
      ? "On demand"
      : "";
  return instance(
    accountId,
    "namespace",
    id,
    spec.name ?? id,
    {
      namespaceId: id,
      name: spec.name ?? id.split(".")[0],
      description: spec.description,
      retentionDays: spec.retentionDays,
      deleteProtection: spec.lifecycle?.enableDeleteProtection ?? false,
      apiKeyAuth: spec.apiKeyAuth?.enabled ?? false,
      mtlsAuth: spec.mtlsAuth?.enabled ?? Boolean(spec.mtlsAuth?.acceptedClientCa),
      codecServerEndpoint: spec.codecServer?.endpoint,
      taskQueueFairness: spec.fairness?.taskQueueFairnessEnabled ?? false,
      tags: formatTags(ns.tags),
      state: stateName(ns.state),
      regions: regions.join(", "),
      region: ns.activeRegion ?? regions[0],
      multiRegion: regions.length > 1,
      grpcAddress: ns.endpoints?.grpcAddress,
      mtlsGrpcAddress: ns.endpoints?.mtlsGrpcAddress,
      webAddress: ns.endpoints?.webAddress,
      apsLimit: ns.limits?.actionsPerSecondLimit,
      capacityMode,
      searchAttributes: Object.entries(searchAttributes)
        .map(([name, type]) => `${name} (${searchAttributeTypeName(type)})`)
        .sort()
        .join(", "),
      projectId: ns.projectId,
      createdAt: ns.createdTime,
      modifiedAt: ns.lastModifiedTime,
    },
    {
      namespaceId: id,
      grpcAddress: ns.endpoints?.grpcAddress,
      mtlsGrpcAddress: ns.endpoints?.mtlsGrpcAddress,
      webAddress: ns.endpoints?.webAddress,
      [SEARCH_ATTRIBUTES_KEY]: JSON.stringify(searchAttributes),
      [REPLICAS_KEY]: JSON.stringify(
        (ns.replicas ?? []).length > 0
          ? ns.replicas
          : regions.map((region) => ({
              region,
              isPrimary: region === (ns.activeRegion ?? regions[0]),
              state: ns.regionStatus?.[region]?.state,
            })),
      ),
      [CONNECTIVITY_KEY]: JSON.stringify(spec.connectivityRuleIds ?? []),
    },
  );
}

export function exportSinkExternalId(namespaceId: string, name: string): string {
  return `${namespaceId}/${name}`;
}

export function parseExportSinkId(externalId: string): { namespaceId: string; name: string } {
  const slash = externalId.lastIndexOf("/");
  return { namespaceId: externalId.slice(0, slash), name: externalId.slice(slash + 1) };
}

export function mapExportSink(
  accountId: string,
  namespaceId: string,
  sink: TcExportSink,
): ResourceInstance {
  const name = sink.name ?? sink.spec?.name ?? "";
  const s3 = sink.spec?.s3;
  const gcs = sink.spec?.gcs;
  return instance(
    accountId,
    "export-sink",
    exportSinkExternalId(namespaceId, name),
    name,
    {
      name,
      namespaceId,
      enabled: sink.spec?.enabled ?? false,
      destination: s3 ? "S3" : gcs ? "GCS" : sink.spec?.azureBlob ? "Azure Blob" : "",
      bucketName: s3?.bucketName ?? gcs?.bucketName ?? sink.spec?.azureBlob?.["containerName"],
      bucketRegion: s3?.region ?? gcs?.region ?? sink.spec?.azureBlob?.["region"],
      roleName: s3?.roleName,
      awsAccountId: s3?.awsAccountId,
      kmsArn: s3?.kmsArn,
      gcpProjectId: gcs?.gcpProjectId,
      serviceAccountId: gcs?.saId,
      health: stateName(sink.health),
      errorMessage: sink.errorMessage,
      state: stateName(sink.state),
      latestExportAt: sink.latestDataExportTime,
      lastHealthCheckAt: sink.lastHealthCheckTime,
    },
    { name },
    `${accountId}:namespace:${namespaceId}`,
  );
}

export function mapUser(accountId: string, u: TcUser): ResourceInstance {
  const id = u.id ?? "";
  const email = u.spec?.email ?? "";
  return instance(
    accountId,
    "user",
    id,
    email || id,
    {
      email,
      accountRole: roleName(u.spec?.access?.accountAccess?.role),
      namespaceAccess: accessSummary(u.spec?.access),
      customRoles: (u.spec?.access?.accountAccess?.customRoles ?? []).join(", "),
      state: stateName(u.state),
      invitedAt: u.invitation?.createdTime,
      inviteExpiresAt: u.invitation?.expiredTime,
      createdAt: u.createdTime,
      modifiedAt: u.lastModifiedTime,
    },
    { userId: id, email, [ACCESS_KEY]: JSON.stringify(u.spec?.access?.namespaceAccesses ?? {}) },
  );
}

export function mapServiceAccount(accountId: string, sa: TcServiceAccount): ResourceInstance {
  const id = sa.id ?? "";
  const scoped = sa.spec?.namespaceScopedAccess;
  const namespaceAccess = scoped?.namespace
    ? `${scoped.namespace}: ${permissionName(scoped.access?.permission) || "none"}`
    : accessSummary(sa.spec?.access);
  return instance(
    accountId,
    "service-account",
    id,
    sa.spec?.name ?? id,
    {
      name: sa.spec?.name,
      description: sa.spec?.description,
      accountRole: scoped?.namespace ? "" : roleName(sa.spec?.access?.accountAccess?.role),
      scope: scoped?.namespace ? "Namespace" : "Account",
      scopedNamespace: scoped?.namespace,
      namespaceAccess,
      state: stateName(sa.state),
      createdAt: sa.createdTime,
      modifiedAt: sa.lastModifiedTime,
    },
    {
      serviceAccountId: id,
      [ACCESS_KEY]: JSON.stringify(
        scoped?.namespace
          ? { [scoped.namespace]: scoped.access ?? {} }
          : (sa.spec?.access?.namespaceAccesses ?? {}),
      ),
    },
  );
}

export function mapApiKey(
  accountId: string,
  k: TcApiKey,
  owners: Map<string, string>,
): ResourceInstance {
  const id = k.id ?? "";
  const spec = k.spec ?? {};
  const ownerType =
    spec.ownerType === "OWNER_TYPE_SERVICE_ACCOUNT"
      ? "Service account"
      : spec.ownerType === "OWNER_TYPE_USER"
        ? "User"
        : "";
  return instance(
    accountId,
    "api-key",
    id,
    spec.displayName || id,
    {
      displayName: spec.displayName,
      description: spec.description,
      ownerType,
      owner: spec.ownerId ? (owners.get(spec.ownerId) ?? spec.ownerId) : undefined,
      disabled: spec.disabled ?? false,
      expiresAt: spec.expiryTime,
      state: stateName(k.state),
      createdAt: k.createdTime,
      modifiedAt: k.lastModifiedTime,
    },
    { keyId: id },
  );
}

export function mapNexusEndpoint(accountId: string, e: TcNexusEndpoint): ResourceInstance {
  const id = e.id ?? "";
  const spec = e.spec ?? {};
  const target = spec.targetSpec?.workerTargetSpec;
  const description = spec.description?.data ? decodePayload(spec.description.data) : "";
  return instance(
    accountId,
    "nexus-endpoint",
    id,
    spec.name ?? id,
    {
      name: spec.name,
      targetNamespace: target?.namespaceId,
      taskQueue: target?.taskQueue,
      allowedCallers: (spec.policySpecs ?? [])
        .map((p) => p.allowedCloudNamespacePolicySpec?.namespaceId ?? "")
        .filter(Boolean)
        .join(", "),
      description,
      state: stateName(e.state),
      createdAt: e.createdTime,
      modifiedAt: e.lastModifiedTime,
    },
    { endpointId: id, name: spec.name },
  );
}

/**
 * Nexus endpoint descriptions are Temporal `Payload`s: base64 `data` with a
 * base64 `encoding` metadata entry. Plain-text descriptions are written as
 * `json/plain` (a JSON string), which is what the Temporal Cloud UI does.
 */
export function decodePayload(data: string): string {
  try {
    const text = new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
    try {
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === "string" ? parsed : text;
    } catch {
      return text;
    }
  } catch {
    return "";
  }
}

export function encodePayload(text: string): { data: string; metadata: Record<string, string> } {
  const toBase64 = (s: string) => {
    const bytes = new TextEncoder().encode(s);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  };
  return { data: toBase64(JSON.stringify(text)), metadata: { encoding: toBase64("json/plain") } };
}

export function mapConnectivityRule(
  accountId: string,
  r: TcConnectivityRule,
  attached: Map<string, string[]>,
): ResourceInstance {
  const id = r.id ?? "";
  const priv = r.spec?.privateRule;
  const pub = r.spec?.publicRule;
  const type = priv ? "Private" : pub ? "Public" : "";
  const label = priv
    ? `Private ${priv.region ?? ""} ${priv.connectionId ?? ""}`.trim()
    : `Public${pub?.enableStableIps ? " (stable IPs)" : ""}`;
  return instance(
    accountId,
    "connectivity-rule",
    id,
    label || id,
    {
      type,
      region: priv?.region,
      connectionId: priv?.connectionId,
      gcpProjectId: priv?.gcpProjectId,
      stableIps: pub ? (pub.enableStableIps ?? false) : undefined,
      namespaces: (attached.get(id) ?? []).join(", "),
      state: stateName(r.state),
      createdAt: r.createdTime,
    },
    { ruleId: id },
  );
}
