import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
import type {
  CostFetchRange,
  CostRow,
  CreateFieldConfig,
  CreateResourceConfig,
  CreditBalance,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  ResourceCreateResult,
  ResourceInstance,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import {
  CreditAccessError,
  decodePromptArgs,
  externalIdOf,
  pathEncode,
  withMetricsCapability,
} from "@infrawrench/plugin-base";
import type {
  CapellaApi,
  CapellaBody,
  CapellaContext,
  CapellaResponse,
  CapellaRow,
  ClusterPath,
  FreeClusterPath,
  OrgPath,
  ProjectPath,
} from "./api.js";
import {
  capellaList,
  createCapellaApi,
  isUnavailable,
  joinId,
  rowsAt,
  splitId,
  statusOf,
} from "./api.js";
import {
  APP_SERVICE_COMPUTE,
  BILLING_CATEGORIES,
  ORG_ROLES,
  PROJECT_ROLES,
  REGIONS,
  SERVICES,
  computeOptions,
  defaultDisk,
  parseCompute,
} from "./catalog.js";
import {
  compact,
  instance,
  isFreeTier,
  mapApiKey,
  mapAppService,
  mapBackup,
  mapBucket,
  mapCidr,
  mapCluster,
  mapCredential,
  mapProject,
  mapUser,
} from "./mappers.js";
import type { components } from "./api-types.gen.js";
import { ENRICH, renderCapellaDetail, renderCapellaSidebar } from "./render.js";
import { RESOURCE_TYPES, T } from "./resource-types.js";

const CACHE_MS = 20_000;
export const PASSWORD_SECRET = "capellaCredentialPassword";

function csv(raw: string | undefined): string[] {
  const text = String(raw ?? "").trim();
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed))
        return parsed
          .map(String)
          .map((s) => s.trim())
          .filter(Boolean);
    } catch {
      /* fall through */
    }
  }
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function boolish(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === "") return undefined;
  return raw === "true" || raw === "1" || raw === "yes";
}

function int(
  raw: string | undefined,
  label: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  return n;
}

/** 20 characters meeting Capella's rules: upper, lower, digit and a special character. */
export function generatePassword(): string {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!#%+-_@"];
  const bytes = new Uint8Array(20);
  globalThis.crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b, i) => {
    const set = sets[i < 4 ? i : b % 3]!;
    return set[b % set.length]!;
  });
  return chars.join("");
}

function notFound(what: string): Error {
  return Object.assign(new Error(`Capella plugin: ${what} not found`), { status: 404 });
}

/**
 * The ranges to ask the billing API for: split at each month's middle and end. Its
 * document says a range within a month answers one period a day, but its examples
 * answer April 1 to 30 with one period for the month. A shorter range is daily on
 * either reading, and a range across months is documented to answer by the month.
 */
export function billingChunks(from: string, to: string): Array<{ start: string; end: string }> {
  const out: Array<{ start: string; end: string }> = [];
  let cur = new Date(`${from}T00:00:00Z`);
  const last = new Date(`${to}T00:00:00Z`);
  while (cur <= last) {
    const year = cur.getUTCFullYear();
    const month = cur.getUTCMonth();
    const stop = new Date(Date.UTC(year, month, 15));
    const boundary = cur <= stop ? stop : new Date(Date.UTC(year, month + 1, 0));
    const end = boundary < last ? boundary : last;
    out.push({ start: cur.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) });
    cur = new Date(end.getTime() + 86_400_000);
  }
  return out;
}

/** The day a billing period covers. Anything longer would lose its spend, so it refuses. */
function billingDay(period: { startDate?: string; endDate?: string }): string {
  if (!period.startDate || period.endDate !== period.startDate) {
    throw new Error(
      `Capella answered with a billing period from ${period.startDate} to ${period.endDate} where it should give one day at a time, and leaving it out would read as no spend.`,
    );
  }
  return period.startDate;
}

/** Recent loads by key, kept for {@link CACHE_MS}. A load that fails is forgotten. */
class RecentLoads<V> {
  private entries = new Map<string, { at: number; value: Promise<V> }>();

