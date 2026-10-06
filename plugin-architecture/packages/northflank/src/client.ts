import type {
  CostFetchRange,
  CostFetchResult,
  CostRow,
  CreateFieldConfig,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  ResourceInstance,
  SelectOption,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { decodePromptArgs, externalIdOf, withMetricsCapability } from "@infrawrench/plugin-base";
import type { NorthflankContext, Query } from "./api.js";
import { nfFetch, nfList, statusOf } from "./api.js";
import { fetchDailyUsage, fetchNorthflankCostData } from "./cost-data.js";
import {
  addonConnection,
  mapAccount,
  mapAddon,
  mapCluster,
  mapDomain,
  mapJob,
  mapPipeline,
  mapProject,
  mapSecretGroup,
  mapService,
  mapSubdomain,
  mapVolume,
  projectChildId,
  publicPorts,
  splitProjectChild,
} from "./mappers.js";
import {
  ADDON_METRICS,
  JOB_METRICS,
  METRICS_WINDOW_MS,
  SERVICE_METRICS,
  logLinesToText,
  metricBlocksToSeries,
} from "./metrics.js";
import { ENRICH, renderNorthflankDetail, renderNorthflankSidebar } from "./render.js";
import { RESOURCE_TYPES, T } from "./resource-types.js";
import type {
  NfAddon,
  NfAddonType,
  NfAuth,
  NfBackup,
  NfBuild,
  NfCluster,
  NfDeployment,
  NfDomain,
  NfInvoice,
  NfJob,
  NfJobRun,
  NfLogLine,
  NfMetricBlock,
  NfNode,
  NfPipeline,
  NfPlan,
  NfPort,
  NfProject,
  NfRegion,
  NfSecretGroup,
  NfService,
  NfSubdomain,
  NfVolume,
} from "./types.js";

/** List results are reused for this long within one client, so a sync does not re-list per type. */
const CACHE_MS = 30_000;
/** Subdomain details (verification, certificate expiry) are fetched for at most this many per domain. */
const MAX_SUBDOMAIN_DETAILS = 25;

function bool(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === "") return undefined;
  return raw === "true" || raw === "1" || raw === "yes";
}

