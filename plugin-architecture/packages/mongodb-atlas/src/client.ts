import type {
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  CreateSizePricingRequest,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  ResourceInstance,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { CostSetupError, externalIdOf } from "@infrawrench/plugin-base";
import type { AtlasContext, AtlasOrg } from "./api.js";
import {
  atlasRequest,
  contextFromCredentials,
  enc,
  isPermissionError,
  listAll,
  listOrgs,
  statusOf,
} from "./api.js";
import type { Invoice } from "./cost-data.js";
import { fetchAtlasCostData, fetchInvoices, instanceRates, summarizeInvoice } from "./cost-data.js";
import type {
  AtlasAccessEntry,
  AtlasAlert,
  AtlasAlertConfig,
  AtlasBackupSchedule,
  AtlasCluster,
  AtlasDatabaseUser,
  AtlasEndpointService,
  AtlasFlexCluster,
  AtlasGroup,
  AtlasOnlineArchive,
  AtlasSearchIndex,
  AtlasServerless,
  AtlasSnapshot,
  ProjectRef,
} from "./mappers.js";
import {
  isListedElsewhere,
  mapAccessEntry,
  mapAlert,
  mapAlertConfig,
  mapBackupPolicy,
  mapCluster,
  mapDatabaseUser,
  mapEndpointService,
  mapFlexCluster,
  mapOnlineArchive,
  mapOrganization,
  mapProject,
  mapSearchIndex,
  mapServerless,
  mapSnapshot,
  parseRoles,
  resourceId as fullResourceId,
  splitId,
} from "./mappers.js";
import {
  COST_METRICS_WINDOW_MS,
  DEFAULT_METRICS_WINDOW_MS,
  clusterSeries,
  rangeOrDefault,
  spendSeries,
} from "./metrics.js";
import {
  ADD_ACCESS_ENTRY_FIELDS,
  AVAILABLE_TIERS_KEY,
  INVOICE_SUMMARY_KEY,
  RECENT_INVOICES_KEY,
  SNAPSHOT_FIELDS,
  renderAtlasDetail,
  renderAtlasSidebar,
} from "./render.js";
import { TIERS_BY_PROVIDER, TIER_SPECS, isDedicatedTier, tierLabel, tierSpec } from "./tiers.js";

const CLUSTER_VERSION = "2024-08-05";
const FLEX_VERSION = "2024-11-13";
const SEARCH_VERSION = "2024-05-30";
const CONCURRENCY = 4;
const HOURS_PER_MONTH = 730;

/** Secret field keys for the cluster connection user Infrawrench creates. */
const CONN_USER_KEY = "connectionUser";
const CONN_PASSWORD_KEY = "connectionPassword";

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/** A 403/404 in one project or cluster lists it empty; anything else fails the listing. */
async function tolerant<T>(load: () => Promise<T[]>): Promise<T[]> {
  try {
    return await load();
  } catch (err) {
    const s = statusOf(err);
    if (s === 401 || s === 403 || s === 404) return [];
    throw err;
  }
}

function parseForm(args: (string | number)[]): Record<string, string> {
  const first = args[0];
  if (typeof first !== "string" || !first) return {};
  try {
    const parsed = JSON.parse(first) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed ?? {}))
      out[k] = v === undefined || v === null ? "" : String(v);
    return out;
  } catch {
    return {};
  }
}

function randomPassword(length = 32): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** `mongodb+srv://host/` plus credentials. */
export function withCredentials(srv: string, user: string, password: string): string {
  const m = /^(mongodb(?:\+srv)?:\/\/)(?:[^@/]*@)?(.*)$/.exec(srv);
  if (!m) return srv;
  const rest = m[2]!.includes("/") ? m[2]! : `${m[2]}/`;
  return `${m[1]}${encodeURIComponent(user)}:${encodeURIComponent(password)}@${rest}`;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Strip read-only parts of a cluster's replication specs so they can be sent
 * back in a PATCH (Atlas rejects some of them, and `effective*` describes the
 * auto-scaled state rather than the configuration).
 */
function writableSpecs(specs: AtlasCluster["replicationSpecs"]): Array<Record<string, unknown>> {
  return (specs ?? []).map((spec) => ({
    ...(spec.zoneName ? { zoneName: spec.zoneName } : {}),
    regionConfigs: (spec.regionConfigs ?? []).map((rc) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rc)) {
        if (k.startsWith("effective")) continue;
        out[k] = v && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v;
      }
      return out;
    }),
  }));
}

