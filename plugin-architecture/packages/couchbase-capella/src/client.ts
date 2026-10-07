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
  withMetricsCapability,
} from "@infrawrench/plugin-base";
import type { CapellaContext } from "./api.js";
import { capellaFetch, capellaList, isUnavailable, joinId, splitId, statusOf } from "./api.js";
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
import { ENRICH, renderCapellaDetail, renderCapellaSidebar } from "./render.js";
import { RESOURCE_TYPES, T } from "./resource-types.js";
import type {
  CpApiKey,
  CpAppService,
  CpBackup,
  CpBilling,
  CpBucket,
  CpCidr,
  CpCluster,
  CpCredential,
  CpProject,
  CpServiceGroup,
  CpUser,
} from "./types.js";

const CACHE_MS = 20_000;
export const PASSWORD_SECRET = "capellaCredentialPassword";

function csv(raw: string | undefined): string[] {
  const text = String(raw ?? "").trim();
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text) as unknown;
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
  const err = new Error(`Capella plugin: ${what} not found`) as Error & { status: number };
  err.status = 404;
  return err;
}

/** Month-aligned chunks: the billing API answers daily periods only within one month. */
export function monthChunks(from: string, to: string): Array<{ start: string; end: string }> {
  const out: Array<{ start: string; end: string }> = [];
  let cur = new Date(`${from}T00:00:00Z`);
  const last = new Date(`${to}T00:00:00Z`);
  while (cur <= last) {
    const monthEnd = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 0));
    const end = monthEnd < last ? monthEnd : last;
    out.push({ start: cur.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) });
    cur = new Date(end.getTime() + 86_400_000);
  }
  return out;
}

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
  private cache = new Map<string, { at: number; value: Promise<unknown> }>();
  private freeTier = new Map<string, boolean>();

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    const organizationId = (credentials["organizationId"] ?? "").trim();
    if (!apiKey) throw new Error("Capella plugin: missing apiKey credential");
    if (!organizationId) throw new Error("Capella plugin: missing organizationId credential");
    this.services = services;
    this.ctx = { apiKey, organizationId, ...(services?.http ? { http: services.http } : {}) };
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private cached<V>(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as Promise<V>;
    const value = load();
    this.cache.set(key, { at: Date.now(), value });
    value.catch(() => this.cache.delete(key));
    return value;
  }

  private invalidate(): void {
    this.cache.clear();
  }

  private get org(): string {
    return `/v4/organizations/${encodeURIComponent(this.ctx.organizationId)}`;
  }

  private projectPath(p: string): string {
    return `${this.org}/projects/${encodeURIComponent(p)}`;
  }

  /** `/clusters/{id}` or, for a free-tier cluster, `/clusters/freeTier/{id}`. */
  private clusterPath(p: string, c: string, freeTierAware = true): string {
    const free = freeTierAware && this.freeTier.get(c) === true;
    return `${this.projectPath(p)}/clusters/${free ? "freeTier/" : ""}${encodeURIComponent(c)}`;
  }

  /** Paths below a cluster (buckets, users, …) always use the plain cluster path. */
  private sub(p: string, c: string): string {
    return this.clusterPath(p, c, false);
  }

  private req<V>(
    method: string,
    path: string,
    body?: unknown,
    query?: Array<[string, string | number | undefined]>,
  ) {
    return capellaFetch<V>(this.ctx, method, path, body, query);
  }

  private async optional<V>(load: () => Promise<V>, fallback: V): Promise<V> {
    try {
      return await load();
    } catch (err) {
      if (isUnavailable(err)) return fallback;
      throw err;
    }
  }

  projects(): Promise<CpProject[]> {
    return this.cached("projects", () => capellaList<CpProject>(this.ctx, `${this.org}/projects`));
  }

  private async projectNames(): Promise<Map<string, string>> {
    return new Map((await this.projects()).map((p) => [p.id, p.name ?? p.id]));
  }

  clustersOf(projectId: string): Promise<CpCluster[]> {
    return this.cached(`clusters-${projectId}`, async () => {
      const list = await this.optional(
        () => capellaList<CpCluster>(this.ctx, `${this.projectPath(projectId)}/clusters`),
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

  private bucketsOf(ref: ClusterRef): Promise<CpBucket[]> {
    return this.cached(`buckets-${ref.clusterId}`, () =>
      this.optional(
        async () =>
          (
            await this.req<{ data?: CpBucket[] }>(
              "GET",
              `${this.sub(ref.projectId, ref.clusterId)}/buckets${ref.free ? "/freeTier" : ""}`,
            )
          )?.data ?? [],
        [],
      ),
    );
  }

  private appServices(): Promise<CpAppService[]> {
    return this.cached("app-services", () =>
      this.optional(() => capellaList<CpAppService>(this.ctx, `${this.org}/appservices`), []),
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
        load(r).catch((err: unknown) => {
          if (statusOf(err) === 401) throw err;
          if (isUnavailable(err)) return [] as V[];
          throw err;
        }),
      ),
    );
    return lists.flat();
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    const list = await this.listRaw(typeId, accountId);
    // The organization id rides along so Terraform import ids can name it.
    for (const r of list) r.fields["organizationId"] = this.ctx.organizationId;
    return list;
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
            const res = await this.optional(
              () =>
                this.req<{
                  scopes?: Array<{
                    name?: string;
                    collections?: Array<{ name?: string; maxTTL?: number }>;
                  }>;
                }>(
                  "GET",
                  `${this.sub(r.projectId, r.clusterId)}/buckets/${encodeURIComponent(b.id)}/scopes`,
                ),
              {},
            );
            for (const s of res.scopes ?? []) {
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
              await capellaList<CpCredential>(
                this.ctx,
                `${this.sub(r.projectId, r.clusterId)}/users`,
              )
            ).map((c) => mapCredential(accountId, r.projectId, r.clusterId, c)),
          false,
        );
      case T.cidr:
        return this.perCluster(
          async (r) =>
            (
              await capellaList<CpCidr>(
                this.ctx,
                `${this.sub(r.projectId, r.clusterId)}/allowedcidrs`,
              )
            ).map((c) => mapCidr(accountId, r.projectId, r.clusterId, c)),
          false,
        );
      case T.backup:
        return this.perCluster(
          async (r) =>
            (
              (
                await this.req<{ data?: CpBackup[] }>(
                  "GET",
                  `${this.sub(r.projectId, r.clusterId)}/backups`,
                )
              )?.data ?? []
            )
              .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")))
              .slice(0, 50)
              .map((b) => mapBackup(accountId, r.projectId, r.clusterId, b)),
          false,
        );
      case T.replication:
        return this.perCluster(
          async (r) =>
            (
              await capellaList<{
                id: string;
                sourceCluster?: string;
                targetCluster?: string;
                status?: string;
                direction?: string;
                audit?: { createdAt?: string; createdBy?: string };
              }>(this.ctx, `${this.sub(r.projectId, r.clusterId)}/replications`)
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
              await capellaList<{
                id: string;
                name?: string;
                status?: { state?: string; reasoning?: string };
                providerConfig?: Record<string, unknown>;
                audit?: { createdAt?: string; createdBy?: string };
              }>(this.ctx, `${this.sub(r.projectId, r.clusterId)}/networkPeers`)
            ).map((x) => {
              const cfg = (x.providerConfig ?? {}) as Record<
                string,
                Record<string, unknown> | undefined
              >;
              const inner = Object.values(cfg).find((v) => v && typeof v === "object") ?? cfg;
              return instance(
                accountId,
                T.networkPeer,
                joinId(r.projectId, r.clusterId, x.id),
                x.name ?? x.id,
                compact({
                  name: x.name,
                  state: x.status?.state,
                  reasoning: x.status?.reasoning,
                  peerDetails: Object.entries(inner as Record<string, unknown>)
                    .filter(([, v]) => typeof v === "string" || typeof v === "number")
                    .map(([k, v]) => `${k}=${v}`)
                    .join(", "),
                  createdAt: x.audit?.createdAt,
                  createdBy: x.audit?.createdBy,
                }),
                { typeId: T.cluster, externalId: joinId(r.projectId, r.clusterId) },
              );
            }),
          false,
        );
      case T.privateEndpoint:
        return this.perCluster(async (r) => {
          const res = await this.req<{
            privateEndpointDNS?: string;
            endpoints?: Array<{ id: string; serviceName?: string; status?: string }>;
          }>("GET", `${this.sub(r.projectId, r.clusterId)}/privateEndpointService/endpoints`);
          return (res?.endpoints ?? []).map((e) =>
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
          await this.optional(() => capellaList<CpUser>(this.ctx, `${this.org}/users`), [])
        ).map((u) => mapUser(accountId, u, names));
      }
      case T.apiKey: {
        const names = await this.projectNames();
        return (
          await this.optional(() => capellaList<CpApiKey>(this.ctx, `${this.org}/apikeys`), [])
        ).map((k) => mapApiKey(accountId, k, names));
      }
      default:
        throw new Error(`Capella plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const ext = externalIdOf(resourceId);
    if (typeId === T.cluster) {
      const [p, c] = splitId(ext, 2) as [string, string];
      await this.clustersOf(p);
      const cluster = await this.req<CpCluster>("GET", this.clusterPath(p, c));
      const stats = this.freeTier.get(c)
        ? undefined
        : await this.req<{ freeMemoryInMb?: number; totalMemoryInMb?: number }>(
            "GET",
            `${this.sub(p, c)}/stats`,
          ).catch(() => undefined);
      const r = mapCluster(accountId, p, cluster, stats);
      r.fields["organizationId"] = this.ctx.organizationId;
      return r;
    }
    const found = (await this.listResources(typeId, accountId)).find((r) => r.externalId === ext);
    if (!found) throw notFound(`${typeId} ${ext}`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const ext = externalIdOf(resourceId);
    if (typeId === T.cluster) {
      const [p, c] = splitId(ext, 2) as [string, string];
      if (outputKey === "connectionString") {
        await this.clustersOf(p);
        return (await this.req<CpCluster>("GET", this.clusterPath(p, c)))?.connectionString ?? "";
      }
      if (outputKey === "certificate") {
        return (
          (await this.req<{ certificate?: string }>("GET", `${this.sub(p, c)}/certificates`))
            ?.certificate ?? ""
        );
      }
    }
    if (typeId === T.credential) {
      const [p, c] = splitId(ext, 3) as [string, string, string];
      const cred = await this.getResource(typeId, resourceId, accountId);
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
          (await this.req<CpCluster>("GET", this.clusterPath(p, c)))?.connectionString ?? ""
        ).replace(/^couchbases?:\/\//, "");
        return `couchbases://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}`;
      }
    }
    throw new Error(`Capella plugin: cannot resolve "${outputKey}" for "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Detail
  // -------------------------------------------------------------------------

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const out: ResourceInstance = { ...resource, resolvedOutputs: { ...resource.resolvedOutputs } };
    const put = (key: string, value: unknown) => {
      if (value !== undefined) out.resolvedOutputs[key] = JSON.stringify(value);
    };
    const settle = async <V>(p: Promise<V>) => p.catch(() => undefined);
    const ext = resource.externalId ?? externalIdOf(resource.id);
    switch (resource.resourceTypeId) {
      case T.cluster: {
        if (resource.fields["freeTier"] === true) break;
        const [p, c] = splitId(ext, 2) as [string, string];
        const [schedule, audit] = await Promise.all([
          settle(this.req<unknown>("GET", `${this.sub(p, c)}/onOffSchedule`)),
          settle(this.req<unknown>("GET", `${this.sub(p, c)}/auditLog`)),
        ]);
        put(ENRICH.schedule, schedule);
        put(ENRICH.auditLog, audit);
        break;
      }
      case T.bucket: {
        const [p, c, b] = splitId(ext, 3) as [string, string, string];
        put(
          ENRICH.backupSchedule,
          await settle(
            this.req<unknown>(
              "GET",
              `${this.sub(p, c)}/buckets/${encodeURIComponent(b)}/backup/schedules`,
            ),
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
          (await this.projects().catch(() => [])).map((p) => ({ id: p.id, label: p.name ?? p.id })),
        );
        break;
    }
    return out;
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

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
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
        const projects = (await this.projects()).map((p) => ({ id: p.id, label: p.name ?? p.id }));
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
        const projects = (await this.projects()).map((p) => ({ id: p.id, label: p.name ?? p.id }));
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
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance | ResourceCreateResult> {
    this.invalidate();
    switch (typeId) {
      case T.project: {
        const res = await this.req<{ id: string }>("POST", `${this.org}/projects`, {
          name: (fields["name"] ?? "").trim(),
          ...(fields["description"] ? { description: fields["description"] } : {}),
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
          const res = await this.req<{ id: string }>(
            "POST",
            `${this.projectPath(projectId)}/clusters/freeTier`,
            { name, cloudProvider },
          );
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
        const group: CpServiceGroup = {
          node: { compute, disk: defaultDisk(cloud, int(fields["storage"] || "50", "Disk", 50)) },
          numOfNodes: int(fields["nodes"], "Nodes", 1, 27),
          services,
        };
        const res = await this.req<{ id: string }>(
          "POST",
          `${this.projectPath(projectId)}/clusters`,
          {
            name,
            cloudProvider,
            serviceGroups: [group],
            availability: { type: fields["availability"] || "multi" },
            support: {
              plan: fields["supportPlan"] || "developer pro",
              ...(fields["timezone"] ? { timezone: fields["timezone"] } : {}),
            },
            ...(fields["version"]
              ? { couchbaseServer: { version: fields["version"].trim() } }
              : {}),
          },
        );
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
        const res = await this.req<{ id: string }>("POST", `${this.sub(p, c)}/appservices`, {
          name: (fields["name"] ?? "").trim(),
          ...(fields["description"] ? { description: fields["description"] } : {}),
          nodes: int(fields["nodes"] || "2", "Nodes", 2, 12),
          ...(compute ? { compute } : {}),
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
        const body: Record<string, unknown> = {
          name: (fields["name"] ?? "").trim(),
          memoryAllocationInMb: int(fields["memoryAllocationInMb"] || "100", "Memory quota", 100),
        };
        if (!free) {
          if (fields["type"]) body["type"] = fields["type"];
          if (fields["storageBackend"] && fields["type"] !== "ephemeral")
            body["storageBackend"] = fields["storageBackend"];
          if (fields["replicas"]) body["replicas"] = Number(fields["replicas"]);
          if (fields["durabilityLevel"]) body["durabilityLevel"] = fields["durabilityLevel"];
          if (fields["timeToLiveInSeconds"])
            body["timeToLiveInSeconds"] = Number(fields["timeToLiveInSeconds"]);
          const flush = boolish(fields["flushEnabled"]);
          if (flush !== undefined) body["flush"] = flush;
        }
        const res = await this.req<{ id: string }>(
          "POST",
          `${this.sub(p, c)}/buckets${free ? "/freeTier" : ""}`,
          body,
        );
        return mapBucket(accountId, p, c, { id: res.id, name: String(body["name"]) });
      }
      case T.scope: {
        if (!parentResourceId) throw new Error("Create scopes from a bucket's page.");
        const [p, c, b] = splitId(externalIdOf(parentResourceId), 3) as [string, string, string];
        const name = (fields["name"] ?? "").trim();
        await this.req("POST", `${this.sub(p, c)}/buckets/${encodeURIComponent(b)}/scopes`, {
          name,
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
        const [p, c, b, s] = splitId(externalIdOf(parentResourceId), 4) as [
          string,
          string,
          string,
          string,
        ];
        const name = (fields["name"] ?? "").trim();
        const body: Record<string, unknown> = { name };
        if (fields["maxTTL"]) body["maxTTL"] = Number(fields["maxTTL"]);
        await this.req(
          "POST",
          `${this.sub(p, c)}/buckets/${encodeURIComponent(b)}/scopes/${encodeURIComponent(s)}/collections`,
          body,
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
        const res = await this.req<{ id: string; password?: string }>(
          "POST",
          `${this.sub(p, c)}/users`,
          {
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
        );
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
        const res = await this.req<{ id: string }>("POST", `${this.sub(p, c)}/allowedcidrs`, {
          cidr,
          ...(fields["comment"] ? { comment: fields["comment"] } : {}),
          ...(fields["expiresAt"] ? { expiresAt: fields["expiresAt"] } : {}),
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
        const res = await this.req<{ id?: string }>("POST", `${this.org}/users`, {
          email,
          ...(fields["name"] ? { name: fields["name"] } : {}),
          organizationRoles: roles.length ? roles : ["organizationMember"],
          ...(fields["projectId"] && projectRoles.length
            ? { resources: [{ type: "project", id: fields["projectId"], roles: projectRoles }] }
            : {}),
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
        const res = await this.req<{ id: string; token: string }>("POST", `${this.org}/apikeys`, {
          name: (fields["name"] ?? "").trim(),
          ...(fields["description"] ? { description: fields["description"] } : {}),
          organizationRoles: roles.length ? roles : ["organizationMember"],
          ...(fields["projectId"] && projectRoles.length
            ? { resources: [{ type: "project", id: fields["projectId"], roles: projectRoles }] }
            : {}),
          allowedCIDRs: csv(fields["allowedCidrs"]).length
            ? csv(fields["allowedCidrs"])
            : ["0.0.0.0/0"],
          ...(fields["expiry"] ? { expiry: Number(fields["expiry"]) } : {}),
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
    const ext = externalIdOf(resourceId);
    this.invalidate();
    switch (typeId) {
      case T.project: {
        const current = await this.getResource(typeId, resourceId, accountId);
        await this.req("PUT", this.projectPath(ext), {
          name: fields["name"] ?? current.fields["name"],
          description: fields["description"] ?? current.fields["description"] ?? "",
        });
        break;
      }
      case T.cluster: {
        const [p, c] = splitId(ext, 2) as [string, string];
        await this.clustersOf(p);
        const cluster = await this.req<CpCluster>("GET", this.clusterPath(p, c));
        if (fields["deletionProtection"] !== undefined) {
          await this.req("PUT", `${this.sub(p, c)}/deletionProtection`, {
            deletionProtection: boolish(fields["deletionProtection"]) ?? false,
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
            await this.req("PUT", this.clusterPath(p, c), {
              name: fields["name"] ?? cluster.name,
              description: fields["description"] ?? cluster.description ?? "",
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
            await this.req("PUT", this.clusterPath(p, c), {
              name: fields["name"] ?? cluster.name,
              description: fields["description"] ?? cluster.description ?? "",
              support: {
                plan: fields["supportPlan"] ?? cluster.support?.plan,
                ...((fields["supportTimezone"] ?? cluster.support?.timezone)
                  ? { timezone: fields["supportTimezone"] ?? cluster.support?.timezone }
                  : {}),
              },
              serviceGroups: groups,
            });
          }
        }
        break;
      }
      case T.appService: {
        const [p, c, a] = splitId(ext, 3) as [string, string, string];
        const current = (await this.appServices()).find((x) => x.id === a);
        if (!current) throw notFound(`App Service ${a}`);
        const compute = fields["compute"] ? parseCompute(fields["compute"]) : current.compute;
        await this.req("PUT", `${this.sub(p, c)}/appservices/${encodeURIComponent(a)}`, {
          nodes: fields["nodes"] ? int(fields["nodes"], "Nodes", 2, 12) : current.nodes,
          compute,
        });
        break;
      }
      case T.bucket: {
        const [p, c, b] = splitId(ext, 3) as [string, string, string];
        await this.clustersOf(p);
        const free = this.freeTier.get(c) === true;
        const current = (await this.bucketsOf({ projectId: p, clusterId: c, free })).find(
          (x) => x.id === b,
        );
        if (!current) throw notFound(`bucket ${b}`);
        if (free) {
          await this.req("PUT", `${this.sub(p, c)}/buckets/freeTier/${encodeURIComponent(b)}`, {
            memoryAllocationInMb: fields["memoryAllocationInMb"]
              ? Number(fields["memoryAllocationInMb"])
              : current.memoryAllocationInMb,
          });
        } else {
          await this.req("PUT", `${this.sub(p, c)}/buckets/${encodeURIComponent(b)}`, {
            memoryAllocationInMb: fields["memoryAllocationInMb"]
              ? int(fields["memoryAllocationInMb"], "Memory quota", 100)
              : current.memoryAllocationInMb,
            durabilityLevel: fields["durabilityLevel"] ?? current.durabilityLevel,
            replicas: fields["replicas"] ? Number(fields["replicas"]) : current.replicas,
            timeToLiveInSeconds:
              fields["timeToLiveInSeconds"] !== undefined && fields["timeToLiveInSeconds"] !== ""
                ? Number(fields["timeToLiveInSeconds"])
                : (current.timeToLiveInSeconds ?? 0),
            flushEnabled:
              boolish(fields["flushEnabled"]) ?? current.flushEnabled ?? current.flush ?? false,
          });
        }
        break;
      }
      case T.collection: {
        const [p, c, b, s, name] = splitId(ext, 5) as [string, string, string, string, string];
        if (fields["maxTTL"] !== undefined && fields["maxTTL"] !== "") {
          await this.req(
            "PUT",
            `${this.sub(p, c)}/buckets/${encodeURIComponent(b)}/scopes/${encodeURIComponent(s)}/collections/${encodeURIComponent(name)}`,
            {
              maxTTL: Number(fields["maxTTL"]),
            },
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
    return this.getResource(typeId, resourceId, accountId);
  }

  private async resetPassword(resourceId: string, requested: string) {
    const [p, c, id] = splitId(externalIdOf(resourceId), 3) as [string, string, string];
    const password = requested.trim() || generatePassword();
    await this.req("PUT", `${this.sub(p, c)}/users/${encodeURIComponent(id)}`, { password });
    await this.services?.secrets?.setPlaintext?.(resourceId, PASSWORD_SECRET, password);
    return { ok: true, message: "Password reset. The connection string output uses the new one." };
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const ext = externalIdOf(resourceId);
    this.invalidate();
    const three = () => splitId(ext, 3) as [string, string, string];
    switch (typeId) {
      case T.project:
        await this.req("DELETE", this.projectPath(ext));
        return;
      case T.cluster: {
        const [p, c] = splitId(ext, 2) as [string, string];
        await this.clustersOf(p);
        await this.req("DELETE", this.clusterPath(p, c));
        return;
      }
      case T.appService: {
        const [p, c, a] = three();
        await this.req("DELETE", `${this.sub(p, c)}/appservices/${encodeURIComponent(a)}`);
        return;
      }
      case T.bucket: {
        const [p, c, b] = three();
        await this.clustersOf(p);
        await this.req(
          "DELETE",
          `${this.sub(p, c)}/buckets/${this.freeTier.get(c) ? "freeTier/" : ""}${encodeURIComponent(b)}`,
        );
        return;
      }
      case T.scope: {
        const [p, c, b, s] = splitId(ext, 4) as [string, string, string, string];
        await this.req(
          "DELETE",
          `${this.sub(p, c)}/buckets/${encodeURIComponent(b)}/scopes/${encodeURIComponent(s)}`,
        );
        return;
      }
      case T.collection: {
        const [p, c, b, s, n] = splitId(ext, 5) as [string, string, string, string, string];
        await this.req(
          "DELETE",
          `${this.sub(p, c)}/buckets/${encodeURIComponent(b)}/scopes/${encodeURIComponent(s)}/collections/${encodeURIComponent(n)}`,
        );
        return;
      }
      case T.credential: {
        const [p, c, id] = three();
        await this.req("DELETE", `${this.sub(p, c)}/users/${encodeURIComponent(id)}`);
        return;
      }
      case T.cidr: {
        const [p, c, id] = three();
        await this.req("DELETE", `${this.sub(p, c)}/allowedcidrs/${encodeURIComponent(id)}`);
        return;
      }
      case T.backup: {
        const [p, c, id] = three();
        await this.req("DELETE", `${this.sub(p, c)}/backups/${encodeURIComponent(id)}`);
        return;
      }
      case T.replication: {
        const [p, c, id] = three();
        await this.req("DELETE", `${this.sub(p, c)}/replications/${encodeURIComponent(id)}`);
        return;
      }
      case T.networkPeer: {
        const [p, c, id] = three();
        await this.req("DELETE", `${this.sub(p, c)}/networkPeers/${encodeURIComponent(id)}`);
        return;
      }
      case T.user:
        await this.req("DELETE", `${this.org}/users/${encodeURIComponent(ext)}`);
        return;
      case T.apiKey:
        await this.req("DELETE", `${this.org}/apikeys/${encodeURIComponent(ext)}`);
        return;
      default:
        throw new Error(`Capella plugin: deleting "${typeId}" is not supported`);
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): Promise<void> {
    const ext = externalIdOf(resourceId);
    this.invalidate();
    if (typeId === T.cluster && (actionId === "turn-on" || actionId === "turn-off")) {
      const [p, c] = splitId(ext, 2) as [string, string];
      await this.clustersOf(p);
      if (actionId === "turn-on") {
        await this.req(
          "POST",
          `${this.clusterPath(p, c)}/activationState`,
          this.freeTier.get(c) ? undefined : { turnOnLinkedAppService: true },
        );
      } else {
        await this.req("DELETE", `${this.clusterPath(p, c)}/activationState`);
      }
      return;
    }
    if (typeId === T.cluster && actionId === "remove-schedule") {
      const [p, c] = splitId(ext, 2) as [string, string];
      await this.req("DELETE", `${this.sub(p, c)}/onOffSchedule`);
      return;
    }
    if (typeId === T.appService && (actionId === "turn-on" || actionId === "turn-off")) {
      const [p, c, a] = splitId(ext, 3) as [string, string, string];
      await this.req(
        actionId === "turn-on" ? "POST" : "DELETE",
        `${this.sub(p, c)}/appservices/${encodeURIComponent(a)}/activationState`,
      );
      return;
    }
    if (typeId === T.bucket && (actionId === "flush" || actionId === "backup")) {
      const [p, c, b] = splitId(ext, 3) as [string, string, string];
      if (actionId === "flush")
        await this.req("PUT", `${this.sub(p, c)}/buckets/${encodeURIComponent(b)}/flush`);
      else await this.req("POST", `${this.sub(p, c)}/buckets/${encodeURIComponent(b)}/backups`);
      return;
    }
    if (typeId === T.replication && (actionId === "pause" || actionId === "resume")) {
      const [p, c, id] = splitId(ext, 3) as [string, string, string];
      await this.req(
        actionId === "resume" ? "POST" : "DELETE",
        `${this.sub(p, c)}/replications/${encodeURIComponent(id)}/activationStatus`,
      );
      return;
    }
    if (actionId === "revoke" && (typeId === T.user || typeId === T.apiKey)) {
      await this.deleteResource(typeId, resourceId, accountId);
      return;
    }
    throw new Error(`Capella plugin: unknown action "${actionId}" for "${typeId}"`);
  }

  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const form = decodePromptArgs(args);
    const ext = externalIdOf(resourceId);
    this.invalidate();
    if (typeId === T.cluster) {
      const [p, c] = splitId(ext, 2) as [string, string];
      switch (command) {
        case "set-schedule": {
          const onDays = new Set(csv(form["days"]));
          const from = int(form["fromHour"], "Start hour", 0, 23);
          const to = int(form["toHour"], "End hour", 1, 24);
          if (to <= from) throw new Error("The off hour must be after the on hour.");
          const allDay = from === 0 && to === 24;
          const days = [
            "monday",
            "tuesday",
            "wednesday",
            "thursday",
            "friday",
            "saturday",
            "sunday",
          ].map((day) =>
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
          const path = `${this.sub(p, c)}/onOffSchedule`;
          try {
            await this.req("PUT", path, body);
          } catch (err) {
            if (statusOf(err) !== 404) throw err;
            await this.req("POST", path, body);
          }
          return { ok: true, message: "Schedule saved." };
        }
        case "set-audit": {
          const current = await this.req<{ disabledUsers?: unknown[]; enabledEventIDs?: number[] }>(
            "GET",
            `${this.sub(p, c)}/auditLog`,
          ).catch(() => ({}) as { disabledUsers?: unknown[]; enabledEventIDs?: number[] });
          await this.req("PUT", `${this.sub(p, c)}/auditLog`, {
            auditEnabled: form["enabled"] === "true",
            disabledUsers: current.disabledUsers ?? [],
            enabledEventIDs: current.enabledEventIDs ?? [],
          });
          return { ok: true, message: "Audit logging updated." };
        }
        case "load-sample":
          await this.req("POST", `${this.sub(p, c)}/sampleBuckets`, {
            name: form["name"] || "travel-sample",
          });
          return { ok: true, message: "Sample bucket is loading." };
      }
    }
    if (typeId === T.bucket && command === "set-backup-schedule") {
      const [p, c, b] = splitId(ext, 3) as [string, string, string];
      const body = {
        type: "weekly",
        weeklySchedule: {
          dayOfWeek: form["dayOfWeek"] || "sunday",
          startAt: int(form["startAt"] || "0", "Start hour", 0, 23),
          incrementalEvery: Number(form["incrementalEvery"] || 24),
          retentionTime: form["retentionTime"] || "30days",
          costOptimizedRetention: form["costOptimizedRetention"] === "true",
        },
      };
      const path = `${this.sub(p, c)}/buckets/${encodeURIComponent(b)}/backup/schedules`;
      try {
        await this.req("PUT", path, body);
      } catch (err) {
        if (statusOf(err) !== 404) throw err;
        await this.req("POST", path, body);
      }
      return { ok: true, message: "Backup schedule saved." };
    }
    if (typeId === T.backup && command === "restore") {
      const [p, c, id] = splitId(ext, 3) as [string, string, string];
      const [, target] = splitId(form["targetClusterId"] ?? "", 2) as [string, string];
      const services = csv(form["services"]);
      await this.req("POST", `${this.sub(p, c)}/backups/${encodeURIComponent(id)}/restore`, {
        targetClusterID: target,
        sourceClusterID: c,
        backupID: id,
        services: services.length ? services : ["data"],
        forceUpdates: form["forceUpdates"] === "true",
      });
      return { ok: true, message: "Restore started." };
    }
    if (typeId === T.credential && command === "reset-password") {
      return this.resetPassword(resourceId, form["password"] ?? "");
    }
    if (typeId === T.apiKey && command === "rotate") {
      const res = await this.req<{ token?: string }>(
        "POST",
        `${this.org}/apikeys/${encodeURIComponent(ext)}/rotate`,
        {},
      );
      return { ok: true, message: `New token (shown once): ${res?.token ?? ""}` };
    }
    if (typeId === T.user && command === "set-roles") {
      const user = (await capellaList<CpUser>(this.ctx, `${this.org}/users`)).find(
        (u) => u.id === ext,
      );
      if (!user) throw notFound(`user ${ext}`);
      const wanted = csv(form["organizationRoles"]);
      const current = user.organizationRoles ?? [];
      const ops: Array<Record<string, unknown>> = [];
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
      await this.req("PATCH", `${this.org}/users/${encodeURIComponent(ext)}`, ops);
      return { ok: true, message: "Roles updated." };
    }
    throw new Error(`Capella plugin: command "${command}" is not supported for "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Observability
  // -------------------------------------------------------------------------

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<MetricSeries[]> {
    const now = Date.now();
    const point = (label: string, unit: string, value: unknown): MetricSeries[] =>
      typeof value === "number" && Number.isFinite(value)
        ? [{ label, unit, points: [{ timestamp: now, value }] }]
        : [];
    if (resourceTypeId === T.cluster) {
      const r = await this.getResource(resourceTypeId, resourceId, accountId);
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
      const r = await this.getResource(resourceTypeId, resourceId, accountId);
      return [
        ...point("Items", "items", r.fields["itemCount"]),
        ...point("Ops/sec", "ops/s", r.fields["opsPerSecond"]),
        ...point("Disk used", "MiB", r.fields["diskUsedMib"]),
        ...point("Memory used", "MiB", r.fields["memoryUsedMib"]),
      ];
    }
    return [];
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const r = await this.getResource(resourceTypeId, resourceId, accountId);
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
  }

  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    const containers = ["All events", "Warnings and critical"];
    const active =
      params.container && containers.includes(params.container) ? params.container : "All events";
    const ext = externalIdOf(resourceId);
    const query: Array<[string, string | number | undefined]> = [
      ["sortBy", "timestamp"],
      ["sortDirection", "desc"],
      ["perPage", Math.min(Math.max(params.tailLines ?? 100, 1), 100)],
      ["page", 1],
    ];
    if (typeId === T.cluster) query.push(["clusterIds", splitId(ext, 2)[1]]);
    else if (typeId === T.project) query.push(["projectIds", ext]);
    if (active !== "All events") {
      query.push(["severityLevels", "warning"], ["severityLevels", "critical"]);
    }
    const res = await this.req<{
      data?: Array<{
        timestamp?: string;
        severity?: string;
        key?: string;
        summary?: string;
        userEmail?: string;
        clusterName?: string;
      }>;
    }>("GET", `${this.org}/events`, undefined, query);
    const text = (res?.data ?? [])
      .slice()
      .reverse()
      .map(
        (e) =>
          `${(e.timestamp ?? "").replace("T", " ").replace(/(\.\d+)?Z$/, "")}  ${(e.severity ?? "").padEnd(8)}  ${e.key ?? ""}${e.summary ? `  ${e.summary}` : ""}${e.userEmail ? `  [${e.userEmail}]` : ""}\n`,
      )
      .join("");
    return { text: text || "No events.\n", containers, activeContainer: active };
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
  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    const refs = (await this.clusterRefs()).filter((r) => !r.free);
    const rows: CostRow[] = [];
    const amountOf = (cat: { currencySpend?: number | null; creditSpend?: number | null }) =>
      typeof cat.currencySpend === "number"
        ? cat.currencySpend
        : typeof cat.creditSpend === "number"
          ? cat.creditSpend
          : 0;
    for (const chunk of monthChunks(range.fromDate, range.toDate)) {
      const body = { startDate: chunk.start, endDate: chunk.end };
      const clusterTotals = new Map<string, number>();
      for (const ref of refs) {
        const res = await this.req<CpBilling>(
          "POST",
          `${this.sub(ref.projectId, ref.clusterId)}/billing`,
          body,
        ).catch((err: unknown) => {
          if (isUnavailable(err)) return undefined;
          throw err;
        });
        const currency = res?.data?.billingCurrency ?? "USD";
        for (const period of res?.data?.periods ?? []) {
          const date = period.startDate;
          if (!date || period.endDate !== date) continue;
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
      let org: CpBilling | undefined;
      try {
        org = await this.req<CpBilling>("POST", `${this.org}/billing`, body);
      } catch (err) {
        const s = statusOf(err);
        if (s === 403) {
          throw new Error("Capella cost data needs an API key with the Organization Owner role.");
        }
        throw err;
      }
      const currency = org?.data?.billingCurrency ?? "USD";
      for (const period of org?.data?.periods ?? []) {
        const date = period.startDate;
        if (!date || period.endDate !== date) continue;
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
  }

  async fetchCreditBalance(_accountId: string): Promise<CreditBalance[]> {
    let res: {
      data?: Array<{
        id: string;
        creditName?: string;
        expirationDate?: string;
        total?: number;
        remaining?: number;
      }>;
    };
    try {
      res = await this.req("GET", `${this.org}/billing/prePaidCredits`, undefined, [
        ["perPage", 100],
      ]);
    } catch (err) {
      if (statusOf(err) === 403) {
        throw new CreditAccessError(
          "Reading prepaid credits needs an API key with the Organization Owner role.",
        );
      }
      throw err;
    }
    return (res?.data ?? []).map((c) => ({
      key: c.id,
      label: c.creditName ?? "Prepaid credits",
      remaining: c.remaining ?? 0,
      currency: "USD",
      ...(typeof c.total === "number" ? { granted: c.total } : {}),
      ...(c.expirationDate ? { expiresAt: c.expirationDate } : {}),
    }));
  }
}