function num(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Parse `KEY=value` lines (blank lines and `#` comments ignored). */
export function parseEnvLines(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) throw new Error(`"${trimmed}" is not KEY=value.`);
    const key = trimmed.slice(0, idx).trim();
    if (!/^[A-Za-z0-9_.\-/]+$/.test(key)) {
      throw new Error(`"${key}" may only contain letters, numbers, _, -, . and /.`);
    }
    let value = trimmed.slice(idx + 1);
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

function csv(raw: string | undefined): string[] {
  return String(raw ?? "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function stamp(raw: string | number | undefined): string {
  if (raw === undefined || raw === "") return "";
  const d = typeof raw === "number" ? new Date(raw < 1e12 ? raw * 1000 : raw) : new Date(raw);
  return Number.isNaN(d.getTime()) ? String(raw) : d.toISOString().replace("T", " ").slice(0, 16);
}

export class NorthflankClient implements PluginClient {
  readonly ctx: NorthflankContext;
  private cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const token = (credentials["apiToken"] ?? "").trim();
    if (!token) throw new Error("Northflank plugin: missing apiToken credential");
    const teamId = (credentials["teamId"] ?? "").trim();
    const caCert = (credentials["caCert"] ?? "").trim();
    this.ctx = {
      token,
      ...(teamId ? { teamId } : {}),
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
  }

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

  private get<V>(path: string, query?: Query, teamScoped = true): Promise<V> {
    return nfFetch<V>(this.ctx, "GET", path, { ...(query ? { query } : {}), teamScoped });
  }

  private post<V>(path: string, body?: unknown): Promise<V> {
    return nfFetch<V>(this.ctx, "POST", path, { body: body ?? {} });
  }

  private p(projectId: string, rest = ""): string {
    return `/v1/projects/${encodeURIComponent(projectId)}${rest}`;
  }

  // -------------------------------------------------------------------------
  // Shared listings
  // -------------------------------------------------------------------------

  /** Projects with their region, cluster and workload counts (one GET each). */
  projects(): Promise<NfProject[]> {
    return this.cached("projects", async () => {
      const list = await nfList<NfProject>(
        this.ctx,
        "/v1/projects",
        (d) => (d as { projects?: NfProject[] })?.projects,
      );
      return Promise.all(
        list.map(async (p) => {
          try {
            const res = await this.get<{ data?: NfProject }>(this.p(p.id ?? ""));
            return { ...p, ...(res?.data ?? {}) };
          } catch {
            return p;
          }
        }),
      );
    });
  }

  private perProject<V>(
    key: string,
    load: (projectId: string) => Promise<V[]>,
  ): Promise<Array<{ projectId: string; item: V }>> {
    return this.cached(key, async () => {
      const projects = await this.projects();
      const out: Array<{ projectId: string; item: V }> = [];
      for (const p of projects) {
        if (!p.id) continue;
        const items = await load(p.id);
        for (const item of items) out.push({ projectId: p.id, item });
      }
      return out;
    });
  }

  private services() {
    return this.perProject<NfService>("services", (pid) =>
      nfList<NfService>(
        this.ctx,
        this.p(pid, "/services"),
        (d) => (d as { services?: NfService[] })?.services,
      ),
    );
  }

  private plans(): Promise<NfPlan[]> {
    return this.cached("plans", async () => {
      const res = await this.get<{ data?: { plans?: NfPlan[] } }>("/v1/plans", undefined, false);
      return res?.data?.plans ?? [];
    });
  }

  private async planOptions(): Promise<SelectOption[]> {
    const plans = await this.plans();
    return plans
      .slice()
      .sort((a, b) => Number(a.amountPerMonth ?? 0) - Number(b.amountPerMonth ?? 0))
      .map((p) => ({
        id: p.id ?? "",
        label: p.name ?? p.id ?? "",
        description: [
          p.cpuResource !== undefined ? `${p.cpuResource} vCPU` : "",
          p.ramResource !== undefined ? `${p.ramResource} MB` : "",
          p.amountPerMonth !== undefined
            ? `~${p.amountPerMonth.toFixed(2)} ${(p.currency ?? "USD").toUpperCase()}/mo`
            : "",
        ]
          .filter(Boolean)
          .join(" · "),
      }));
  }

  private addonTypes(): Promise<NfAddonType[]> {
    return this.cached("addon-types", async () => {
      const res = await this.get<{ data?: { addonTypes?: NfAddonType[] } }>(
        "/v1/addon-types",
        undefined,
        false,
      );
      return Array.isArray(res?.data?.addonTypes) ? res.data.addonTypes : [];
    });
  }

  // -------------------------------------------------------------------------
  // Inventory
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case T.account: {
        const res = await this.get<{ data?: NfAuth }>("/v1/auth", undefined, false);
        return [mapAccount(accountId, res?.data ?? {}, this.ctx.teamId)];
      }
      case T.project:
        return (await this.projects()).map((p) => mapProject(accountId, p));
      case T.service:
        return (await this.services()).map(({ projectId, item }) =>
          mapService(accountId, projectId, item),
        );
      case T.job:
        return (
          await this.perProject<NfJob>("jobs", (pid) =>
            nfList<NfJob>(this.ctx, this.p(pid, "/jobs"), (d) => (d as { jobs?: NfJob[] })?.jobs),
          )
        ).map(({ projectId, item }) => mapJob(accountId, projectId, item));
      case T.addon:
        return (
          await this.perProject<NfAddon>("addons", (pid) =>
            nfList<NfAddon>(
              this.ctx,
              this.p(pid, "/addons"),
              (d) => (d as { addons?: NfAddon[] })?.addons,
            ),
          )
        ).map(({ projectId, item }) => mapAddon(accountId, projectId, item));
      case T.secretGroup:
        return (
          await this.perProject<NfSecretGroup>("secrets", (pid) =>
            nfList<NfSecretGroup>(
              this.ctx,
              this.p(pid, "/secrets"),
              (d) => (d as { secrets?: NfSecretGroup[] })?.secrets,
            ),
          )
        ).map(({ projectId, item }) => mapSecretGroup(accountId, projectId, item));
      case T.volume:
        return (
          await this.perProject<NfVolume>("volumes", (pid) =>
            nfList<NfVolume>(this.ctx, this.p(pid, "/volumes"), (d) =>
              Array.isArray(d) ? (d as NfVolume[]) : (d as { volumes?: NfVolume[] })?.volumes,
            ),
          )
        ).map(({ projectId, item }) => mapVolume(accountId, projectId, item));
      case T.pipeline:
        return (
          await this.perProject<NfPipeline>("pipelines", (pid) =>
            nfList<NfPipeline>(
              this.ctx,
              this.p(pid, "/pipelines"),
              (d) => (d as { pipelines?: NfPipeline[] })?.pipelines,
            ),
          )
        ).map(({ projectId, item }) => mapPipeline(accountId, projectId, item));
      case T.domain:
        return (await this.domains()).map((d) => mapDomain(accountId, d));
      case T.subdomain:
        return this.listSubdomains(accountId);
      case T.cluster:
        return (
          await nfList<NfCluster>(
            this.ctx,
            "/v1/cloud-providers/clusters",
            (d) => (d as { clusters?: NfCluster[] })?.clusters,
          )
        ).map((c) => mapCluster(accountId, c));
      default:
        throw new Error(`Northflank plugin: unknown resource type "${typeId}"`);
    }
  }

  /** Domains with their subdomain lists (the listing omits them, so one GET each). */
  private domains(): Promise<NfDomain[]> {
    return this.cached("domains", async () => {
      const list = await nfList<NfDomain>(
        this.ctx,
        "/v1/domains",
        (d) => (d as { domains?: NfDomain[] })?.domains,
      );
      return Promise.all(
        list.map(async (d) => {
          try {
            const res = await this.get<{ data?: NfDomain }>(
              `/v1/domains/${encodeURIComponent(d.name ?? "")}`,
            );
            return { ...d, ...(res?.data ?? {}) };
          } catch {
            return d;
          }
        }),
      );
    });
  }

  private async listSubdomains(accountId: string): Promise<ResourceInstance[]> {
    const out: ResourceInstance[] = [];
    for (const d of await this.domains()) {
      const domain = d.name ?? "";
      const subs = d.subdomains ?? [];
      for (const [i, s] of subs.entries()) {
        let detail: NfSubdomain = { ...s };
        if (i < MAX_SUBDOMAIN_DETAILS) {
          try {
            const res = await this.get<{ data?: NfSubdomain }>(
              `/v1/domains/${encodeURIComponent(domain)}/subdomains/${encodeURIComponent(s.name ?? "")}`,
            );
            detail = { ...detail, ...(res?.data ?? {}) };
          } catch {
            /* keep the summary */
          }
        }
        out.push(mapSubdomain(accountId, domain, detail));
      }
    }
    return out;
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const ext = externalIdOf(resourceId);
    switch (typeId) {
      case T.project: {
        const res = await this.get<{ data?: NfProject }>(this.p(ext));
        return mapProject(accountId, res?.data ?? { id: ext });
      }
      case T.service: {
        const { projectId, id } = splitProjectChild(ext);
        const [svc, ports] = await Promise.all([
          this.get<{ data?: NfService }>(this.p(projectId, `/services/${encodeURIComponent(id)}`)),
          this.servicePorts(projectId, id).catch(() => undefined),
        ]);
        return mapService(accountId, projectId, {
          ...(svc?.data ?? { id }),
          ...(ports ? { ports } : {}),
        });
      }
      case T.job: {
        const { projectId, id } = splitProjectChild(ext);
        const res = await this.get<{ data?: NfJob }>(
          this.p(projectId, `/jobs/${encodeURIComponent(id)}`),
        );
        return mapJob(accountId, projectId, res?.data ?? { id });
      }
      case T.addon: {
        const { projectId, id } = splitProjectChild(ext);
        const res = await this.get<{ data?: NfAddon }>(
          this.p(projectId, `/addons/${encodeURIComponent(id)}`),
        );
        return mapAddon(accountId, projectId, res?.data ?? { id });
      }
      case T.secretGroup: {
        const { projectId, id } = splitProjectChild(ext);
        const res = await this.get<{ data?: NfSecretGroup }>(
          this.p(projectId, `/secrets/${encodeURIComponent(id)}`),
          {
            show: "this",
          },
        );
        return mapSecretGroup(accountId, projectId, res?.data ?? { id });
      }
      case T.volume: {
        const { projectId, id } = splitProjectChild(ext);
        const res = await this.get<{ data?: NfVolume }>(
          this.p(projectId, `/volumes/${encodeURIComponent(id)}`),
        );
        return mapVolume(accountId, projectId, res?.data ?? { id });
      }
      case T.pipeline: {
        const { projectId, id } = splitProjectChild(ext);
        const res = await this.get<{ data?: NfPipeline }>(
          this.p(projectId, `/pipelines/${encodeURIComponent(id)}`),
        );
        return mapPipeline(accountId, projectId, { id, ...(res?.data ?? {}) });
      }
      case T.domain: {
        const res = await this.get<{ data?: NfDomain }>(`/v1/domains/${encodeURIComponent(ext)}`);
        return mapDomain(accountId, res?.data ?? { name: ext });
      }
      case T.subdomain: {
        const [domain, sub] = this.splitSubdomain(ext);
        const res = await this.get<{ data?: NfSubdomain }>(
          `/v1/domains/${encodeURIComponent(domain)}/subdomains/${encodeURIComponent(sub)}`,
        );
        return mapSubdomain(accountId, domain, res?.data ?? { name: sub });
      }
      case T.cluster: {
        const res = await this.get<{ data?: NfCluster }>(
          `/v1/cloud-providers/clusters/${encodeURIComponent(ext)}`,
        );
        return mapCluster(accountId, res?.data ?? { id: ext });
      }
      default: {
        const found = (await this.listResources(typeId, accountId)).find(
          (r) => r.id === resourceId,
        );
        if (!found) {
          const err = new Error(`Northflank plugin: resource ${typeId}/${ext} not found`);
          (err as Error & { status?: number }).status = 404;
          throw err;
        }
        return found;
      }
    }
  }

  private splitSubdomain(ext: string): [string, string] {
    const idx = ext.indexOf("/");
    if (idx <= 0) throw new Error(`Northflank plugin: malformed subdomain id "${ext}"`);
    return [ext.slice(0, idx), ext.slice(idx + 1)];
  }

  private async servicePorts(projectId: string, serviceId: string): Promise<NfPort[]> {
    const res = await this.get<{ data?: { ports?: NfPort[] } }>(
      this.p(projectId, `/services/${encodeURIComponent(serviceId)}/ports`),
    );
    return res?.data?.ports ?? [];
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    _accountId: string,
  ): Promise<string> {
    const ext = externalIdOf(resourceId);
    if (typeId === T.service) {
      const { projectId, id } = splitProjectChild(ext);
      if (outputKey === "internalHost") return id;
      if (outputKey === "publicUrl") {
        const port = publicPorts(await this.servicePorts(projectId, id))[0];
        if (!port) throw new Error("This service has no public port.");
        return `https://${port.dns}`;
      }
    }
    if (typeId === T.addon) {
      const { projectId, id } = splitProjectChild(ext);
      const [addon, creds] = await Promise.all([
        this.get<{ data?: NfAddon }>(this.p(projectId, `/addons/${encodeURIComponent(id)}`)),
        this.get<{ data?: { secrets?: Record<string, unknown>; envs?: Record<string, unknown> } }>(
          this.p(projectId, `/addons/${encodeURIComponent(id)}/credentials`),
        ),
      ]);
      const external = addon?.data?.spec?.config?.networking?.externalAccessEnabled === true;
      const conn = addonConnection(creds?.data, external);
      const value = conn[outputKey as keyof typeof conn];
      if (value) return value;
      if (outputKey === "connectionString") {
        throw new Error(
          external
            ? "Northflank returned no connection string for this addon."
            : "This addon is only reachable inside Northflank. Turn on TLS and public access (Edit) to connect from here.",
        );
      }
      return "";
    }
    throw new Error(`Northflank plugin: cannot resolve "${outputKey}" for "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Detail
  // -------------------------------------------------------------------------

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const out: ResourceInstance = { ...resource, resolvedOutputs: { ...resource.resolvedOutputs } };
    const put = (key: string, value: unknown) => {
      if (value !== undefined) out.resolvedOutputs[key] = JSON.stringify(value);
    };
    const settle = async <V>(p: Promise<V>): Promise<V | undefined> => {
      try {
        return await p;
      } catch {
        return undefined;
      }
    };
    const ext = resource.externalId ?? externalIdOf(resource.id);
    switch (resource.resourceTypeId) {
      case T.account: {
        const now = new Date();
        const monthStart = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
        const [invoices, usage] = await Promise.all([
          settle(
            this.get<{ data?: { invoices?: NfInvoice[] } }>("/v1/billing/invoices", {
              perPage: 12,
            }),
          ),
          settle(
            this.get<{ data?: { usage?: Array<Record<string, unknown>> } }>("/v1/billing/usage", {
              granularity: "total",
              startTime: monthStart,
              endTime: Math.floor(now.getTime() / 1000),
              removeLegacyFields: true,
            }),
          ),
        ]);
        put(
          ENRICH.invoices,
          invoices?.data?.invoices?.map((i) => ({
            id: i.id,
            start: i.period?.start,
            end: i.period?.end,
            status: i.status,
            total: i.total,
            currency: i.currency,
          })),
        );
        const u = usage?.data?.usage?.[0] as
          | {
              total?: number;
              currency?: string;
              paas?: { price?: { total?: number } };
              byoc?: { price?: { total?: number } };
              egressIp?: { price?: { total?: number } };
              loadBalancer?: { price?: { total?: number } };
            }
          | undefined;
        if (u) {
          const parts: Array<[string, number]> = [];
          for (const [label, v] of [
            ["Workloads (PaaS)", u.paas?.price?.total],
            ["BYOC", u.byoc?.price?.total],
            ["Egress IPs", u.egressIp?.price?.total],
            ["Load balancers", u.loadBalancer?.price?.total],
          ] as Array<[string, number | undefined]>) {
            if (typeof v === "number" && v) parts.push([label, v]);
          }
          put(ENRICH.usage, { total: u.total, currency: u.currency, parts });
        }
        break;
      }
      case T.service: {
        const { projectId, id } = splitProjectChild(ext);
        const base = this.p(projectId, `/services/${encodeURIComponent(id)}`);
        const type = String(resource.fields["serviceType"] ?? "");
        const [plans, builds, deployments, env, ports] = await Promise.all([
          settle(this.planOptions()),
          type === "deployment"
            ? Promise.resolve(undefined)
            : settle(
                this.get<{ data?: { builds?: NfBuild[] } }>(`${base}/build`, { per_page: 10 }),
              ),
          type === "build"
            ? Promise.resolve(undefined)
            : settle(
                this.get<{ data?: { deployments?: NfDeployment[] } }>(`${base}/deployments`, {
                  per_page: 10,
                }),
              ),
          type === "build"
            ? Promise.resolve(undefined)
            : settle(
                this.get<{ data?: { runtimeEnvironment?: Record<string, unknown> } }>(
                  `${base}/runtime-environment`,
                  { show: "this" },
                ),
              ),
          type === "build" ? Promise.resolve(undefined) : settle(this.servicePorts(projectId, id)),
        ]);
        put(ENRICH.plans, plans);
        put(
          ENRICH.builds,
          builds?.data?.builds?.map((b) => ({
            created: stamp(b.createdAt),
            status: b.status ?? "",
            branch: b.branch ?? "",
            sha: (b.sha ?? "").slice(0, 8),
          })),
        );
        put(
          ENRICH.deployments,
          deployments?.data?.deployments?.map((d) => ({
            created: stamp(d.createdAt),
            active: d.active ? "Yes" : "No",
            image: d.image?.imagePath ?? [d.image?.image, d.image?.tag].filter(Boolean).join(":"),
            commit: (d.commit?.sha ?? "").slice(0, 8),
          })),
        );
        if (env?.data) put(ENRICH.envKeys, Object.keys(env.data.runtimeEnvironment ?? {}).sort());
        put(
          ENRICH.ports,
          ports?.map((p) => ({
            name: p.name,
            internalPort: p.internalPort,
            protocol: p.protocol,
            public: p.public,
            dns: p.dns,
            domains: (p.domains ?? [])
              .map((d) => d.name)
              .filter(Boolean)
              .join(", "),
          })),
        );
        break;
      }
      case T.job: {
        const { projectId, id } = splitProjectChild(ext);
        const base = this.p(projectId, `/jobs/${encodeURIComponent(id)}`);
        const [plans, runs, env] = await Promise.all([
          settle(this.planOptions()),
          settle(this.get<{ data?: { runs?: NfJobRun[] } }>(`${base}/runs`, { per_page: 10 })),
          settle(
            this.get<{ data?: { runtimeEnvironment?: Record<string, unknown> } }>(
              `${base}/runtime-environment`,
              { show: "this" },
            ),
          ),
        ]);
        put(ENRICH.plans, plans);
        put(
          ENRICH.runs,
          runs?.data?.runs?.map((r) => ({
            name: r.runName ?? r.id ?? "",
            status: r.status ?? "",
            started: stamp(r.startedAt),
            concluded: stamp(r.concludedAt),
          })),
        );
        if (env?.data) put(ENRICH.envKeys, Object.keys(env.data.runtimeEnvironment ?? {}).sort());
        break;
      }
      case T.addon: {
        const { projectId, id } = splitProjectChild(ext);
        const base = this.p(projectId, `/addons/${encodeURIComponent(id)}`);
        const [plans, backups, version] = await Promise.all([
          settle(this.planOptions()),
          settle(
            this.get<{ data?: { backups?: NfBackup[] } }>(`${base}/backups`, { per_page: 10 }),
          ),
          settle(
            this.get<{ data?: { upgradeTo?: Array<{ version: string; type?: string }> } }>(
              `${base}/version`,
            ),
          ),
        ]);
        put(ENRICH.plans, plans);
        put(
          ENRICH.backups,
          backups?.data?.backups?.map((b) => ({
            name: b.name ?? b.id ?? "",
            type: b.config?.source?.type ?? "",
            status: b.status ?? "",
            created: stamp(b.createdAt),
            size: b.config?.size ? `${Math.round(Number(b.config.size) / 1048576)} MB` : "",
          })),
        );
        put(ENRICH.upgrades, version?.data?.upgradeTo);
        break;
      }
      case T.volume: {
        const { projectId, id } = splitProjectChild(ext);
        const [services, backups] = await Promise.all([
          settle(this.services()),
          settle(
            this.get<{ data?: { backups?: NfBackup[] } | NfBackup[] }>(
              this.p(projectId, `/volumes/${encodeURIComponent(id)}/backups`),
            ),
          ),
        ]);
        put(
          ENRICH.services,
          services
            ?.filter((s) => s.projectId === projectId && s.item.serviceType !== "build")
            .map((s) => ({ id: s.item.id ?? "", label: s.item.name ?? s.item.id ?? "" })),
        );
        const list = Array.isArray(backups?.data) ? backups.data : backups?.data?.backups;
        put(
          ENRICH.backups,
          list?.map((b) => ({
            name: b.name ?? b.id ?? "",
            status: b.status ?? "",
            created: stamp(b.createdAt),
          })),
        );
        break;
      }
      case T.pipeline: {
        const { projectId, id } = splitProjectChild(ext);
        const res = await settle(
          this.get<{ data?: NfPipeline }>(
            this.p(projectId, `/pipelines/${encodeURIComponent(id)}`),
          ),
        );
        const objects = res?.data?.nfObjects ?? [];
        put(
          ENRICH.pipelineObjects,
          objects.map((o) => ({ stage: o.stage ?? "", type: o.type ?? "", id: o.id ?? "" })),
        );
        const stages = [...new Set(objects.map((o) => o.stage).filter((s): s is string => !!s))];
        const runs = await Promise.all(
          stages.map(async (stage) => {
            const r = await settle(
              this.get<{
                data?: {
                  runs?: Array<{ name?: string; id?: string; status?: string; createdAt?: string }>;
                };
              }>(
                this.p(
                  projectId,
                  `/pipelines/${encodeURIComponent(id)}/release-flows/${encodeURIComponent(stage)}/runs`,
                ),
                { per_page: 5 },
              ),
            );
            return (r?.data?.runs ?? []).map((x) => ({
              stage,
              name: x.name ?? x.id ?? "",
              status: x.status ?? "",
              created: stamp(x.createdAt),
              at: x.createdAt ?? "",
            }));
          }),
        );
        put(
          ENRICH.releaseRuns,
          runs
            .flat()
            .sort((a, b) => b.at.localeCompare(a.at))
            .slice(0, 15)
            .map(({ at: _at, ...rest }) => rest),
        );
        break;
      }
      case T.subdomain: {
        const services = await settle(this.services());
        const targets: SelectOption[] = [];
        for (const s of (services ?? [])
          .filter((x) => x.item.serviceType !== "build")
          .slice(0, 30)) {
          const ports = await settle(this.servicePorts(s.projectId, s.item.id ?? ""));
          for (const port of ports ?? []) {
            if (!port.public || !/HTTP/i.test(port.protocol ?? "")) continue;
            targets.push({
              id: `${s.projectId}/${s.item.id}/${port.name}`,
              label: `${s.item.name ?? s.item.id} : ${port.name} (${port.internalPort})`,
              description: s.projectId,
            });
          }
        }
        put(ENRICH.portTargets, targets);
        break;
      }
      case T.cluster: {
        const [cluster, nodes] = await Promise.all([
          settle(
            this.get<{ data?: NfCluster }>(
              `/v1/cloud-providers/clusters/${encodeURIComponent(ext)}`,
            ),
          ),
          settle(
            nfList<NfNode>(
              this.ctx,
              `/v1/cloud-providers/clusters/${encodeURIComponent(ext)}/nodes`,
              (d) => (d as { nodes?: NfNode[] })?.nodes,
              {
                query: { status: "RUNNING" },
                maxPages: 3,
              },
            ),
          ),
        ]);
        put(
          ENRICH.pools,
          cluster?.data?.nodePools?.map((p) => ({
            id: p.id ?? "",
            nodeType: p.nodeType ?? "",
            nodes: String(p.nodeCount ?? ""),
            autoscaling: p.autoscaling?.enabled
              ? `${p.autoscaling.min ?? "?"} to ${p.autoscaling.max ?? "?"}`
              : "Off",
          })),
        );
        put(
          ENRICH.nodes,
          nodes?.map((n) => ({
            id: n.nodeId ?? n.nodeName ?? "",
            name: n.nodeName ?? n.nodeId ?? "",
            pool: n.nodePool ?? "",
            status: n.status ?? "",
            zone: n.zone ?? "",
            type: n.instanceType ?? "",
          })),
        );
        break;
      }
    }
    return out;
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return withMetricsCapability(
      renderNorthflankDetail(resource),
      RESOURCE_TYPES,
      resource.resourceTypeId,
      METRICS_WINDOW_MS,
    );
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderNorthflankSidebar(resource);
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  private async projectField(parentResourceId?: string): Promise<CreateFieldConfig[]> {
    if (parentResourceId) return [];
    const projects = await this.projects();
    return [
      {
        key: "projectId",
        label: "Project",
        kind: "select",
        required: true,
        options: projects.map((p) => ({
          id: p.id ?? "",
          label: p.name ?? p.id ?? "",
          ...(p.deployment?.region || p.cluster?.name
            ? { description: p.deployment?.region ?? p.cluster?.name ?? "" }
            : {}),
        })),
      },
    ];
  }

  private projectOf(fields: Record<string, string>, parentResourceId?: string): string {
    const projectId =
      fields["projectId"] || (parentResourceId ? externalIdOf(parentResourceId) : "");
    if (!projectId) throw new Error("Pick a project.");
    return projectId;
  }

  private async planSelect(defaultPlan = "nf-compute-20"): Promise<CreateFieldConfig> {
    const options = await this.planOptions().catch(() => [] as SelectOption[]);
    return options.length
      ? {
          key: "deploymentPlan",
          label: "Compute plan",
          kind: "select",
          required: true,
          options,
          defaultValue: options.some((o) => o.id === defaultPlan)
            ? defaultPlan
            : (options[0]?.id ?? ""),
        }
      : {
          key: "deploymentPlan",
          label: "Compute plan",
          kind: "text",
          required: true,
          defaultValue: defaultPlan,
        };
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case T.project: {
        const [regions, clusters] = await Promise.all([
          this.get<{ data?: { regions?: NfRegion[] } }>("/v1/regions", undefined, false)
            .then((r) => r?.data?.regions ?? [])
            .catch(() => [] as NfRegion[]),
          nfList<NfCluster>(
            this.ctx,
            "/v1/cloud-providers/clusters",
            (d) => (d as { clusters?: NfCluster[] })?.clusters,
          ).catch(() => [] as NfCluster[]),
        ]);
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "my-project" },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "placement",
              label: "Deploy to",
              kind: "select",
              required: true,
              defaultValue: "region",
              options: [
                { id: "region", label: "Northflank's cloud" },
                ...(clusters.length ? [{ id: "cluster", label: "My BYOC cluster" }] : []),
              ],
            },
            {
              key: "region",
              label: "Region",
              kind: "select",
              required: false,
              options: regions.map((r) => ({
                id: r.id ?? "",
                label: r.name ?? r.id ?? "",
                description: r.regionName ?? "",
              })),
              defaultValue: regions[0]?.id ?? "europe-west",
              showWhen: { fieldKey: "placement", fieldValue: "region" },
            },
            {
              key: "clusterId",
              label: "Cluster",
              kind: "select",
              required: false,
              options: clusters.map((c) => ({
                id: c.id ?? "",
                label: c.name ?? c.id ?? "",
                description: [c.provider, c.region].filter(Boolean).join(" · "),
              })),
              showWhen: { fieldKey: "placement", fieldValue: "cluster" },
            },
            {
              key: "color",
              label: "Colour",
              kind: "text",
              required: false,
              placeholder: "#EF233C",
            },
          ],
        };
      }
      case T.service: {
        const [projectField, plan, repos] = await Promise.all([
          this.projectField(parentResourceId),
          this.planSelect(),
          nfList<{ url?: string; full_name?: string; vcsService?: string; accountLogin?: string }>(
            this.ctx,
            "/v1/integrations/vcs/repos",
            (d) => (d as { repos?: Array<{ url?: string }> })?.repos,
            { maxPages: 5 },
          ).catch(() => []),
        ]);
        return {
          fields: [
            ...projectField,
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "api" },
            {
              key: "kind",
              label: "Source",
              kind: "select",
              required: true,
              defaultValue: "deployment",
              options: [
                {
                  id: "deployment",
                  label: "Container image",
                  description: "Deploy an image from a registry",
                },
                {
                  id: "combined",
                  label: "Git repository",
                  description: "Build with a Dockerfile and deploy",
                },
              ],
            },
            {
              key: "imagePath",
              label: "Image",
              kind: "text",
              required: false,
              placeholder: "nginx:1.27 or ghcr.io/org/app:tag",
              showWhen: { fieldKey: "kind", fieldValue: "deployment" },
            },
            repos.length
              ? {
                  key: "repo",
                  label: "Repository",
                  kind: "select",
                  required: false,
                  options: repos.map((r) => ({
                    id: `${r.vcsService ?? "github"}|${r.url ?? ""}|${r.accountLogin ?? ""}`,
                    label: r.full_name ?? r.url ?? "",
                    description: r.vcsService ?? "",
                  })),
                  showWhen: { fieldKey: "kind", fieldValue: "combined" },
                }
              : {
                  key: "repo",
                  label: "Repository URL",
                  kind: "text",
                  required: false,
                  placeholder: "https://github.com/org/repo",
                  description: "Link a Git account in Northflank to pick repositories here.",
                  showWhen: { fieldKey: "kind", fieldValue: "combined" },
                },
            {
              key: "branch",
              label: "Branch",
              kind: "text",
              required: false,
              defaultValue: "main",
              showWhen: { fieldKey: "kind", fieldValue: "combined" },
            },
            {
              key: "dockerfile",
              label: "Dockerfile path",
              kind: "text",
              required: false,
              defaultValue: "/Dockerfile",
              showWhen: { fieldKey: "kind", fieldValue: "combined" },
            },
            plan,
            {
              key: "instances",
              label: "Instances",
              kind: "number",
              required: false,
              defaultValue: "1",
              minValue: 0,
            },
            {
              key: "port",
              label: "HTTP port (optional)",
              kind: "number",
              required: false,
              placeholder: "8080",
              description:
                "The port the container listens on. Leave empty for a worker with no port.",
            },
            {
              key: "public",
              label: "Expose publicly",
              kind: "select",
              required: false,
              defaultValue: "true",
              options: [
                { id: "true", label: "Public HTTPS address" },
                { id: "false", label: "Private to the project" },
              ],
            },
          ],
        };
      }
      case T.job: {
        const [projectField, plan] = await Promise.all([
          this.projectField(parentResourceId),
          this.planSelect(),
        ]);
        return {
          fields: [
            ...projectField,
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "nightly-report",
            },
            {
              key: "jobType",
              label: "Trigger",
              kind: "select",
              required: true,
              defaultValue: "cron",
              options: [
                { id: "cron", label: "On a schedule (cron)" },
                { id: "manual", label: "Manually" },
              ],
            },
            {
              key: "schedule",
              label: "Schedule",
              kind: "text",
              required: false,
              defaultValue: "0 3 * * *",
              description: "Cron expression in UTC.",
              showWhen: { fieldKey: "jobType", fieldValue: "cron" },
            },
            {
              key: "concurrencyPolicy",
              label: "If the last run is still going",
              kind: "select",
              required: false,
              defaultValue: "forbid",
              options: [
                { id: "forbid", label: "Skip the new run" },
                { id: "replace", label: "Replace the running one" },
                { id: "allow", label: "Run both" },
              ],
              showWhen: { fieldKey: "jobType", fieldValue: "cron" },
            },
            {
              key: "imagePath",
              label: "Image",
              kind: "text",
              required: true,
              placeholder: "alpine:3.20",
            },
            {
              key: "command",
              label: "Command (optional)",
              kind: "text",
              required: false,
              placeholder: "sh -c 'echo hello'",
            },
            plan,
            {
              key: "backoffLimit",
              label: "Retries",
              kind: "number",
              required: false,
              defaultValue: "0",
              minValue: 0,
            },
            {
              key: "activeDeadlineSeconds",
              label: "Timeout (s)",
              kind: "number",
              required: false,
              defaultValue: "600",
              minValue: 1,
            },
          ],
        };
      }
      case T.addon: {
        const [projectField, plan, types] = await Promise.all([
          this.projectField(parentResourceId),
          this.planSelect("nf-compute-20"),
          this.addonTypes().catch(() => [] as NfAddonType[]),
        ]);
        const perType: CreateFieldConfig[] = [];
        for (const t of types) {
          if (!t.type) continue;
          const when = { fieldKey: "addonType", fieldValue: t.type };
          const versions = [...(t.versions ?? [])].reverse();
          perType.push({
            key: `version__${t.type}`,
            label: "Version",
            kind: "select",
            required: false,
            options: [
              { id: "latest", label: "Latest" },
              ...versions.map((v) => ({ id: v, label: v })),
            ],
            defaultValue: "latest",
            showWhen: when,
          });
          const storage = t.resources?.storage;
          if (storage?.options?.length) {
            perType.push({
              key: `storage__${t.type}`,
              label: "Storage",
              kind: "select",
              required: false,
              options: storage.options.map((mbv) => ({
                id: String(mbv),
                label: mbv >= 1024 ? `${Math.round((mbv / 1024) * 10) / 10} GB` : `${mbv} MB`,
              })),
              defaultValue: String(storage.default ?? storage.options[0]),
              showWhen: when,
            });
          }
          const replicas = t.resources?.replicas;
          if (replicas?.options?.length && t.features?.["scaleReplicas"]) {
            perType.push({
              key: `replicas__${t.type}`,
              label: "Replicas",
              kind: "select",
              required: false,
              options: replicas.options.map((r) => ({ id: String(r), label: String(r) })),
              defaultValue: String(replicas.default ?? 1),
              showWhen: when,
            });
          }
        }
        return {
          fields: [
            ...projectField,
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "database" },
            {
              key: "addonType",
              label: "Type",
              kind: "select",
              required: true,
              options: types.map((t) => ({
                id: t.type ?? "",
                label: t.name ?? t.type ?? "",
                description: t.description ?? "",
              })),
              defaultValue: types.some((t) => t.type === "postgresql")
                ? "postgresql"
                : (types[0]?.type ?? ""),
            },
            ...perType,
            plan,
            {
              key: "tlsEnabled",
              label: "TLS",
              kind: "select",
              required: false,
              defaultValue: "true",
              options: [
                { id: "true", label: "Enabled" },
                { id: "false", label: "Disabled" },
              ],
            },
            {
              key: "externalAccessEnabled",
              label: "Public access",
              kind: "select",
              required: false,
              defaultValue: "false",
              description:
                "Needed to open the addon's database console from Infrawrench. Requires TLS.",
              options: [
                { id: "false", label: "Private to the project" },
                { id: "true", label: "Reachable from the internet" },
              ],
            },
          ],
        };
      }
      case T.secretGroup:
        return {
          fields: [
            ...(await this.projectField(parentResourceId)),
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "app-secrets",
            },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "secretType",
              label: "Inject into",
              kind: "select",
              required: true,
              defaultValue: "environment-arguments",
              options: [
                { id: "environment-arguments", label: "Runtime variables and build arguments" },
                { id: "environment", label: "Runtime variables only" },
                { id: "arguments", label: "Build arguments only" },
              ],
            },
            {
              key: "priority",
              label: "Priority",
              kind: "number",
              required: false,
              defaultValue: "10",
            },
            {
              key: "variables",
              label: "Variables",
              kind: "text",
              multiline: true,
              required: false,
              placeholder: "DATABASE_URL=postgres://…\nAPI_KEY=…",
              description: "One KEY=value per line.",
            },
          ],
        };
      case T.volume: {
        const projectField = await this.projectField(parentResourceId);
        const services = parentResourceId
          ? (await this.services()).filter((s) => s.projectId === externalIdOf(parentResourceId))
          : await this.services();
        return {
          fields: [
            ...projectField,
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "data" },
            {
              key: "storageSizeMb",
              label: "Size",
              kind: "select",
              required: true,
              defaultValue: "5120",
              options: [1024, 5120, 10240, 20480, 51200, 102400, 204800, 512000].map((m) => ({
                id: String(m),
                label: `${m / 1024} GB`,
              })),
            },
            {
              key: "containerMountPath",
              label: "Mount path",
              kind: "text",
              required: true,
              defaultValue: "/data",
            },
            {
              key: "attachTo",
              label: "Attach to service (optional)",
              kind: "select",
              required: false,
              options: services
                .filter((s) => s.item.serviceType !== "build")
                .map((s) => ({
                  id: `${s.projectId}/${s.item.id}`,
                  label: s.item.name ?? s.item.id ?? "",
                  description: s.projectId,
                })),
            },
          ],
        };
      }
      case T.domain:
        return {
          fields: [
            {
              key: "domain",
              label: "Domain",
              kind: "text",
              required: true,
              placeholder: "example.com",
            },
          ],
        };
      case T.subdomain: {
        const domains = parentResourceId ? [] : await this.domains();
        return {
          fields: [
            ...(parentResourceId
              ? []
              : [
                  {
                    key: "domain",
                    label: "Domain",
                    kind: "select" as const,
                    required: true,
                    options: domains.map((d) => ({
                      id: d.name ?? "",
                      label: d.name ?? "",
                      description: d.status ?? "",
                    })),
                  },
                ]),
            {
              key: "subdomain",
              label: "Subdomain",
              kind: "text",
              required: true,
              placeholder: "app",
              description: "Use -default for the bare domain.",
            },
          ],
        };
      }
      default:
        throw new Error(`Northflank plugin: creating "${typeId}" is not supported`);
    }
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    this.invalidate();
    switch (typeId) {
      case T.project: {
        const body: Record<string, unknown> = { name: fields["name"] };
        if (fields["description"]) body["description"] = fields["description"];
        if (fields["color"]) body["color"] = fields["color"];
        if (fields["placement"] === "cluster") {
          if (!fields["clusterId"]) throw new Error("Pick a cluster.");
          body["clusterId"] = fields["clusterId"];
        } else body["region"] = fields["region"] || "europe-west";
        const res = await this.post<{ data?: NfProject }>("/v1/projects", body);
        const id = res?.data?.id;
        if (!id) throw new Error("Northflank did not return the new project's id.");
        return this.getResource(T.project, `${accountId}:${T.project}:${id}`, accountId);
      }
      case T.service: {
        const projectId = this.projectOf(fields, parentResourceId);
        const kind = fields["kind"] === "combined" ? "combined" : "deployment";
        const port = num(fields["port"]);
        const body: Record<string, unknown> = {
          name: fields["name"],
          billing: { deploymentPlan: fields["deploymentPlan"] || "nf-compute-20" },
          ...(port
            ? {
                ports: [
                  {
                    name: "p01",
                    internalPort: port,
                    public: fields["public"] !== "false",
                    protocol: "HTTP",
                  },
                ],
              }
            : {}),
        };
        const instances = num(fields["instances"]) ?? 1;
        if (kind === "deployment") {
          if (!fields["imagePath"]) throw new Error("Give an image to deploy.");
          body["deployment"] = { instances, external: { imagePath: fields["imagePath"] } };
        } else {
          const [vcs, url, login] = (fields["repo"] ?? "").includes("|")
            ? (fields["repo"] ?? "").split("|")
            : [guessVcs(fields["repo"] ?? ""), fields["repo"] ?? "", ""];
          if (!url) throw new Error("Pick a repository.");
          body["deployment"] = { instances };
          body["vcsData"] = {
            projectUrl: url,
            projectType: vcs || "github",
            projectBranch: fields["branch"] || "main",
            ...(login ? { accountLogin: login } : {}),
          };
          body["buildSettings"] = {
            dockerfile: {
              buildEngine: "buildkit",
              dockerFilePath: fields["dockerfile"] || "/Dockerfile",
              dockerWorkDir: "/",
            },
          };
        }
        const res = await this.post<{ data?: NfService }>(
          this.p(projectId, `/services/${kind}`),
          body,
        );
        const id = res?.data?.id;
        if (!id) throw new Error("Northflank did not return the new service's id.");
        return this.getResource(
          T.service,
          `${accountId}:${T.service}:${projectChildId(projectId, id)}`,
          accountId,
        );
      }
      case T.job: {
        const projectId = this.projectOf(fields, parentResourceId);
        const cron = fields["jobType"] !== "manual";
        if (!fields["imagePath"]) throw new Error("Give an image to run.");
        const body: Record<string, unknown> = {
          name: fields["name"],
          billing: { deploymentPlan: fields["deploymentPlan"] || "nf-compute-20" },
          deployment: {
            external: { imagePath: fields["imagePath"] },
            ...(fields["command"]
              ? { docker: { configType: "customCommand", customCommand: fields["command"] } }
              : {}),
          },
          backoffLimit: num(fields["backoffLimit"]) ?? 0,
          activeDeadlineSeconds: num(fields["activeDeadlineSeconds"]) ?? 600,
        };
        if (cron) {
          if (!fields["schedule"]) throw new Error("Give a cron schedule.");
          body["schedule"] = fields["schedule"];
          body["concurrencyPolicy"] = fields["concurrencyPolicy"] || "forbid";
        }
        const res = await this.post<{ data?: NfJob }>(
          this.p(projectId, cron ? "/jobs/cron" : "/jobs/manual"),
          body,
        );
        const id = res?.data?.id;
        if (!id) throw new Error("Northflank did not return the new job's id.");
        return this.getResource(
          T.job,
          `${accountId}:${T.job}:${projectChildId(projectId, id)}`,
          accountId,
        );
      }
      case T.addon: {
        const projectId = this.projectOf(fields, parentResourceId);
        const type = fields["addonType"];
        if (!type) throw new Error("Pick an addon type.");
        const types = await this.addonTypes().catch(() => [] as NfAddonType[]);
        const def = types.find((t) => t.type === type);
        const storage = num(fields[`storage__${type}`]) ?? def?.resources?.storage?.default ?? 4096;
        const replicas = num(fields[`replicas__${type}`]) ?? def?.resources?.replicas?.default ?? 1;
        const tls = fields["tlsEnabled"] !== "false";
        const external = fields["externalAccessEnabled"] === "true";
        if (external && !tls) throw new Error("Public access needs TLS.");
        const res = await this.post<{ data?: NfAddon }>(this.p(projectId, "/addons"), {
          name: fields["name"],
          type,
          version: fields[`version__${type}`] || "latest",
          billing: {
            deploymentPlan: fields["deploymentPlan"] || "nf-compute-20",
            storage,
            replicas,
          },
          tlsEnabled: tls,
          externalAccessEnabled: external,
        });
        const id = res?.data?.id;
        if (!id) throw new Error("Northflank did not return the new addon's id.");
        return this.getResource(
          T.addon,
          `${accountId}:${T.addon}:${projectChildId(projectId, id)}`,
          accountId,
        );
      }
      case T.secretGroup: {
        const projectId = this.projectOf(fields, parentResourceId);
        const variables = parseEnvLines(fields["variables"]);
        const res = await this.post<{ data?: NfSecretGroup }>(this.p(projectId, "/secrets"), {
          name: fields["name"],
          ...(fields["description"] ? { description: fields["description"] } : {}),
          secretType: fields["secretType"] || "environment-arguments",
          priority: num(fields["priority"]) ?? 10,
          type: "secret",
          secrets: { variables },
        });
        const id = res?.data?.id;
        if (!id) throw new Error("Northflank did not return the new secret group's id.");
        return this.getResource(
          T.secretGroup,
          `${accountId}:${T.secretGroup}:${projectChildId(projectId, id)}`,
          accountId,
        );
      }
      case T.volume: {
        const attach = fields["attachTo"] ? splitProjectChild(fields["attachTo"]) : undefined;
        const projectId = attach?.projectId ?? this.projectOf(fields, parentResourceId);
        if (fields["projectId"] && attach && attach.projectId !== fields["projectId"]) {
          throw new Error("The service must be in the same project as the volume.");
        }
        const res = await this.post<{ data?: NfVolume }>(this.p(projectId, "/volumes"), {
          name: fields["name"],
          mounts: [{ containerMountPath: fields["containerMountPath"] || "/data" }],
          spec: { accessMode: "ReadWriteOnce", storageSize: num(fields["storageSizeMb"]) ?? 5120 },
          ...(attach ? { attachedObjects: [{ id: attach.id, type: "service" }] } : {}),
        });
        const id = res?.data?.id;
        if (!id) throw new Error("Northflank did not return the new volume's id.");
        return this.getResource(
          T.volume,
          `${accountId}:${T.volume}:${projectChildId(projectId, id)}`,
          accountId,
        );
      }
      case T.domain: {
        const domain = (fields["domain"] ?? "").trim().toLowerCase();
        if (!domain) throw new Error("Give a domain.");
        await this.post("/v1/domains", { domain });
        return this.getResource(T.domain, `${accountId}:${T.domain}:${domain}`, accountId);
      }
      case T.subdomain: {
        const domain = fields["domain"] || (parentResourceId ? externalIdOf(parentResourceId) : "");
        if (!domain) throw new Error("Pick a domain.");
        const sub = (fields["subdomain"] ?? "").trim().toLowerCase();
        if (!sub) throw new Error("Give a subdomain.");
        await this.post(`/v1/domains/${encodeURIComponent(domain)}/subdomains`, { subdomain: sub });
        return this.getResource(
          T.subdomain,
          `${accountId}:${T.subdomain}:${domain}/${sub}`,
          accountId,
        );
      }
      default:
        throw new Error(`Northflank plugin: creating "${typeId}" is not supported`);
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
        const body: Record<string, unknown> = {};
        if (fields["description"] !== undefined) body["description"] = fields["description"];
        if (fields["color"] !== undefined) body["color"] = fields["color"];
        if (Object.keys(body).length) await nfFetch(this.ctx, "PATCH", this.p(ext), { body });
        break;
      }
      case T.service: {
        const { projectId, id } = splitProjectChild(ext);
        const current = await this.getResource(T.service, resourceId, accountId);
        const kind = String(current.fields["serviceType"] ?? "deployment");
        if (fields["description"] !== undefined) {
          await nfFetch(
            this.ctx,
            "PATCH",
            this.p(projectId, `/services/${kind}/${encodeURIComponent(id)}`),
            {
              body: { description: fields["description"] },
            },
          );
        }
        const instances = num(fields["instances"]);
        if (instances !== undefined && kind !== "build") {
          await this.post(this.p(projectId, `/services/${encodeURIComponent(id)}/scale`), {
            instances,
          });
        }
        break;
      }
      case T.job: {
        const { projectId, id } = splitProjectChild(ext);
        const base = this.p(projectId, `/jobs/${encodeURIComponent(id)}`);
        if (fields["description"] !== undefined) {
          await nfFetch(this.ctx, "PATCH", base, { body: { description: fields["description"] } });
        }
        const settings: Record<string, unknown> = {};
        if (fields["schedule"]) settings["schedule"] = fields["schedule"];
        if (fields["concurrencyPolicy"])
          settings["concurrencyPolicy"] = fields["concurrencyPolicy"];
        if (num(fields["backoffLimit"]) !== undefined)
          settings["backoffLimit"] = num(fields["backoffLimit"]);
        if (num(fields["activeDeadlineSeconds"]) !== undefined)
          settings["activeDeadlineSeconds"] = num(fields["activeDeadlineSeconds"]);
        if (Object.keys(settings).length) await this.post(`${base}/settings`, settings);
        break;
      }
      case T.addon: {
        const { projectId, id } = splitProjectChild(ext);
        const base = this.p(projectId, `/addons/${encodeURIComponent(id)}`);
        if (fields["description"] !== undefined) {
          await nfFetch(this.ctx, "PATCH", base, { body: { description: fields["description"] } });
        }
        const net: Record<string, unknown> = {};
        const tls = bool(fields["tlsEnabled"]);
        const external = bool(fields["externalAccessEnabled"]);
        if (tls !== undefined) net["tlsEnabled"] = tls;
        if (external !== undefined) net["externalAccessEnabled"] = external;
        if (external && tls === undefined) net["tlsEnabled"] = true;
        if (external && tls === false) throw new Error("Public access needs TLS.");
        if (Object.keys(net).length) await this.post(`${base}/network-settings`, net);
        break;
      }
      case T.secretGroup: {
        const { projectId, id } = splitProjectChild(ext);
        const body: Record<string, unknown> = {};
        if (fields["description"] !== undefined) body["description"] = fields["description"];
        if (fields["secretType"]) body["secretType"] = fields["secretType"];
        if (num(fields["priority"]) !== undefined) body["priority"] = num(fields["priority"]);
        if (Object.keys(body).length) {
          await nfFetch(
            this.ctx,
            "PATCH",
            this.p(projectId, `/secrets/${encodeURIComponent(id)}`),
            { body },
          );
        }
        break;
      }
      case T.volume: {
        const { projectId, id } = splitProjectChild(ext);
        const size = num(fields["storageSizeMb"]);
        if (size !== undefined) {
          await this.post(this.p(projectId, `/volumes/${encodeURIComponent(id)}`), {
            spec: { storageSize: size },
          });
        }
        break;
      }
      default:
        throw new Error(`Northflank plugin: updating "${typeId}" is not supported`);
    }
    this.invalidate();
    return this.getResource(typeId, resourceId, accountId);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const ext = externalIdOf(resourceId);
    this.invalidate();
    let path: string;
    switch (typeId) {
      case T.project:
        path = this.p(ext);
        break;
      case T.service:
      case T.job:
      case T.addon:
      case T.secretGroup:
      case T.volume: {
        const { projectId, id } = splitProjectChild(ext);
        const seg = {
          [T.service]: "services",
          [T.job]: "jobs",
          [T.addon]: "addons",
          [T.secretGroup]: "secrets",
          [T.volume]: "volumes",
        }[typeId];
        path = this.p(projectId, `/${seg}/${encodeURIComponent(id)}`);
        break;
      }
      case T.domain:
        path = `/v1/domains/${encodeURIComponent(ext)}`;
        break;
      case T.subdomain: {
        const [domain, sub] = this.splitSubdomain(ext);
        path = `/v1/domains/${encodeURIComponent(domain)}/subdomains/${encodeURIComponent(sub)}`;
        break;
      }
      case T.cluster:
        path = `/v1/cloud-providers/clusters/${encodeURIComponent(ext)}`;
        break;
      default:
        throw new Error(`Northflank plugin: deleting "${typeId}" is not supported`);
    }
    await nfFetch(this.ctx, "DELETE", path);
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
    if (typeId === T.service || typeId === T.addon) {
      const { projectId, id } = splitProjectChild(ext);
      const base = this.p(
        projectId,
        `/${typeId === T.service ? "services" : "addons"}/${encodeURIComponent(id)}`,
      );
      switch (actionId) {
        case "pause":
        case "resume":
        case "restart":
          await this.post(`${base}/${actionId}`);
          return;
      }
      if (typeId === T.service) {
        if (actionId === "clear-build-cache") {
          await nfFetch(this.ctx, "DELETE", `${base}/build-cache`);
          return;
        }
        if (actionId === "deploy-latest") {
          const svc = await this.getResource(T.service, resourceId, accountId);
          const buildServiceId = String(svc.fields["buildServiceId"] ?? "");
          if (!buildServiceId)
            throw new Error("This service does not deploy from a build service.");
          await this.post(`${base}/deployment`, {
            internal: {
              id: buildServiceId,
              branch: String(svc.fields["branch"] ?? "main"),
              buildSHA: "latest",
            },
          });
          return;
        }
      } else {
        if (actionId === "rotate-secrets") {
          await this.post(`${base}/secret-rotation`);
          return;
        }
        if (actionId === "finalise-rotation") {
          await this.post(`${base}/secret-rotation/finalise`);
          return;
        }
      }
    }
    if (typeId === T.job) {
      const { projectId, id } = splitProjectChild(ext);
      const base = this.p(projectId, `/jobs/${encodeURIComponent(id)}`);
      if (actionId === "run") return void (await this.post(`${base}/runs`));
      if (actionId === "suspend")
        return void (await this.post(`${base}/suspend`, { suspended: true }));
      if (actionId === "unsuspend")
        return void (await this.post(`${base}/suspend`, { suspended: false }));
    }
    if (typeId === T.volume && actionId === "detach") {
      const { projectId, id } = splitProjectChild(ext);
      await this.post(this.p(projectId, `/volumes/${encodeURIComponent(id)}/detach`));
      return;
    }
    if (typeId === T.domain && actionId === "verify") {
      await this.post(`/v1/domains/${encodeURIComponent(ext)}/verify`);
      return;
    }
    if (typeId === T.subdomain) {
      const [domain, sub] = this.splitSubdomain(ext);
      const base = `/v1/domains/${encodeURIComponent(domain)}/subdomains/${encodeURIComponent(sub)}`;
      switch (actionId) {
        case "verify":
          await this.post(`${base}/verify`);
          return;
        case "unassign":
          await nfFetch(this.ctx, "DELETE", `${base}/assign`);
          return;
        case "cdn-enable":
          await this.post(`${base}/cdn/enable`, {});
          return;
        case "cdn-disable":
          await this.post(`${base}/cdn/disable`, {});
          return;
        case "cdn-purge":
          await this.post(`${base}/cdn/purge`, {});
          return;
      }
    }
    if (typeId === T.cluster) {
      const m = /^node-(cordon|uncordon|drain):(.+)$/.exec(actionId);
      if (m) {
        await this.post(
          `/v1/cloud-providers/clusters/${encodeURIComponent(ext)}/nodes/${encodeURIComponent(m[2]!)}/${m[1]}`,
        );
        return;
      }
    }
    throw new Error(`Northflank plugin: unknown action "${actionId}" for "${typeId}"`);
  }

  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const form = decodePromptArgs(args);
    const ext = externalIdOf(resourceId);
    this.invalidate();
    if (typeId === T.service || typeId === T.job) {
      const { projectId, id } = splitProjectChild(ext);
      const base = this.p(
        projectId,
        `/${typeId === T.service ? "services" : "jobs"}/${encodeURIComponent(id)}`,
      );
      switch (command) {
        case "scale": {
          const body: Record<string, unknown> = {};
          const instances = num(form["instances"]);
          if (instances !== undefined && typeId === T.service) body["instances"] = instances;
          if (form["deploymentPlan"]) body["deploymentPlan"] = form["deploymentPlan"];
          if (!Object.keys(body).length) throw new Error("Nothing to change.");
          if (typeId === T.service) await this.post(`${base}/scale`, body);
          else await this.post(`${base}/scale`, { deploymentPlan: form["deploymentPlan"] });
          return { ok: true, message: "Scaling." };
        }
        case "build": {
          const body: Record<string, unknown> = {};
          if (form["branch"]) body["branch"] = form["branch"];
          if (form["sha"]) body["sha"] = form["sha"];
          const res = await this.post<{ data?: { id?: string } }>(`${base}/build`, body);
          return { ok: true, message: `Build ${res?.data?.id ?? ""} started.`.replace("  ", " ") };
        }
        case "deploy-image": {
          if (!form["imagePath"]) throw new Error("Give an image.");
          await this.post(`${base}/deployment`, { external: { imagePath: form["imagePath"] } });
          return { ok: true, message: "Deploying." };
        }
        case "set-env":
        case "unset-env": {
          const current = await this.get<{
            data?: { runtimeEnvironment?: Record<string, string> };
          }>(`${base}/runtime-environment`, { show: "this" });
          const env: Record<string, string> = { ...(current?.data?.runtimeEnvironment ?? {}) };
          if (command === "set-env") {
            const vars = parseEnvLines(form["variables"]);
            if (!Object.keys(vars).length) throw new Error("Give at least one KEY=value.");
            Object.assign(env, vars);
          } else {
            const keys = csv(form["keys"]);
            const missing = keys.filter((k) => !(k in env));
            if (missing.length === keys.length)
              throw new Error(`None of ${keys.join(", ")} are set here.`);
            for (const k of keys) delete env[k];
          }
          await this.post(`${base}/runtime-environment`, { runtimeEnvironment: env });
          return { ok: true, message: "Variables saved." };
        }
      }
    }
    if (typeId === T.addon) {
      const { projectId, id } = splitProjectChild(ext);
      const base = this.p(projectId, `/addons/${encodeURIComponent(id)}`);
      switch (command) {
        case "scale": {
          const body: Record<string, unknown> = {};
          if (form["deploymentPlan"]) body["deploymentPlan"] = form["deploymentPlan"];
          const storage = num(form["storage"]);
          const replicas = num(form["replicas"]);
          if (storage !== undefined) body["storage"] = storage;
          if (replicas !== undefined) body["replicas"] = replicas;
          if (!Object.keys(body).length) throw new Error("Nothing to change.");
          await this.post(`${base}/scale`, body);
          return { ok: true, message: "Scaling." };
        }
        case "backup": {
          await this.post(`${base}/backups`, {
            ...(form["name"] ? { name: form["name"] } : {}),
            backupType: form["backupType"] === "dump" ? "dump" : "snapshot",
          });
          return { ok: true, message: "Backup started." };
        }
        case "upgrade": {
          if (!form["version"]) throw new Error("Pick a version.");
          await this.post(`${base}/version`, { version: form["version"] });
          return { ok: true, message: "Upgrade started." };
        }
      }
    }
    if (typeId === T.secretGroup && (command === "set-vars" || command === "unset-vars")) {
      const { projectId, id } = splitProjectChild(ext);
      const path = this.p(projectId, `/secrets/${encodeURIComponent(id)}`);
      const current = await this.get<{ data?: NfSecretGroup }>(path, { show: "this" });
      const vars: Record<string, string> = { ...(current?.data?.secrets?.variables ?? {}) };
      if (command === "set-vars") {
        const add = parseEnvLines(form["variables"]);
        if (!Object.keys(add).length) throw new Error("Give at least one KEY=value.");
        Object.assign(vars, add);
      } else {
        for (const k of csv(form["keys"])) delete vars[k];
      }
      await nfFetch(this.ctx, "PATCH", path, { body: { secrets: { variables: vars } } });
      return { ok: true, message: "Variables saved." };
    }
    if (typeId === T.volume) {
      const { projectId, id } = splitProjectChild(ext);
      const base = this.p(projectId, `/volumes/${encodeURIComponent(id)}`);
      if (command === "backup") {
        await this.post(`${base}/backups`, {
          name: form["name"] || `backup-${new Date().toISOString().slice(0, 10)}`,
        });
        return { ok: true, message: "Backup started." };
      }
      if (command === "attach") {
        if (!form["serviceId"]) throw new Error("Pick a service.");
        if (form["containerMountPath"]) {
          await this.post(base, { mounts: [{ containerMountPath: form["containerMountPath"] }] });
        }
        await this.post(`${base}/attach`, { nfObject: { id: form["serviceId"], type: "service" } });
        return { ok: true, message: "Attached." };
      }
    }
    if (typeId === T.pipeline && command === "run-release") {
      const { projectId, id } = splitProjectChild(ext);
      if (!form["stage"]) throw new Error("Pick a stage.");
      await this.post(
        this.p(
          projectId,
          `/pipelines/${encodeURIComponent(id)}/release-flows/${encodeURIComponent(form["stage"])}/runs`,
        ),
        form["name"] ? { name: form["name"] } : {},
      );
      return { ok: true, message: "Release flow started." };
    }
    if (typeId === T.subdomain && command === "assign") {
      const [domain, sub] = this.splitSubdomain(ext);
      const parts = (form["target"] ?? "").split("/");
      if (parts.length < 3) throw new Error("Pick a service port.");
      const [projectId, serviceId, ...portParts] = parts;
      await this.post(
        `/v1/domains/${encodeURIComponent(domain)}/subdomains/${encodeURIComponent(sub)}/assign`,
        {
          projectId,
          serviceId,
          portName: portParts.join("/"),
        },
      );
      return { ok: true, message: "Assigned." };
    }
    void accountId;
    throw new Error(`Northflank plugin: command "${command}" is not supported for "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Observability
  // -------------------------------------------------------------------------

  private workloadBase(typeId: string, ext: string): string | null {
    const seg =
      typeId === T.service
        ? "services"
        : typeId === T.job
          ? "jobs"
          : typeId === T.addon
            ? "addons"
            : null;
    if (!seg) return null;
    const { projectId, id } = splitProjectChild(ext);
    return this.p(projectId, `/${seg}/${encodeURIComponent(id)}`);
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const base = this.workloadBase(resourceTypeId, externalIdOf(resourceId));
    if (!base) return [];
    const end = timeRange?.endMs ?? Date.now();
    const start = timeRange?.startMs ?? end - METRICS_WINDOW_MS;
    const metricTypes =
      resourceTypeId === T.service
        ? SERVICE_METRICS
        : resourceTypeId === T.job
          ? JOB_METRICS
          : ADDON_METRICS;
    const res = await this.get<{ data?: Record<string, NfMetricBlock> }>(`${base}/metrics`, {
      queryType: "range",
      metricTypes,
      startTime: new Date(start).toISOString(),
      endTime: new Date(end).toISOString(),
    });
    return metricBlocksToSeries(res?.data ?? {});
  }

  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    const base = this.workloadBase(typeId, externalIdOf(resourceId));
    if (!base)
      throw new Error("Northflank plugin: logs are available for services, jobs and addons.");
    const containers = typeId === T.addon ? ["Runtime"] : ["Runtime", "Build"];
    const active =
      params.container && containers.includes(params.container) ? params.container : "Runtime";
    const lineLimit = Math.min(Math.max(params.tailLines ?? 200, 1), 1000);
    const query: Query = {
      queryType: "range",
      lineLimit,
      direction: "backward",
      duration: 24 * 60 * 60,
    };
    const path = active === "Build" ? `${base}/build-logs` : `${base}/logs`;
    let lines: NfLogLine[] = [];
    try {
      const res = await this.get<{ data?: NfLogLine[] }>(path, query);
      lines = Array.isArray(res?.data) ? res.data : [];
    } catch (err) {
      if (statusOf(err) !== 404) throw err;
    }
    return {
      text:
        logLinesToText(lines) ||
        (active === "Build"
          ? "No build logs in the last 24 hours.\n"
          : "No log lines in the last 24 hours.\n"),
      containers,
      activeContainer: active,
    };
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const r = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = r.fields;
    const variant = (s: unknown): NonNullable<DashboardStat["variant"]> => {
      const v = String(s ?? "").toLowerCase();
      if (["running", "completed", "verified"].includes(v)) return "status-healthy";
      if (/fail|error/.test(v)) return "status-error";
      return "status-degraded";
    };
    switch (resourceTypeId) {
      case T.service:
        return [
          { label: "State", value: String(f["state"] ?? ""), variant: variant(f["state"]) },
          { label: "Instances", value: String(f["instances"] ?? "") },
          { label: "Plan", value: String(f["deploymentPlan"] ?? "") },
          { label: "Build", value: String(f["buildStatus"] ?? "") },
        ];
      case T.addon:
        return [
          { label: "Status", value: String(f["status"] ?? ""), variant: variant(f["status"]) },
          { label: "Version", value: String(f["version"] ?? "") },
          { label: "Plan", value: String(f["deploymentPlan"] ?? "") },
          { label: "Storage", value: f["storageMb"] !== undefined ? `${f["storageMb"]} MB` : "" },
        ];
      case T.job:
        return [
          { label: "Type", value: String(f["jobType"] ?? "") },
          { label: "Schedule", value: String(f["schedule"] ?? "") },
          { label: "Suspended", value: f["suspended"] === true ? "Yes" : "No" },
        ];
      default:
        return [{ label: "Status", value: String(f["status"] ?? f["state"] ?? "") }];
    }
  }

  fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[] | CostFetchResult> {
    return fetchNorthflankCostData(this.ctx, range, () => this.projects());
  }

  /** Exposed for tests. */
  dailyUsage(startTime: number, endTime: number) {
    return fetchDailyUsage(this.ctx, startTime, endTime);
  }
}

function guessVcs(url: string): string {
  if (/gitlab/i.test(url)) return "gitlab";
  if (/bitbucket/i.test(url)) return "bitbucket";
  if (/dev\.azure|visualstudio/i.test(url)) return "azure";
  return "github";
}
