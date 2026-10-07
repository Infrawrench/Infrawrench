/**
 * Raw Vault shapes (only the fields the plugin reads) and their mapping to
 * `ResourceInstance`s. Field names follow the Vault HTTP API reference
 * (developer.hashicorp.com/vault/api-docs, Vault 1.21, read 2026-10).
 */
import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CertInfo } from "./x509.js";

export const PLUGIN_ID = "hashicorp-vault";

export interface VaultHealth {
  initialized?: boolean;
  sealed?: boolean;
  standby?: boolean;
  performance_standby?: boolean;
  replication_performance_mode?: string;
  replication_dr_mode?: string;
  server_time_utc?: number;
  version?: string;
  enterprise?: boolean;
  cluster_name?: string;
  cluster_id?: string;
  ha_connection_healthy?: boolean;
  last_request_forwarding_heartbeat_ms?: number;
  clock_skew_ms?: number;
}

export interface VaultSealStatus {
  type?: string;
  initialized?: boolean;
  sealed?: boolean;
  t?: number;
  n?: number;
  progress?: number;
  version?: string;
  build_date?: string;
  storage_type?: string;
  cluster_name?: string;
  recovery_seal?: boolean;
}

export interface VaultLeader {
  ha_enabled?: boolean;
  is_self?: boolean;
  leader_address?: string;
  leader_cluster_address?: string;
  raft_committed_index?: number;
  raft_applied_index?: number;
}

export interface VaultMount {
  type?: string;
  description?: string;
  accessor?: string;
  local?: boolean;
  seal_wrap?: boolean;
  options?: Record<string, string> | null;
  config?: {
    default_lease_ttl?: number;
    max_lease_ttl?: number;
    listing_visibility?: string;
    token_type?: string;
  };
  running_plugin_version?: string;
  deprecation_status?: string;
}

export interface VaultKvMetadata {
  cas_required?: boolean;
  created_time?: string;
  current_version?: number;
  delete_version_after?: string;
  max_versions?: number;
  oldest_version?: number;
  updated_time?: string;
  custom_metadata?: Record<string, string> | null;
  versions?: Record<string, { created_time?: string; deletion_time?: string; destroyed?: boolean }>;
}

export interface VaultPkiRole {
  allowed_domains?: string[] | string;
  allow_subdomains?: boolean;
  allow_bare_domains?: boolean;
  allow_glob_domains?: boolean;
  allow_any_name?: boolean;
  allow_ip_sans?: boolean;
  allow_localhost?: boolean;
  enforce_hostnames?: boolean;
  server_flag?: boolean;
  client_flag?: boolean;
  key_type?: string;
  key_bits?: number;
  ttl?: number;
  max_ttl?: number;
  issuer_ref?: string;
  no_store?: boolean;
}

export interface VaultLease {
  id?: string;
  issue_time?: string;
  expire_time?: string | null;
  last_renewal_time?: string | null;
  renewable?: boolean;
  ttl?: number;
}

export interface VaultTokenInfo {
  accessor?: string;
  creation_time?: number;
  creation_ttl?: number;
  display_name?: string;
  entity_id?: string;
  expire_time?: string | null;
  explicit_max_ttl?: number;
  issue_time?: string;
  meta?: Record<string, string> | null;
  num_uses?: number;
  orphan?: boolean;
  path?: string;
  policies?: string[];
  identity_policies?: string[];
  renewable?: boolean;
  ttl?: number;
  type?: string;
}

export interface VaultAuditDevice {
  type?: string;
  description?: string;
  local?: boolean;
  options?: Record<string, string> | null;
}

/** Separator between a mount and the object inside it in composite ids. */
export const SEP = "::";

export function splitId(id: string): { mount: string; rest: string } {
  const i = id.indexOf(SEP);
  if (i <= 0) throw new Error(`Vault plugin: "${id}" is not a mount-scoped id`);
  return { mount: id.slice(0, i), rest: id.slice(i + SEP.length) };
}

/** `secret/` → `secret`. */
export const trimSlash = (p: string) => p.replace(/^\/+|\/+$/g, "");

export function ttlText(seconds: number | undefined): string | undefined {
  if (seconds === undefined || seconds === null) return undefined;
  if (seconds === 0) return "system default";
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, string | number | boolean | undefined | null>,
  extra: Partial<ResourceInstance> = {},
): ResourceInstance {
  const now = new Date().toISOString();
  const clean: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) clean[k] = v;
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName,
    fields: clean,
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