  get(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const value = load();
    this.entries.set(key, { at: Date.now(), value });
    value.catch(() => this.entries.delete(key));
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}

type BucketRow = CapellaRow<"listBuckets">;
type AppServiceRow = CapellaRow<"listAppServices">;

/** A network peer's provider settings, flattened: they sit one level down, under the cloud's name. */
function peerDetails(config: CapellaRow<"listNetworkPeeringRecords">["providerConfig"]): string {
  const cfg = config ?? {};
  const inner =
    Object.values(cfg).find(
      (v): v is Exclude<typeof v, string | undefined> => Boolean(v) && typeof v === "object",
    ) ?? cfg;
  return Object.entries(inner)
    .filter(([, v]) => typeof v === "string" || typeof v === "number")
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

const SEVERE_EVENTS: ("warning" | "critical")[] = ["warning", "critical"];

const WEEK = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

interface ClusterRef {
  projectId: string;
  clusterId: string;
  free: boolean;
  name?: string;
  region?: string;
}

export class CapellaClient implements PluginClient {
  readonly ctx: CapellaContext;
  private readonly services: HostServices | undefined;
  private readonly api: CapellaApi;
  private readonly projectLoads = new RecentLoads<CapellaRow<"listProjects">[]>();
  private readonly clusterLoads = new RecentLoads<CapellaRow<"listClusters">[]>();
  private readonly bucketLoads = new RecentLoads<BucketRow[]>();
  private readonly appServiceLoads = new RecentLoads<AppServiceRow[]>();
  private freeTier = new Map<string, boolean>();

  constructor(credentials: Credentials, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    const organizationId = (credentials["organizationId"] ?? "").trim();
    if (!apiKey) throw new Error("Capella plugin: missing apiKey credential");
    if (!organizationId) throw new Error("Capella plugin: missing organizationId credential");
    this.services = services;
    this.ctx = { apiKey, organizationId, ...(services?.http ? { http: services.http } : {}) };
    this.api = createCapellaApi(this.ctx);
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private invalidate(): void {
    this.projectLoads.clear();
    this.clusterLoads.clear();
    this.bucketLoads.clear();
    this.appServiceLoads.clear();
  }

  private get org(): OrgPath {
    return `/v4/organizations/${pathEncode(this.ctx.organizationId)}`;
  }

  private projectPath(p: string): ProjectPath {
    return `${this.org}/projects/${pathEncode(p)}`;
  }

  /** `/clusters/{id}` or, for a free-tier cluster, `/clusters/freeTier/{id}`. */
  private clusterPath(p: string, c: string): ClusterPath | FreeClusterPath {
    return this.freeTier.get(c) === true
      ? `${this.projectPath(p)}/clusters/freeTier/${pathEncode(c)}`
      : this.sub(p, c);
  }

  /** Paths below a cluster (buckets, users, …) always use the plain cluster path. */
  private sub(p: string, c: string): ClusterPath {
    return `${this.projectPath(p)}/clusters/${pathEncode(c)}`;
  }

  private async optional<V>(load: () => Promise<V>, fallback: V): Promise<V> {
    try {
      return await load();
    } catch (err) {
      if (isUnavailable(err)) return fallback;
      throw err;
    }
  }

  projects(): Promise<CapellaRow<"listProjects">[]> {
    return this.projectLoads.get("projects", () =>
      capellaList(`${this.org}/projects`, (path, query) => this.api.get(path, { query })),
    );
  }

  private async projectNames(): Promise<Map<string, string>> {
    return new Map((await this.projects()).map((p) => [p.id, p.name ?? p.id]));
  }

  clustersOf(projectId: string): Promise<CapellaRow<"listClusters">[]> {
    return this.clusterLoads.get(`clusters-${projectId}`, async () => {
      const list = await this.optional(
        () =>
          capellaList(`${this.projectPath(projectId)}/clusters`, (path, query) =>
            this.api.get(path, { query }),
          ),
        [],
      );
      for (const c of list) this.freeTier.set(c.id, isFreeTier(c));
      return list;
    });
  }

  async clusterRefs(): Promise<ClusterRef[]> {
    const out: ClusterRef[] = [];
    for (const p of await this.projects()) {
      for (const c of await this.clustersOf(p.id)) {
        out.push({
          projectId: p.id,
          clusterId: c.id,
          free: isFreeTier(c),
          ...(c.name ? { name: c.name } : {}),
          ...(c.cloudProvider?.region ? { region: c.cloudProvider.region } : {}),
        });
      }
    }
    return out;
  }

  private bucketsOf(ref: ClusterRef): Promise<BucketRow[]> {
    const cluster = this.sub(ref.projectId, ref.clusterId);
    return this.bucketLoads.get(`buckets-${ref.clusterId}`, () =>
      this.optional<BucketRow[]>(async () => {
        if (ref.free) {
          const path = `${cluster}/buckets/freeTier` as const;
          return rowsAt(path, "data", await this.api.get(path));
        }
        const path = `${cluster}/buckets` as const;
        return rowsAt(path, "data", await this.api.get(path));
      }, []),
    );
  }

  private appServices(): Promise<AppServiceRow[]> {
    return this.appServiceLoads.get("app-services", () =>
      this.optional<AppServiceRow[]>(
        () =>
          capellaList(`${this.org}/appservices`, (path, query) => this.api.get(path, { query })),
        [],
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Inventory
  // -------------------------------------------------------------------------

  /** For every non-free cluster (or every cluster), run `load` and flatten. */
  private async perCluster<V>(
    load: (ref: ClusterRef) => Promise<V[]>,
    includeFree = true,
  ): Promise<V[]> {
    const refs = (await this.clusterRefs()).filter((r) => includeFree || !r.free);
    const lists = await Promise.all(
      refs.map((r) =>
        load(r).catch((err: unknown): V[] => {
          if (statusOf(err) === 401) throw err;
          if (isUnavailable(err)) return [];
          throw err;
        }),
      ),
    );
    return lists.flat();
  }

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      const list = await this.listRaw(typeId, accountId);
      // The organization id rides along so Terraform import ids can name it.
      for (const r of list) r.fields["organizationId"] = this.ctx.organizationId;
      return list;
    });
  }

  private async listRaw(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case T.project:
        return (await this.projects()).map((p) => mapProject(accountId, p));
      case T.cluster: {
        const out: ResourceInstance[] = [];
        for (const p of await this.projects()) {
          for (const c of await this.clustersOf(p.id)) out.push(mapCluster(accountId, p.id, c));
        }
        return out;
      }
      case T.appService: {
        const refs = await this.clusterRefs();
        const projectOf = new Map(refs.map((r) => [r.clusterId, r.projectId]));
        return (await this.appServices())
          .filter((a) => a.clusterId && projectOf.has(a.clusterId))
          .map((a) => mapAppService(accountId, projectOf.get(a.clusterId!)!, a));
      }
      case T.bucket:
        return this.perCluster(async (r) =>
          (await this.bucketsOf(r)).map((b) => mapBucket(accountId, r.projectId, r.clusterId, b)),
        );
      case T.scope:
      case T.collection:
        return this.perCluster(async (r) => {
          const out: ResourceInstance[] = [];
          for (const b of await this.bucketsOf(r)) {
            const path =
              `${this.sub(r.projectId, r.clusterId)}/buckets/${pathEncode(b.id)}/scopes` as const;
            const scopes = await this.optional<CapellaResponse<"getScopes">["scopes"]>(
              async () => rowsAt(path, "scopes", await this.api.get(path)),
              [],
            );
            for (const s of scopes) {
              if (!s.name) continue;
              const bucketExt = joinId(r.projectId, r.clusterId, b.id);
              const scopeExt = joinId(r.projectId, r.clusterId, b.id, s.name);
              if (typeId === T.scope) {
                out.push(
                  instance(
                    accountId,
                    T.scope,
                    scopeExt,
                    `${b.name ?? b.id}.${s.name}`,
                    compact({
                      name: s.name,
                      bucketName: b.name,
                      collections: s.collections?.length ?? 0,
                    }),
                    { typeId: T.bucket, externalId: bucketExt },
                  ),
                );
              } else {
                for (const c of s.collections ?? []) {
                  if (!c.name) continue;
                  out.push(
                    instance(
                      accountId,
                      T.collection,
                      joinId(r.projectId, r.clusterId, b.id, s.name, c.name),
                      `${b.name ?? b.id}.${s.name}.${c.name}`,
                      compact({
                        name: c.name,
                        scope: s.name,
                        bucketName: b.name,
                        maxTTL: c.maxTTL,
                      }),
                      { typeId: T.scope, externalId: scopeExt },
                    ),
                  );
                }
              }
            }
          }
          return out;
        }, false);
      case T.credential:
        return this.perCluster(
          async (r) =>
            (
              await capellaList(`${this.sub(r.projectId, r.clusterId)}/users`, (path, query) =>
                this.api.get(path, { query }),
              )
            ).map((c) => mapCredential(accountId, r.projectId, r.clusterId, c)),
          false,
        );
      case T.cidr:
        return this.perCluster(
          async (r) =>
            (
              await capellaList(
                `${this.sub(r.projectId, r.clusterId)}/allowedcidrs`,
                (path, query) => this.api.get(path, { query }),
              )
            ).map((c) => mapCidr(accountId, r.projectId, r.clusterId, c)),
          false,
        );
      case T.backup:
        return this.perCluster(async (r) => {
          const path = `${this.sub(r.projectId, r.clusterId)}/backups` as const;
          return rowsAt(path, "data", await this.api.get(path))
            .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")))
            .map((b) => mapBackup(accountId, r.projectId, r.clusterId, b));
        }, false);
      case T.replication:
        return this.perCluster(
          async (r) =>
            (
              await capellaList(
                `${this.sub(r.projectId, r.clusterId)}/replications`,
                (path, query) => this.api.get(path, { query }),
              )
            ).map((x) =>
              instance(
                accountId,
                T.replication,
                joinId(r.projectId, r.clusterId, x.id),
                `${x.sourceCluster ?? r.name ?? ""} → ${x.targetCluster ?? ""}`,
                compact({
                  replicationId: x.id,
                  sourceCluster: x.sourceCluster,
                  targetCluster: x.targetCluster,
                  status: x.status,
                  direction: x.direction,
                  createdAt: x.audit?.createdAt,
                  createdBy: x.audit?.createdBy,
                }),
                { typeId: T.cluster, externalId: joinId(r.projectId, r.clusterId) },
              ),
            ),
          false,
        );
      case T.networkPeer:
        return this.perCluster(
          async (r) =>
            (
              await capellaList(
                `${this.sub(r.projectId, r.clusterId)}/networkPeers`,
                (path, query) => this.api.get(path, { query }),
              )
            ).map((x) =>
              instance(
                accountId,
                T.networkPeer,
                joinId(r.projectId, r.clusterId, x.id),
                x.name ?? x.id,
                compact({
                  name: x.name,
                  state: x.status?.state,
                  reasoning: x.status?.reasoning,
                  peerDetails: peerDetails(x.providerConfig),
                  createdAt: x.audit?.createdAt,
                  createdBy: x.audit?.createdBy,
                }),
                { typeId: T.cluster, externalId: joinId(r.projectId, r.clusterId) },
              ),
            ),
          false,
        );
      case T.privateEndpoint:
        return this.perCluster(async (r) => {
          const path =
            `${this.sub(r.projectId, r.clusterId)}/privateEndpointService/endpoints` as const;
          const res = await this.api.get(path);
          return rowsAt(path, "endpoints", res).map((e) =>
            instance(
              accountId,
              T.privateEndpoint,
              joinId(r.projectId, r.clusterId, e.id),
              e.id,
              compact({
                endpointId: e.id,
                serviceName: e.serviceName,
                status: e.status,
                dns: res?.privateEndpointDNS,
              }),
              { typeId: T.cluster, externalId: joinId(r.projectId, r.clusterId) },
            ),
          );
        }, false);
      case T.user: {
        const names = await this.projectNames();
        return (
          await this.optional<CapellaRow<"listUsers">[]>(
            () => capellaList(`${this.org}/users`, (path, query) => this.api.get(path, { query })),
            [],
          )
        ).map((u) => mapUser(accountId, u, names));
      }
      case T.apiKey: {
        const names = await this.projectNames();
        return (
          await this.optional<CapellaRow<"listOrganizationAPIKeys">[]>(
            () =>
              capellaList(`${this.org}/apikeys`, (path, query) => this.api.get(path, { query })),
            [],
          )
        ).map((k) => mapApiKey(accountId, k, names));
      }
      default:
        throw new Error(`Capella plugin: unknown resource type "${typeId}"`);
    }
  }

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const ext = externalIdOf(resourceId);
      if (typeId === T.cluster) {
        const [p, c] = splitId(ext, 2);
        await this.clustersOf(p);
        const cluster = await this.api.get(this.clusterPath(p, c));
        const stats = this.freeTier.get(c)
          ? undefined
          : await this.api.get(`${this.sub(p, c)}/stats`).catch(() => undefined);
        const r = mapCluster(accountId, p, cluster, stats);
        r.fields["organizationId"] = this.ctx.organizationId;
        return r;
      }
      const found = (await runPluginEffect(this.listResources(typeId, accountId))).find(
        (r) => r.externalId === ext,
      );
      if (!found) throw notFound(`${typeId} ${ext}`);
      return found;
    });
  }

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      const ext = externalIdOf(resourceId);
      if (typeId === T.cluster) {
        const [p, c] = splitId(ext, 2);
        if (outputKey === "connectionString") {
          await this.clustersOf(p);
          return (await this.api.get(this.clusterPath(p, c)))?.connectionString ?? "";
        }
        if (outputKey === "certificate") {
          return (await this.api.get(`${this.sub(p, c)}/certificates`))?.certificate ?? "";
        }
      }
      if (typeId === T.credential) {
        const [p, c] = splitId(ext, 3);
        const cred = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
        const username = String(cred.fields["name"] ?? "");
        if (outputKey === "username") return username;
        const password = await this.services?.secrets?.getPlaintext(resourceId, PASSWORD_SECRET);
        if (!password) {
          throw new Error(
            "Capella shows a credential's password only when it is set. Use Reset password and Infrawrench keeps the new one.",
          );
        }
        if (outputKey === "password") return password;
        if (outputKey === "connectionString") {
          await this.clustersOf(p);
          const host = (
            (await this.api.get(this.clusterPath(p, c)))?.connectionString ?? ""
          ).replace(/^couchbases?:\/\//, "");
          return `couchbases://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}`;
        }
      }
      throw new Error(`Capella plugin: cannot resolve "${outputKey}" for "${typeId}"`);
    });
  }

  // -------------------------------------------------------------------------
  // Detail
  // -------------------------------------------------------------------------

  enrichDetail(resource: ResourceInstance): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const out: ResourceInstance = {
        ...resource,
        resolvedOutputs: { ...resource.resolvedOutputs },
      };
      const put = <V>(key: string, value: V) => {
        if (value !== undefined) out.resolvedOutputs[key] = JSON.stringify(value);
      };
      const settle = async <V>(p: Promise<V>) => p.catch(() => undefined);
      const ext = resource.externalId ?? externalIdOf(resource.id);
      switch (resource.resourceTypeId) {
        case T.cluster: {
          if (resource.fields["freeTier"] === true) break;
          const [p, c] = splitId(ext, 2);
          const [schedule, audit] = await Promise.all([
            settle(this.api.get(`${this.sub(p, c)}/onOffSchedule`)),
            settle(this.api.get(`${this.sub(p, c)}/auditLog`)),
          ]);
          put(ENRICH.schedule, schedule);
          put(ENRICH.auditLog, audit);
          break;
        }
        case T.bucket: {
          const [p, c, b] = splitId(ext, 3);
          put(
            ENRICH.backupSchedule,
            await settle(
              this.api.get(`${this.sub(p, c)}/buckets/${pathEncode(b)}/backup/schedules`),
            ),
          );
          break;
        }
        case T.backup:
          put(
            ENRICH.clusters,
            (await this.clusterRefs().catch(() => []))
              .filter((r) => !r.free)
              .map((r) => ({
                id: joinId(r.projectId, r.clusterId),
                label: r.name ?? r.clusterId,
                description: r.region ?? "",
              })),
          );
          break;
        case T.user:
          put(
            ENRICH.projects,
            (await this.projects().catch(() => [])).map((p) => ({
              id: p.id,
              label: p.name ?? p.id,
            })),
          );
          break;
      }
      return out;
    });
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return withMetricsCapability(
      renderCapellaDetail(resource),
      RESOURCE_TYPES,
      resource.resourceTypeId,
    );
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderCapellaSidebar(resource);
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  private async projectField(parentResourceId?: string): Promise<CreateFieldConfig[]> {
    if (parentResourceId) return [];
    return [
      {
        key: "projectId",
        label: "Project",
        kind: "select",
        required: true,
        options: (await this.projects()).map((p) => ({ id: p.id, label: p.name ?? p.id })),
      },
    ];
  }

  private async clusterField(
    parentResourceId?: string,
    includeFree = false,
  ): Promise<CreateFieldConfig[]> {
    if (parentResourceId) return [];
    return [
      {
        key: "cluster",
        label: "Cluster",
        kind: "select",
        required: true,
        options: (await this.clusterRefs())
          .filter((r) => includeFree || !r.free)
          .map((r) => ({
            id: joinId(r.projectId, r.clusterId),
            label: r.name ?? r.clusterId,
            description: r.region ?? "",
          })),
      },
    ];
  }

  private parentCluster(
    fields: Record<string, string>,
    parentResourceId?: string,
  ): [string, string] {
    const ext = parentResourceId ? externalIdOf(parentResourceId) : (fields["cluster"] ?? "");
    const parts = ext.split("/");
    if (parts.length < 2) throw new Error("Pick a cluster.");
    return [decodeURIComponent(parts[0]!), decodeURIComponent(parts[1]!)];
  }

  getCreateConfig(typeId: string, parentResourceId?: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      switch (typeId) {
        case T.project:
          return {
            fields: [
              { key: "name", label: "Name", kind: "text", required: true },
              { key: "description", label: "Description", kind: "text", required: false },
            ],
          };
        case T.cluster:
          return {
            fields: [
              ...(await this.projectField(parentResourceId)),
              { key: "name", label: "Name", kind: "text", required: true },
              {
                key: "tier",
                label: "Tier",
                kind: "select",
                required: true,
                options: [
                  {
                    id: "paid",
                    label: "Provisioned",
                    description: "Choose node size, count and services",
                  },
                  {
                    id: "free",
                    label: "Free tier",
                    description: "One small single-node cluster per organization",
                  },
                ],
                defaultValue: "paid",
              },
              {
                key: "cloud",
                label: "Cloud",
                kind: "select",
                required: true,
                options: [
                  { id: "aws", label: "AWS" },
                  { id: "gcp", label: "Google Cloud" },
                  { id: "azure", label: "Azure" },
                ],
                defaultValue: "aws",
              },
              {
                key: "region",
                label: "Region",
                kind: "region-picker",
                required: true,
                regions: REGIONS,
                filterByFieldKey: "cloud",
              },
              {
                key: "cidr",
                label: "CIDR",
                kind: "text",
                required: false,
                placeholder: "10.0.30.0/23",
                description:
                  "Private range for the cluster's network; must not overlap networks you will peer with. Blank picks one.",
              },
              {
                key: "compute",
                label: "Node size",
                kind: "select",
                required: true,
                options: computeOptions(),
                defaultValue: "4/16",
                showWhen: { fieldKey: "tier", fieldValue: "paid" },
              },
              {
                key: "nodes",
                label: "Nodes",
                kind: "number",
                required: true,
                minValue: 1,
                maxValue: 27,
                defaultValue: "3",
                showWhen: { fieldKey: "tier", fieldValue: "paid" },
              },
              {
                key: "storage",
                label: "Disk per node (GB)",
                kind: "number",
                required: true,
                minValue: 50,
                defaultValue: "50",
                showWhen: { fieldKey: "tier", fieldValue: "paid" },
              },
              {
                key: "services",
                label: "Services",
                kind: "policy-picker",
                required: true,
                policies: SERVICES.map((s) => ({ id: s, label: s })),
                defaultValue: JSON.stringify(["data", "query", "index", "search"]),
                showWhen: { fieldKey: "tier", fieldValue: "paid" },
              },
              {
                key: "availability",
                label: "Availability",
                kind: "select",
                required: true,
                options: [
                  { id: "multi", label: "Multiple availability zones" },
                  { id: "single", label: "Single availability zone" },
                ],
                defaultValue: "multi",
                showWhen: { fieldKey: "tier", fieldValue: "paid" },
              },
              {
                key: "supportPlan",
                label: "Support plan",
                kind: "select",
                required: true,
                options: [
                  { id: "basic", label: "Basic" },
                  { id: "developer pro", label: "Developer Pro" },
                  { id: "enterprise", label: "Enterprise" },
                ],
                defaultValue: "developer pro",
                showWhen: { fieldKey: "tier", fieldValue: "paid" },
              },
              {
                key: "timezone",
                label: "Support timezone",
                kind: "select",
                required: false,
                options: ["ET", "GMT", "IST", "PT"].map((t) => ({ id: t, label: t })),
                defaultValue: "ET",
                showWhen: { fieldKey: "tier", fieldValue: "paid" },
              },
              {
                key: "version",
                label: "Couchbase Server version (optional)",
                kind: "text",
                required: false,
                placeholder: "Latest",
                showWhen: { fieldKey: "tier", fieldValue: "paid" },
              },
            ],
          };
        case T.appService:
          return {
            fields: [
              ...(await this.clusterField(parentResourceId)),
              { key: "name", label: "Name", kind: "text", required: true },
              { key: "description", label: "Description", kind: "text", required: false },
              {
                key: "nodes",
                label: "Nodes",
                kind: "number",
                required: true,
                minValue: 2,
                maxValue: 12,
                defaultValue: "2",
              },
              {
                key: "compute",
                label: "Node size",
                kind: "select",
                required: true,
                options: APP_SERVICE_COMPUTE,
                defaultValue: "2/4",
              },
            ],
          };
        case T.bucket:
          return {
            fields: [
              ...(await this.clusterField(parentResourceId, true)),
              {
                key: "name",
                label: "Name",
                kind: "text",
                required: true,
                description:
                  "Up to 100 letters, digits, periods, underscores, percent signs and hyphens.",
              },
              {
                key: "type",
                label: "Type",
                kind: "select",
                required: false,
                options: [
                  { id: "couchbase", label: "Couchbase (persistent)" },
                  { id: "ephemeral", label: "Ephemeral (memory only)" },
                ],
                defaultValue: "couchbase",
              },
              {
                key: "storageBackend",
                label: "Storage backend",
                kind: "select",
                required: false,
                options: [
                  { id: "couchstore", label: "Couchstore" },
                  { id: "magma", label: "Magma" },
                ],
                defaultValue: "couchstore",
                showWhen: { fieldKey: "type", fieldValue: "couchbase" },
              },
              {
                key: "memoryAllocationInMb",
                label: "Memory quota (MB)",
                kind: "number",
                required: true,
                minValue: 100,
                defaultValue: "100",
              },
              {
                key: "replicas",
                label: "Replicas",
                kind: "select",
                required: false,
                options: ["1", "2", "3"].map((r) => ({ id: r, label: r })),
                defaultValue: "1",
              },
              {
                key: "durabilityLevel",
                label: "Minimum durability",
                kind: "select",
                required: false,
                options: ["none", "majority", "majorityAndPersistActive", "persistToMajority"].map(
                  (d) => ({ id: d, label: d }),
                ),
                defaultValue: "none",
              },
              {
                key: "timeToLiveInSeconds",
                label: "Max TTL (seconds, 0 for none)",
                kind: "number",
                required: false,
                minValue: 0,
                defaultValue: "0",
              },
              {
                key: "flushEnabled",
                label: "Allow flush",
                kind: "select",
                required: false,
                options: [
                  { id: "false", label: "No" },
                  { id: "true", label: "Yes" },
                ],
                defaultValue: "false",
              },
            ],
          };
        case T.scope:
          return { fields: [{ key: "name", label: "Name", kind: "text", required: true }] };
        case T.collection:
          return {
            fields: [
              { key: "name", label: "Name", kind: "text", required: true },
              {
                key: "maxTTL",
                label: "Max TTL (seconds)",
                kind: "number",
                required: false,
                minValue: -1,
                defaultValue: "0",
                description: "0 inherits the bucket's TTL; -1 never expires.",
              },
            ],
          };
        case T.credential: {
          let buckets: Array<{ id: string; label: string }> = [];
          if (parentResourceId) {
            const [p, c] = this.parentCluster({}, parentResourceId);
            buckets = (
              await this.bucketsOf({
                projectId: p,
                clusterId: c,
                free: this.freeTier.get(c) === true,
              })
            ).map((b) => ({
              id: b.name ?? b.id,
              label: b.name ?? b.id,
            }));
          }
          return {
            fields: [
              ...(await this.clusterField(parentResourceId)),
              { key: "name", label: "Username", kind: "text", required: true },
              {
                key: "access",
                label: "Access",
                kind: "select",
                required: true,
                options: [
                  { id: "read", label: "Read" },
                  { id: "write", label: "Read and write" },
                ],
                defaultValue: "write",
              },
              buckets.length
                ? {
                    key: "buckets",
                    label: "Buckets",
                    kind: "policy-picker",
                    required: false,
                    policies: buckets,
                    description: "Leave empty for every bucket.",
                  }
                : {
                    key: "buckets",
                    label: "Buckets",
                    kind: "string-list",
                    required: false,
                    description: "Leave empty for every bucket.",
                  },
              {
                key: "password",
                label: "Password (optional)",
                kind: "password",
                required: false,
                description: "Blank generates one; Infrawrench keeps it either way.",
              },
            ],
          };
        }
        case T.cidr:
          return {
            fields: [
              ...(await this.clusterField(parentResourceId)),
              {
                key: "cidr",
                label: "CIDR",
                kind: "text",
                required: true,
                placeholder: "203.0.113.0/24",
              },
              { key: "comment", label: "Comment", kind: "text", required: false },
              { key: "expiresAt", label: "Expires (optional)", kind: "datetime", required: false },
            ],
          };
        case T.user: {
          const projects = (await this.projects()).map((p) => ({
            id: p.id,
            label: p.name ?? p.id,
          }));
          return {
            fields: [
              { key: "email", label: "Email", kind: "text", required: true },
              { key: "name", label: "Name", kind: "text", required: false },
              {
                key: "organizationRoles",
                label: "Organization roles",
                kind: "policy-picker",
                required: true,
                policies: ORG_ROLES.map((r) => ({ id: r, label: r })),
                defaultValue: JSON.stringify(["organizationMember"]),
              },
              {
                key: "projectId",
                label: "Project (optional)",
                kind: "select",
                required: false,
                options: [{ id: "", label: "None" }, ...projects],
                defaultValue: "",
              },
              {
                key: "projectRoles",
                label: "Project roles",
                kind: "policy-picker",
                required: false,
                policies: PROJECT_ROLES.map((r) => ({ id: r, label: r })),
              },
            ],
          };
        }
        case T.apiKey: {
          const projects = (await this.projects()).map((p) => ({
            id: p.id,
            label: p.name ?? p.id,
          }));
          return {
            fields: [
              { key: "name", label: "Name", kind: "text", required: true },
              { key: "description", label: "Description", kind: "text", required: false },
              {
                key: "organizationRoles",
                label: "Organization roles",
                kind: "policy-picker",
                required: true,
                policies: ORG_ROLES.map((r) => ({ id: r, label: r })),
                defaultValue: JSON.stringify(["organizationMember"]),
              },
              {
                key: "projectId",
                label: "Project (optional)",
                kind: "select",
                required: false,
                options: [{ id: "", label: "None" }, ...projects],
                defaultValue: "",
              },
              {
                key: "projectRoles",
                label: "Project roles",
                kind: "policy-picker",
                required: false,
                policies: PROJECT_ROLES.map((r) => ({ id: r, label: r })),
              },
              {
                key: "allowedCidrs",
                label: "Allowed CIDRs",
                kind: "string-list",
                required: true,
                defaultValue: "0.0.0.0/0",
                description: "Where the key may be used from.",
              },
              {
                key: "expiry",
                label: "Expires after (days)",
                kind: "number",
                required: false,
                minValue: 1,
                maxValue: 365,
                defaultValue: "180",
              },
            ],
          };
        }
        default:
          throw new Error(`Capella plugin: creating "${typeId}" is not supported`);
      }
    });
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): PluginEffect<ResourceInstance | ResourceCreateResult> {
    return attempt(async () => {
      this.invalidate();
      switch (typeId) {
        case T.project: {
          const res = await this.api.post(`${this.org}/projects`, {
            body: {
              name: (fields["name"] ?? "").trim(),
              description: fields["description"] || undefined,
            },
          });
          return mapProject(accountId, {
            id: res.id,
            name: fields["name"] ?? "",
            description: fields["description"] ?? "",
          });
        }
        case T.cluster: {
          const projectId = parentResourceId
            ? externalIdOf(parentResourceId)
            : (fields["projectId"] ?? "");
          if (!projectId) throw new Error("Pick a project.");
          const cloud = fields["cloud"] || "aws";
          const cloudProvider = {
            type: cloud,
            region: fields["region"] ?? "",
            ...(fields["cidr"] ? { cidr: fields["cidr"].trim() } : {}),
          };
          const name = (fields["name"] ?? "").trim();
          if (fields["tier"] === "free") {
            const res = await this.api.post(`${this.projectPath(projectId)}/clusters/freeTier`, {
              body: { name, cloudProvider },
            });
            return mapCluster(accountId, projectId, {
              id: res.id,
              name,
              currentState: "deploying",
              cloudProvider,
              support: { plan: "free" },
            });
          }
          const compute = parseCompute(fields["compute"] ?? "");
          if (!compute) throw new Error("Pick a node size.");
          const services = csv(fields["services"]);
          if (!services.includes("data")) throw new Error("A cluster needs the data service.");
          const group = {
            node: { compute, disk: defaultDisk(cloud, int(fields["storage"] || "50", "Disk", 50)) },
            numOfNodes: int(fields["nodes"], "Nodes", 1, 27),
            services,
          };
          const res = await this.api.post(`${this.projectPath(projectId)}/clusters`, {
            body: {
              name,
              cloudProvider,
              serviceGroups: [group],
              availability: { type: fields["availability"] || "multi" },
              support: {
                plan: fields["supportPlan"] || "developer pro",
                ...(fields["timezone"] ? { timezone: fields["timezone"] } : {}),
              },
              couchbaseServer: fields["version"]
                ? { version: fields["version"].trim() }
                : undefined,
            },
          });
          return mapCluster(accountId, projectId, {
            id: res.id,
            name,
            currentState: "deploying",
            cloudProvider,
            serviceGroups: [group],
          });
        }
        case T.appService: {
          const [p, c] = this.parentCluster(fields, parentResourceId);
          const compute = parseCompute(fields["compute"] ?? "2/4");
          const res = await this.api.post(`${this.sub(p, c)}/appservices`, {
            body: {
              name: (fields["name"] ?? "").trim(),
              description: fields["description"] || undefined,
              nodes: int(fields["nodes"] || "2", "Nodes", 2, 12),
              compute: compute ?? undefined,
            },
          });
          return mapAppService(accountId, p, {
            id: res.id,
            name: fields["name"] ?? "",
            clusterId: c,
            currentState: "deploying",
          });
        }
        case T.bucket: {
          const [p, c] = this.parentCluster(fields, parentResourceId);
          await this.clustersOf(p);
          const free = this.freeTier.get(c) === true;
          const name = (fields["name"] ?? "").trim();
          const memoryAllocationInMb = int(
            fields["memoryAllocationInMb"] || "100",
            "Memory quota",
            100,
          );
          if (free) {
            const res = await this.api.post(`${this.sub(p, c)}/buckets/freeTier`, {
              body: { name, memoryAllocationInMb },
            });
            return mapBucket(accountId, p, c, { id: res.id, name });
          }
          const body: CapellaBody<"postBucket"> = { name, memoryAllocationInMb };
          if (fields["type"]) body["type"] = fields["type"];
          if (fields["storageBackend"] && fields["type"] !== "ephemeral")
            body["storageBackend"] = fields["storageBackend"];
          if (fields["replicas"]) body["replicas"] = Number(fields["replicas"]);
          if (fields["durabilityLevel"]) body["durabilityLevel"] = fields["durabilityLevel"];
          if (fields["timeToLiveInSeconds"])
            body["timeToLiveInSeconds"] = Number(fields["timeToLiveInSeconds"]);
          const flushEnabled = boolish(fields["flushEnabled"]);
          if (flushEnabled !== undefined) body["flushEnabled"] = flushEnabled;
          const res = await this.api.post(`${this.sub(p, c)}/buckets`, { body });
          return mapBucket(accountId, p, c, { id: res.id, name });
        }
        case T.scope: {
          if (!parentResourceId) throw new Error("Create scopes from a bucket's page.");
          const [p, c, b] = splitId(externalIdOf(parentResourceId), 3);
          const name = (fields["name"] ?? "").trim();
          await this.api.post(`${this.sub(p, c)}/buckets/${pathEncode(b)}/scopes`, {
            body: { name },
          });
          return instance(
            accountId,
            T.scope,
            joinId(p, c, b, name),
            name,
            compact({ name, collections: 0 }),
            {
              typeId: T.bucket,
              externalId: joinId(p, c, b),
            },
          );
        }
        case T.collection: {
          if (!parentResourceId) throw new Error("Create collections from a scope's page.");
          const [p, c, b, s] = splitId(externalIdOf(parentResourceId), 4);
          const name = (fields["name"] ?? "").trim();
          await this.api.post(
            `${this.sub(p, c)}/buckets/${pathEncode(b)}/scopes/${pathEncode(s)}/collections`,
            { body: { name, maxTTL: fields["maxTTL"] ? Number(fields["maxTTL"]) : undefined } },
          );
          return instance(
            accountId,
            T.collection,
            joinId(p, c, b, s, name),
            name,
            compact({ name, scope: s, maxTTL: fields["maxTTL"] }),
            {
              typeId: T.scope,
              externalId: joinId(p, c, b, s),
            },
          );
        }
        case T.credential: {
          const [p, c] = this.parentCluster(fields, parentResourceId);
          const buckets = csv(fields["buckets"]);
          const password = fields["password"]?.trim() || generatePassword();
          const res = await this.api.post(`${this.sub(p, c)}/users`, {
            body: {
              name: (fields["name"] ?? "").trim(),
              password,
              credentialType: "basic",
              access: [
                {
                  privileges:
                    fields["access"] === "read" ? ["data_reader"] : ["data_reader", "data_writer"],
                  ...(buckets.length
                    ? { resources: { buckets: buckets.map((name) => ({ name })) } }
                    : {}),
                },
              ],
            },
          });
          const r = mapCredential(accountId, p, c, { id: res.id, name: fields["name"] ?? "" });
          await this.services?.secrets?.setPlaintext?.(
            r.id,
            PASSWORD_SECRET,
            res.password || password,
          );
          return r;
        }
        case T.cidr: {
          const [p, c] = this.parentCluster(fields, parentResourceId);
          const cidr = (fields["cidr"] ?? "").trim();
          const res = await this.api.post(`${this.sub(p, c)}/allowedcidrs`, {
            body: {
              cidr,
              comment: fields["comment"] || undefined,
              expiresAt: fields["expiresAt"] || undefined,
            },
          });
          return mapCidr(accountId, p, c, {
            id: res.id,
            cidr,
            comment: fields["comment"] ?? "",
            status: "active",
          });
        }
        case T.user: {
          const email = (fields["email"] ?? "").trim();
          const roles = csv(fields["organizationRoles"]);
          const projectRoles = csv(fields["projectRoles"]);
          const res = await this.api.post(`${this.org}/users`, {
            body: {
              email,
              name: fields["name"] || undefined,
              organizationRoles: roles.length ? roles : ["organizationMember"],
              resources:
                fields["projectId"] && projectRoles.length
                  ? [{ type: "project", id: fields["projectId"], roles: projectRoles }]
                  : undefined,
            },
          });
          return mapUser(
            accountId,
            { id: res?.id ?? email, email, status: "not-verified", organizationRoles: roles },
            await this.projectNames(),
          );
        }
        case T.apiKey: {
          const roles = csv(fields["organizationRoles"]);
          const projectRoles = csv(fields["projectRoles"]);
          const res = await this.api.post(`${this.org}/apikeys`, {
            body: {
              name: (fields["name"] ?? "").trim(),
              description: fields["description"] || undefined,
              organizationRoles: roles.length ? roles : ["organizationMember"],
              resources:
                fields["projectId"] && projectRoles.length
                  ? [{ type: "project", id: fields["projectId"], roles: projectRoles }]
                  : undefined,
              allowedCIDRs: csv(fields["allowedCidrs"]).length
                ? csv(fields["allowedCidrs"])
                : ["0.0.0.0/0"],
              expiry: fields["expiry"] ? Number(fields["expiry"]) : undefined,
            },
          });
          const r = mapApiKey(
            accountId,
            { id: res.id, name: fields["name"] ?? "", organizationRoles: roles },
            await this.projectNames(),
          );
          r.resolvedOutputs["token"] = res.token;
          return {
            resource: r,
            warnings: [
              {
                code: "token-shown-once",
                message:
                  "Copy the API key's token from its outputs now: Capella will not show it again.",
              },
            ],
          };
        }
        default:
          throw new Error(`Capella plugin: creating "${typeId}" is not supported`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Update / delete
  // -------------------------------------------------------------------------

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const ext = externalIdOf(resourceId);
      this.invalidate();
      switch (typeId) {
        case T.project: {
          const current = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
          await this.api.put(this.projectPath(ext), {
            body: {
              name: fields["name"] ?? current.fields["name"],
              description: fields["description"] ?? current.fields["description"] ?? "",
            },
          });
          break;
        }
        case T.cluster: {
          const [p, c] = splitId(ext, 2);
          await this.clustersOf(p);
          const cluster = await this.api.get(this.clusterPath(p, c));
          if (fields["deletionProtection"] !== undefined) {
            await this.api.put(`${this.sub(p, c)}/deletionProtection`, {
              body: { deletionProtection: boolish(fields["deletionProtection"]) ?? false },
            });
          }
          const touched = [
            "name",
            "description",
            "supportPlan",
            "supportTimezone",
            "nodes",
            "compute",
          ].some((k) => fields[k] !== undefined);
          if (touched) {
            if (isFreeTier(cluster)) {
              await this.api.put(this.clusterPath(p, c), {
                body: {
                  name: fields["name"] ?? cluster.name,
                  description: fields["description"] ?? cluster.description ?? "",
                },
              });
            } else {
              const groups = (cluster.serviceGroups ?? []).map((g) => ({ ...g }));
              const idx = Math.max(
                0,
                groups.findIndex((g) => g.services?.includes("data")),
              );
              const g = groups[idx];
              if (g && (fields["nodes"] !== undefined || fields["compute"] !== undefined)) {
                if (fields["nodes"]) g.numOfNodes = int(fields["nodes"], "Nodes", 1, 27);
                if (fields["compute"]) {
                  const compute = parseCompute(fields["compute"]);
                  if (!compute) throw new Error("Pick a node size from the list.");
                  g.node = { ...g.node, compute };
                }
              }
              await this.api.put(this.clusterPath(p, c), {
                body: {
                  name: fields["name"] ?? cluster.name,
                  description: fields["description"] ?? cluster.description ?? "",
                  support: {
                    plan: fields["supportPlan"] ?? cluster.support?.plan,
                    ...((fields["supportTimezone"] ?? cluster.support?.timezone)
                      ? { timezone: fields["supportTimezone"] ?? cluster.support?.timezone }
                      : {}),
                  },
                  serviceGroups: groups,
                },
              });
            }
          }
          break;
        }
        case T.appService: {
          const [p, c, a] = splitId(ext, 3);
          const current = (await this.appServices()).find((x) => x.id === a);
          if (!current) throw notFound(`App Service ${a}`);
          const compute = fields["compute"] ? parseCompute(fields["compute"]) : current.compute;
          await this.api.put(`${this.sub(p, c)}/appservices/${pathEncode(a)}`, {
            body: {
              nodes: fields["nodes"] ? int(fields["nodes"], "Nodes", 2, 12) : current.nodes,
              compute,
            },
          });
          break;
        }
        case T.bucket: {
          const [p, c, b] = splitId(ext, 3);
          await this.clustersOf(p);
          const free = this.freeTier.get(c) === true;
          const current = (await this.bucketsOf({ projectId: p, clusterId: c, free })).find(
            (x) => x.id === b,
          );
          if (!current) throw notFound(`bucket ${b}`);
          if (free) {
            await this.api.put(`${this.sub(p, c)}/buckets/freeTier/${pathEncode(b)}`, {
              body: {
                memoryAllocationInMb: fields["memoryAllocationInMb"]
                  ? Number(fields["memoryAllocationInMb"])
                  : current.memoryAllocationInMb,
              },
            });
          } else {
            await this.api.put(`${this.sub(p, c)}/buckets/${pathEncode(b)}`, {
              body: {
                memoryAllocationInMb: fields["memoryAllocationInMb"]
                  ? int(fields["memoryAllocationInMb"], "Memory quota", 100)
                  : current.memoryAllocationInMb,
                durabilityLevel: fields["durabilityLevel"] ?? current.durabilityLevel,
                replicas: fields["replicas"] ? Number(fields["replicas"]) : current.replicas,
                timeToLiveInSeconds:
                  fields["timeToLiveInSeconds"] !== undefined &&
                  fields["timeToLiveInSeconds"] !== ""
                    ? Number(fields["timeToLiveInSeconds"])
                    : (current.timeToLiveInSeconds ?? 0),
                flushEnabled:
                  boolish(fields["flushEnabled"]) ?? current.flushEnabled ?? current.flush ?? false,
              },
            });
          }
          break;
        }
        case T.collection: {
          const [p, c, b, s, name] = splitId(ext, 5);
          if (fields["maxTTL"] !== undefined && fields["maxTTL"] !== "") {
            await this.api.put(
              `${this.sub(p, c)}/buckets/${pathEncode(b)}/scopes/${pathEncode(s)}/collections/${pathEncode(name)}`,
              { body: { maxTTL: Number(fields["maxTTL"]) } },
            );
          }
          break;
        }
        case T.credential:
          if (fields["password"]) await this.resetPassword(resourceId, fields["password"]);
          break;
        default:
          throw new Error(`Capella plugin: updating "${typeId}" is not supported`);
      }
      this.invalidate();
      return runPluginEffect(this.getResource(typeId, resourceId, accountId));
    });
  }

  private async resetPassword(resourceId: string, requested: string) {
    const [p, c, id] = splitId(externalIdOf(resourceId), 3);
    const password = requested.trim() || generatePassword();
    await this.api.put(`${this.sub(p, c)}/users/${pathEncode(id)}`, { body: { password } });
    await this.services?.secrets?.setPlaintext?.(resourceId, PASSWORD_SECRET, password);
    return { ok: true, message: "Password reset. The connection string output uses the new one." };
  }

  deleteResource(typeId: string, resourceId: string, _accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const ext = externalIdOf(resourceId);
      this.invalidate();
      const three = () => splitId(ext, 3);
      switch (typeId) {
        case T.project:
          await this.api.delete(this.projectPath(ext));
          return;
        case T.cluster: {
          const [p, c] = splitId(ext, 2);
          await this.clustersOf(p);
          await this.api.delete(this.clusterPath(p, c));
          return;
        }
        case T.appService: {
          const [p, c, a] = three();
          await this.api.delete(`${this.sub(p, c)}/appservices/${pathEncode(a)}`);
          return;
        }
        case T.bucket: {
          const [p, c, b] = three();
          await this.clustersOf(p);
          await this.api.delete(
            this.freeTier.get(c)
              ? `${this.sub(p, c)}/buckets/freeTier/${pathEncode(b)}`
              : `${this.sub(p, c)}/buckets/${pathEncode(b)}`,
          );
          return;
        }
        case T.scope: {
          const [p, c, b, s] = splitId(ext, 4);
          await this.api.delete(
            `${this.sub(p, c)}/buckets/${pathEncode(b)}/scopes/${pathEncode(s)}`,
          );
          return;
        }
        case T.collection: {
          const [p, c, b, s, n] = splitId(ext, 5);
          await this.api.delete(
            `${this.sub(p, c)}/buckets/${pathEncode(b)}/scopes/${pathEncode(s)}/collections/${pathEncode(n)}`,
          );
          return;
        }
        case T.credential: {
          const [p, c, id] = three();
          await this.api.delete(`${this.sub(p, c)}/users/${pathEncode(id)}`);
          return;
        }
        case T.cidr: {
          const [p, c, id] = three();
          await this.api.delete(`${this.sub(p, c)}/allowedcidrs/${pathEncode(id)}`);
          return;
        }
        case T.backup: {
          const [p, c, id] = three();
          await this.api.delete(`${this.sub(p, c)}/backups/${pathEncode(id)}`);
          return;
        }
        case T.replication: {
          const [p, c, id] = three();
          await this.api.delete(`${this.sub(p, c)}/replications/${pathEncode(id)}`);
          return;
        }
        case T.networkPeer: {
          const [p, c, id] = three();
          await this.api.delete(`${this.sub(p, c)}/networkPeers/${pathEncode(id)}`);
          return;
        }
        case T.user:
          await this.api.delete(`${this.org}/users/${pathEncode(ext)}`);
          return;
        case T.apiKey:
          await this.api.delete(`${this.org}/apikeys/${pathEncode(ext)}`);
          return;
        default:
          throw new Error(`Capella plugin: deleting "${typeId}" is not supported`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      const ext = externalIdOf(resourceId);
      this.invalidate();
      if (typeId === T.cluster && (actionId === "turn-on" || actionId === "turn-off")) {
        const [p, c] = splitId(ext, 2);
        await this.clustersOf(p);
        if (actionId === "turn-on") {
          await this.api.post(
            `${this.clusterPath(p, c)}/activationState`,
            this.freeTier.get(c) ? {} : { body: { turnOnLinkedAppService: true } },
          );
        } else {
          await this.api.delete(`${this.clusterPath(p, c)}/activationState`);
        }
        return;
      }
      if (typeId === T.cluster && actionId === "remove-schedule") {
        const [p, c] = splitId(ext, 2);
        await this.api.delete(`${this.sub(p, c)}/onOffSchedule`);
        return;
      }
      if (typeId === T.appService && (actionId === "turn-on" || actionId === "turn-off")) {
        const [p, c, a] = splitId(ext, 3);
        const path = `${this.sub(p, c)}/appservices/${pathEncode(a)}/activationState` as const;
        await (actionId === "turn-on" ? this.api.post(path) : this.api.delete(path));
        return;
      }
      if (typeId === T.bucket && (actionId === "flush" || actionId === "backup")) {
        const [p, c, b] = splitId(ext, 3);
        if (actionId === "flush")
          await this.api.put(`${this.sub(p, c)}/buckets/${pathEncode(b)}/flush`);
        else await this.api.post(`${this.sub(p, c)}/buckets/${pathEncode(b)}/backups`);
        return;
      }
      if (typeId === T.replication && (actionId === "pause" || actionId === "resume")) {
        const [p, c, id] = splitId(ext, 3);
        const path = `${this.sub(p, c)}/replications/${pathEncode(id)}/activationStatus` as const;
        await (actionId === "resume" ? this.api.post(path) : this.api.delete(path));
        return;
      }
      if (actionId === "revoke" && (typeId === T.user || typeId === T.apiKey)) {
        await runPluginEffect(this.deleteResource(typeId, resourceId, accountId));
        return;
      }
      throw new Error(`Capella plugin: unknown action "${actionId}" for "${typeId}"`);
    });
  }

  executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): PluginEffect<unknown> {
    return attempt(async () => {
      const form = decodePromptArgs(args);
      const ext = externalIdOf(resourceId);
      this.invalidate();
      if (typeId === T.cluster) {
        const [p, c] = splitId(ext, 2);
        switch (command) {
          case "set-schedule": {
            const onDays = new Set(csv(form["days"]));
            const from = int(form["fromHour"], "Start hour", 0, 23);
            const to = int(form["toHour"], "End hour", 1, 24);
            if (to <= from) throw new Error("The off hour must be after the on hour.");
            const allDay = from === 0 && to === 24;
            const days = WEEK.map((day): components["schemas"]["Days"] =>
              !onDays.has(day)
                ? { day, state: "off" }
                : allDay
                  ? { day, state: "on" }
                  : {
                      day,
                      state: "custom",
                      from: { hour: from, minute: 0 },
                      to: { hour: to === 24 ? 0 : to, minute: 0 },
                    },
            );
            const body = { timezone: form["timezone"] || "US/Eastern", days };
            const path = `${this.sub(p, c)}/onOffSchedule` as const;
            try {
              await this.api.put(path, { body });
            } catch (err) {
              if (statusOf(err) !== 404) throw err;
              await this.api.post(path, { body });
            }
            return { ok: true, message: "Schedule saved." };
          }
          case "set-audit": {
            const current: Partial<CapellaResponse<"getClusterAuditSettings">> = await this.api
              .get(`${this.sub(p, c)}/auditLog`)
              .catch(() => ({}));
            await this.api.put(`${this.sub(p, c)}/auditLog`, {
              body: {
                auditEnabled: form["enabled"] === "true",
                disabledUsers: current.disabledUsers ?? [],
                enabledEventIDs: current.enabledEventIDs ?? [],
              },
            });
            return { ok: true, message: "Audit logging updated." };
          }
          case "load-sample":
            await this.api.post(`${this.sub(p, c)}/sampleBuckets`, {
              body: { name: form["name"] || "travel-sample" },
            });
            return { ok: true, message: "Sample bucket is loading." };
        }
      }
      if (typeId === T.bucket && command === "set-backup-schedule") {
        const [p, c, b] = splitId(ext, 3);
        const body: CapellaBody<"putBackupSchedule"> = {
          type: "weekly",
          weeklySchedule: {
            dayOfWeek: form["dayOfWeek"] || "sunday",
            startAt: int(form["startAt"] || "0", "Start hour", 0, 23),
            incrementalEvery: Number(form["incrementalEvery"] || 24),
            retentionTime: form["retentionTime"] || "30days",
            costOptimizedRetention: form["costOptimizedRetention"] === "true",
          },
        };
        const path = `${this.sub(p, c)}/buckets/${pathEncode(b)}/backup/schedules` as const;
        try {
          await this.api.put(path, { body });
        } catch (err) {
          if (statusOf(err) !== 404) throw err;
          await this.api.post(path, { body });
        }
        return { ok: true, message: "Backup schedule saved." };
      }
      if (typeId === T.backup && command === "restore") {
        const [p, c, id] = splitId(ext, 3);
        const [, target] = splitId(form["targetClusterId"] ?? "", 2);
        const services = csv(form["services"]);
        await this.api.post(`${this.sub(p, c)}/backups/${pathEncode(id)}/restore`, {
          body: {
            targetClusterID: target,
            sourceClusterID: c,
            backupID: id,
            services: services.length ? services : ["data"],
            forceUpdates: form["forceUpdates"] === "true",
          },
        });
        return { ok: true, message: "Restore started." };
      }
      if (typeId === T.credential && command === "reset-password") {
        return this.resetPassword(resourceId, form["password"] ?? "");
      }
      if (typeId === T.apiKey && command === "rotate") {
        const res = await this.api.post(`${this.org}/apikeys/${pathEncode(ext)}/rotate`, {
          body: {},
        });
        return { ok: true, message: `New token (shown once): ${res?.token ?? ""}` };
      }
      if (typeId === T.user && command === "set-roles") {
        const user = (
          await capellaList(`${this.org}/users`, (path, query) => this.api.get(path, { query }))
        ).find((u) => u.id === ext);
        if (!user) throw notFound(`user ${ext}`);
        const wanted = csv(form["organizationRoles"]);
        const current = user.organizationRoles ?? [];
        const ops: CapellaBody<"patchUser"> = [];
        const add = wanted.filter((r) => !current.includes(r));
        const remove = current.filter((r) => !wanted.includes(r));
        if (add.length) ops.push({ op: "add", path: "/organizationRoles", value: add });
        if (remove.length) ops.push({ op: "remove", path: "/organizationRoles", value: remove });
        const projectId = form["projectId"];
        if (projectId) {
          const roles = csv(form["projectRoles"]);
          const has = (user.resources ?? []).some((r) => r.id === projectId);
          if (!roles.length) {
            if (has) ops.push({ op: "remove", path: `/resources/${projectId}` });
          } else {
            if (has) ops.push({ op: "remove", path: `/resources/${projectId}` });
            ops.push({
              op: "add",
              path: `/resources/${projectId}`,
              value: { id: projectId, type: "project", roles },
            });
          }
        }
        if (!ops.length) return { ok: true, message: "Nothing changed." };
        await this.api.patch(`${this.org}/users/${pathEncode(ext)}`, { body: ops });
        return { ok: true, message: "Roles updated." };
      }
      throw new Error(`Capella plugin: command "${command}" is not supported for "${typeId}"`);
    });
  }

  // -------------------------------------------------------------------------
  // Observability
  // -------------------------------------------------------------------------

  fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      const now = Date.now();
      const point = (
        label: string,
        unit: string,
        value: ResourceInstance["fields"][string] | undefined,
      ): MetricSeries[] =>
        typeof value === "number" && Number.isFinite(value)
          ? [{ label, unit, points: [{ timestamp: now, value }] }]
          : [];
      if (resourceTypeId === T.cluster) {
        const r = await runPluginEffect(this.getResource(resourceTypeId, resourceId, accountId));
        const used = r.fields["memoryUsedMb"];
        const total = r.fields["memoryTotalMb"];
        return [
          ...point("Bucket memory allocated", "MB", used),
          ...point("Bucket memory available", "MB", total),
          ...(typeof used === "number" && typeof total === "number" && total > 0
            ? point("Bucket memory allocated (%)", "%", Math.round((used / total) * 1000) / 10)
            : []),
        ];
      }
      if (resourceTypeId === T.bucket) {
        const r = await runPluginEffect(this.getResource(resourceTypeId, resourceId, accountId));
        return [
          ...point("Items", "items", r.fields["itemCount"]),
          ...point("Ops/sec", "ops/s", r.fields["opsPerSecond"]),
          ...point("Disk used", "MiB", r.fields["diskUsedMib"]),
          ...point("Memory used", "MiB", r.fields["memoryUsedMib"]),
        ];
      }
      return [];
    });
  }

  fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<DashboardStat[]> {
    return attempt(async () => {
      const r = await runPluginEffect(this.getResource(resourceTypeId, resourceId, accountId));
      const f = r.fields;
      const s = String(f["state"] ?? f["status"] ?? "");
      const variant: DashboardStat["variant"] =
        s === "healthy"
          ? "status-healthy"
          : /failed|offline/.test(s)
            ? "status-error"
            : s
              ? "status-degraded"
              : "default";
      if (resourceTypeId === T.cluster) {
        return [
          { label: "State", value: s, variant },
          { label: "Nodes", value: String(f["totalNodes"] ?? "") },
          { label: "Region", value: String(f["region"] ?? "") },
          { label: "Version", value: String(f["version"] ?? "") },
        ];
      }
      if (resourceTypeId === T.bucket) {
        return [
          { label: "Items", value: String(f["itemCount"] ?? "") },
          { label: "Ops/sec", value: String(f["opsPerSecond"] ?? "") },
          {
            label: "Memory",
            value: `${f["memoryUsedMib"] ?? "?"} / ${f["memoryAllocationInMb"] ?? "?"} MB`,
          },
        ];
      }
      return [{ label: "Status", value: s || "Active", variant }];
    });
  }

  getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): PluginEffect<LogsFetchResult> {
    return attempt(async () => {
      const containers = ["All events", "Warnings and critical"];
      const active =
        params.container && containers.includes(params.container) ? params.container : "All events";
      const ext = externalIdOf(resourceId);
      const res = await this.api.get(`${this.org}/events`, {
        query: {
          sortBy: ["timestamp"],
          sortDirection: "desc",
          perPage: Math.min(Math.max(params.tailLines ?? 100, 1), 100),
          page: 1,
          ...(typeId === T.cluster ? { clusterIds: [splitId(ext, 2)[1]] } : {}),
          ...(typeId === T.project && ext ? { projectIds: [ext] } : {}),
          ...(active !== "All events" ? { severityLevels: SEVERE_EVENTS } : {}),
        },
      });
      const text = (res?.data ?? [])
        .slice()
        .reverse()
        .map(
          (e) =>
            `${(e.timestamp ?? "").replace("T", " ").replace(/(\.\d+)?Z$/, "")}  ${(e.severity ?? "").padEnd(8)}  ${e.key ?? ""}${e.summary ? `  ${e.summary}` : ""}${e.userEmail ? `  [${e.userEmail}]` : ""}\n`,
        )
        .join("");
      return { text: text || "No events.\n", containers, activeContainer: active };
    });
  }

  // -------------------------------------------------------------------------
  // Cost and credits
  // -------------------------------------------------------------------------

  /**
   * Billed spend per day and billing category. Clusters come from the
   * per-cluster itemized endpoint (resource = cluster id); everything the
   * clusters do not account for (App Services, analytics, AI services) is the
   * organization total minus the cluster rows, left without a resource.
   */
  fetchCostData(_accountId: string, range: CostFetchRange): PluginEffect<CostRow[]> {
    return attempt(async () => {
      const refs = (await this.clusterRefs()).filter((r) => !r.free);
      const rows: CostRow[] = [];
      const amountOf = (cat: { currencySpend?: number | null; creditSpend?: number | null }) =>
        typeof cat.currencySpend === "number"
          ? cat.currencySpend
          : typeof cat.creditSpend === "number"
            ? cat.creditSpend
            : 0;
      for (const chunk of billingChunks(range.fromDate, range.toDate)) {
        const body = { startDate: chunk.start, endDate: chunk.end };
        const clusterTotals = new Map<string, number>();
        for (const ref of refs) {
          const res = await this.api
            .post(`${this.sub(ref.projectId, ref.clusterId)}/billing`, {
              body,
            })
            .catch((err: unknown) => {
              if (isUnavailable(err)) return undefined;
              throw err;
            });
          const currency = res?.data?.billingCurrency ?? "USD";
          for (const period of res?.data?.periods ?? []) {
            const date = billingDay(period);
            for (const cat of period.categories ?? []) {
              const amount = amountOf(cat);
              if (!amount || !cat.category) continue;
              const key = `${date}|${cat.category}`;
              clusterTotals.set(key, (clusterTotals.get(key) ?? 0) + amount);
              rows.push({
                date,
                service: BILLING_CATEGORIES[cat.category] ?? cat.category,
                ...(ref.region ? { region: ref.region } : {}),
                resourceId: ref.clusterId,
                tags: { project: ref.projectId, ...(ref.name ? { cluster: ref.name } : {}) },
                currency,
                amount,
              });
            }
          }
        }
        let org: CapellaResponse<"categorizedBilling"> | undefined;
        try {
          org = await this.api.post(`${this.org}/billing`, { body });
        } catch (err) {
          const s = statusOf(err);
          if (s === 403) {
            throw new Error("Capella cost data needs an API key with the Organization Owner role.");
          }
          throw err;
        }
        const currency = org?.data?.billingCurrency ?? "USD";
        for (const period of org?.data?.periods ?? []) {
          const date = billingDay(period);
          for (const cat of period.categories ?? []) {
            if (!cat.category) continue;
            const rest = amountOf(cat) - (clusterTotals.get(`${date}|${cat.category}`) ?? 0);
            if (rest <= 0.005) continue;
            rows.push({
              date,
              service: BILLING_CATEGORIES[cat.category] ?? cat.category,
              currency,
              amount: Math.round(rest * 10000) / 10000,
            });
          }
        }
      }
      return rows.filter((r) => r.date >= range.fromDate && r.date <= range.toDate);
    });
  }

  fetchCreditBalance(_accountId: string): PluginEffect<CreditBalance[]> {
    return attempt(async () => {
      let credits: CapellaRow<"prepaidCreditsBilling">[];
      try {
        credits = await capellaList(`${this.org}/billing/prePaidCredits`, (path, query) =>
          this.api.get(path, { query }),
        );
      } catch (err) {
        if (statusOf(err) === 403) {
          throw new CreditAccessError(
            "Reading prepaid credits needs an API key with the Organization Owner role.",
          );
        }
        throw err;
      }
      return credits.map((c) => ({
        key: c.id,
        label: c.creditName ?? "Prepaid credits",
        remaining: c.remaining ?? 0,
        currency: "USD",
        ...(typeof c.total === "number" ? { granted: c.total } : {}),
        ...(c.expirationDate ? { expiresAt: c.expirationDate } : {}),
      }));
    });
  }
}
