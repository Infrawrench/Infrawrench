import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
import type {
  CostFetchRange,
  CostRow,
  CreateFieldConfig,
  CreateResourceConfig,
  CreditBalance,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  QuotaUsage,
  ResourceCreateReturn,
  ResourceInstance,
  ResourceTypeDefinition,
  SidebarItemSchema,
  SizeOption,
} from "@infrawrench/plugin-base";
import {
  CreditAccessError,
  pathEncode,
  QuotaAccessError,
  withMetricsCapability,
  type NoSlashString,
} from "@infrawrench/plugin-base";
import {
  collectPages,
  createCloudApi,
  createDatabaseApi,
  daysToDuration,
  errorText,
  isStatus,
  type QdrantCloudApi,
  type QdrantConnection,
} from "./api.js";
import { fetchQdrantCostData } from "./cost-data.js";
import {
  clusterPhase,
  clusterResourceId,
  clusterRestUrl,
  externalOf,
  mapBackup,
  mapBackupSchedule,
  mapCluster,
  mapCollection,
  mapDatabaseKey,
  mapHybridEnvironment,
  mapRestore,
  parseCollectionId,
  parseLabels,
  parseQuantity,
  SCHEDULE_PRESETS,
} from "./mappers.js";
import {
  ENRICH_ALERTS,
  ENRICH_COLLECTIONS,
  ENRICH_HAS_DB_KEY,
  ENRICH_NODES,
  ENRICH_PACKAGES,
  ENRICH_RELEASES,
  renderQdrantDetail,
  renderQdrantSidebarItem,
  type PackageOption,
} from "./render.js";
import { REBALANCE_STRATEGIES, RESTART_POLICIES, STORAGE_TIERS } from "./resource-types.js";
import type {
  QcAccessRule,
  QcAlert,
  QcBackup,
  QcCluster,
  QcCreditContracts,
  QcDatabaseApiKey,
  QcPackage,
  QcQuotas,
  QcRegion,
  QcRelease,
  QcUsageMetrics,
  QdbCollectionParamsDiff,
} from "./types.js";

const CLUSTER_TTL_MS = 30_000;
const CATALOG_TTL_MS = 10 * 60_000;
const FAN_OUT = 6;
const MAX_COLLECTIONS_PER_CLUSTER = 100;
const CLUSTER_NAME_RE = /^[A-Za-z0-9_-]{2,64}$/;

/** Secret-store keys for values Qdrant shows exactly once. */
export const DB_KEY_FIELD = "databaseApiKey";
export const BOOTSTRAP_FIELD = "bootstrapCommands";

function str(v: string | undefined): string {
  return v === undefined || v === null ? "" : String(v).trim();
}

function intField(raw: string | undefined, label: string, min: number, max?: number) {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || (max !== undefined && n > max)) {
    throw new Error(
      max === undefined
        ? `${label} must be a whole number of at least ${min}.`
        : `${label} must be a whole number from ${min} to ${max}.`,
    );
  }
  return n;
}

function parseFormArg(raw: string | number | undefined): Record<string, string> {
  if (typeof raw !== "string") return {};
  try {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries<unknown>(JSON.parse(raw))) out[k] = String(v ?? "");
    return out;
  } catch {
    return {};
  }
}

/** Crontab sanity check: five space-separated fields of cron characters. */
export function checkCron(cron: string): void {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5 || parts.some((p) => !/^[0-9*,/\-A-Za-z?]+$/.test(p))) {
    throw new Error("Schedules are standard 5-field crontab, e.g. 0 2 * * * for 02:00 UTC daily.");
  }
}

export function parseIpRanges(raw: string): string[] {
  const ranges = raw
    .split(/[,\s]+/)
    .map((r) => r.trim())
    .filter(Boolean);
  for (const r of ranges) {
    if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(r)) {
      throw new Error(`"${r}" is not an IPv4 CIDR range such as 203.0.113.0/24.`);
    }
  }
  if (ranges.length > 40) throw new Error("Qdrant allows at most 40 IP ranges per cluster.");
  return ranges;
}

/** A page token only goes back once there is one. */
const pageAfter = (token: string | undefined) => (token ? { pageToken: token } : {});

interface Cached<T> {
  at: number;
  value: Promise<T>;
}