export function mapCluster(
  accountId: string,
  address: string,
  namespace: string | undefined,
  health: VaultHealth | undefined,
  seal: VaultSealStatus | undefined,
  leader: VaultLeader | undefined,
): ResourceInstance {
  const host = address.replace(/^https?:\/\//, "");
  const sealed = seal?.sealed ?? health?.sealed;
  return instance(
    accountId,
    "vault-cluster",
    host,
    health?.cluster_name || seal?.cluster_name || host,
    {
      address,
      namespace: namespace || undefined,
      version: health?.version ?? seal?.version,
      enterprise: health?.enterprise,
      clusterName: health?.cluster_name ?? seal?.cluster_name,
      clusterId: health?.cluster_id,
      initialized: health?.initialized ?? seal?.initialized,
      sealed,
      sealType: seal?.type,
      storageType: seal?.storage_type,
      threshold: seal?.t,
      shares: seal?.n,
      standby: health?.standby,
      performanceStandby: health?.performance_standby,
      haEnabled: leader?.ha_enabled,
      leaderAddress: leader?.leader_address || undefined,
      isLeader: leader?.is_self,
      replicationPerformance: health?.replication_performance_mode,
      replicationDr: health?.replication_dr_mode,
      raftCommittedIndex: leader?.raft_committed_index,
      raftAppliedIndex: leader?.raft_applied_index,
      buildDate: seal?.build_date,
    },
    { resolvedOutputs: { address, ...(namespace ? { namespace } : {}) } },
  );
}

export function mapMount(accountId: string, path: string, m: VaultMount): ResourceInstance {
  const p = trimSlash(path);
  const version = m.options?.["version"];
  const type = m.type === "kv" && version === "2" ? "kv-v2" : (m.type ?? "");
  return instance(accountId, "vault-mount", p, `${p}/`, {
    path: p,
    type,
    description: m.description ?? "",
    accessor: m.accessor,
    local: m.local,
    sealWrap: m.seal_wrap,
    defaultLeaseTtl: m.config?.default_lease_ttl,
    maxLeaseTtl: m.config?.max_lease_ttl,
    listingVisibility: m.config?.listing_visibility || undefined,
    pluginVersion: m.running_plugin_version || undefined,
    deprecationStatus: m.deprecation_status,
  });
}

export function mapAuthMethod(accountId: string, path: string, m: VaultMount): ResourceInstance {
  const p = trimSlash(path);
  return instance(accountId, "vault-auth-method", p, `${p}/`, {
    path: p,
    type: m.type ?? "",
    description: m.description ?? "",
    accessor: m.accessor,
    local: m.local,
    defaultLeaseTtl: m.config?.default_lease_ttl,
    maxLeaseTtl: m.config?.max_lease_ttl,
    listingVisibility: m.config?.listing_visibility || undefined,
    tokenType: m.config?.token_type,
    pluginVersion: m.running_plugin_version || undefined,
  });
}

export function mapPolicy(accountId: string, name: string, policy?: string): ResourceInstance {
  const rules = policy ? (policy.match(/\bpath\s+"/g) ?? []).length : undefined;
  const builtIn = name === "root" || name === "default";
  return instance(
    accountId,
    "vault-policy",
    name,
    name,
    {
      name,
      paths: rules,
      builtIn,
      grantsSudo: policy ? /"sudo"/.test(policy) : undefined,
    },
    policy !== undefined ? { resolvedOutputs: { policy } } : {},
  );
}

export function mapKvSecret(
  accountId: string,
  mount: string,
  path: string,
  meta?: VaultKvMetadata,
): ResourceInstance {
  const versions = Object.values(meta?.versions ?? {});
  const current =
    meta?.current_version !== undefined ? meta.versions?.[String(meta.current_version)] : undefined;
  return instance(
    accountId,
    "vault-kv-secret",
    `${mount}${SEP}${path}`,
    path,
    {
      mount,
      path,
      currentVersion: meta?.current_version,
      versions: meta ? versions.length : undefined,
      currentDeleted: current
        ? Boolean(current.deletion_time) || Boolean(current.destroyed)
        : undefined,
      createdAt: meta?.created_time,
      updatedAt: meta?.updated_time,
      maxVersions: meta?.max_versions,
      casRequired: meta?.cas_required,
      deleteVersionAfter: meta?.delete_version_after,
      customMetadata: meta?.custom_metadata
        ? Object.entries(meta.custom_metadata)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")
        : undefined,
    },
    {
      parentResourceId: `${accountId}:vault-mount:${mount}`,
      resolvedOutputs: { path: `${mount}/${path}` },
    },
  );
}

const list = (v: string[] | string | undefined) => (Array.isArray(v) ? v.join(", ") : (v ?? ""));

export function mapPkiRole(
  accountId: string,
  mount: string,
  name: string,
  r?: VaultPkiRole,
): ResourceInstance {
  return instance(
    accountId,
    "vault-pki-role",
    `${mount}${SEP}${name}`,
    name,
    {
      mount,
      name,
      allowedDomains: r ? list(r.allowed_domains) : undefined,
      allowSubdomains: r?.allow_subdomains,
      allowBareDomains: r?.allow_bare_domains,
      allowGlobDomains: r?.allow_glob_domains,
      allowAnyName: r?.allow_any_name,
      allowIpSans: r?.allow_ip_sans,
      allowLocalhost: r?.allow_localhost,
      enforceHostnames: r?.enforce_hostnames,
      serverFlag: r?.server_flag,
      clientFlag: r?.client_flag,
      keyType: r?.key_type,
      keyBits: r?.key_bits,
      ttl: r?.ttl,
      maxTtl: r?.max_ttl,
      issuerRef: r?.issuer_ref,
      noStore: r?.no_store,
    },
    { parentResourceId: `${accountId}:vault-mount:${mount}` },
  );
}

/** Vault takes serials colon- or hyphen-separated; ids use hyphens so `::` stays unambiguous. */
export const hyphenSerial = (s: string) => s.replace(/:/g, "-");

export function mapPkiCert(
  accountId: string,
  mount: string,
  serial: string,
  info: CertInfo,
  revocationTime?: number,
): ResourceInstance {
  const s = hyphenSerial(serial);
  const revoked = typeof revocationTime === "number" && revocationTime > 0;
  return instance(
    accountId,
    "vault-pki-cert",
    `${mount}${SEP}${s}`,
    info.commonName ?? s,
    {
      mount,
      serial: s,
      commonName: info.commonName,
      issuer: info.issuerCommonName,
      notBefore: info.notBefore,
      notAfter: revoked ? undefined : info.notAfter,
      expires: info.notAfter,
      revoked,
      revokedAt: revoked ? new Date(revocationTime! * 1000).toISOString() : undefined,
    },
    { parentResourceId: `${accountId}:vault-mount:${mount}` },
  );
}

export function mapLease(accountId: string, id: string, l?: VaultLease): ResourceInstance {
  const prefix = id.split("/").slice(0, -1).join("/");
  return instance(accountId, "vault-lease", id, id.split("/").slice(-2).join("/"), {
    leaseId: id,
    prefix,
    issueTime: l?.issue_time,
    expireTime: l?.expire_time ?? undefined,
    lastRenewal: l?.last_renewal_time ?? undefined,
    renewable: l?.renewable,
    ttl: l?.ttl,
  });
}

export function mapToken(accountId: string, t: VaultTokenInfo): ResourceInstance {
  const accessor = t.accessor ?? "";
  const policies = [...(t.policies ?? []), ...(t.identity_policies ?? [])];
  return instance(accountId, "vault-token", accessor, t.display_name || accessor, {
    accessor,
    displayName: t.display_name,
    policies: policies.join(", "),
    root: policies.includes("root"),
    path: t.path,
    type: t.type,
    createdAt: t.creation_time ? new Date(t.creation_time * 1000).toISOString() : t.issue_time,
    expireTime: t.expire_time ?? undefined,
    neverExpires: !t.expire_time,
    ttl: t.ttl,
    renewable: t.renewable,
    orphan: t.orphan,
    numUses: t.num_uses,
    entityId: t.entity_id || undefined,
    meta: t.meta
      ? Object.entries(t.meta)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")
      : undefined,
  });
}

export function mapAudit(accountId: string, path: string, a: VaultAuditDevice): ResourceInstance {
  const p = trimSlash(path);
  return instance(accountId, "vault-audit-device", p, `${p}/`, {
    path: p,
    type: a.type ?? "",
    description: a.description ?? "",
    local: a.local,
    options: a.options
      ? Object.entries(a.options)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")
      : undefined,
    filePath: a.options?.["file_path"],
  });
}
