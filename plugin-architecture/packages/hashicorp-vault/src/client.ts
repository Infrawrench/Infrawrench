import type {
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  PreflightCapability,
  PreflightCapabilityCheck,
  PreflightResult,
  ResourceInstance,
  SecretVersion,
  SecretVersionMutation,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { decodePromptArgs, externalIdOf } from "@infrawrench/plugin-base";
import type { VaultContext } from "./api.js";
import {
  encodePath,
  normaliseAddress,
  payload,
  statusOf,
  VaultApiError,
  vaultFetch,
  vaultList,
} from "./api.js";
import type {
  VaultAuditDevice,
  VaultHealth,
  VaultKvMetadata,
  VaultLeader,
  VaultLease,
  VaultMount,
  VaultPkiRole,
  VaultSealStatus,
  VaultTokenInfo,
} from "./mappers.js";
import {
  mapAudit,
  mapAuthMethod,
  mapCluster,
  mapKvSecret,
  mapLease,
  mapMount,
  mapPkiCert,
  mapPkiRole,
  mapPolicy,
  mapToken,
  splitId,
  trimSlash,
} from "./mappers.js";
import { COMMANDS, renderVaultDetail, renderVaultSidebar } from "./render.js";
import { parsePemCertificate } from "./x509.js";

const MAX_KV_PER_MOUNT = 500;
const MAX_KV_METADATA = 200;
const MAX_CERTS_PER_MOUNT = 200;
const MAX_LEASES = 300;
const MAX_TOKENS = 200;

/** Health answers non-2xx for perfectly normal states (standby 429, sealed 503…). */
const HEALTH_STATUSES = [429, 472, 473, 474, 501, 503, 530];

const SECRET_ENGINES = [
  { id: "kv-v2", label: "KV version 2", description: "Versioned key/value secrets" },
  { id: "kv", label: "KV version 1", description: "Unversioned key/value secrets" },
  { id: "pki", label: "PKI", description: "X.509 certificates" },
  { id: "transit", label: "Transit", description: "Encryption as a service" },
  { id: "database", label: "Databases", description: "Dynamic database credentials" },
  { id: "aws", label: "AWS", description: "Dynamic AWS credentials" },
  { id: "azure", label: "Azure", description: "Dynamic Azure service principals" },
  { id: "gcp", label: "Google Cloud", description: "Dynamic GCP credentials" },
  { id: "ssh", label: "SSH", description: "Signed SSH certificates and OTPs" },
  { id: "totp", label: "TOTP", description: "Time-based one-time passwords" },
  { id: "kubernetes", label: "Kubernetes", description: "Service account tokens" },
  { id: "ldap", label: "LDAP", description: "LDAP credential rotation" },
  { id: "rabbitmq", label: "RabbitMQ", description: "Dynamic RabbitMQ users" },
  { id: "consul", label: "Consul", description: "Consul ACL tokens" },
  { id: "nomad", label: "Nomad", description: "Nomad ACL tokens" },
  { id: "terraform", label: "HCP Terraform", description: "API tokens" },
];

const AUTH_METHODS = [
  { id: "approle", label: "AppRole" },
  { id: "userpass", label: "Username & password" },
  { id: "oidc", label: "OIDC" },
  { id: "jwt", label: "JWT" },
  { id: "kubernetes", label: "Kubernetes" },
  { id: "ldap", label: "LDAP" },
  { id: "github", label: "GitHub" },
  { id: "aws", label: "AWS" },
  { id: "azure", label: "Azure" },
  { id: "gcp", label: "Google Cloud" },
  { id: "cert", label: "TLS certificates" },
  { id: "okta", label: "Okta" },
  { id: "radius", label: "RADIUS" },
];

const POLICY_TEMPLATE = `# Read secrets under secret/data/app/*
path "secret/data/app/*" {
  capabilities = ["read", "list"]
}
`;

const bool = (raw: string | undefined): boolean => /^(true|yes|1|on)$/i.test((raw ?? "").trim());
const list = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

function numberField(raw: string | undefined, label: string): number | undefined {
  const v = (raw ?? "").trim();
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0)
    throw new Error(`Vault plugin: "${label}" must be a non-negative number`);
  return n;
}

/**
 * A KV value typed by a person: a JSON object, `KEY=value` lines, or a bare
 * string (stored under `value`). Vault needs an object of string keys.
 */