function cached<T>(slot: Cached<T> | undefined, ttl: number, load: () => Promise<T>): Cached<T> {
  if (slot && Date.now() - slot.at < ttl) return slot;
  const value = load();
  const next = { at: Date.now(), value };
  value.catch(() => {
    next.at = 0;
  });
  return next;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
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

interface RegionChoice {
  key: string;
  provider: string;
  region: string;
  label: string;
}

const isRestartPolicy = (value: string): value is (typeof RESTART_POLICIES)[number] =>
  RESTART_POLICIES.some((policy) => policy === value);

const isRebalanceStrategy = (value: string): value is (typeof REBALANCE_STRATEGIES)[number] =>
  REBALANCE_STRATEGIES.some((strategy) => strategy === value);

/**
 * Build the cluster update body: the current cluster with the edited fields
 * applied. UpdateCluster replaces the whole cluster when no field mask is
 * sent, so read-only `state` is stripped and everything else round-trips.
 */
export function buildClusterUpdate(
  current: QcCluster,
  fields: Record<string, string>,
  releases: QcRelease[],
): QcCluster | null {
  const next: Omit<QcCluster, "state"> & { state?: NonNullable<QcCluster["state"]> } = JSON.parse(
    JSON.stringify(current),
  );
  delete next.state;
  const conf = (next.configuration ??= {});
  let changed = false;
  const nodes = intField(fields["nodes"], "Nodes", 1);
  if (nodes !== undefined && nodes !== conf.numberOfNodes) {
    conf.numberOfNodes = nodes;
    changed = true;
  }
  const version = str(fields["version"]);
  if (version && version !== conf.version) {
    const known = releases.filter((r) => !r.unavailable).map((r) => r.version);
    if (known.length && !known.includes(version)) {
      throw new Error(
        `Qdrant version ${version} is not available. Choose one of: ${known.join(", ")}.`,
      );
    }
    conf.version = version;
    changed = true;
  }
  if (fields["packageId"]) {
    conf.packageId = str(fields["packageId"]);
    changed = true;
  }
  const disk = intField(fields["additionalDiskGib"], "Extra disk", 0);
  if (disk !== undefined && disk !== (conf.additionalResources?.disk ?? 0)) {
    if (disk < (conf.additionalResources?.disk ?? 0)) {
      throw new Error("Disks can only grow; extra disk cannot be reduced.");
    }
    conf.additionalResources = { ...(conf.additionalResources ?? {}), disk };
    changed = true;
  }
  if (fields["storageTier"]) {
    const tier = str(fields["storageTier"]);
    if (!STORAGE_TIERS.includes(tier))
      throw new Error(`Storage tier must be one of ${STORAGE_TIERS.join(", ")}.`);
    conf.clusterStorageConfiguration = {
      ...(conf.clusterStorageConfiguration ?? {}),
      storageTierType: `STORAGE_TIER_TYPE_${tier}`,
    };
    changed = true;
  }
  if (fields["allowedIpSourceRanges"] !== undefined) {
    conf.allowedIpSourceRanges = parseIpRanges(fields["allowedIpSourceRanges"]);
    changed = true;
  }
  if (fields["labels"] !== undefined) {
    next.labels = parseLabels(fields["labels"]);
    changed = true;
  }
  if (fields["restartPolicy"]) {
    const v = str(fields["restartPolicy"]);
    if (!isRestartPolicy(v))
      throw new Error(`Restart policy must be one of ${RESTART_POLICIES.join(", ")}.`);
    conf.restartPolicy = `CLUSTER_CONFIGURATION_RESTART_POLICY_${v}`;
    changed = true;
  }
  if (fields["rebalanceStrategy"]) {
    const v = str(fields["rebalanceStrategy"]);
    if (!isRebalanceStrategy(v)) {
      throw new Error(`Shard rebalancing must be one of ${REBALANCE_STRATEGIES.join(", ")}.`);
    }
    conf.rebalanceStrategy = `CLUSTER_CONFIGURATION_REBALANCE_STRATEGY_${v}`;
    changed = true;
  }
  const db = (conf.databaseConfiguration ??= {});
  const rf = intField(fields["replicationFactor"], "Replication factor", 1);
  const wc = intField(fields["writeConsistencyFactor"], "Write consistency", 1);
  if (rf !== undefined || wc !== undefined || fields["vectorsOnDisk"] !== undefined) {
    const col = (db.collection ??= {});
    if (rf !== undefined) col.replicationFactor = rf;
    if (wc !== undefined) col.writeConsistencyFactor = wc;
    if (fields["vectorsOnDisk"] !== undefined && fields["vectorsOnDisk"] !== "") {
      col.vectors = { ...(col.vectors ?? {}), onDisk: fields["vectorsOnDisk"] === "true" };
    }
    changed = true;
  }
  if (fields["inferenceEnabled"] !== undefined && fields["inferenceEnabled"] !== "") {
    db.inference = { enabled: fields["inferenceEnabled"] === "true" };
    changed = true;
  }
  if (fields["auditLogging"] !== undefined && fields["auditLogging"] !== "") {
    db.auditLogging = { ...(db.auditLogging ?? {}), enabled: fields["auditLogging"] === "true" };
    changed = true;
  }
  return changed ? next : null;
}

/**
 * Qdrant Cloud plugin client. One account per Qdrant Cloud account (the
 * management key is account-scoped); every route carries the account id.
 */
export class QdrantCloudClient implements PluginClient {
  readonly api: QdrantCloudApi;
  private readonly accountId: string;
  /** The account id as every Management API path holds it. */
  private readonly acct: NoSlashString;
  private readonly connection: QdrantConnection;
  private clusterCache: Cached<QcCluster[]> | undefined;
  private regionCache: Cached<RegionChoice[]> | undefined;
  private releaseCache: Cached<QcRelease[]> | undefined;

  constructor(
    credentials: Credentials,
    private readonly resourceTypes: ResourceTypeDefinition[],
    private readonly services?: HostServices,
  ) {
    const apiKey = str(credentials["apiKey"]);
    if (!apiKey) throw new Error("Qdrant Cloud plugin: missing apiKey credential");
    this.accountId = str(credentials["accountId"]);
    if (!this.accountId) throw new Error("Qdrant Cloud plugin: missing accountId credential");
    this.acct = pathEncode(this.accountId);
    this.connection = { caCert: credentials["caCert"] ?? "", http: services?.http };
    this.api = createCloudApi(apiKey, this.connection);
  }

  /** A client for one cluster's own REST API. */
  private database(url: string, key: string) {
    return createDatabaseApi(url, key, this.connection);
  }

  // ── Discovery ────────────────────────────────────────────────────────

  clusters(): Promise<QcCluster[]> {
    this.clusterCache = cached(this.clusterCache, CLUSTER_TTL_MS, () =>
      collectPages((token) =>
        this.api.get(`/api/cluster/v1/accounts/${this.acct}/clusters`, {
          query: { pageSize: 100, ...pageAfter(token) },
        }),
      ).then((list) => list.filter((c) => !c.deletedAt)),
    );
    return this.clusterCache.value;
  }

  private invalidateClusters(): void {
    this.clusterCache = undefined;
  }

  private async clusterName(id: string): Promise<string> {
    const list = await this.clusters().catch((): QcCluster[] => []);
    return list.find((c) => c.id === id)?.name ?? "";
  }

  private async getCluster(id: string): Promise<QcCluster> {
    const res = await this.api.get(
      `/api/cluster/v1/accounts/${this.acct}/clusters/${pathEncode(id)}`,
    );
    return res.cluster;
  }

  releases(): Promise<QcRelease[]> {
    this.releaseCache = cached(this.releaseCache, CATALOG_TTL_MS, () =>
      this.api.get(`/api/cluster/v1/accounts/${this.acct}/releases`).then((r) => r?.items ?? []),
    );
    return this.releaseCache.value;
  }

  /** Every cloud region the account can create clusters in, hybrid environments included. */
  regions(): Promise<RegionChoice[]> {
    this.regionCache = cached(this.regionCache, CATALOG_TTL_MS, async () => {
      const providers = await this.api
        .get(`/api/platform/v1/accounts/${this.acct}/cloud-providers`)
        .then((r) => (r?.items ?? []).filter((p) => p.available !== false));
      const lists = await mapLimit(providers, FAN_OUT, async (p) => {
        const regions = await this.api
          .get(`/api/platform/v1/accounts/${this.acct}/cloud-providers/${pathEncode(p.id)}/regions`)
          .then((r) => r?.items ?? [])
          .catch((): QcRegion[] => []);
        return regions
          .filter((r) => r.available !== false)
          .map((r) => ({
            key: `${p.id}/${r.id}`,
            provider: p.id,
            region: r.id,
            label:
              p.id === "hybrid"
                ? `Hybrid: ${r.name || r.id}`
                : `${(p.id || "").toUpperCase()} ${r.id}${r.name ? ` (${r.name})` : ""}`,
          }));
      });
      return lists.flat();
    });
    return this.regionCache.value;
  }

  private async packagesFor(provider: string, region: string): Promise<QcPackage[]> {
    const res = await this.api.get(`/api/booking/v1/accounts/${this.acct}/packages`, {
      query: { cloudProviderId: provider, cloudProviderRegionId: region },
    });
    return (res?.items ?? []).filter((p) => !p.status || p.status === "PACKAGE_STATUS_ACTIVE");
  }

  /** The database key Connect Infrawrench stored against the cluster's host resource id. */
  private async dbKey(accountId: string, clusterId: string): Promise<string | null> {
    const secrets = this.services?.secrets;
    if (!secrets) return null;
    return secrets.getPlaintext(clusterResourceId(accountId, clusterId), DB_KEY_FIELD);
  }

  private async listDatabaseKeys(clusterId?: string): Promise<QcDatabaseApiKey[]> {
    const res = await this.api.get(`/api/cluster/auth/v2/accounts/${this.acct}/database-api-keys`, {
      query: clusterId ? { clusterId } : {},
    });
    return res?.items ?? [];
  }

  // ── Listing ──────────────────────────────────────────────────────────

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      switch (typeId) {
        case "cluster":
          return (await this.clusters()).map((c) => mapCluster(c, accountId));
        case "database-api-key": {
          const [keys, clusters] = await Promise.all([this.listDatabaseKeys(), this.clusters()]);
          const names = new Map(clusters.map((c) => [c.id, c.name]));
          return keys.map((k) => mapDatabaseKey(k, names.get(k.clusterId ?? "") ?? "", accountId));
        }
        case "backup": {
          const list = await collectPages((token) =>
            this.api.get(`/api/cluster/backup/v1/accounts/${this.acct}/backups`, {
              query: { pageSize: 100, ...pageAfter(token) },
            }),
          );
          return list.filter((b) => !b.deletedAt).map((b) => mapBackup(b, accountId));
        }
        case "backup-schedule": {
          const [list, clusters] = await Promise.all([
            collectPages((token) =>
              this.api.get(`/api/cluster/backup/v1/accounts/${this.acct}/backup_schedules`, {
                query: { pageSize: 100, ...pageAfter(token) },
              }),
            ),
            this.clusters(),
          ]);
          const names = new Map(clusters.map((c) => [c.id, c.name]));
          return list
            .filter((s) => !s.deletedAt)
            .map((s) => mapBackupSchedule(s, names.get(s.clusterId ?? "") ?? "", accountId));
        }
        case "backup-restore": {
          const [list, clusters] = await Promise.all([
            collectPages((token) =>
              this.api.get(`/api/cluster/backup/v1/accounts/${this.acct}/backup_restores`, {
                query: { pageSize: 100, ...pageAfter(token) },
              }),
            ),
            this.clusters(),
          ]);
          const names = new Map(clusters.map((c) => [c.id, c.name]));
          return list.map((r) => mapRestore(r, names.get(r.clusterId ?? "") ?? "", accountId));
        }
        case "hybrid-environment": {
          const res = await this.api.get(
            `/api/hybrid/v1/accounts/${this.acct}/hybrid-cloud-environments`,
          );
          return (res?.items ?? []).map((h) => mapHybridEnvironment(h, accountId));
        }
        case "collection": {
          const clusters = (await this.clusters()).filter((c) => clusterPhase(c) === "HEALTHY");
          const lists = await mapLimit(clusters, FAN_OUT, (c) =>
            this.listCollections(c, accountId).catch((): ResourceInstance[] => []),
          );
          return lists.flat();
        }
        default:
          throw new Error(`Qdrant Cloud plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  /** Collections through the cluster's own REST API; needs a stored database key. */
  private async listCollections(c: QcCluster, accountId: string): Promise<ResourceInstance[]> {
    const url = clusterRestUrl(c);
    const key = await this.dbKey(accountId, c.id);
    if (!url || !key) return [];
    const db = this.database(url, key);
    const res = await db.get("/collections");
    const names = (res?.result?.collections ?? [])
      .map((x) => x.name)
      .slice(0, MAX_COLLECTIONS_PER_CLUSTER);
    const infos = await mapLimit(names, FAN_OUT, (name) =>
      db
        .get(`/collections/${pathEncode(name)}`)
        .then((r) => r?.result)
        .catch(() => undefined),
    );
    return names.map((name, i) => mapCollection(c.id, c.name, name, infos[i], accountId));
  }

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalOf(resourceId);
      switch (typeId) {
        case "cluster":
          return mapCluster(await this.getCluster(id), accountId);
        case "backup": {
          const res = await this.api.get(
            `/api/cluster/backup/v1/accounts/${this.acct}/backups/${pathEncode(id)}`,
          );
          return mapBackup(res.backup, accountId);
        }
        case "backup-schedule": {
          const res = await this.api.get(
            `/api/cluster/backup/v1/accounts/${this.acct}/backup_schedules/${pathEncode(id)}`,
          );
          const s = res.backupSchedule;
          return mapBackupSchedule(s, await this.clusterName(s.clusterId ?? ""), accountId);
        }
        case "hybrid-environment": {
          const res = await this.api.get(
            `/api/hybrid/v1/accounts/${this.acct}/hybrid-cloud-environments/${pathEncode(id)}`,
          );
          return mapHybridEnvironment(res.hybridCloudEnvironment, accountId);
        }
        case "collection": {
          const { clusterId, name } = parseCollectionId(resourceId);
          const cluster = await this.getCluster(clusterId);
          const key = await this.dbKey(accountId, clusterId);
          const info = key
            ? await this.database(clusterRestUrl(cluster), key)
                .get(`/collections/${pathEncode(name)}`)
                .then((r) => r?.result)
            : undefined;
          return mapCollection(clusterId, cluster.name, name, info, accountId);
        }
        default: {
          const all = await runPluginEffect(this.listResources(typeId, accountId));
          const found = all.find((r) => r.id === resourceId || r.externalId === id);
          if (!found) {
            throw Object.assign(new Error(`Qdrant Cloud plugin: ${typeId} ${id} not found`), {
              status: 404,
            });
          }
          return found;
        }
      }
    });
  }

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      const secrets = this.services?.secrets;
      if (typeId === "cluster" && outputKey === "apiKey") {
        const v = await secrets?.getPlaintext(resourceId, DB_KEY_FIELD);
        if (!v)
          throw new Error("No database key is stored yet. Run Connect Infrawrench on the cluster.");
        return v;
      }
      if (typeId === "database-api-key" && outputKey === "apiKey") {
        const v = await secrets?.getPlaintext(resourceId, DB_KEY_FIELD);
        if (!v) {
          throw new Error(
            "Qdrant shows a key once. Only keys created from Infrawrench keep their value here.",
          );
        }
        return v;
      }
      if (typeId === "hybrid-environment" && outputKey === "bootstrapCommands") {
        const v = await secrets?.getPlaintext(resourceId, BOOTSTRAP_FIELD);
        if (!v) throw new Error("Run Generate bootstrap commands first.");
        return v;
      }
      const r = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      return r.resolvedOutputs[outputKey] ?? "";
    });
  }

  // ── Detail ───────────────────────────────────────────────────────────

  enrichDetail(resource: ResourceInstance): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      if (resource.resourceTypeId !== "cluster") return resource;
      const fields = { ...resource.fields };
      const id = resource.externalId ?? externalOf(resource.id);
      const [cluster, alerts, releases, key] = await Promise.all([
        this.getCluster(id).catch(() => null),
        this.api
          .get(`/api/monitoring/v1/accounts/${this.acct}/cluster/${pathEncode(id)}/alerts`, {
            query: { state: "CLUSTER_ALERT_STATE_FIRING" },
          })
          .then((r) => r?.alerts ?? [])
          .catch((): QcAlert[] => []),
        this.api
          .get(`/api/cluster/v1/accounts/${this.acct}/releases`, { query: { clusterId: id } })
          .then((r) => r?.items ?? [])
          .catch((): QcRelease[] => []),
        this.dbKey(resource.accountId, id).catch(() => null),
      ]);
      if (key) fields[ENRICH_HAS_DB_KEY] = "1";
      if (cluster) {
        const nodes = cluster.state?.nodes ?? [];
        if (nodes.length) {
          fields[ENRICH_NODES] = JSON.stringify(
            nodes.map((n) => ({
              name: n.name ?? "",
              state: (n.state ?? "").replace("CLUSTER_NODE_STATE_", ""),
              zone: n.availabilityZone ?? "",
              version: n.version ?? "",
              note: n.notReadyInfo?.reasonMessage || n.notReadyInfo?.conditionMessage || "",
            })),
          );
        }
        const packages = await this.packagesFor(
          cluster.cloudProviderId ?? "",
          cluster.cloudProviderRegionId ?? "",
        ).catch((): QcPackage[] => []);
        if (packages.length) {
          const opts: PackageOption[] = packages.map((p) => ({
            id: p.id,
            label: packageLabel(p),
            ...(p.unitIntPricePerHour !== undefined
              ? {
                  description: `${p.currency ?? "USD"} ${((p.unitIntPricePerHour / 100_000) * 730).toFixed(2)} per node per month`,
                }
              : {}),
          }));
          fields[ENRICH_PACKAGES] = JSON.stringify(opts);
        }
        if (key && clusterRestUrl(cluster)) {
          const cols = await this.listCollections(cluster, resource.accountId).catch(() => []);
          if (cols.length) {
            fields[ENRICH_COLLECTIONS] = JSON.stringify(
              cols.map((c) => ({
                name: c.displayName,
                status: String(c.fields["status"] ?? ""),
                points: String(c.fields["pointsCount"] ?? ""),
              })),
            );
          }
        }
      }
      if (alerts.length) {
        fields[ENRICH_ALERTS] = JSON.stringify(
          alerts.map((a) => ({
            severity: (a.severity ?? "").replace("CLUSTER_ALERT_SEVERITY_", ""),
            title: a.title ?? "",
            description: a.description ?? "",
            at: a.lastFiringAt ?? "",
          })),
        );
      }
      const current = String(fields["version"] ?? "");
      const newer = releases.filter((r) => !r.unavailable && !r.endOfLife && r.version !== current);
      if (newer.length) fields[ENRICH_RELEASES] = JSON.stringify(newer.map((r) => r.version));
      return { ...resource, fields };
    });
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return withMetricsCapability(
      renderQdrantDetail(resource, this.resourceTypes),
      this.resourceTypes,
      resource.resourceTypeId,
    );
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderQdrantSidebarItem(resource);
  }

  // ── Create ───────────────────────────────────────────────────────────

  private async clusterOptions(filter: (c: QcCluster) => boolean = () => true) {
    const clusters = await this.clusters().catch((): QcCluster[] => []);
    return clusters.filter(filter).map((c) => ({
      id: c.id,
      label: c.name,
      description: `${c.cloudProviderId ?? ""} ${c.cloudProviderRegionId ?? ""}`.trim(),
    }));
  }

  getCreateConfig(typeId: string, parentResourceId?: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      const fromCluster = parentResourceId?.includes(":cluster:") === true;
      const clusterPicker = async (): Promise<CreateFieldConfig[]> =>
        fromCluster
          ? []
          : [
              {
                key: "clusterId",
                label: "Cluster",
                kind: "select",
                required: true,
                options: await this.clusterOptions(),
              },
            ];
      switch (typeId) {
        case "cluster": {
          const regions = await this.regions().catch((): RegionChoice[] => []);
          const perRegion = await mapLimit(regions, FAN_OUT, async (r) => ({
            r,
            pkgs: await this.packagesFor(r.provider, r.region).catch((): QcPackage[] => []),
          }));
          const sizes = new Map<string, SizeOption>();
          for (const { r, pkgs } of perRegion) {
            for (const p of pkgs) {
              const existing = sizes.get(p.id);
              if (existing) {
                existing.availableFor = [...(existing.availableFor ?? []), r.key];
                continue;
              }
              const rc = p.resourceConfiguration ?? {};
              sizes.set(p.id, {
                id: p.id,
                label: packageLabel(p),
                vcpus: parseQuantity(rc.cpu) ?? 0,
                memoryMb: Math.round((parseQuantity(rc.ram) ?? 0) * 1024),
                ...(parseQuantity(rc.disk) !== undefined
                  ? { diskGb: parseQuantity(rc.disk)! }
                  : {}),
                ...(p.unitIntPricePerHour !== undefined
                  ? {
                      priceMonthly: Math.round((p.unitIntPricePerHour / 100_000) * 730 * 100) / 100,
                    }
                  : {}),
                ...(p.type
                  ? {
                      category:
                        p.type === "free"
                          ? "Free"
                          : p.tier?.includes("PREMIUM")
                            ? "Premium"
                            : "Standard",
                    }
                  : {}),
                availableFor: [r.key],
              });
            }
          }
          const firstRegion = regions.find((r) => r.provider !== "hybrid") ?? regions[0];
          return {
            fields: [
              {
                key: "name",
                label: "Name",
                kind: "text",
                required: true,
                placeholder: "search-prod",
                description: "Letters, digits, underscores and hyphens",
              },
              {
                key: "region",
                label: "Region",
                kind: "region-picker",
                required: true,
                ...(firstRegion ? { defaultValue: firstRegion.key } : {}),
                regions: regions.map((r) => ({ id: r.key, label: r.label })),
              },
              {
                key: "packageId",
                label: "Package (per node)",
                kind: "size-picker",
                required: true,
                filterByFieldKey: "region",
                sizes: [...sizes.values()],
                description: "Prices are per node per month at the list rate, before discounts",
              },
              {
                key: "nodes",
                label: "Nodes",
                kind: "number",
                required: true,
                minValue: 1,
                defaultValue: "1",
              },
              {
                key: "additionalDiskGib",
                label: "Extra disk per node (GiB)",
                kind: "number",
                required: false,
                minValue: 0,
                defaultValue: "0",
              },
              {
                key: "storageTier",
                label: "Storage tier",
                kind: "select",
                required: false,
                defaultValue: "COST_OPTIMISED",
                options: [
                  { id: "COST_OPTIMISED", label: "Cost optimised" },
                  { id: "BALANCED", label: "Balanced (more IOPS)" },
                  { id: "PERFORMANCE", label: "Performance (most IOPS)" },
                ],
              },
              {
                key: "allowedIpSourceRanges",
                label: "Allowed IP ranges",
                kind: "string-list",
                required: false,
                placeholder: "203.0.113.0/24",
                description: "Leave empty to allow all addresses",
              },
              {
                key: "labels",
                label: "Labels",
                kind: "text",
                required: false,
                placeholder: "env=prod, team=search",
              },
            ],
          };
        }
        case "database-api-key":
          return {
            fields: [
              ...(await clusterPicker()),
              { key: "name", label: "Name", kind: "text", required: true },
              {
                key: "access",
                label: "Access",
                kind: "select",
                required: true,
                defaultValue: "MANAGE",
                options: [
                  { id: "MANAGE", label: "Manage (read, write and administer everything)" },
                  { id: "READ_ONLY", label: "Read-only (every collection)" },
                  { id: "COLLECTION", label: "One collection only" },
                ],
              },
              {
                key: "collectionName",
                label: "Collection",
                kind: "text",
                required: true,
                showWhen: { fieldKey: "access", fieldValue: "COLLECTION" },
                description: "Collection-scoped keys need JWT RBAC enabled on the cluster",
              },
              {
                key: "collectionAccess",
                label: "Collection access",
                kind: "select",
                required: true,
                defaultValue: "READ_ONLY",
                showWhen: { fieldKey: "access", fieldValue: "COLLECTION" },
                options: [
                  { id: "READ_ONLY", label: "Read-only" },
                  { id: "READ_WRITE", label: "Read and write" },
                ],
              },
              {
                key: "expiresAt",
                label: "Expires",
                kind: "datetime",
                datetimeMode: "datetime",
                required: false,
                description: "Leave empty for a key that never expires",
              },
            ],
          };
        case "backup":
          return {
            fields: [
              ...(await clusterPicker()),
              { key: "name", label: "Name", kind: "text", required: false },
              {
                key: "retentionDays",
                label: "Keep for (days)",
                kind: "number",
                required: true,
                minValue: 1,
                maxValue: 365,
                defaultValue: "7",
              },
            ],
          };
        case "backup-schedule":
          return {
            fields: [
              ...(await clusterPicker()),
              { key: "name", label: "Name", kind: "text", required: false },
              {
                key: "preset",
                label: "Frequency",
                kind: "select",
                required: true,
                defaultValue: "0 2 * * *",
                options: [
                  ...Object.entries(SCHEDULE_PRESETS).map(([id, label]) => ({ id, label })),
                  { id: "custom", label: "Custom cron expression" },
                ],
              },
              {
                key: "schedule",
                label: "Cron expression (UTC)",
                kind: "text",
                required: true,
                placeholder: "30 1 * * 1-5",
                showWhen: { fieldKey: "preset", fieldValue: "custom" },
              },
              {
                key: "retentionDays",
                label: "Keep each backup for (days)",
                kind: "number",
                required: true,
                minValue: 1,
                maxValue: 365,
                defaultValue: "7",
              },
            ],
          };
        case "hybrid-environment":
          return {
            fields: [
              { key: "name", label: "Name", kind: "text", required: true },
              {
                key: "namespace",
                label: "Kubernetes namespace",
                kind: "text",
                required: true,
                defaultValue: "qdrant",
                description:
                  "Where the Qdrant operator and clusters are installed; fixed after bootstrap",
              },
            ],
          };
        case "collection":
          return {
            fields: [
              ...(fromCluster
                ? []
                : [
                    {
                      key: "clusterId",
                      label: "Cluster",
                      kind: "select" as const,
                      required: true,
                      description:
                        "Clusters Infrawrench has a database key for (Connect Infrawrench)",
                      options: await this.clusterOptions((c) => clusterPhase(c) === "HEALTHY"),
                    },
                  ]),
              { key: "name", label: "Name", kind: "text", required: true },
              {
                key: "vectorSize",
                label: "Vector size",
                kind: "number",
                required: true,
                minValue: 1,
                maxValue: 65536,
                defaultValue: "1536",
                description: "Dimensions of the embeddings you will store",
              },
              {
                key: "distance",
                label: "Distance",
                kind: "select",
                required: true,
                defaultValue: "Cosine",
                options: [
                  { id: "Cosine", label: "Cosine" },
                  { id: "Dot", label: "Dot product" },
                  { id: "Euclid", label: "Euclidean" },
                  { id: "Manhattan", label: "Manhattan" },
                ],
              },
              {
                key: "shardNumber",
                label: "Shards",
                kind: "number",
                required: false,
                minValue: 1,
              },
              {
                key: "replicationFactor",
                label: "Replication factor",
                kind: "number",
                required: false,
                minValue: 1,
              },
              {
                key: "onDisk",
                label: "Store vectors on disk",
                kind: "select",
                required: false,
                defaultValue: "false",
                options: [
                  { id: "false", label: "No, keep them in RAM" },
                  { id: "true", label: "Yes, memory-map from disk" },
                ],
              },
            ],
          };
        default:
          throw new Error(`Qdrant Cloud plugin: cannot create "${typeId}"`);
      }
    });
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): PluginEffect<ResourceCreateReturn> {
    return attempt(async () => {
      const clusterId = parentResourceId?.includes(":cluster:")
        ? externalOf(parentResourceId)
        : str(fields["clusterId"]);
      switch (typeId) {
        case "cluster": {
          const name = str(fields["name"]);
          if (!CLUSTER_NAME_RE.test(name)) {
            throw new Error("Cluster names are 2 to 64 letters, digits, underscores or hyphens.");
          }
          const [provider, ...regionParts] = str(fields["region"]).split("/");
          const region = regionParts.join("/");
          if (!provider || !region) throw new Error("Choose a region.");
          const packageId = str(fields["packageId"]);
          if (!packageId) throw new Error("Choose a package.");
          const disk = intField(fields["additionalDiskGib"], "Extra disk", 0) ?? 0;
          const tier = str(fields["storageTier"]);
          const ranges = parseIpRanges(fields["allowedIpSourceRanges"] ?? "");
          const labels = parseLabels(fields["labels"] ?? "");
          const res = await this.api.post(`/api/cluster/v1/accounts/${this.acct}/clusters`, {
            body: {
              cluster: {
                accountId: this.accountId,
                name,
                cloudProviderId: provider,
                cloudProviderRegionId: region,
                ...(labels.length ? { labels } : {}),
                configuration: {
                  numberOfNodes: intField(fields["nodes"], "Nodes", 1) ?? 1,
                  packageId,
                  ...(disk ? { additionalResources: { disk } } : {}),
                  ...(tier && tier !== "COST_OPTIMISED"
                    ? {
                        clusterStorageConfiguration: {
                          storageTierType: `STORAGE_TIER_TYPE_${tier}`,
                        },
                      }
                    : {}),
                  ...(ranges.length ? { allowedIpSourceRanges: ranges } : {}),
                },
              },
            },
          });
          this.invalidateClusters();
          return mapCluster(res.cluster, accountId);
        }
        case "database-api-key": {
          if (!clusterId) throw new Error("Choose a cluster.");
          const name = str(fields["name"]);
          if (!/^[A-Za-z0-9 _-]{1,64}$/.test(name)) {
            throw new Error("Key names use letters, digits, spaces, underscores and hyphens.");
          }
          const access = str(fields["access"]) || "MANAGE";
          const accessRules =
            access === "COLLECTION"
              ? [
                  {
                    collectionAccess: {
                      collectionName: str(fields["collectionName"]),
                      accessType: `COLLECTION_ACCESS_RULE_ACCESS_TYPE_${str(fields["collectionAccess"]) || "READ_ONLY"}`,
                    },
                  },
                ]
              : [{ globalAccess: { accessType: `GLOBAL_ACCESS_RULE_ACCESS_TYPE_${access}` } }];
          if (access === "COLLECTION" && !str(fields["collectionName"])) {
            throw new Error("Enter the collection the key may access.");
          }
          const expires = str(fields["expiresAt"]);
          const created = await this.createDatabaseKey(clusterId, name, accessRules, expires);
          const inst = mapDatabaseKey(created, await this.clusterName(clusterId), accountId);
          if (created.key)
            await this.services?.secrets?.setPlaintext?.(inst.id, DB_KEY_FIELD, created.key);
          return inst;
        }
        case "backup": {
          if (!clusterId) throw new Error("Choose a cluster.");
          return mapBackup(await this.createBackup(clusterId, fields), accountId);
        }
        case "backup-schedule": {
          if (!clusterId) throw new Error("Choose a cluster.");
          const preset = str(fields["preset"]);
          const schedule = preset && preset !== "custom" ? preset : str(fields["schedule"]);
          checkCron(schedule);
          const days = intField(fields["retentionDays"], "Retention", 1, 365) ?? 7;
          const name = str(fields["name"]);
          const res = await this.api.post(
            `/api/cluster/backup/v1/accounts/${this.acct}/backup_schedules`,
            {
              body: {
                backupSchedule: {
                  accountId: this.accountId,
                  clusterId,
                  schedule,
                  retentionPeriod: daysToDuration(days),
                  ...(name ? { displayName: name } : {}),
                },
              },
            },
          );
          return mapBackupSchedule(
            res.backupSchedule,
            await this.clusterName(clusterId),
            accountId,
          );
        }
        case "hybrid-environment": {
          const name = str(fields["name"]);
          if (!CLUSTER_NAME_RE.test(name)) {
            throw new Error("Environment names are letters, digits, underscores or hyphens.");
          }
          const res = await this.api.post(
            `/api/hybrid/v1/accounts/${this.acct}/hybrid-cloud-environments`,
            {
              body: {
                hybridCloudEnvironment: {
                  accountId: this.accountId,
                  name,
                  configuration: { namespace: str(fields["namespace"]) || "qdrant" },
                },
              },
            },
          );
          return mapHybridEnvironment(res.hybridCloudEnvironment, accountId);
        }
        case "collection": {
          if (!clusterId) throw new Error("Choose a cluster.");
          const name = str(fields["name"]);
          if (!name || /[/\\\s]/.test(name))
            throw new Error("Collection names cannot contain spaces or slashes.");
          const { url, key, cluster } = await this.databaseAccess(accountId, clusterId);
          const shards = intField(fields["shardNumber"], "Shards", 1);
          const rf = intField(fields["replicationFactor"], "Replication factor", 1);
          const db = this.database(url, key);
          await db.put(`/collections/${pathEncode(name)}`, {
            body: {
              vectors: {
                size: intField(fields["vectorSize"], "Vector size", 1) ?? 1536,
                distance: str(fields["distance"]) || "Cosine",
                ...(fields["onDisk"] === "true" ? { on_disk: true } : {}),
              },
              ...(shards ? { shard_number: shards } : {}),
              ...(rf ? { replication_factor: rf } : {}),
            },
          });
          const info = await db
            .get(`/collections/${pathEncode(name)}`)
            .then((r) => r?.result)
            .catch(() => undefined);
          return mapCollection(clusterId, cluster.name, name, info, accountId);
        }
        default:
          throw new Error(`Qdrant Cloud plugin: cannot create "${typeId}"`);
      }
    });
  }

  private async createDatabaseKey(
    clusterId: string,
    name: string,
    accessRules: QcAccessRule[],
    expiresAt?: string,
  ): Promise<QcDatabaseApiKey> {
    const res = await this.api.post(
      `/api/cluster/auth/v2/accounts/${this.acct}/database-api-keys`,
      {
        body: {
          databaseApiKey: {
            accountId: this.accountId,
            clusterId,
            name,
            accessRules,
            ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
          },
        },
      },
    );
    return res.databaseApiKey;
  }

  private async createBackup(clusterId: string, fields: Record<string, string>): Promise<QcBackup> {
    const days = intField(fields["retentionDays"], "Retention", 1, 365) ?? 7;
    const name = str(fields["name"]);
    const res = await this.api.post(`/api/cluster/backup/v1/accounts/${this.acct}/backups`, {
      body: {
        backup: {
          accountId: this.accountId,
          clusterId,
          retentionPeriod: daysToDuration(days),
          ...(name ? { displayName: name } : {}),
        },
      },
    });
    return res.backup;
  }

  private async databaseAccess(accountId: string, clusterId: string) {
    const cluster = await this.getCluster(clusterId);
    const url = clusterRestUrl(cluster);
    const key = await this.dbKey(accountId, clusterId);
    if (!url) throw new Error("This cluster has no endpoint yet.");
    if (!key)
      throw new Error(
        "Run Connect Infrawrench on the cluster first so Infrawrench has a database key.",
      );
    return { cluster, url, key };
  }

  // ── Update ───────────────────────────────────────────────────────────

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalOf(resourceId);
      switch (typeId) {
        case "cluster": {
          const [current, releases] = await Promise.all([
            this.getCluster(id),
            fields["version"] ? this.releases().catch((): QcRelease[] => []) : Promise.resolve([]),
          ]);
          const body = buildClusterUpdate(current, fields, releases);
          if (body) {
            await this.api.put(`/api/cluster/v1/accounts/${this.acct}/clusters/${pathEncode(id)}`, {
              body: { cluster: body },
            });
            this.invalidateClusters();
          }
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "backup": {
          const name = str(fields["name"]);
          if (name) {
            await this.api.patch(
              `/api/cluster/backup/v1/accounts/${this.acct}/backups/${pathEncode(id)}`,
              { body: { backup: { id, accountId: this.accountId, displayName: name } } },
            );
          }
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "backup-schedule": {
          const res = await this.api.get(
            `/api/cluster/backup/v1/accounts/${this.acct}/backup_schedules/${pathEncode(id)}`,
          );
          const s = { ...res.backupSchedule };
          delete s.status;
          if (fields["schedule"]) {
            checkCron(fields["schedule"]);
            s.schedule = str(fields["schedule"]);
          }
          const days = intField(fields["retentionDays"], "Retention", 1, 365);
          if (days !== undefined) s.retentionPeriod = daysToDuration(days);
          if (fields["name"] !== undefined) s.displayName = str(fields["name"]);
          await this.api.put(
            `/api/cluster/backup/v1/accounts/${this.acct}/backup_schedules/${pathEncode(id)}`,
            { body: { backupSchedule: s } },
          );
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "hybrid-environment": {
          const name = str(fields["name"]);
          if (name) {
            const res = await this.api.get(
              `/api/hybrid/v1/accounts/${this.acct}/hybrid-cloud-environments/${pathEncode(id)}`,
            );
            const env = { ...res.hybridCloudEnvironment, name };
            delete env.status;
            await this.api.put(
              `/api/hybrid/v1/accounts/${this.acct}/hybrid-cloud-environments/${pathEncode(id)}`,
              { body: { hybridCloudEnvironment: env } },
            );
          }
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "collection": {
          const { clusterId, name } = parseCollectionId(resourceId);
          const params: QdbCollectionParamsDiff = {};
          const rf = intField(fields["replicationFactor"], "Replication factor", 1);
          const wc = intField(fields["writeConsistencyFactor"], "Write consistency", 1);
          if (rf !== undefined) params.replication_factor = rf;
          if (wc !== undefined) params.write_consistency_factor = wc;
          if (Object.keys(params).length) {
            const { url, key } = await this.databaseAccess(accountId, clusterId);
            await this.database(url, key).patch(`/collections/${pathEncode(name)}`, {
              body: { params },
            });
          }
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        default:
          throw new Error(`Qdrant Cloud plugin: cannot update "${typeId}"`);
      }
    });
  }

  // ── Delete ───────────────────────────────────────────────────────────

  deleteResource(typeId: string, resourceId: string, accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const id = externalOf(resourceId);
      switch (typeId) {
        case "cluster":
          await this.api.delete(`/api/cluster/v1/accounts/${this.acct}/clusters/${pathEncode(id)}`);
          this.invalidateClusters();
          return;
        case "database-api-key":
          await this.api.delete(
            `/api/cluster/auth/v2/accounts/${this.acct}/database-api-keys/${pathEncode(id)}`,
          );
          return;
        case "backup":
          await this.api.delete(
            `/api/cluster/backup/v1/accounts/${this.acct}/backups/${pathEncode(id)}`,
          );
          return;
        case "backup-schedule":
          await this.api.delete(
            `/api/cluster/backup/v1/accounts/${this.acct}/backup_schedules/${pathEncode(id)}`,
          );
          return;
        case "hybrid-environment":
          await this.api.delete(
            `/api/hybrid/v1/accounts/${this.acct}/hybrid-cloud-environments/${pathEncode(id)}`,
          );
          return;
        case "collection": {
          const { clusterId, name } = parseCollectionId(resourceId);
          const { url, key } = await this.databaseAccess(accountId, clusterId);
          await this.database(url, key).delete(`/collections/${pathEncode(name)}`);
          return;
        }
        default:
          throw new Error(`Qdrant Cloud plugin: cannot delete "${typeId}"`);
      }
    });
  }

  // ── Actions ──────────────────────────────────────────────────────────

  /** Each is its own route in the document, so each path is written out. */
  private clusterLifecycle(actionId: string, id: NoSlashString) {
    switch (actionId) {
      case "restart":
        return this.api.post(`/api/cluster/v1/accounts/${this.acct}/clusters/${id}/restart`, {
          body: {},
        });
      case "suspend":
        return this.api.post(`/api/cluster/v1/accounts/${this.acct}/clusters/${id}/suspend`, {
          body: {},
        });
      case "unsuspend":
        return this.api.post(`/api/cluster/v1/accounts/${this.acct}/clusters/${id}/unsuspend`, {
          body: {},
        });
      case "enable-jwt":
        return this.api.post(`/api/cluster/v1/accounts/${this.acct}/clusters/${id}/enable-jwt`, {
          body: {},
        });
      default:
        return undefined;
    }
  }

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      const id = externalOf(resourceId);
      if (typeId === "cluster") {
        const lifecycle = this.clusterLifecycle(actionId, pathEncode(id));
        if (lifecycle) {
          await lifecycle;
          this.invalidateClusters();
          return;
        }
        if (actionId === "mint-db-key") {
          const secrets = this.services?.secrets;
          if (!secrets?.setPlaintext) {
            throw new Error("This host cannot store credentials, so the key could not be kept.");
          }
          const created = await this.createDatabaseKey(id, "infrawrench", [
            { globalAccess: { accessType: "GLOBAL_ACCESS_RULE_ACCESS_TYPE_MANAGE" } },
          ]);
          if (!created.key) throw new Error("Qdrant Cloud did not return the new key's value.");
          await secrets.setPlaintext(resourceId, DB_KEY_FIELD, created.key);
          return;
        }
      }
      if (typeId === "backup" && actionId === "restore") {
        await this.api.post(
          `/api/cluster/backup/v1/accounts/${this.acct}/backups/${pathEncode(id)}/restore`,
          { body: {} },
        );
        return;
      }
      if (typeId === "hybrid-environment" && actionId === "bootstrap") {
        const res = await this.api.post(
          `/api/hybrid/v1/accounts/${this.acct}/hybrid-cloud-environments/${pathEncode(id)}/bootstrap-commands`,
          { body: {} },
        );
        const commands = (res?.commands ?? []).join("\n");
        if (!commands) throw new Error("Qdrant Cloud returned no bootstrap commands.");
        await this.services?.secrets?.setPlaintext?.(resourceId, BOOTSTRAP_FIELD, commands);
        return;
      }
      throw new Error(`Qdrant Cloud plugin: action "${actionId}" is not supported for "${typeId}"`);
    });
  }

  executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    accountId: string,
    command: string,
    args: (string | number)[],
  ): PluginEffect<null> {
    return attempt(async () => {
      const id = externalOf(resourceId);
      const vals = parseFormArg(args[0]);
      if (typeId === "cluster" && command === "resize") {
        const current = await this.getCluster(id);
        const body = buildClusterUpdate(
          current,
          { packageId: vals["packageId"] ?? "", nodes: vals["nodes"] ?? "" },
          [],
        );
        if (body) {
          await this.api.put(`/api/cluster/v1/accounts/${this.acct}/clusters/${pathEncode(id)}`, {
            body: { cluster: body },
          });
          this.invalidateClusters();
        }
        return null;
      }
      if (typeId === "cluster" && command === "createBackup") {
        await this.createBackup(id, vals);
        return null;
      }
      if (typeId === "backup" && command === "createClusterFromBackup") {
        const name = str(vals["name"]);
        if (!CLUSTER_NAME_RE.test(name)) {
          throw new Error("Cluster names are 2 to 64 letters, digits, underscores or hyphens.");
        }
        await this.api.post(
          `/api/cluster/v1/accounts/${this.acct}/backups/${pathEncode(id)}/clusters`,
          { query: { clusterName: name }, body: {} },
        );
        this.invalidateClusters();
        return null;
      }
      throw new Error(`Qdrant Cloud plugin: unknown command "${command}"`);
    });
  }

  // ── Logs and metrics ─────────────────────────────────────────────────

  getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): PluginEffect<LogsFetchResult> {
    return attempt(async () => {
      if (typeId !== "cluster") throw new Error("Only clusters have logs.");
      const res = await this.api.get(
        `/api/monitoring/v1/accounts/${this.acct}/cluster/${pathEncode(externalOf(resourceId))}/logs`,
        {
          query: {
            limit: Math.min(Math.max(params.tailLines ?? 200, 1), 10_000),
            since: new Date(Date.now() - 86_400_000).toISOString(),
          },
        },
      );
      const lines = (res?.items ?? [])
        .slice()
        .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
        .map((l) => `${l.timestamp ?? ""} ${l.message ?? ""}\n`);
      return { text: lines.join(""), containers: ["cluster"], activeContainer: "cluster" };
    });
  }

  fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      if (resourceTypeId !== "cluster") return [];
      const end = timeRange?.endMs ?? Date.now();
      const start = timeRange?.startMs ?? end - 6 * 3_600_000;
      const res = await this.api.get(
        `/api/monitoring/v1/accounts/${this.acct}/cluster/${pathEncode(externalOf(resourceId))}/usage-metrics`,
        {
          query: {
            since: new Date(start).toISOString(),
            until: new Date(end).toISOString(),
            aggregator: "AGGREGATOR_AVG",
          },
        },
      );
      return usageSeries(res);
    });
  }

  // ── Cost, credits, quotas ────────────────────────────────────────────

  fetchCostData(_accountId: string, range: CostFetchRange): PluginEffect<CostRow[]> {
    return attempt(async () => {
      return fetchQdrantCostData(this.api, this.accountId, range);
    });
  }

  fetchCreditBalance(): PluginEffect<CreditBalance[]> {
    return attempt(async () => {
      let res: QcCreditContracts;
      try {
        res = await this.api.get(`/api/billing/v1/accounts/${this.acct}/credit-contracts`);
      } catch (e) {
        if (isStatus(e, 401, 403)) {
          throw new CreditAccessError(
            "The management key cannot read billing (needs read:payment_information).",
          );
        }
        throw e;
      }
      const now = Date.now();
      return (res?.items ?? [])
        .filter((c) => !c.activeTo || Date.parse(c.activeTo) > now)
        .filter((c) => !c.activeFrom || Date.parse(c.activeFrom) <= now)
        .map((c) => ({
          key: c.id,
          label: "Qdrant Cloud credits",
          remaining: c.remainingAmount ?? 0,
          currency: c.currency || "USD",
          ...(c.totalAmount !== undefined ? { granted: c.totalAmount } : {}),
          ...(c.activeTo ? { expiresAt: c.activeTo } : {}),
        }));
    });
  }

  fetchQuotas(): PluginEffect<QuotaUsage[]> {
    return attempt(async () => {
      let q: QcQuotas;
      try {
        q = await this.api.get(`/api/quota/v1/accounts/${this.acct}/quotas`);
      } catch (e) {
        if (isStatus(e, 401, 403))
          throw new QuotaAccessError(`Qdrant Cloud refused the quota read: ${errorText(e)}`);
        throw e;
      }
      const clusters = await this.clusters();
      const out: QuotaUsage[] = [];
      if (q.maxClusters && q.maxClusters > 0) {
        out.push({
          id: "clusters",
          service: "Clusters",
          name: "Clusters in account",
          limit: q.maxClusters,
          used: clusters.length,
          unit: "clusters",
          adjustable: true,
        });
      }
      if (q.maxClusterNodes && q.maxClusterNodes > 0) {
        for (const c of clusters) {
          out.push({
            id: `nodes/${c.id}`,
            service: "Clusters",
            name: `Nodes in ${c.name}`,
            limit: q.maxClusterNodes,
            used: c.configuration?.numberOfNodes ?? 0,
            unit: "nodes",
            adjustable: true,
          });
        }
      }
      if (q.maxClusterDatabaseApiKeys && q.maxClusterDatabaseApiKeys > 0) {
        const keys = await this.listDatabaseKeys();
        const perCluster = new Map<string, number>();
        for (const k of keys)
          perCluster.set(k.clusterId ?? "", (perCluster.get(k.clusterId ?? "") ?? 0) + 1);
        for (const c of clusters) {
          out.push({
            id: `database-api-keys/${c.id}`,
            service: "Database API keys",
            name: `Database API keys on ${c.name}`,
            limit: q.maxClusterDatabaseApiKeys,
            used: perCluster.get(c.id) ?? 0,
            unit: "keys",
            adjustable: true,
          });
        }
      }
      return out;
    });
  }
}

function packageLabel(p: QcPackage): string {
  const rc = p.resourceConfiguration ?? {};
  const parts = [
    p.name || p.id,
    [rc.cpu && `${parseQuantity(rc.cpu)} vCPU`, rc.ram, rc.disk].filter(Boolean).join(" / "),
  ];
  if (p.multiAz) parts.push("multi-AZ");
  return parts.filter(Boolean).join(", ");
}

const SERIES: Array<{
  key: Exclude<keyof QcUsageMetrics, "nodes">;
  label: string;
  unit?: string;
}> = [
  { key: "cpu", label: "CPU" },
  { key: "ram", label: "RAM" },
  { key: "ramCache", label: "RAM Cache" },
  { key: "ramRss", label: "RAM RSS" },
  { key: "ramQdrantRss", label: "Qdrant RSS" },
  { key: "disk", label: "Disk" },
  { key: "rps", label: "Requests per Second", unit: "req/s" },
  { key: "latency", label: "Request Latency" },
  { key: "gpu", label: "GPU" },
  { key: "gpuRam", label: "GPU RAM" },
];

/** Qdrant's usage metrics carry no unit; series are labelled as the console labels them. */
export function usageSeries(res: QcUsageMetrics | undefined): MetricSeries[] {
  const out: MetricSeries[] = [];
  for (const s of SERIES) {
    const pts = (res?.[s.key] ?? [])
      .map((m) => ({ timestamp: Date.parse(m.timestamp ?? ""), value: Number(m.value) }))
      .filter((p) => Number.isFinite(p.timestamp) && Number.isFinite(p.value));
    if (!pts.length) continue;
    out.push({ label: s.label, ...(s.unit ? { unit: s.unit } : {}), points: pts });
  }
  return out;
}