export class MongoDBAtlasClient implements PluginClient {
  private readonly ctx: AtlasContext;
  private readonly services: HostServices | undefined;
  private readonly configuredOrgId: string;
  private orgCache: Promise<AtlasOrg> | undefined;
  private projectsCache: Promise<AtlasGroup[]> | undefined;
  private clustersCache: Promise<Array<{ project: ProjectRef; cluster: AtlasCluster }>> | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    this.ctx = contextFromCredentials(credentials, services?.http);
    this.services = services;
    this.configuredOrgId = (credentials["orgId"] ?? "").trim();
  }

  // -------------------------------------------------------------------------
  // Shared lookups
  // -------------------------------------------------------------------------

  private org(): Promise<AtlasOrg> {
    this.orgCache ??= (async () => {
      if (this.configuredOrgId) {
        const o = await atlasRequest<{ id?: string; name?: string }>(
          this.ctx,
          "GET",
          `/api/atlas/v2/orgs/${enc(this.configuredOrgId)}`,
        ).catch(() => undefined);
        return { id: this.configuredOrgId, name: o?.name ?? this.configuredOrgId };
      }
      const orgs = await listOrgs(this.ctx);
      if (orgs.length === 0) {
        throw new Error("MongoDB Atlas plugin: the credential cannot see any organization");
      }
      return orgs[0]!;
    })().catch((err: unknown) => {
      this.orgCache = undefined;
      throw err;
    });
    return this.orgCache;
  }

  private projects(): Promise<AtlasGroup[]> {
    this.projectsCache ??= (async () => {
      const org = await this.org();
      return listAll<AtlasGroup>(this.ctx, `/api/atlas/v2/orgs/${enc(org.id)}/groups`);
    })().catch((err: unknown) => {
      this.projectsCache = undefined;
      throw err;
    });
    return this.projectsCache;
  }

  private async projectRef(groupId: string): Promise<ProjectRef> {
    const projects = await this.projects().catch(() => [] as AtlasGroup[]);
    const p = projects.find((x) => x.id === groupId);
    return { groupId, projectName: p?.name ?? groupId };
  }

  private async refs(): Promise<ProjectRef[]> {
    return (await this.projects())
      .filter((p): p is AtlasGroup & { id: string } => typeof p.id === "string")
      .map((p) => ({ groupId: p.id, projectName: p.name ?? p.id }));
  }

  private perProject<T>(load: (p: ProjectRef) => Promise<T[]>): Promise<T[]> {
    return this.refs().then(async (refs) =>
      (await mapLimit(refs, CONCURRENCY, (p) => tolerant(() => load(p)))).flat(),
    );
  }

  private clusters(): Promise<Array<{ project: ProjectRef; cluster: AtlasCluster }>> {
    this.clustersCache ??= this.perProject(async (p) => {
      const clusters = await listAll<AtlasCluster>(
        this.ctx,
        `/api/atlas/v2/groups/${enc(p.groupId)}/clusters`,
        { version: CLUSTER_VERSION },
      );
      return clusters
        .filter((c) => !isListedElsewhere(c))
        .map((cluster) => ({ project: p, cluster }));
    }).catch((err: unknown) => {
      this.clustersCache = undefined;
      throw err;
    });
    return this.clustersCache;
  }

  /** Dedicated, running clusters: the ones with backups, archives and process metrics. */
  private async perCluster<T>(
    filter: (c: AtlasCluster) => boolean,
    load: (project: ProjectRef, clusterName: string, cluster: AtlasCluster) => Promise<T[]>,
  ): Promise<T[]> {
    const all = (await this.clusters()).filter(({ cluster }) => cluster.name && filter(cluster));
    return (
      await mapLimit(all, CONCURRENCY, ({ project, cluster }) =>
        tolerant(() => load(project, cluster.name!, cluster)),
      )
    ).flat();
  }

  private groupPath(groupId: string): string {
    return `/api/atlas/v2/groups/${enc(groupId)}`;
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    const dedicated = (c: AtlasCluster) => !c.paused && isDedicatedTier(this.tierOf(c));
    switch (typeId) {
      case "organization": {
        const org = await this.org();
        const projects = await this.projects().catch(() => [] as AtlasGroup[]);
        return [mapOrganization(accountId, org, { projectCount: projects.length })];
      }
      case "project":
        return (await this.projects()).filter((g) => g.id).map((g) => mapProject(accountId, g));
      case "cluster":
        return (await this.clusters()).map(({ project, cluster }) =>
          mapCluster(accountId, cluster, project),
        );
      case "flex-cluster":
        return this.perProject(async (p) =>
          (
            await listAll<AtlasFlexCluster>(this.ctx, `${this.groupPath(p.groupId)}/flexClusters`, {
              version: FLEX_VERSION,
            })
          ).map((c) => mapFlexCluster(accountId, c, p)),
        );
      case "serverless-instance":
        return this.perProject(async (p) =>
          (await listAll<AtlasServerless>(this.ctx, `${this.groupPath(p.groupId)}/serverless`)).map(
            (s) => mapServerless(accountId, s, p),
          ),
        );
      case "database-user":
        return this.perProject(async (p) =>
          (
            await listAll<AtlasDatabaseUser>(this.ctx, `${this.groupPath(p.groupId)}/databaseUsers`)
          ).map((u) => mapDatabaseUser(accountId, u, p)),
        );
      case "ip-access-entry":
        return this.perProject(async (p) =>
          (
            await listAll<AtlasAccessEntry>(this.ctx, `${this.groupPath(p.groupId)}/accessList`)
          ).map((e) => mapAccessEntry(accountId, e, p)),
        );
      case "alert":
        return this.perProject(async (p) =>
          (
            await listAll<AtlasAlert>(this.ctx, `${this.groupPath(p.groupId)}/alerts`, {
              query: { status: "OPEN" },
            })
          ).map((a) => mapAlert(accountId, a, p)),
        );
      case "alert-configuration":
        return this.perProject(async (p) =>
          (
            await listAll<AtlasAlertConfig>(this.ctx, `${this.groupPath(p.groupId)}/alertConfigs`)
          ).map((c) => mapAlertConfig(accountId, c, p)),
        );
      case "private-endpoint-service":
        return this.perProject(async (p) => {
          const per = await Promise.all(
            ["AWS", "AZURE", "GCP"].map((provider) =>
              tolerant(() =>
                atlasRequest<AtlasEndpointService[]>(
                  this.ctx,
                  "GET",
                  `${this.groupPath(p.groupId)}/privateEndpoint/${provider}/endpointService`,
                ).then((r) => (Array.isArray(r) ? r : [])),
              ),
            ),
          );
          return per.flat().map((e) => mapEndpointService(accountId, e, p));
        });
      case "backup-snapshot":
        return this.perCluster(
          (c) => dedicated(c) && c.backupEnabled === true,
          async (p, name) =>
            (
              await listAll<AtlasSnapshot>(
                this.ctx,
                `${this.groupPath(p.groupId)}/clusters/${enc(name)}/backup/snapshots`,
              )
            ).map((s) => mapSnapshot(accountId, s, p, name)),
        );
      case "backup-policy":
        return this.perCluster(
          (c) => dedicated(c) && c.backupEnabled === true,
          async (p, name) => {
            const schedule = await atlasRequest<AtlasBackupSchedule>(
              this.ctx,
              "GET",
              `${this.groupPath(p.groupId)}/clusters/${enc(name)}/backup/schedule`,
              { version: CLUSTER_VERSION },
            );
            return schedule ? [mapBackupPolicy(accountId, schedule, p, name)] : [];
          },
        );
      case "search-index":
        return this.perCluster(
          (c) => !c.paused,
          async (p, name) => {
            const res = await atlasRequest<AtlasSearchIndex[]>(
              this.ctx,
              "GET",
              `${this.groupPath(p.groupId)}/clusters/${enc(name)}/search/indexes`,
              { version: SEARCH_VERSION },
            );
            return (Array.isArray(res) ? res : []).map((s) =>
              mapSearchIndex(accountId, s, p, name),
            );
          },
        );
      case "online-archive":
        return this.perCluster(dedicated, async (p, name) =>
          (
            await listAll<AtlasOnlineArchive>(
              this.ctx,
              `${this.groupPath(p.groupId)}/clusters/${enc(name)}/onlineArchives`,
            )
          ).map((a) => mapOnlineArchive(accountId, a, p, name)),
        );
      default:
        throw new Error(`MongoDB Atlas plugin: unknown resource type "${typeId}"`);
    }
  }

  private tierOf(c: AtlasCluster): string {
    const rc = [...(c.replicationSpecs?.[0]?.regionConfigs ?? [])].sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
    )[0];
    return rc?.effectiveElectableSpecs?.instanceSize ?? rc?.electableSpecs?.instanceSize ?? "";
  }

  // -------------------------------------------------------------------------
  // Single reads
  // -------------------------------------------------------------------------

  private async getCluster(groupId: string, name: string): Promise<AtlasCluster> {
    return atlasRequest<AtlasCluster>(
      this.ctx,
      "GET",
      `${this.groupPath(groupId)}/clusters/${enc(name)}`,
      { version: CLUSTER_VERSION },
    );
  }

  /** Tiers offered in the cluster's cloud region, from Atlas itself. */
  private async availableTiers(
    groupId: string,
    provider: string,
    region: string,
  ): Promise<string[]> {
    if (!provider || !region) return [];
    const res = await atlasRequest<{
      results?: Array<{
        provider?: string;
        instanceSizes?: Array<{ name?: string; availableRegions?: Array<{ name?: string }> }>;
      }>;
    }>(this.ctx, "GET", `${this.groupPath(groupId)}/clusters/provider/regions`, {
      query: { providers: provider },
    });
    const out: string[] = [];
    for (const p of res?.results ?? []) {
      if (p.provider && p.provider !== provider) continue;
      for (const size of p.instanceSizes ?? []) {
        if (!size.name) continue;
        if ((size.availableRegions ?? []).some((r) => r.name === region)) out.push(size.name);
      }
    }
    return out;
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    switch (typeId) {
      case "organization":
        return this.getOrganization(accountId);
      case "project": {
        const g = await atlasRequest<AtlasGroup>(this.ctx, "GET", this.groupPath(id));
        return mapProject(accountId, g);
      }
      case "cluster": {
        const [groupId, name] = splitId(id, 1) as [string, string];
        const [cluster, project] = await Promise.all([
          this.getCluster(groupId, name),
          this.projectRef(groupId),
        ]);
        const r = mapCluster(accountId, cluster, project);
        const tiers = await this.availableTiers(
          groupId,
          String(r.fields["provider"] ?? ""),
          String(r.fields["region"] ?? ""),
        ).catch(() => [] as string[]);
        if (tiers.length > 0) r.resolvedOutputs[AVAILABLE_TIERS_KEY] = JSON.stringify(tiers);
        return r;
      }
      case "flex-cluster": {
        const [groupId, name] = splitId(id, 1) as [string, string];
        const c = await atlasRequest<AtlasFlexCluster>(
          this.ctx,
          "GET",
          `${this.groupPath(groupId)}/flexClusters/${enc(name)}`,
          { version: FLEX_VERSION },
        );
        return mapFlexCluster(accountId, c, await this.projectRef(groupId));
      }
      case "serverless-instance": {
        const [groupId, name] = splitId(id, 1) as [string, string];
        const s = await atlasRequest<AtlasServerless>(
          this.ctx,
          "GET",
          `${this.groupPath(groupId)}/serverless/${enc(name)}`,
        );
        return mapServerless(accountId, s, await this.projectRef(groupId));
      }
      case "database-user": {
        const [groupId, db, user] = splitId(id, 2) as [string, string, string];
        const u = await atlasRequest<AtlasDatabaseUser>(
          this.ctx,
          "GET",
          `${this.groupPath(groupId)}/databaseUsers/${enc(db)}/${enc(user)}`,
        );
        return mapDatabaseUser(accountId, u, await this.projectRef(groupId));
      }
      case "ip-access-entry": {
        const [groupId, entry] = splitId(id, 1) as [string, string];
        const e = await atlasRequest<AtlasAccessEntry>(
          this.ctx,
          "GET",
          `${this.groupPath(groupId)}/accessList/${enc(entry)}`,
        );
        return mapAccessEntry(accountId, e, await this.projectRef(groupId));
      }
      case "backup-snapshot": {
        const [groupId, cluster, snap] = splitId(id, 2) as [string, string, string];
        const s = await atlasRequest<AtlasSnapshot>(
          this.ctx,
          "GET",
          `${this.groupPath(groupId)}/clusters/${enc(cluster)}/backup/snapshots/${enc(snap)}`,
        );
        return mapSnapshot(accountId, s, await this.projectRef(groupId), cluster);
      }
      case "backup-policy": {
        const [groupId, cluster] = splitId(id, 1) as [string, string];
        const s = await atlasRequest<AtlasBackupSchedule>(
          this.ctx,
          "GET",
          `${this.groupPath(groupId)}/clusters/${enc(cluster)}/backup/schedule`,
          { version: CLUSTER_VERSION },
        );
        return mapBackupPolicy(accountId, s, await this.projectRef(groupId), cluster);
      }
      case "alert": {
        const [groupId, alertId] = splitId(id, 1) as [string, string];
        const a = await atlasRequest<AtlasAlert>(
          this.ctx,
          "GET",
          `${this.groupPath(groupId)}/alerts/${enc(alertId)}`,
        );
        return mapAlert(accountId, a, await this.projectRef(groupId));
      }
      case "alert-configuration": {
        const [groupId, configId] = splitId(id, 1) as [string, string];
        const c = await atlasRequest<AtlasAlertConfig>(
          this.ctx,
          "GET",
          `${this.groupPath(groupId)}/alertConfigs/${enc(configId)}`,
        );
        return mapAlertConfig(accountId, c, await this.projectRef(groupId));
      }
      case "search-index": {
        const [groupId, cluster, indexId] = splitId(id, 2) as [string, string, string];
        const s = await atlasRequest<AtlasSearchIndex>(
          this.ctx,
          "GET",
          `${this.groupPath(groupId)}/clusters/${enc(cluster)}/search/indexes/${enc(indexId)}`,
          { version: SEARCH_VERSION },
        );
        return mapSearchIndex(accountId, s, await this.projectRef(groupId), cluster);
      }
      case "online-archive": {
        const [groupId, cluster, archiveId] = splitId(id, 2) as [string, string, string];
        const a = await atlasRequest<AtlasOnlineArchive>(
          this.ctx,
          "GET",
          `${this.groupPath(groupId)}/clusters/${enc(cluster)}/onlineArchives/${enc(archiveId)}`,
        );
        return mapOnlineArchive(accountId, a, await this.projectRef(groupId), cluster);
      }
      case "private-endpoint-service": {
        const [groupId, provider, serviceId] = splitId(id, 2) as [string, string, string];
        const e = await atlasRequest<AtlasEndpointService>(
          this.ctx,
          "GET",
          `${this.groupPath(groupId)}/privateEndpoint/${enc(provider)}/endpointService/${enc(serviceId)}`,
        );
        return mapEndpointService(accountId, e, await this.projectRef(groupId));
      }
      default:
        throw new Error(`MongoDB Atlas plugin: unknown resource type "${typeId}"`);
    }
  }

  private async getOrganization(accountId: string): Promise<ResourceInstance> {
    const org = await this.org();
    const projects = await this.projects().catch(() => [] as AtlasGroup[]);
    const base = `/api/atlas/v2/orgs/${enc(org.id)}/invoices`;
    const [pending, recent] = await Promise.all([
      atlasRequest<{ results?: Invoice[] }>(this.ctx, "GET", `${base}/pending`).catch(
        () => undefined,
      ),
      atlasRequest<{ results?: Invoice[] }>(this.ctx, "GET", base, {
        query: { itemsPerPage: 6, pageNum: 1, sortBy: "START_DATE", orderBy: "desc" },
      }).catch(() => undefined),
    ]);
    const current = pending?.results?.[0];
    const summary = current ? summarizeInvoice(current) : undefined;
    const r = mapOrganization(accountId, org, {
      projectCount: projects.length,
      ...(summary ? { pendingTotal: Math.round(summary.totalCents) / 100 } : {}),
    });
    if (summary) r.resolvedOutputs[INVOICE_SUMMARY_KEY] = JSON.stringify(summary);
    const rows = (recent?.results ?? []).map((inv) => ({
      month: inv.startDate?.slice(0, 7) ?? "",
      status: inv.statusName ?? "",
      cents: inv.amountBilledCents ?? inv.subtotalCents ?? 0,
    }));
    if (rows.length > 0) r.resolvedOutputs[RECENT_INVOICES_KEY] = JSON.stringify(rows);
    return r;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (outputKey === "connectionString" && (typeId === "cluster" || typeId === "flex-cluster")) {
      return this.connectionString(typeId, resourceId, accountId);
    }
    const resource = await this.getResource(typeId, resourceId, accountId);
    const resolved = resource.resolvedOutputs[outputKey];
    if (resolved !== undefined) return resolved;
    const field = resource.fields[outputKey];
    if (field !== undefined) return String(field);
    throw new Error(
      `MongoDB Atlas plugin: cannot resolve output "${outputKey}" for type "${typeId}"`,
    );
  }

  private async connectionString(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<string> {
    const resource = await this.getResource(typeId, resourceId, accountId);
    const srv = String(resource.fields["standardSrv"] ?? "");
    if (!srv) throw new Error("This cluster has no public connection string.");
    const secrets = this.services?.secrets;
    const key = fullResourceId(accountId, typeId, externalIdOf(resourceId));
    const [user, password] = secrets
      ? await Promise.all([
          secrets.getPlaintext(key, CONN_USER_KEY),
          secrets.getPlaintext(key, CONN_PASSWORD_KEY),
        ])
      : [null, null];
    if (!user || !password) {
      throw new Error(
        "Atlas never returns database passwords. Use “Create connection user” and Infrawrench creates a user for this cluster and keeps its password, so the MongoDB tab can connect.",
      );
    }
    return withCredentials(srv, user, password);
  }

  // -------------------------------------------------------------------------
  // Stats, metrics and costs
  // -------------------------------------------------------------------------

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const r = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = r.fields;
    const show = (v: unknown) => (v === undefined || v === "" ? "—" : String(v));
    switch (resourceTypeId) {
      case "organization":
        return [
          {
            label: "Month to date",
            value:
              typeof f["pendingTotal"] === "number"
                ? `$${f["pendingTotal"].toLocaleString("en-US", { maximumFractionDigits: 0 })}`
                : "—",
          },
          { label: "Projects", value: show(f["projectCount"]) },
        ];
      case "cluster":
        return [
          {
            label: "State",
            value: f["paused"] === true ? "Paused" : show(f["stateName"]),
            variant:
              f["paused"] === true
                ? "default"
                : f["stateName"] === "IDLE"
                  ? "status-healthy"
                  : "status-degraded",
          },
          { label: "Tier", value: show(f["instanceSize"]) },
          { label: "Nodes", value: show(f["nodeCount"]) },
          { label: "Version", value: show(f["mongoDBVersion"]) },
        ];
      case "flex-cluster":
      case "serverless-instance":
        return [
          { label: "State", value: show(f["stateName"]) },
          { label: "Region", value: show(f["region"]) },
        ];
      default:
        return [];
    }
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    if (resourceTypeId === "organization") {
      const range = rangeOrDefault(timeRange, COST_METRICS_WINDOW_MS);
      const org = await this.org();
      const costRange = { fromDate: isoDate(range.startMs), toDate: isoDate(range.endMs) };
      const rows = await fetchAtlasCostData(this.ctx, org.id, costRange);
      return spendSeries(rows, range);
    }
    if (resourceTypeId === "cluster") {
      const [groupId, name] = splitId(externalIdOf(resourceId), 1) as [string, string];
      const cluster = await this.getCluster(groupId, name);
      if (cluster.paused) return [];
      return clusterSeries(
        this.ctx,
        groupId,
        cluster.connectionStrings?.standardSrv ?? "",
        rangeOrDefault(timeRange, DEFAULT_METRICS_WINDOW_MS),
      );
    }
    return [];
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    let org: AtlasOrg;
    try {
      org = await this.org();
    } catch (err) {
      if (isPermissionError(err)) {
        throw new CostSetupError(
          "MongoDB Atlas rejected the credential. Check the client ID and secret (or API key pair), and that the organization's API access list allows Infrawrench.",
        );
      }
      throw err;
    }
    return fetchAtlasCostData(this.ctx, org.id, range);
  }

  // -------------------------------------------------------------------------
  // Create forms (plus the tier catalogue the oversized finder reads)
  // -------------------------------------------------------------------------

  private async projectSelect(description: string) {
    const refs = await this.refs().catch(() => [] as ProjectRef[]);
    return {
      key: "groupId",
      label: "Project",
      kind: "select" as const,
      required: true,
      description,
      ...(refs[0] ? { defaultValue: refs[0].groupId } : {}),
      options: refs.map((p) => ({ id: p.groupId, label: p.projectName, description: p.groupId })),
    };
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case "database-user": {
        const clusters = await this.clusters().catch(() => []);
        const parentGroup = parentResourceId ? externalIdOf(parentResourceId) : "";
        return {
          fields: [
            ...(parentResourceId
              ? []
              : [await this.projectSelect("The project the user belongs to.")]),
            {
              key: "username",
              label: "Username",
              kind: "text",
              required: true,
              placeholder: "app-service",
            },
            {
              key: "password",
              label: "Password",
              kind: "text",
              required: true,
              defaultValue: randomPassword(24),
              description: "At least 8 characters. Copy it now: Atlas never shows it again.",
            },
            {
              key: "role",
              label: "Role",
              kind: "select",
              required: true,
              defaultValue: "readWrite",
              options: [
                { id: "readWrite", label: "Read and write one database (readWrite)" },
                { id: "read", label: "Read one database (read)" },
                { id: "dbAdmin", label: "Administer one database (dbAdmin)" },
                { id: "readWriteAnyDatabase", label: "Read and write any database" },
                { id: "readAnyDatabase", label: "Read any database" },
                { id: "atlasAdmin", label: "Atlas admin (everything)" },
              ],
            },
            {
              key: "database",
              label: "Database",
              kind: "text",
              required: false,
              placeholder: "app",
              description:
                "The database the role applies to. Ignored for the any-database roles and atlasAdmin.",
              showWhen: { fieldKey: "role", fieldValues: ["readWrite", "read", "dbAdmin"] },
            },
            {
              key: "cluster",
              label: "Limit to cluster",
              kind: "select",
              required: false,
              defaultValue: "",
              options: [
                { id: "", label: "All clusters in the project" },
                ...clusters
                  .filter(({ project }) => !parentGroup || project.groupId === parentGroup)
                  .map(({ project, cluster }) => ({
                    id: cluster.name ?? "",
                    label: cluster.name ?? "",
                    description: project.projectName,
                  })),
              ],
            },
            { key: "description", label: "Description", kind: "text", required: false },
          ],
        };
      }
      case "ip-access-entry":
        return {
          fields: [
            ...(parentResourceId
              ? []
              : [await this.projectSelect("The project whose clusters the entry opens.")]),
            ...ADD_ACCESS_ENTRY_FIELDS,
          ],
        };
      case "backup-snapshot": {
        if (parentResourceId) return { fields: SNAPSHOT_FIELDS };
        const clusters = (await this.clusters().catch(() => [])).filter(
          ({ cluster }) => cluster.backupEnabled && !cluster.paused,
        );
        return {
          fields: [
            {
              key: "cluster",
              label: "Cluster",
              kind: "select",
              required: true,
              options: clusters.map(({ project, cluster }) => ({
                id: `${project.groupId}/${cluster.name}`,
                label: cluster.name ?? "",
                description: project.projectName,
              })),
            },
            ...SNAPSHOT_FIELDS,
          ],
        };
      }
      case "cluster":
        // Not offered as a create form (supportsCreate is false); this is the
        // size catalogue the oversized-cluster finder reads.
        return {
          fields: [
            {
              key: "instanceSize",
              label: "Tier",
              kind: "size-picker",
              required: true,
              sizes: Object.entries(TIER_SPECS).map(([id, spec]) => ({
                id,
                label: tierLabel(id),
                vcpus: spec.vcpus,
                memoryMb: spec.memoryMb,
                diskGb: spec.diskGb,
              })),
            },
          ],
        };
      default:
        throw new Error(`MongoDB Atlas plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  /**
   * Monthly per-node prices for the tier catalogue, from the hourly rates on
   * this organization's pending and most recent closed invoice in the given
   * region. Atlas has no price list API; tiers the org was never billed for
   * have no price and the finder skips them.
   */
  async getCreateSizePricing(
    typeId: string,
    request: CreateSizePricingRequest,
  ): Promise<Record<string, number>> {
    if (typeId !== "cluster" || !request.regionId) return {};
    const org = await this.org();
    const now = Date.now();
    const invoices = await fetchInvoices(this.ctx, org.id, {
      fromDate: isoDate(now - 40 * 86_400_000),
      toDate: isoDate(now),
    });
    const clusters = await this.clusters();
    const regionOf = (groupId: string, name: string) => {
      const found = clusters.find((c) => c.project.groupId === groupId && c.cluster.name === name);
      if (!found) return undefined;
      const rc = [...(found.cluster.replicationSpecs?.[0]?.regionConfigs ?? [])].sort(
        (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
      )[0];
      return rc?.regionName;
    };
    const out: Record<string, number> = {};
    for (const [key, hourly] of instanceRates(invoices, regionOf)) {
      const [region, tier] = key.split("|") as [string, string];
      if (region !== request.regionId) continue;
      out[tier] = Math.round(hourly * HOURS_PER_MONTH * 100) / 100;
    }
    return out;
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    switch (typeId) {
      case "database-user": {
        const groupId = (
          fields["groupId"] || (parentResourceId ? externalIdOf(parentResourceId) : "")
        ).trim();
        if (!groupId) throw new Error("MongoDB Atlas plugin: pick a project");
        const username = (fields["username"] ?? "").trim();
        const password = fields["password"] ?? "";
        if (!username) throw new Error("MongoDB Atlas plugin: a database user needs a username");
        if (password.length < 8)
          throw new Error("MongoDB Atlas plugin: the password needs at least 8 characters");
        const role = fields["role"] || "readWrite";
        const anyDb = role === "atlasAdmin" || role.endsWith("AnyDatabase");
        const database = anyDb ? "admin" : (fields["database"] ?? "").trim();
        if (!database)
          throw new Error("MongoDB Atlas plugin: name the database the role applies to");
        const cluster = (fields["cluster"] ?? "").trim();
        const created = await atlasRequest<AtlasDatabaseUser>(
          this.ctx,
          "POST",
          `${this.groupPath(groupId)}/databaseUsers`,
          {
            body: {
              groupId,
              databaseName: "admin",
              username,
              password,
              roles: [{ roleName: role, databaseName: database }],
              ...(cluster ? { scopes: [{ name: cluster, type: "CLUSTER" }] } : {}),
              ...(fields["description"]?.trim()
                ? { description: fields["description"].trim() }
                : {}),
            },
          },
        );
        return mapDatabaseUser(accountId, created, await this.projectRef(groupId));
      }
      case "ip-access-entry": {
        const groupId = (
          fields["groupId"] || (parentResourceId ? externalIdOf(parentResourceId) : "")
        ).trim();
        if (!groupId) throw new Error("MongoDB Atlas plugin: pick a project");
        const entry = await this.addAccessEntry(groupId, fields);
        return mapAccessEntry(accountId, entry, await this.projectRef(groupId));
      }
      case "backup-snapshot": {
        const target = parentResourceId
          ? externalIdOf(parentResourceId)
          : (fields["cluster"] ?? "");
        const [groupId, cluster] = splitId(target, 1) as [string, string];
        if (!groupId || !cluster) throw new Error("MongoDB Atlas plugin: pick a cluster");
        const snap = await this.takeSnapshot(groupId, cluster, fields);
        return mapSnapshot(accountId, snap, await this.projectRef(groupId), cluster);
      }
      default:
        throw new Error(`MongoDB Atlas plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  private async addAccessEntry(
    groupId: string,
    fields: Record<string, string>,
  ): Promise<AtlasAccessEntry> {
    const raw = (fields["entry"] ?? "").trim();
    if (!raw) throw new Error("MongoDB Atlas plugin: enter an IP address or CIDR block");
    const body: Record<string, unknown> = raw.startsWith("sg-")
      ? { awsSecurityGroup: raw }
      : raw.includes("/")
        ? { cidrBlock: raw }
        : { ipAddress: raw };
    if (fields["comment"]?.trim()) body["comment"] = fields["comment"].trim();
    const hours = Number(fields["expiresInHours"] ?? "");
    if (Number.isFinite(hours) && hours > 0) {
      body["deleteAfterDate"] = new Date(Date.now() + hours * 3_600_000)
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z");
    }
    const res = await atlasRequest<{ results?: AtlasAccessEntry[] }>(
      this.ctx,
      "POST",
      `${this.groupPath(groupId)}/accessList`,
      { body: [body] },
    );
    const value = raw.includes("/") || raw.startsWith("sg-") ? raw : `${raw}/32`;
    const found = (res?.results ?? []).find(
      (e) => e.cidrBlock === value || e.ipAddress === raw || e.awsSecurityGroup === raw,
    );
    return found ?? { groupId, ...(body as AtlasAccessEntry) };
  }

  private async takeSnapshot(
    groupId: string,
    cluster: string,
    fields: Record<string, string>,
  ): Promise<AtlasSnapshot> {
    const retention = Math.max(1, Math.round(Number(fields["retentionInDays"] ?? "7") || 7));
    return atlasRequest<AtlasSnapshot>(
      this.ctx,
      "POST",
      `${this.groupPath(groupId)}/clusters/${enc(cluster)}/backup/snapshots`,
      {
        body: {
          description:
            (fields["description"] ?? "").trim() || "On-demand snapshot from Infrawrench",
          retentionInDays: retention,
        },
      },
    );
  }

  // -------------------------------------------------------------------------
  // Update / delete
  // -------------------------------------------------------------------------

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    switch (typeId) {
      case "project": {
        const name = (fields["name"] ?? "").trim();
        if (name) {
          await atlasRequest(this.ctx, "PATCH", this.groupPath(id), { body: { name } });
          this.projectsCache = undefined;
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "cluster": {
        const [groupId, name] = splitId(id, 1) as [string, string];
        await this.patchCluster(groupId, name, fields);
        return this.getResource(typeId, resourceId, accountId);
      }
      case "flex-cluster": {
        const [groupId, name] = splitId(id, 1) as [string, string];
        if ("terminationProtectionEnabled" in fields) {
          await atlasRequest(
            this.ctx,
            "PATCH",
            `${this.groupPath(groupId)}/flexClusters/${enc(name)}`,
            {
              version: FLEX_VERSION,
              body: {
                terminationProtectionEnabled: fields["terminationProtectionEnabled"] === "true",
              },
            },
          );
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "database-user": {
        const [groupId, db, user] = splitId(id, 2) as [string, string, string];
        const body: Record<string, unknown> = {};
        if ("roles" in fields) {
          const roles = parseRoles(fields["roles"] ?? "");
          if (roles.length === 0)
            throw new Error("MongoDB Atlas plugin: a database user needs at least one role");
          body["roles"] = roles;
        }
        if ("description" in fields) body["description"] = fields["description"] ?? "";
        if (Object.keys(body).length > 0) {
          await atlasRequest(
            this.ctx,
            "PATCH",
            `${this.groupPath(groupId)}/databaseUsers/${enc(db)}/${enc(user)}`,
            { body },
          );
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "ip-access-entry": {
        // The access list is an upsert: posting an existing entry replaces its comment.
        const [groupId, entry] = splitId(id, 1) as [string, string];
        if ("comment" in fields) {
          await this.addAccessEntry(groupId, { entry, comment: fields["comment"] ?? "" });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "backup-policy": {
        const [groupId, cluster] = splitId(id, 1) as [string, string];
        const body: Record<string, unknown> = {};
        const num = (key: string, min: number, max: number) => {
          if (!(key in fields) || fields[key] === "") return;
          const v = Math.round(Number(fields[key]));
          if (!Number.isFinite(v) || v < min || v > max) {
            throw new Error(`MongoDB Atlas plugin: ${key} must be between ${min} and ${max}`);
          }
          body[key] = v;
        };
        num("referenceHourOfDay", 0, 23);
        num("referenceMinuteOfHour", 0, 59);
        num("restoreWindowDays", 1, 365);
        if (Object.keys(body).length > 0) {
          await atlasRequest(
            this.ctx,
            "PATCH",
            `${this.groupPath(groupId)}/clusters/${enc(cluster)}/backup/schedule`,
            { version: CLUSTER_VERSION, body },
          );
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      default:
        throw new Error(`MongoDB Atlas plugin: "${typeId}" cannot be edited from Infrawrench`);
    }
  }

  /**
   * Apply tier, storage, auto-scaling and termination protection changes in
   * one PATCH. Tier and storage live on every region config's hardware specs,
   * so the current replication specs are read, changed and sent back whole.
   */
  private async patchCluster(
    groupId: string,
    name: string,
    fields: Record<string, string>,
  ): Promise<void> {
    const body: Record<string, unknown> = {};
    if ("terminationProtectionEnabled" in fields) {
      body["terminationProtectionEnabled"] = fields["terminationProtectionEnabled"] === "true";
    }
    const tier = (fields["instanceSize"] ?? "").trim();
    const disk =
      fields["diskSizeGB"] !== undefined && fields["diskSizeGB"] !== ""
        ? Number(fields["diskSizeGB"])
        : undefined;
    const compute =
      "autoScalingCompute" in fields ? fields["autoScalingCompute"] === "true" : undefined;
    const diskAuto = "autoScalingDisk" in fields ? fields["autoScalingDisk"] === "true" : undefined;
    if (tier && !isDedicatedTier(tier)) {
      throw new Error(`MongoDB Atlas plugin: "${tier}" is not a dedicated cluster tier`);
    }
    if (disk !== undefined && (!Number.isFinite(disk) || disk <= 0)) {
      throw new Error("MongoDB Atlas plugin: storage must be a positive number of GB");
    }
    if (tier || disk !== undefined || compute !== undefined || diskAuto !== undefined) {
      const current = await this.getCluster(groupId, name);
      const provider =
        [...(current.replicationSpecs?.[0]?.regionConfigs ?? [])][0]?.providerName ?? "";
      const specs = writableSpecs(current.replicationSpecs);
      for (const spec of specs) {
        for (const rc of spec["regionConfigs"] as Array<Record<string, unknown>>) {
          for (const key of ["electableSpecs", "readOnlySpecs", "analyticsSpecs"]) {
            const hw = rc[key] as Record<string, unknown> | undefined;
            if (!hw) continue;
            if (tier && key !== "analyticsSpecs") hw["instanceSize"] = tier;
            if (disk !== undefined) hw["diskSizeGB"] = disk;
          }
          if (compute !== undefined || diskAuto !== undefined) {
            const auto = (rc["autoScaling"] as Record<string, unknown> | undefined) ?? {};
            if (compute !== undefined) {
              const c = (auto["compute"] as Record<string, unknown> | undefined) ?? {};
              c["enabled"] = compute;
              if (compute) {
                const size =
                  tier ||
                  String(
                    (rc["electableSpecs"] as Record<string, unknown> | undefined)?.[
                      "instanceSize"
                    ] ?? "",
                  );
                const ladder = (TIERS_BY_PROVIDER[provider] ?? []).filter(
                  (t) => t[0] === size[0] && /_NVME/.test(t) === /_NVME/.test(size),
                );
                const at = ladder.indexOf(size);
                c["scaleDownEnabled"] = c["scaleDownEnabled"] ?? true;
                c["minInstanceSize"] = c["minInstanceSize"] ?? size;
                c["maxInstanceSize"] =
                  c["maxInstanceSize"] ?? ladder[Math.min(at + 2, ladder.length - 1)] ?? size;
              } else {
                delete c["minInstanceSize"];
                delete c["maxInstanceSize"];
                c["scaleDownEnabled"] = false;
              }
              auto["compute"] = c;
            }
            if (diskAuto !== undefined) auto["diskGB"] = { enabled: diskAuto };
            rc["autoScaling"] = auto;
            if (rc["analyticsAutoScaling"] === undefined && rc["analyticsSpecs"]) {
              rc["analyticsAutoScaling"] = JSON.parse(JSON.stringify(auto));
            }
          }
        }
      }
      body["replicationSpecs"] = specs;
    }
    if (Object.keys(body).length === 0) return;
    await atlasRequest(this.ctx, "PATCH", `${this.groupPath(groupId)}/clusters/${enc(name)}`, {
      version: CLUSTER_VERSION,
      body,
    });
    this.clustersCache = undefined;
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const id = externalIdOf(resourceId);
    switch (typeId) {
      case "database-user": {
        const [groupId, db, user] = splitId(id, 2) as [string, string, string];
        await atlasRequest(
          this.ctx,
          "DELETE",
          `${this.groupPath(groupId)}/databaseUsers/${enc(db)}/${enc(user)}`,
        );
        return;
      }
      case "ip-access-entry": {
        const [groupId, entry] = splitId(id, 1) as [string, string];
        await atlasRequest(
          this.ctx,
          "DELETE",
          `${this.groupPath(groupId)}/accessList/${enc(entry)}`,
        );
        return;
      }
      case "backup-snapshot": {
        const [groupId, cluster, snap] = splitId(id, 2) as [string, string, string];
        await atlasRequest(
          this.ctx,
          "DELETE",
          `${this.groupPath(groupId)}/clusters/${enc(cluster)}/backup/snapshots/${enc(snap)}`,
        );
        return;
      }
      case "alert-configuration": {
        const [groupId, configId] = splitId(id, 1) as [string, string];
        await atlasRequest(
          this.ctx,
          "DELETE",
          `${this.groupPath(groupId)}/alertConfigs/${enc(configId)}`,
        );
        return;
      }
      case "search-index": {
        const [groupId, cluster, indexId] = splitId(id, 2) as [string, string, string];
        await atlasRequest(
          this.ctx,
          "DELETE",
          `${this.groupPath(groupId)}/clusters/${enc(cluster)}/search/indexes/${enc(indexId)}`,
          { version: SEARCH_VERSION },
        );
        return;
      }
      case "online-archive": {
        const [groupId, cluster, archiveId] = splitId(id, 2) as [string, string, string];
        await atlasRequest(
          this.ctx,
          "DELETE",
          `${this.groupPath(groupId)}/clusters/${enc(cluster)}/onlineArchives/${enc(archiveId)}`,
        );
        return;
      }
      case "private-endpoint-service": {
        const [groupId, provider, serviceId] = splitId(id, 2) as [string, string, string];
        await atlasRequest(
          this.ctx,
          "DELETE",
          `${this.groupPath(groupId)}/privateEndpoint/${enc(provider)}/endpointService/${enc(serviceId)}`,
        );
        return;
      }
      default:
        throw new Error(`MongoDB Atlas plugin: "${typeId}" cannot be deleted from Infrawrench`);
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const id = externalIdOf(resourceId);
    if (typeId === "cluster" && (actionId === "pause" || actionId === "resume")) {
      const [groupId, name] = splitId(id, 1) as [string, string];
      await atlasRequest(this.ctx, "PATCH", `${this.groupPath(groupId)}/clusters/${enc(name)}`, {
        version: CLUSTER_VERSION,
        body: { paused: actionId === "pause" },
      });
      this.clustersCache = undefined;
      return;
    }
    if (typeId === "alert" && actionId === "unacknowledge") {
      const [groupId, alertId] = splitId(id, 1) as [string, string];
      await atlasRequest(this.ctx, "PATCH", `${this.groupPath(groupId)}/alerts/${enc(alertId)}`, {
        body: { unacknowledgeAlert: true },
        version: "2024-05-30",
      });
      return;
    }
    if (typeId === "alert-configuration" && (actionId === "enable" || actionId === "disable")) {
      const [groupId, configId] = splitId(id, 1) as [string, string];
      await atlasRequest(
        this.ctx,
        "PATCH",
        `${this.groupPath(groupId)}/alertConfigs/${enc(configId)}`,
        {
          body: { enabled: actionId === "enable" },
        },
      );
      return;
    }
    if (typeId === "online-archive" && (actionId === "pause" || actionId === "resume")) {
      const [groupId, cluster, archiveId] = splitId(id, 2) as [string, string, string];
      await atlasRequest(
        this.ctx,
        "PATCH",
        `${this.groupPath(groupId)}/clusters/${enc(cluster)}/onlineArchives/${enc(archiveId)}`,
        { body: { paused: actionId === "pause" } },
      );
      return;
    }
    throw new Error(`MongoDB Atlas plugin: unknown action "${actionId}" for "${typeId}"`);
  }

  /** Form-driven actions (the host's prompt modal); values arrive JSON-encoded in `args[0]`. */
  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const id = externalIdOf(resourceId);
    const form = parseForm(args);
    switch (`${typeId}:${command}`) {
      case "project:add-ip-access-entry":
        await this.addAccessEntry(id, form);
        return { ok: true };
      case "cluster:scale-tier": {
        const [groupId, name] = splitId(id, 1) as [string, string];
        const tier = (form["instanceSize"] ?? "").trim();
        if (!tier) throw new Error("Pick a tier.");
        await this.patchCluster(groupId, name, { instanceSize: tier });
        return { ok: true };
      }
      case "cluster:take-snapshot": {
        const [groupId, name] = splitId(id, 1) as [string, string];
        await this.takeSnapshot(groupId, name, form);
        return { ok: true };
      }
      case "cluster:create-connection-user":
      case "flex-cluster:create-connection-user":
        await this.createConnectionUser(typeId, id, accountId, form["role"] ?? "readAnyDatabase");
        return { ok: true };
      case "alert:acknowledge": {
        const [groupId, alertId] = splitId(id, 1) as [string, string];
        const hours = Math.max(1, Number(form["hours"] ?? "24") || 24);
        await atlasRequest(this.ctx, "PATCH", `${this.groupPath(groupId)}/alerts/${enc(alertId)}`, {
          version: "2024-05-30",
          body: {
            acknowledgedUntil: new Date(Date.now() + hours * 3_600_000)
              .toISOString()
              .replace(/\.\d{3}Z$/, "Z"),
            ...(form["comment"]?.trim() ? { acknowledgementComment: form["comment"].trim() } : {}),
          },
        });
        return { ok: true };
      }
      default:
        throw new Error(`MongoDB Atlas plugin: unknown command "${command}" for "${typeId}"`);
    }
  }

  /**
   * Create a database user scoped to one cluster with a generated password and
   * keep the password in the host's secret store, so the MongoDB console tab
   * (the `mongodb` plugin, fed by the `connectionString` output) can connect.
   */
  private async createConnectionUser(
    typeId: string,
    externalId: string,
    accountId: string,
    role: string,
  ): Promise<void> {
    const secrets = this.services?.secrets;
    if (!secrets?.setPlaintext) {
      throw new Error(
        "This host cannot store credentials, so the connection user could not be kept.",
      );
    }
    const [groupId, name] = splitId(externalId, 1) as [string, string];
    const safeRole = role === "readWriteAnyDatabase" ? role : "readAnyDatabase";
    const username = `infrawrench-${name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .slice(0, 30)}-${randomPassword(6).toLowerCase()}`;
    const password = randomPassword(32);
    await atlasRequest(this.ctx, "POST", `${this.groupPath(groupId)}/databaseUsers`, {
      body: {
        groupId,
        databaseName: "admin",
        username,
        password,
        roles: [{ roleName: safeRole, databaseName: "admin" }],
        scopes: [{ name, type: "CLUSTER" }],
        description: "Created by Infrawrench for its MongoDB console",
      },
    });
    const key = fullResourceId(accountId, typeId, externalId);
    await secrets.setPlaintext(key, CONN_USER_KEY, username);
    await secrets.setPlaintext(key, CONN_PASSWORD_KEY, password);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderAtlasDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderAtlasSidebar(resource);
  }
}

export { tierSpec };