export function parseKvValue(raw: string): Record<string, unknown> {
  const text = raw.trim();
  if (text.startsWith("{")) {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
  if (lines.length > 0 && lines.every((l) => /^[^=\s][^=]*=/.test(l))) {
    return Object.fromEntries(
      lines.map((l) => {
        const i = l.indexOf("=");
        return [
          l.slice(0, i).trim(),
          l
            .slice(i + 1)
            .trim()
            .replace(/^"(.*)"$/, "$1"),
        ];
      }),
    );
  }
  return { value: raw };
}

function keyValuePairs(raw: string | undefined): Record<string, string> {
  return Object.fromEntries(
    list(raw).map((pair) => {
      const i = pair.indexOf("=");
      return i < 0 ? [pair, ""] : [pair.slice(0, i).trim(), pair.slice(i + 1).trim()];
    }),
  );
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

export function buildContext(
  credentials: Record<string, string>,
  services?: HostServices,
): VaultContext {
  const address = normaliseAddress(credentials["address"] ?? "");
  if (!address) throw new Error("Vault plugin: missing the Vault address");
  const token = (credentials["token"] ?? "").trim();
  const roleId = (credentials["roleId"] ?? "").trim();
  const secretId = (credentials["secretId"] ?? "").trim();
  if (!token && !(roleId && secretId)) {
    throw new Error("Vault plugin: enter a token, or an AppRole role ID and secret ID");
  }
  const namespace = trimSlash(credentials["namespace"] ?? "");
  const caCert = credentials["caCert"] ?? "";
  return {
    address,
    ...(namespace ? { namespace } : {}),
    ...(token
      ? { token }
      : {
          appRole: {
            roleId,
            secretId,
            mount: trimSlash(credentials["appRoleMount"] ?? "") || "approle",
          },
        }),
    ...(caCert ? { caCert } : {}),
    ...(services?.http ? { http: services.http } : {}),
  };
}

const PROBES: Array<{ capability: PreflightCapability; path: string; list?: boolean }> = [
  {
    capability: {
      id: "engines",
      label: "Secrets engines and auth methods",
      description: "List, enable, tune and disable secrets engines and auth methods.",
      requiredPermissions: [
        {
          id: 'path "sys/mounts*" { capabilities = ["read", "create", "update", "delete", "sudo"] }',
          label: "sys/mounts",
        },
      ],
      essential: true,
    },
    path: "/sys/mounts",
  },
  {
    capability: {
      id: "policies",
      label: "Policies",
      description: "List, read, write and delete ACL policies.",
      requiredPermissions: [
        {
          id: 'path "sys/policies/acl/*" { capabilities = ["create", "read", "update", "delete", "list"] }',
          label: "sys/policies/acl",
        },
      ],
    },
    path: "/sys/policies/acl",
    list: true,
  },
  {
    capability: {
      id: "tokens",
      label: "Tokens",
      description: "List token accessors, renew and revoke tokens (needs sudo).",
      requiredPermissions: [
        {
          id: 'path "auth/token/accessors" { capabilities = ["list", "sudo"] }',
          label: "auth/token/accessors",
        },
      ],
    },
    path: "/auth/token/accessors",
    list: true,
  },
  {
    capability: {
      id: "leases",
      label: "Leases",
      description: "List, renew and revoke leases (needs sudo).",
      requiredPermissions: [
        {
          id: 'path "sys/leases/lookup/*" { capabilities = ["list", "sudo"] }',
          label: "sys/leases/lookup",
        },
      ],
    },
    path: "/sys/leases/lookup/",
    list: true,
  },
  {
    capability: {
      id: "audit",
      label: "Audit devices",
      description: "List, enable and disable audit devices (needs sudo).",
      requiredPermissions: [
        {
          id: 'path "sys/audit*" { capabilities = ["read", "create", "update", "delete", "sudo"] }',
          label: "sys/audit",
        },
      ],
    },
    path: "/sys/audit",
  },
];

export const VAULT_PREFLIGHT = { capabilities: PROBES.map((p) => p.capability) };

export class VaultClient implements PluginClient {
  private readonly ctx: VaultContext;
  private mountsCache: Promise<Record<string, VaultMount>> | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    this.ctx = buildContext(credentials, services);
  }

  private mounts(fresh = false): Promise<Record<string, VaultMount>> {
    if (fresh) this.mountsCache = undefined;
    this.mountsCache ??= vaultFetch<unknown>(this.ctx, "/sys/mounts")
      .then((res) => {
        const all = payload<Record<string, VaultMount>>(res);
        return Object.fromEntries(
          Object.entries(all).filter(
            ([k, v]) => k.endsWith("/") && v && typeof v === "object" && "type" in v,
          ),
        );
      })
      .catch((err: unknown) => {
        this.mountsCache = undefined;
        throw err;
      });
    return this.mountsCache;
  }

  private async mountsOfType(type: string): Promise<string[]> {
    return Object.entries(await this.mounts())
      .filter(([, m]) =>
        type === "kv-v2" ? m.type === "kv" && m.options?.["version"] === "2" : m.type === type,
      )
      .map(([p]) => trimSlash(p));
  }

  private async kvPaths(mount: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (prefix: string, depth: number): Promise<void> => {
      if (out.length >= MAX_KV_PER_MOUNT || depth > 10) return;
      for (const key of await vaultList(
        this.ctx,
        `/${encodePath(mount)}/metadata/${encodePath(prefix)}`,
      )) {
        if (out.length >= MAX_KV_PER_MOUNT) return;
        if (key.endsWith("/")) await walk(`${prefix}${key}`, depth + 1);
        else out.push(`${prefix}${key}`);
      }
    };
    await walk("", 0);
    return out;
  }

  private kvMetadata(mount: string, path: string): Promise<VaultKvMetadata> {
    return vaultFetch<{ data?: VaultKvMetadata }>(
      this.ctx,
      `/${encodePath(mount)}/metadata/${encodePath(path)}`,
    ).then((r) => r?.data ?? {});
  }

  private async leaseIds(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (prefix: string, depth: number): Promise<void> => {
      if (out.length >= MAX_LEASES || depth > 12) return;
      for (const key of await vaultList(this.ctx, `/sys/leases/lookup/${encodePath(prefix)}`)) {
        if (out.length >= MAX_LEASES) return;
        if (key.endsWith("/")) await walk(`${prefix}${key}`, depth + 1);
        else out.push(`${prefix}${key}`);
      }
    };
    await walk("", 0);
    return out;
  }

  private lease(id: string): Promise<VaultLease> {
    return vaultFetch<{ data?: VaultLease }>(this.ctx, "/sys/leases/lookup", {
      method: "PUT",
      body: { lease_id: id },
    }).then((r) => r?.data ?? {});
  }

  private tokenByAccessor(accessor: string): Promise<VaultTokenInfo> {
    return vaultFetch<{ data?: VaultTokenInfo }>(this.ctx, "/auth/token/lookup-accessor", {
      method: "POST",
      body: { accessor },
    }).then((r) => ({ accessor, ...(r?.data ?? {}) }));
  }

  private async cert(mount: string, serial: string): Promise<{ pem: string; revocation?: number }> {
    const r = await vaultFetch<{ data?: { certificate?: string; revocation_time?: number } }>(
      this.ctx,
      `/${encodePath(mount)}/cert/${encodeURIComponent(serial)}`,
    );
    return {
      pem: r?.data?.certificate ?? "",
      ...(r?.data?.revocation_time !== undefined ? { revocation: r.data.revocation_time } : {}),
    };
  }

  private async policyText(name: string): Promise<string | undefined> {
    const r = await vaultFetch<{ data?: { policy?: string }; policy?: string }>(
      this.ctx,
      `/sys/policies/acl/${encodeURIComponent(name)}`,
    );
    return r?.data?.policy ?? r?.policy;
  }

  private async cluster(accountId: string): Promise<ResourceInstance> {
    const [health, seal, leader] = await Promise.all([
      vaultFetch<VaultHealth>(this.ctx, "/sys/health", { acceptStatuses: HEALTH_STATUSES }).catch(
        () => undefined,
      ),
      vaultFetch<VaultSealStatus>(this.ctx, "/sys/seal-status").catch(() => undefined),
      vaultFetch<VaultLeader>(this.ctx, "/sys/leader").catch(() => undefined),
    ]);
    if (!health && !seal) {
      // Unreachable: make the real failure visible.
      await vaultFetch(this.ctx, "/auth/token/lookup-self");
    }
    return mapCluster(accountId, this.ctx.address, this.ctx.namespace, health, seal, leader);
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "vault-cluster":
        return [await this.cluster(accountId)];
      case "vault-mount":
        return Object.entries(await this.mounts(true)).map(([p, m]) => mapMount(accountId, p, m));
      case "vault-kv-secret": {
        const out: ResourceInstance[] = [];
        let detailed = 0;
        for (const mount of await this.mountsOfType("kv-v2")) {
          const paths = await this.kvPaths(mount).catch((err: unknown) => {
            if (statusOf(err) === 403) return [] as string[];
            throw err;
          });
          const rows = await mapLimit(paths, 6, async (path) => {
            if (detailed++ >= MAX_KV_METADATA) return mapKvSecret(accountId, mount, path);
            return mapKvSecret(
              accountId,
              mount,
              path,
              await this.kvMetadata(mount, path).catch(() => undefined),
            );
          });
          out.push(...rows);
        }
        return out;
      }
      case "vault-auth-method": {
        const res = payload<Record<string, VaultMount>>(await vaultFetch(this.ctx, "/sys/auth"));
        return Object.entries(res)
          .filter(([k, v]) => k.endsWith("/") && v && typeof v === "object" && "type" in v)
          .map(([p, m]) => mapAuthMethod(accountId, p, m));
      }
      case "vault-policy": {
        const names = await vaultList(this.ctx, "/sys/policies/acl");
        return mapLimit(names, 6, async (n) => {
          const text = await this.policyText(n).catch(() => undefined);
          return mapPolicy(accountId, n, text);
        });
      }
      case "vault-pki-role": {
        const out: ResourceInstance[] = [];
        for (const mount of await this.mountsOfType("pki")) {
          const names = await vaultList(this.ctx, `/${encodePath(mount)}/roles`);
          out.push(
            ...(await mapLimit(names, 6, async (n) =>
              mapPkiRole(
                accountId,
                mount,
                n,
                await vaultFetch<{ data?: VaultPkiRole }>(
                  this.ctx,
                  `/${encodePath(mount)}/roles/${encodeURIComponent(n)}`,
                )
                  .then((r) => r?.data)
                  .catch(() => undefined),
              ),
            )),
          );
        }
        return out;
      }
      case "vault-pki-cert": {
        const out: ResourceInstance[] = [];
        for (const mount of await this.mountsOfType("pki")) {
          const serials = (await vaultList(this.ctx, `/${encodePath(mount)}/certs`)).slice(
            0,
            MAX_CERTS_PER_MOUNT,
          );
          out.push(
            ...(await mapLimit(serials, 6, async (s) => {
              const c = await this.cert(mount, s).catch(
                () => ({ pem: "" }) as { pem: string; revocation?: number },
              );
              return mapPkiCert(accountId, mount, s, parsePemCertificate(c.pem), c.revocation);
            })),
          );
        }
        return out;
      }
      case "vault-lease": {
        const ids = await this.leaseIds();
        return mapLimit(ids, 6, async (id) =>
          mapLease(accountId, id, await this.lease(id).catch(() => undefined)),
        );
      }
      case "vault-token": {
        const accessors = (await vaultList(this.ctx, "/auth/token/accessors")).slice(0, MAX_TOKENS);
        const tokens = await mapLimit(accessors, 6, (a) =>
          this.tokenByAccessor(a).catch(() => undefined),
        );
        return tokens.filter((t): t is VaultTokenInfo => !!t).map((t) => mapToken(accountId, t));
      }
      case "vault-audit-device": {
        const res = payload<Record<string, VaultAuditDevice>>(
          await vaultFetch(this.ctx, "/sys/audit"),
        );
        return Object.entries(res)
          .filter(([k, v]) => k.endsWith("/") && v && typeof v === "object" && "type" in v)
          .map(([p, a]) => mapAudit(accountId, p, a));
      }
      default:
        throw new Error(`Vault plugin: unknown resource type "${typeId}"`);
    }
  }

  // -------------------------------------------------------------------------
  // Single reads
  // -------------------------------------------------------------------------

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    const notFound = (what: string) =>
      new VaultApiError(404, `Vault plugin: ${what} "${id}" not found`);
    switch (typeId) {
      case "vault-cluster":
        return this.cluster(accountId);
      case "vault-mount": {
        const m = (await this.mounts(true))[`${id}/`];
        if (!m) throw notFound("secrets engine");
        return mapMount(accountId, id, m);
      }
      case "vault-kv-secret": {
        const { mount, rest } = splitId(id);
        return mapKvSecret(accountId, mount, rest, await this.kvMetadata(mount, rest));
      }
      case "vault-auth-method": {
        const all = payload<Record<string, VaultMount>>(await vaultFetch(this.ctx, "/sys/auth"));
        const m = all[`${id}/`];
        if (!m) throw notFound("auth method");
        return mapAuthMethod(accountId, id, m);
      }
      case "vault-policy":
        return mapPolicy(accountId, id, await this.policyText(id));
      case "vault-pki-role": {
        const { mount, rest } = splitId(id);
        const r = await vaultFetch<{ data?: VaultPkiRole }>(
          this.ctx,
          `/${encodePath(mount)}/roles/${encodeURIComponent(rest)}`,
        );
        return mapPkiRole(accountId, mount, rest, r?.data ?? {});
      }
      case "vault-pki-cert": {
        const { mount, rest } = splitId(id);
        const c = await this.cert(mount, rest);
        const r = mapPkiCert(accountId, mount, rest, parsePemCertificate(c.pem), c.revocation);
        return c.pem ? { ...r, resolvedOutputs: { ...r.resolvedOutputs, certificate: c.pem } } : r;
      }
      case "vault-lease":
        return mapLease(accountId, id, await this.lease(id));
      case "vault-token":
        return mapToken(accountId, await this.tokenByAccessor(id));
      case "vault-audit-device": {
        const all = payload<Record<string, VaultAuditDevice>>(
          await vaultFetch(this.ctx, "/sys/audit"),
        );
        const a = all[`${id}/`];
        if (!a) throw notFound("audit device");
        return mapAudit(accountId, id, a);
      }
      default:
        throw new Error(`Vault plugin: unknown resource type "${typeId}"`);
    }
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "vault-kv-secret" && outputKey === "value") {
      const { mount, rest } = splitId(externalIdOf(resourceId));
      const r = await vaultFetch<{ data?: { data?: unknown } }>(
        this.ctx,
        `/${encodePath(mount)}/data/${encodePath(rest)}`,
      );
      return JSON.stringify(r?.data?.data ?? {});
    }
    const resource = await this.getResource(typeId, resourceId, accountId);
    const resolved = resource.resolvedOutputs[outputKey];
    if (resolved !== undefined) return resolved;
    const field = resource.fields[outputKey];
    if (field !== undefined) return String(field);
    throw new Error(`Vault plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // KV v2 versions
  // -------------------------------------------------------------------------

  async listSecretVersions(typeId: string, resourceId: string): Promise<SecretVersion[]> {
    if (typeId !== "vault-kv-secret") return [];
    const { mount, rest } = splitId(externalIdOf(resourceId));
    const meta = await this.kvMetadata(mount, rest);
    return Object.entries(meta.versions ?? {})
      .map(([v, info]): SecretVersion => {
        const state = info.destroyed ? "destroyed" : info.deletion_time ? "disabled" : "enabled";
        return {
          id: v,
          state,
          createdAt: info.created_time ?? "",
          ...(state === "destroyed" && info.deletion_time
            ? { destroyedAt: info.deletion_time }
            : {}),
          ...(Number(v) === meta.current_version ? { isLatest: true } : {}),
        };
      })
      .sort((a, b) => Number(b.id) - Number(a.id));
  }

  async accessSecretVersion(
    typeId: string,
    resourceId: string,
    _accountId: string,
    versionId: string,
  ): Promise<string> {
    const { mount, rest } = splitId(externalIdOf(resourceId));
    const r = await vaultFetch<{ data?: { data?: unknown } }>(
      this.ctx,
      `/${encodePath(mount)}/data/${encodePath(rest)}`,
      {
        query: { version: versionId },
      },
    );
    if (r?.data?.data == null)
      throw new Error("Vault plugin: this version is deleted or destroyed");
    return JSON.stringify(r.data.data, null, 2);
  }

  async addSecretVersion(
    typeId: string,
    resourceId: string,
    _accountId: string,
    value: string,
  ): Promise<SecretVersion> {
    const { mount, rest } = splitId(externalIdOf(resourceId));
    const r = await vaultFetch<{ data?: { version?: number; created_time?: string } }>(
      this.ctx,
      `/${encodePath(mount)}/data/${encodePath(rest)}`,
      { method: "POST", body: { data: parseKvValue(value) } },
    );
    return {
      id: String(r?.data?.version ?? ""),
      state: "enabled",
      createdAt: r?.data?.created_time ?? new Date().toISOString(),
      isLatest: true,
    };
  }

  async modifySecretVersion(
    typeId: string,
    resourceId: string,
    accountId: string,
    versionId: string,
    action: SecretVersionMutation,
  ): Promise<SecretVersion> {
    const { mount, rest } = splitId(externalIdOf(resourceId));
    const verb = action === "enable" ? "undelete" : action === "disable" ? "delete" : "destroy";
    await vaultFetch(this.ctx, `/${encodePath(mount)}/${verb}/${encodePath(rest)}`, {
      method: action === "destroy" ? "PUT" : "POST",
      body: { versions: [Number(versionId)] },
    });
    const versions = await this.listSecretVersions(typeId, resourceId);
    return (
      versions.find((v) => v.id === versionId) ?? {
        id: versionId,
        state: action === "enable" ? "enabled" : action === "disable" ? "disabled" : "destroyed",
        createdAt: "",
      }
    );
  }

  // -------------------------------------------------------------------------
  // Stats, metrics, preflight
  // -------------------------------------------------------------------------

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    if (resourceTypeId !== "vault-cluster") return [];
    const r = await this.getResource(resourceTypeId, resourceId, accountId);
    const sealed = r.fields["sealed"] === true;
    return [
      {
        label: "Seal",
        value: sealed ? "sealed" : "unsealed",
        variant: sealed ? "status-error" : "status-healthy",
      },
      { label: "Version", value: String(r.fields["version"] ?? "—") },
    ];
  }

  /**
   * Cluster metrics: seal and standby state from `sys/health`, a handful of
   * gauges from `sys/metrics` (needs a token allowed to read it, or
   * unauthenticated metrics access), and monthly clients from
   * `sys/internal/counters/activity` over the last twelve months.
   */
  async fetchMetricSeries(
    resourceTypeId: string,
    _resourceId: string,
    _accountId: string,
  ): Promise<MetricSeries[]> {
    if (resourceTypeId !== "vault-cluster") return [];
    const now = Date.now();
    const out: MetricSeries[] = [];
    const health = await vaultFetch<VaultHealth>(this.ctx, "/sys/health", {
      acceptStatuses: HEALTH_STATUSES,
    }).catch(() => undefined);
    if (health) {
      out.push({
        label: "Sealed",
        unit: "bool",
        points: [{ timestamp: now, value: health.sealed ? 1 : 0 }],
      });
      out.push({
        label: "Standby",
        unit: "bool",
        points: [{ timestamp: now, value: health.standby ? 1 : 0 }],
      });
      if (typeof health.clock_skew_ms === "number") {
        out.push({
          label: "Clock skew",
          unit: "ms",
          points: [{ timestamp: now, value: health.clock_skew_ms }],
        });
      }
    }
    const metrics = await vaultFetch<{
      Gauges?: Array<{ Name?: string; Value?: number; Labels?: Record<string, string> }>;
    }>(this.ctx, "/sys/metrics").catch(() => undefined);
    const wanted: Record<string, [string, string]> = {
      "vault.expire.num_leases": ["Leases", "count"],
      "vault.token.count": ["Tokens", "count"],
      "vault.secret.kv.count": ["KV secrets", "count"],
      "vault.identity.num_entities": ["Identity entities", "count"],
      "vault.runtime.alloc_bytes": ["Memory allocated", "bytes"],
      "vault.runtime.num_goroutines": ["Goroutines", "count"],
    };
    const sums = new Map<string, number>();
    for (const g of metrics?.Gauges ?? []) {
      if (!g.Name || typeof g.Value !== "number") continue;
      const key = Object.keys(wanted).find((w) => g.Name === w || g.Name!.endsWith(`.${w}`));
      if (key) sums.set(key, (sums.get(key) ?? 0) + g.Value);
    }
    for (const [key, value] of sums) {
      const [label, unit] = wanted[key]!;
      out.push({ label, unit, points: [{ timestamp: now, value }] });
    }
    const start = new Date(
      Date.UTC(new Date(now).getUTCFullYear() - 1, new Date(now).getUTCMonth(), 1),
    ).toISOString();
    const activity = await vaultFetch<{
      data?: {
        months?: Array<{
          timestamp?: string;
          counts?: {
            clients?: number;
            entity_clients?: number;
            non_entity_clients?: number;
          } | null;
        }>;
      };
    }>(this.ctx, "/sys/internal/counters/activity", {
      query: { start_time: start, end_time: new Date(now).toISOString() },
    }).catch(() => undefined);
    const months = (activity?.data?.months ?? []).filter((m) => m.timestamp && m.counts);
    if (months.length) {
      const series = (
        label: string,
        key: "clients" | "entity_clients" | "non_entity_clients",
      ): MetricSeries => ({
        label,
        unit: "count",
        points: months
          .map((m) => ({ timestamp: Date.parse(m.timestamp!), value: m.counts?.[key] ?? 0 }))
          .sort((a, b) => a.timestamp - b.timestamp),
      });
      out.push(
        series("Monthly clients", "clients"),
        series("Entity clients", "entity_clients"),
        series("Non-entity clients", "non_entity_clients"),
      );
    }
    return out;
  }

  async verifyCredentials(): Promise<PreflightResult> {
    const checks = await Promise.all(
      PROBES.map(async (p): Promise<PreflightCapabilityCheck> => {
        try {
          if (p.list) await vaultFetch(this.ctx, p.path, { query: { list: true } });
          else await vaultFetch(this.ctx, p.path);
          return { capabilityId: p.capability.id, status: "ok" };
        } catch (err) {
          const s = statusOf(err);
          if (s === 404 && p.list) return { capabilityId: p.capability.id, status: "ok" };
          if (s === 403 || s === 401) {
            return {
              capabilityId: p.capability.id,
              status: "missing",
              missingPermissions: p.capability.requiredPermissions,
            };
          }
          return {
            capabilityId: p.capability.id,
            status: "unknown",
            message: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
    const self = await vaultFetch<{ data?: { display_name?: string; policies?: string[] } }>(
      this.ctx,
      "/auth/token/lookup-self",
    ).catch(() => undefined);
    const identity = self?.data?.display_name
      ? `${self.data.display_name} (${(self.data.policies ?? []).join(", ")})`
      : undefined;
    return { checks, ...(identity ? { identity } : {}) };
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    const parentMount = parentResourceId ? externalIdOf(parentResourceId) : undefined;
    const mountPicker = async (type: string, label: string) => {
      if (parentMount) return [];
      const mounts = await this.mountsOfType(type).catch(() => [] as string[]);
      return [
        {
          key: "mount",
          label,
          kind: "select" as const,
          required: true,
          ...(mounts[0] ? { defaultValue: mounts[0] } : {}),
          options: mounts.map((m) => ({ id: m, label: `${m}/` })),
        },
      ];
    };
    switch (typeId) {
      case "vault-mount":
        return {
          fields: [
            {
              key: "type",
              label: "Engine",
              kind: "select",
              required: true,
              defaultValue: "kv-v2",
              options: SECRET_ENGINES,
            },
            {
              key: "path",
              label: "Path",
              kind: "text",
              required: true,
              placeholder: "secret",
              description: "Where the engine is mounted, e.g. secret or pki-internal.",
            },
            { key: "description", label: "Description", kind: "text", required: false },
          ],
        };
      case "vault-kv-secret":
        return {
          fields: [
            ...(await mountPicker("kv-v2", "KV engine")),
            {
              key: "path",
              label: "Path",
              kind: "text",
              required: true,
              placeholder: "app/database",
            },
            {
              key: "value",
              label: "Value",
              kind: "text",
              multiline: true,
              required: true,
              placeholder: '{"username": "app", "password": "…"}',
              description: "A JSON object or KEY=value lines.",
            },
          ],
        };
      case "vault-auth-method":
        return {
          fields: [
            {
              key: "type",
              label: "Method",
              kind: "select",
              required: true,
              defaultValue: "approle",
              options: AUTH_METHODS,
            },
            {
              key: "path",
              label: "Path",
              kind: "text",
              required: false,
              placeholder: "Defaults to the method name",
            },
            { key: "description", label: "Description", kind: "text", required: false },
          ],
        };
      case "vault-policy":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "app-read" },
            {
              key: "policy",
              label: "Policy (HCL)",
              kind: "code",
              codeLanguage: "hcl",
              required: true,
              defaultValue: POLICY_TEMPLATE,
            },
          ],
        };
      case "vault-pki-role":
        return {
          fields: [
            ...(await mountPicker("pki", "PKI engine")),
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "internal-services",
            },
            {
              key: "allowedDomains",
              label: "Allowed domains",
              kind: "string-list",
              required: false,
              placeholder: "example.internal",
            },
            {
              key: "allowSubdomains",
              label: "Allow subdomains",
              kind: "select",
              required: false,
              defaultValue: "true",
              options: [
                { id: "true", label: "Yes" },
                { id: "false", label: "No" },
              ],
            },
            { key: "ttl", label: "TTL", kind: "text", required: false, placeholder: "72h" },
            { key: "maxTtl", label: "Max TTL", kind: "text", required: false, placeholder: "720h" },
          ],
        };
      case "vault-audit-device":
        return {
          fields: [
            {
              key: "type",
              label: "Type",
              kind: "select",
              required: true,
              defaultValue: "file",
              options: [
                { id: "file", label: "File" },
                { id: "syslog", label: "Syslog" },
                { id: "socket", label: "Socket" },
              ],
            },
            {
              key: "path",
              label: "Path",
              kind: "text",
              required: false,
              placeholder: "Defaults to the type",
            },
            {
              key: "filePath",
              label: "File path",
              kind: "text",
              required: false,
              placeholder: "/var/log/vault/audit.log",
              description: "On the Vault server; use stdout to log to the server's output.",
              showWhen: { fieldKey: "type", fieldValue: "file" },
            },
            {
              key: "address",
              label: "Address",
              kind: "text",
              required: false,
              placeholder: "logs.internal:9090",
              showWhen: { fieldKey: "type", fieldValue: "socket" },
            },
            { key: "description", label: "Description", kind: "text", required: false },
          ],
        };
      default:
        throw new Error(`Vault plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    const text = (k: string) => (fields[k] ?? "").trim();
    const mount = parentResourceId ? externalIdOf(parentResourceId) : trimSlash(text("mount"));
    const ref = (ext: string) => `${accountId}:${typeId}:${ext}`;
    switch (typeId) {
      case "vault-mount": {
        const path = trimSlash(text("path"));
        if (!path) throw new Error("Vault plugin: a mount path is required");
        const engine = text("type") || "kv-v2";
        await vaultFetch(this.ctx, `/sys/mounts/${encodePath(path)}`, {
          method: "POST",
          body: {
            type: engine === "kv-v2" ? "kv" : engine,
            description: text("description"),
            ...(engine === "kv-v2" ? { options: { version: "2" } } : {}),
          },
        });
        return this.getResource(typeId, ref(path), accountId);
      }
      case "vault-kv-secret": {
        const path = trimSlash(text("path"));
        if (!mount || !path) throw new Error("Vault plugin: pick a KV engine and enter a path");
        await vaultFetch(this.ctx, `/${encodePath(mount)}/data/${encodePath(path)}`, {
          method: "POST",
          body: { data: parseKvValue(fields["value"] ?? "") },
        });
        return this.getResource(typeId, ref(`${mount}::${path}`), accountId);
      }
      case "vault-auth-method": {
        const type = text("type");
        const path = trimSlash(text("path")) || type;
        await vaultFetch(this.ctx, `/sys/auth/${encodePath(path)}`, {
          method: "POST",
          body: { type, description: text("description") },
        });
        return this.getResource(typeId, ref(path), accountId);
      }
      case "vault-policy": {
        const name = text("name");
        if (!name) throw new Error("Vault plugin: a policy name is required");
        await this.writePolicy(name, fields["policy"] ?? "");
        return mapPolicy(accountId, name, fields["policy"] ?? "");
      }
      case "vault-pki-role": {
        const name = text("name");
        if (!mount || !name) throw new Error("Vault plugin: pick a PKI engine and enter a name");
        const domains = list(fields["allowedDomains"]);
        await vaultFetch(this.ctx, `/${encodePath(mount)}/roles/${encodeURIComponent(name)}`, {
          method: "POST",
          body: {
            ...(domains.length ? { allowed_domains: domains } : {}),
            allow_subdomains: bool(fields["allowSubdomains"]),
            ...(text("ttl") ? { ttl: text("ttl") } : {}),
            ...(text("maxTtl") ? { max_ttl: text("maxTtl") } : {}),
          },
        });
        return this.getResource(typeId, ref(`${mount}::${name}`), accountId);
      }
      case "vault-audit-device": {
        const type = text("type") || "file";
        const path = trimSlash(text("path")) || type;
        const options: Record<string, string> = {};
        if (type === "file") options["file_path"] = text("filePath") || "stdout";
        if (type === "socket" && text("address")) options["address"] = text("address");
        await vaultFetch(this.ctx, `/sys/audit/${encodePath(path)}`, {
          method: "POST",
          body: { type, description: text("description"), options },
        });
        return this.getResource(typeId, ref(path), accountId);
      }
      default:
        throw new Error(`Vault plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  private async writePolicy(name: string, policy: string): Promise<void> {
    if (!policy.trim()) throw new Error("Vault plugin: the policy is empty");
    await vaultFetch(this.ctx, `/sys/policies/acl/${encodeURIComponent(name)}`, {
      method: "POST",
      body: { policy },
    });
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    const has = (k: string) => k in fields;
    const text = (k: string) => (fields[k] ?? "").trim();
    const tune = (): Record<string, unknown> => {
      const body: Record<string, unknown> = {};
      if (has("description")) body["description"] = text("description");
      if (has("defaultLeaseTtl"))
        body["default_lease_ttl"] = numberField(fields["defaultLeaseTtl"], "Default TTL") ?? 0;
      if (has("maxLeaseTtl"))
        body["max_lease_ttl"] = numberField(fields["maxLeaseTtl"], "Max TTL") ?? 0;
      if (has("listingVisibility")) body["listing_visibility"] = text("listingVisibility");
      if (has("tokenType") && text("tokenType")) body["token_type"] = text("tokenType");
      return body;
    };
    switch (typeId) {
      case "vault-mount":
        await vaultFetch(this.ctx, `/sys/mounts/${encodePath(id)}/tune`, {
          method: "POST",
          body: tune(),
        });
        break;
      case "vault-auth-method":
        await vaultFetch(this.ctx, `/sys/auth/${encodePath(id)}/tune`, {
          method: "POST",
          body: tune(),
        });
        break;
      case "vault-kv-secret": {
        const { mount, rest } = splitId(id);
        const body: Record<string, unknown> = {};
        if (has("maxVersions"))
          body["max_versions"] = numberField(fields["maxVersions"], "Max versions") ?? 0;
        if (has("casRequired")) body["cas_required"] = bool(fields["casRequired"]);
        if (has("deleteVersionAfter"))
          body["delete_version_after"] = text("deleteVersionAfter") || "0s";
        if (has("customMetadata"))
          body["custom_metadata"] = keyValuePairs(fields["customMetadata"]);
        await vaultFetch(this.ctx, `/${encodePath(mount)}/metadata/${encodePath(rest)}`, {
          method: "POST",
          body,
        });
        break;
      }
      case "vault-pki-role": {
        const { mount, rest } = splitId(id);
        const flags: Record<string, string> = {
          allowSubdomains: "allow_subdomains",
          allowBareDomains: "allow_bare_domains",
          allowGlobDomains: "allow_glob_domains",
          allowAnyName: "allow_any_name",
          allowIpSans: "allow_ip_sans",
          allowLocalhost: "allow_localhost",
          enforceHostnames: "enforce_hostnames",
          serverFlag: "server_flag",
          clientFlag: "client_flag",
        };
        const body: Record<string, unknown> = {};
        for (const [field, key] of Object.entries(flags))
          if (has(field)) body[key] = bool(fields[field]);
        if (has("allowedDomains")) body["allowed_domains"] = list(fields["allowedDomains"]);
        if (has("ttl")) body["ttl"] = numberField(fields["ttl"], "TTL") ?? 0;
        if (has("maxTtl")) body["max_ttl"] = numberField(fields["maxTtl"], "Max TTL") ?? 0;
        await vaultFetch(this.ctx, `/${encodePath(mount)}/roles/${encodeURIComponent(rest)}`, {
          method: "PATCH",
          body,
          contentType: "application/merge-patch+json",
        });
        break;
      }
      default:
        throw new Error(`Vault plugin: "${typeId}" cannot be edited from Infrawrench`);
    }
    return this.getResource(typeId, resourceId, accountId);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const id = externalIdOf(resourceId);
    const del = (path: string) => vaultFetch(this.ctx, path, { method: "DELETE" });
    switch (typeId) {
      case "vault-mount":
        await del(`/sys/mounts/${encodePath(id)}`);
        this.mountsCache = undefined;
        return;
      case "vault-auth-method":
        await del(`/sys/auth/${encodePath(id)}`);
        return;
      case "vault-kv-secret": {
        const { mount, rest } = splitId(id);
        await del(`/${encodePath(mount)}/metadata/${encodePath(rest)}`);
        return;
      }
      case "vault-policy":
        if (id === "root" || id === "default")
          throw new VaultApiError(
            400,
            `Vault plugin: the ${id} policy is built in and cannot be deleted`,
          );
        await del(`/sys/policies/acl/${encodeURIComponent(id)}`);
        return;
      case "vault-pki-role": {
        const { mount, rest } = splitId(id);
        await del(`/${encodePath(mount)}/roles/${encodeURIComponent(rest)}`);
        return;
      }
      case "vault-lease":
        await vaultFetch(this.ctx, "/sys/leases/revoke", { method: "PUT", body: { lease_id: id } });
        return;
      case "vault-token":
        await vaultFetch(this.ctx, "/auth/token/revoke-accessor", {
          method: "POST",
          body: { accessor: id },
        });
        return;
      case "vault-audit-device":
        await del(`/sys/audit/${encodePath(id)}`);
        return;
      default:
        throw new Error(`Vault plugin: "${typeId}" cannot be deleted from Infrawrench`);
    }
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const id = externalIdOf(resourceId);
    switch (`${typeId}:${actionId}`) {
      case "vault-cluster:seal":
        await vaultFetch(this.ctx, "/sys/seal", { method: "POST" });
        return;
      case "vault-cluster:step-down":
        await vaultFetch(this.ctx, "/sys/step-down", { method: "POST" });
        return;
      case "vault-pki-cert:revoke": {
        const { mount, rest } = splitId(id);
        await vaultFetch(this.ctx, `/${encodePath(mount)}/revoke`, {
          method: "POST",
          body: { serial_number: rest },
        });
        return;
      }
      case "vault-lease:renew":
        await vaultFetch(this.ctx, "/sys/leases/renew", { method: "PUT", body: { lease_id: id } });
        return;
      case "vault-token:renew":
        await vaultFetch(this.ctx, "/auth/token/renew-accessor", {
          method: "POST",
          body: { accessor: id },
        });
        return;
      default:
        throw new Error(`Vault plugin: unknown action "${actionId}" for "${typeId}"`);
    }
  }

  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    if (typeId !== "vault-policy" || command !== COMMANDS.editPolicy) {
      throw new Error(`Vault plugin: unknown command "${command}"`);
    }
    const name = externalIdOf(resourceId);
    if (name === "root")
      throw new VaultApiError(400, "Vault plugin: the root policy cannot be changed");
    await this.writePolicy(name, decodePromptArgs(args)["policy"] ?? "");
    return { ok: true };
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderVaultDetail(resource, this.ctx.address);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderVaultSidebar(resource);
  }
}
