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
  MetricSeries,
  PluginClient,
  ResourceInstance,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import {
  externalIdOf,
  ListTruncatedError,
  pathEncode,
  requireListPage,
  rethrowIncompleteList,
  type ApiBody,
} from "@infrawrench/plugin-base";
import type { EcContext } from "./api.js";
import { createEcContext, isProjectType, statusOf, VENDOR } from "./api.js";
import type { operations as BillingOperations } from "./api-types.billing.gen.js";
import type { operations as ServerlessOperations } from "./api-types.serverless.gen.js";
import {
  fetchCostsOverview,
  fetchElasticCostData,
  fetchElasticCreditBalance,
  listOrganizations,
} from "./cost-data.js";
import {
  hotTier,
  mapBudget,
  mapDeployment,
  mapExtension,
  mapOrganization,
  mapProject,
  mapServerlessTrafficFilter,
  mapTrafficFilter,
  parseBudgetExternalId,
  parseProjectExternalId,
  parseTags,
  PROJECT_TYPE_LABELS,
  projectExternalId,
  splitList,
} from "./mappers.js";
import {
  COST_METRICS_WINDOW_MS,
  instanceCostSeries,
  organizationCostSeries,
  rangeOrDefault,
} from "./metrics.js";
import {
  DEPLOYMENT_NAMES_KEY,
  INSTANCE_COSTS_KEY,
  OVERVIEW_KEY,
  REGION_FILTERS_KEY,
  TIERS_KEY,
  parseJson,
  renderElasticDetail,
  renderElasticSidebar,
  usd,
} from "./render.js";
import type {
  EcBudget,
  EcDeployment,
  EcDeploymentListing,
  EcOrganization,
  EcProject,
  EcServerlessRegion,
  EcServerlessTrafficFilter,
  EcTrafficRule,
  EcTrafficRuleset,
  ProjectType,
} from "./types.js";
import { PROJECT_TYPES } from "./types.js";

const DEPLOYMENT_CONCURRENCY = 4;
/** 50,000 filters at the document's largest page, 1,000, which is also its default. */
const SERVERLESS_FILTER_MAX_PAGES = 50;
const SOURCE_TYPES = new Set([
  "ip",
  "vpce",
  "gcp_private_service_connect_endpoint",
  "psc_endpoint",
]);
const RECIPIENT_GROUPS = [
  { id: "organization-admins", label: "Organization admins" },
  { id: "billing-admins", label: "Billing admins" },
  {
    id: "resource-viewers",
    label: "Resource viewers",
    description: "Deployment and project budgets only",
  },
  {
    id: "resource-editors",
    label: "Resource editors",
    description: "Deployment and project budgets only",
  },
  {
    id: "resource-admins",
    label: "Resource admins",
    description: "Deployment and project budgets only",
  },
];

async function mapLimited<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function startOfMonthIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** "50, 80, 100" → percentage alerts. */
export function thresholdsToAlerts(value: string | undefined) {
  return splitList(value)
    .map((s) => Number(s.replace(/%$/, "")))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((threshold) => ({
      operator: "gte" as const,
      threshold: Math.round(threshold),
      threshold_type: "percentage" as const,
    }));
}

/** A rule written from a source, which either API's traffic filters take. */
interface SourceRule {
  source?: string;
  description?: string;
}

/** The document says an array; an answer wrapped in `items` is read as well. */
function regionList(res: EcServerlessRegion[] | { items?: EcServerlessRegion[] }) {
  return Array.isArray(res) ? res : (res.items ?? []);
}

/** Sources to rules, keeping each existing rule's description when its source is kept. */
export function sourcesToRules(sources: string[], existing: EcTrafficRule[] = []): SourceRule[] {
  const known = new Map(
    existing
      .filter((r): r is EcTrafficRule & { source: string } => Boolean(r.source))
      .map((r): [string, EcTrafficRule] => [r.source, r]),
  );
  return sources.map((source) => {
    const prev = known.get(source);
    return prev?.description ? { source, description: prev.description } : { source };
  });
}

export class ElasticCloudClient implements PluginClient {
  private readonly ctx: EcContext;
  private readonly services: HostServices | undefined;

  constructor(credentials: Credentials, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    if (!apiKey) throw new Error("Elastic Cloud plugin: missing apiKey credential");
    const caCert = credentials["caCert"] ?? "";
    this.services = services;
    this.ctx = createEcContext({ apiKey, caCert, http: services?.http });
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  /**
   * A 403 on one list means the key's role does not cover that surface (a
   * Billing admin key cannot list deployments, a deployment-scoped key cannot
   * read budgets); the rest of the account still works, so that type lists
   * empty rather than failing the sync. A 401 still throws.
   */
  private async scoped(load: () => Promise<ResourceInstance[]>): Promise<ResourceInstance[]> {
    try {
      return await load();
    } catch (err) {
      const s = statusOf(err);
      if (s === 403 || s === 404) return [];
      throw err;
    }
  }

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      switch (typeId) {
        case "organization":
          return this.listOrganizationRows(accountId);
        case "deployment":
          return this.scoped(async () =>
            (await this.fetchDeployments()).map((d) => mapDeployment(accountId, d)),
          );
        case "project":
          return this.listProjects(accountId);
        case "traffic-filter":
          return this.scoped(async () =>
            (await this.fetchRulesets()).map((r) => mapTrafficFilter(accountId, r)),
          );
        case "serverless-traffic-filter":
          return (await this.fetchServerlessFilters()).map((t) =>
            mapServerlessTrafficFilter(accountId, t),
          );
        case "extension":
          return this.scoped(async () => {
            const path = "/deployments/extensions";
            const res = await this.ctx.cloud.get(path);
            return requireListPage(res.extensions, { vendor: VENDOR, path, key: "extensions" }).map(
              (e) => mapExtension(accountId, e),
            );
          });
        case "budget":
          return this.listBudgets(accountId);
        default:
          throw new Error(`Elastic Cloud plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  private async listOrganizationRows(accountId: string): Promise<ResourceInstance[]> {
    const orgs = await listOrganizations(this.ctx);
    return Promise.all(
      orgs.map(async (o) => {
        const overview = await fetchCostsOverview(this.ctx, o.id!).catch(() => undefined);
        return mapOrganization(accountId, o, overview);
      }),
    );
  }

  private async fetchDeployment(id: string): Promise<EcDeployment> {
    return this.ctx.cloud.get(`/deployments/${pathEncode(id)}`, {
      query: { show_plans: true, show_instance_metrics: true },
    });
  }

  private async fetchDeploymentListing(): Promise<EcDeploymentListing[]> {
    const path = "/deployments";
    const res = await this.ctx.cloud.get(path);
    return requireListPage(res.deployments, { vendor: VENDOR, path, key: "deployments" });
  }

  private async fetchDeployments(): Promise<EcDeployment[]> {
    const listing = (await this.fetchDeploymentListing()).filter((d) => d.id);
    return mapLimited(listing, DEPLOYMENT_CONCURRENCY, async (d): Promise<EcDeployment> => {
      try {
        return await this.fetchDeployment(d.id!);
      } catch (err) {
        if (statusOf(err) === 401) throw err;
        // One deployment that cannot be read in full still appears, thinly.
        const es = (d.resources ?? []).find((r) => r.kind === "elasticsearch");
        return {
          id: d.id!,
          ...(d.name ? { name: d.name } : {}),
          resources: {
            elasticsearch: es
              ? [
                  {
                    ...(es.ref_id ? { ref_id: es.ref_id } : {}),
                    ...(es.region ? { region: es.region } : {}),
                    info: { metadata: es.cloud_id ? { cloud_id: es.cloud_id } : {} },
                  },
                ]
              : [],
          },
        };
      }
    });
  }

  private async fetchProjectsOfType(type: ProjectType): Promise<EcProject[]> {
    try {
      const path = `/api/v1/serverless/projects/${pathEncode(type)}` as const;
      const res = await this.ctx.projects.get(path);
      return requireListPage<EcProject>(res.items, { vendor: VENDOR, path, key: "items" });
    } catch (err) {
      const s = statusOf(err);
      if (s === 403 || s === 404) return [];
      throw err;
    }
  }

  private async listProjects(accountId: string): Promise<ResourceInstance[]> {
    const perType = await Promise.all(PROJECT_TYPES.map((t) => this.fetchProjectsOfType(t)));
    return PROJECT_TYPES.flatMap((type, i) =>
      (perType[i] ?? []).filter((p) => p.id).map((p) => mapProject(accountId, type, p)),
    );
  }

  private async fetchRulesets(region?: string): Promise<EcTrafficRuleset[]> {
    const path = "/deployments/traffic-filter/rulesets";
    const res = await this.ctx.cloud.get(path, {
      query: { include_associations: true, ...(region ? { region } : {}) },
    });
    return requireListPage(res.rulesets, { vendor: VENDOR, path, key: "rulesets" });
  }

  /**
   * The token goes back in a header, which `getAll` has no way to send. The document
   * says to page until `next_page` is absent, as a token does not promise a next page
   * with anything on it, so an empty page does not end the list.
   */
  private async fetchServerlessFilters(): Promise<EcServerlessTrafficFilter[]> {
    const path = "/api/v1/serverless/traffic-filters";
    const out: EcServerlessTrafficFilter[] = [];
    let token: string | null | undefined;
    for (let page = 0; page < SERVERLESS_FILTER_MAX_PAGES; page++) {
      let res;
      try {
        res = await this.ctx.serverless.get(
          path,
          token ? { headers: { "X-Elastic-Next-Page": token } } : {},
        );
      } catch (err) {
        // Only a first answer can mean the key has no filters. Later on, the same
        // status would read the rows already in hand as none.
        const s = statusOf(err);
        if (page === 0 && (s === 403 || s === 404)) return [];
        throw err;
      }
      out.push(...requireListPage(res.items, { vendor: VENDOR, path, key: "items" }));
      token = res.next_page;
      if (!token) return out;
    }
    throw new ListTruncatedError({
      vendor: VENDOR,
      path,
      items: out.length,
      maxPages: SERVERLESS_FILTER_MAX_PAGES,
    });
  }

  private async fetchBudgets(orgId: string): Promise<EcBudget[]> {
    const path = `/api/v1/billing/organization/${pathEncode(orgId)}/budgets` as const;
    const res = await this.ctx.billing.get(path);
    return requireListPage(res, { vendor: VENDOR, path, key: null });
  }

  /** Deployment and project names by id, for labelling budgets and associations. */
  private async instanceNames(): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    // Only labels depend on these, but a list that came back unreadable must not pass
    // for an empty one on the way to `listResources`.
    const none = (err: unknown): [] => {
      rethrowIncompleteList(err);
      return [];
    };
    const [deployments, projects] = await Promise.all([
      this.fetchDeploymentListing().catch(none),
      Promise.all(PROJECT_TYPES.map((t) => this.fetchProjectsOfType(t).catch(none))),
    ]);
    for (const d of deployments) if (d.id) names.set(d.id, d.name ?? d.id);
    for (const p of projects.flat()) if (p.id) names.set(p.id, p.name ?? p.id);
    return names;
  }

  private async listBudgets(accountId: string): Promise<ResourceInstance[]> {
    return this.scoped(async () => {
      const orgs = await listOrganizations(this.ctx);
      const names = await this.instanceNames();
      const out: ResourceInstance[] = [];
      for (const o of orgs) {
        const budgets = await this.fetchBudgets(o.id!).catch((err): EcBudget[] => {
          if (statusOf(err) === 403 || statusOf(err) === 404) return [];
          throw err;
        });
        for (const b of budgets) out.push(mapBudget(accountId, o.id!, b, names));
      }
      return out;
    });
  }

  // -------------------------------------------------------------------------
  // Single reads
  // -------------------------------------------------------------------------

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      switch (typeId) {
        case "organization":
          return this.getOrganization(accountId, id);
        case "deployment":
          return this.getDeployment(accountId, id);
        case "project":
          return this.getProject(accountId, id);
        case "traffic-filter": {
          const r = await this.ctx.cloud.get(
            `/deployments/traffic-filter/rulesets/${pathEncode(id)}`,
            { query: { include_associations: true } },
          );
          const mapped = mapTrafficFilter(accountId, r);
          const names = await this.instanceNames().catch(() => new Map<string, string>());
          return {
            ...mapped,
            resolvedOutputs: {
              ...mapped.resolvedOutputs,
              [DEPLOYMENT_NAMES_KEY]: JSON.stringify(Object.fromEntries(names)),
            },
          };
        }
        case "serverless-traffic-filter": {
          const t = await this.ctx.serverless.get(
            `/api/v1/serverless/traffic-filters/${pathEncode(id)}`,
          );
          return mapServerlessTrafficFilter(accountId, t);
        }
        case "extension": {
          const e = await this.ctx.cloud.get(`/deployments/extensions/${pathEncode(id)}`, {
            query: { include_deployments: true },
          });
          return mapExtension(accountId, e);
        }
        case "budget": {
          const { orgId, budgetId } = parseBudgetExternalId(id);
          const b = await this.ctx.billing.get(
            `/api/v1/billing/organization/${pathEncode(orgId)}/budgets/${pathEncode(budgetId)}`,
          );
          const names = await this.instanceNames().catch(() => new Map<string, string>());
          return mapBudget(accountId, orgId, b, names);
        }
        default:
          throw new Error(`Elastic Cloud plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  private async getOrganization(accountId: string, orgId: string): Promise<ResourceInstance> {
    const orgs = await listOrganizations(this.ctx);
    const org: EcOrganization = orgs.find((o) => o.id === orgId) ?? { id: orgId, name: orgId };
    const [overview, costs] = await Promise.all([
      fetchCostsOverview(this.ctx, orgId).catch(() => undefined),
      this.ctx.billing
        .get(`/api/v2/billing/organizations/${pathEncode(orgId)}/costs/instances`, {
          query: { from: startOfMonthIso(), to: new Date().toISOString(), include_names: true },
        })
        .catch(() => undefined),
    ]);
    const mapped = mapOrganization(accountId, org, overview);
    return {
      ...mapped,
      resolvedOutputs: {
        ...mapped.resolvedOutputs,
        ...(overview ? { [OVERVIEW_KEY]: JSON.stringify(overview) } : {}),
        ...(costs ? { [INSTANCE_COSTS_KEY]: JSON.stringify(costs) } : {}),
      },
    };
  }

  private async getDeployment(accountId: string, id: string): Promise<ResourceInstance> {
    const d = await this.fetchDeployment(id);
    const mapped = mapDeployment(accountId, d);
    const esRef = String(mapped.fields["esRefId"] ?? "");
    const region = String(mapped.fields["region"] ?? "");
    const [tiers, rulesets] = await Promise.all([
      esRef
        ? this.ctx.cloud
            .get(`/deployments/${pathEncode(id)}/elasticsearch/${pathEncode(esRef)}/tiers`)
            .catch(() => undefined)
        : Promise.resolve(undefined),
      this.fetchRulesets(region || undefined).catch((): EcTrafficRuleset[] => []),
    ]);
    return {
      ...mapped,
      resolvedOutputs: {
        ...mapped.resolvedOutputs,
        ...(tiers ? { [TIERS_KEY]: JSON.stringify(tiers) } : {}),
        [REGION_FILTERS_KEY]: JSON.stringify(
          rulesets
            .filter((r) => r.id && (!region || r.region === region))
            .map((r) => ({ id: r.id, name: r.name ?? r.id, type: r.type })),
        ),
      },
    };
  }

  private async getProject(accountId: string, externalId: string): Promise<ResourceInstance> {
    const { type, id } = parseProjectExternalId(externalId);
    const [t, i] = [pathEncode(type), pathEncode(id)];
    const [p, status] = await Promise.all([
      this.ctx.projects.get(`/api/v1/serverless/projects/${t}/${i}`),
      this.ctx.projects.get(`/api/v1/serverless/projects/${t}/${i}/status`).catch(() => undefined),
    ]);
    return mapProject(accountId, type, p, status?.phase);
  }

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      if (typeId === "project" && outputKey === "password") {
        const stored = await this.services?.secrets?.getPlaintext(resourceId, "password");
        if (stored) return stored;
        throw new Error(
          "Elastic Cloud only shows a project's admin password when the project is created or its credentials are reset. Use Reset credentials to issue a new one.",
        );
      }
      const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      const resolved = resource.resolvedOutputs[outputKey];
      if (resolved !== undefined) return resolved;
      const field = resource.fields[outputKey];
      if (field !== undefined) return String(field);
      throw new Error(
        `Elastic Cloud plugin: cannot resolve output "${outputKey}" for type "${typeId}"`,
      );
    });
  }

  // -------------------------------------------------------------------------
  // Stats, metrics, costs, credits
  // -------------------------------------------------------------------------

  fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<DashboardStat[]> {
    return attempt(async () => {
      const r = await runPluginEffect(this.getResource(resourceTypeId, resourceId, accountId));
      const f = r.fields;
      switch (resourceTypeId) {
        case "organization":
          return [
            { label: "Month to Date", value: usd(f["monthToDate"]) || "—" },
            { label: "Hourly Rate", value: usd(f["hourlyRate"]) || "—" },
          ];
        case "deployment": {
          const instances =
            parseJson<
              Array<{ memoryPressure?: number; diskUsedMb?: number; diskAvailableMb?: number }>
            >(f["instancesJson"]) ?? [];
          const pressure = Math.max(
            -1,
            ...instances.map((i) => (typeof i.memoryPressure === "number" ? i.memoryPressure : -1)),
          );
          const disk = Math.max(
            -1,
            ...instances.map((i) =>
              i.diskAvailableMb && typeof i.diskUsedMb === "number"
                ? Math.round((i.diskUsedMb / i.diskAvailableMb) * 100)
                : -1,
            ),
          );
          const healthy = f["healthy"] !== false;
          return [
            {
              label: "Health",
              value: healthy ? "Healthy" : "Unhealthy",
              variant: healthy ? "status-healthy" : "status-error",
            },
            {
              label: "JVM Memory Pressure",
              value: pressure >= 0 ? `${pressure}%` : "—",
              ...(pressure >= 75
                ? { variant: "status-error" as const }
                : pressure >= 60
                  ? { variant: "status-degraded" as const }
                  : {}),
            },
            { label: "Disk Used", value: disk >= 0 ? `${disk}%` : "—" },
            { label: "Version", value: String(f["version"] ?? "—") },
          ];
        }
        case "project":
          return [
            { label: "Status", value: String(f["phase"] ?? "—") },
            { label: "Type", value: String(f["projectType"] ?? "—") },
            ...(f["searchPower"] !== undefined
              ? [{ label: "Search Power", value: String(f["searchPower"]) }]
              : []),
          ];
        case "budget":
          return [
            {
              label: "Monthly",
              value: f["amount"] !== undefined ? `${String(f["amount"])} ECU` : "—",
            },
            { label: "Active", value: f["active"] === false ? "No" : "Yes" },
          ];
        default:
          return [];
      }
    });
  }

  /** Organization for an instance: the one the project names, else the first that answers. */
  private async instanceCharts(
    instanceId: string,
    instanceType: "deployments" | "projects",
    orgHint: string | undefined,
    range: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const orgIds = orgHint ? [orgHint] : (await listOrganizations(this.ctx)).map((o) => o.id!);
    let lastErr: unknown;
    for (const orgId of orgIds) {
      try {
        return await instanceCostSeries(this.ctx, orgId, instanceId, instanceType, range);
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) throw lastErr;
    return [];
  }

  fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      const range = rangeOrDefault(timeRange, COST_METRICS_WINDOW_MS);
      switch (resourceTypeId) {
        case "organization":
          return organizationCostSeries(this.ctx, id, range);
        case "deployment":
          return this.instanceCharts(id, "deployments", undefined, range);
        case "project": {
          const { type, id: projectId } = parseProjectExternalId(id);
          const p = await this.ctx.projects
            .get(`/api/v1/serverless/projects/${pathEncode(type)}/${pathEncode(projectId)}`)
            .catch(() => undefined);
          return this.instanceCharts(projectId, "projects", p?.metadata?.organization_id, range);
        }
        default:
          return [];
      }
    });
  }

  fetchCostData(_accountId: string, range: CostFetchRange): PluginEffect<CostRow[]> {
    return attempt(async () => {
      return fetchElasticCostData(this.ctx, range);
    });
  }

  fetchCreditBalance(): PluginEffect<CreditBalance[]> {
    return attempt(async () => {
      return fetchElasticCreditBalance(this.ctx);
    });
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  private async serverlessRegions(): Promise<EcServerlessRegion[]> {
    const res = await this.ctx.serverless
      .get("/api/v1/serverless/regions")
      .catch((): EcServerlessRegion[] => []);
    const list = regionList(res);
    return list.filter((r) => r.id);
  }

  private regionField(regions: EcServerlessRegion[], description: string): CreateFieldConfig {
    return {
      key: "region",
      label: "Region",
      kind: "region-picker",
      required: true,
      description,
      regions: regions
        .filter((r) => r.project_creation_enabled !== false)
        .map((r) => ({
          id: r.id!,
          label: r.id!,
          location: [r.csp?.toUpperCase(), r.name].filter(Boolean).join(" · "),
        })),
    };
  }

  /** Hosted regions in use, from deployments and existing rulesets. */
  private async hostedRegions(): Promise<string[]> {
    const [deployments, rulesets] = await Promise.all([
      this.fetchDeploymentListing().catch((): EcDeploymentListing[] => []),
      this.fetchRulesets().catch((): EcTrafficRuleset[] => []),
    ]);
    const regions = new Set<string>();
    for (const d of deployments)
      for (const r of d.resources ?? []) if (r.region) regions.add(r.region);
    for (const r of rulesets) if (r.region) regions.add(r.region);
    return [...regions].sort();
  }

  getCreateConfig(typeId: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      switch (typeId) {
        case "project": {
          const regions = await this.serverlessRegions();
          return {
            fields: [
              {
                key: "name",
                label: "Name",
                kind: "text",
                required: true,
                placeholder: "my-project",
              },
              {
                key: "projectType",
                label: "Project type",
                kind: "select",
                required: true,
                defaultValue: "elasticsearch",
                options: PROJECT_TYPES.map((t) => ({
                  id: t,
                  label: PROJECT_TYPE_LABELS[t] ?? t,
                })),
              },
              this.regionField(regions, "Where the project runs. It cannot be moved later."),
              {
                key: "optimizedFor",
                label: "Optimized for",
                kind: "select",
                required: false,
                defaultValue: "general_purpose",
                showWhen: { fieldKey: "projectType", fieldValue: "elasticsearch" },
                options: [
                  {
                    id: "general_purpose",
                    label: "General purpose",
                    description: "Full-text search, sparse vectors and compressed dense vectors",
                  },
                  {
                    id: "vector",
                    label: "Vector",
                    description: "Uncompressed, high-dimensional dense vectors",
                  },
                ],
              },
              {
                key: "productTier",
                label: "Product tier",
                kind: "select",
                required: false,
                defaultValue: "complete",
                showWhen: { fieldKey: "projectType", fieldValue: "observability" },
                options: [
                  { id: "complete", label: "Complete" },
                  { id: "logs_essentials", label: "Logs Essentials" },
                ],
              },
            ],
          };
        }
        case "traffic-filter": {
          const [regions, deployments] = await Promise.all([
            this.hostedRegions(),
            this.fetchDeploymentListing().catch((): EcDeploymentListing[] => []),
          ]);
          return {
            fields: [
              {
                key: "name",
                label: "Name",
                kind: "text",
                required: true,
                placeholder: "office-ips",
              },
              {
                key: "region",
                label: "Region",
                kind: "select",
                required: true,
                description:
                  "A ruleset only applies to deployments in its own region. The list shows the regions your deployments run in.",
                options: regions.map((r) => ({ id: r, label: r })),
              },
              {
                key: "sources",
                label: "Allowed IP addresses or CIDR ranges",
                kind: "string-list",
                required: true,
                placeholder: "203.0.113.0/24",
                addLabel: "Add source",
              },
              { key: "description", label: "Description", kind: "text", required: false },
              {
                key: "includeByDefault",
                label: "Apply to new deployments",
                kind: "select",
                required: false,
                defaultValue: "false",
                options: [
                  { id: "false", label: "No" },
                  {
                    id: "true",
                    label: "Yes",
                    description: "New deployments in this region get it automatically",
                  },
                ],
              },
              {
                key: "deploymentIds",
                label: "Apply to deployments",
                kind: "policy-picker",
                required: false,
                description: "Only deployments in the selected region can use the filter.",
                policies: deployments
                  .filter((d) => d.id)
                  .map((d) => ({
                    id: d.id!,
                    label: d.name ?? d.id!,
                    category: d.resources?.find((r) => r.region)?.region ?? "Deployments",
                  })),
              },
            ],
          };
        }
        case "serverless-traffic-filter": {
          const regions = await this.serverlessRegions();
          return {
            fields: [
              {
                key: "name",
                label: "Name",
                kind: "text",
                required: true,
                placeholder: "office-ips",
              },
              this.regionField(regions, "A filter only applies to projects in its own region."),
              {
                key: "sources",
                label: "Allowed IP addresses or CIDR ranges",
                kind: "string-list",
                required: true,
                placeholder: "203.0.113.0/24",
                addLabel: "Add source",
              },
              { key: "description", label: "Description", kind: "text", required: false },
              {
                key: "includeByDefault",
                label: "Apply to new projects",
                kind: "select",
                required: false,
                defaultValue: "false",
                options: [
                  { id: "false", label: "No" },
                  { id: "true", label: "Yes" },
                ],
              },
            ],
          };
        }
        case "extension":
          return {
            fields: [
              {
                key: "name",
                label: "Name",
                kind: "text",
                required: true,
                placeholder: "my-synonyms",
                description: "Letters, digits, dots, dashes and underscores only.",
              },
              {
                key: "extensionType",
                label: "Type",
                kind: "select",
                required: true,
                defaultValue: "bundle",
                options: [
                  {
                    id: "bundle",
                    label: "Bundle",
                    description: "Scripts, dictionaries or synonym files",
                  },
                  { id: "plugin", label: "Plugin", description: "A compiled Elasticsearch plugin" },
                ],
              },
              {
                key: "version",
                label: "Elasticsearch version",
                kind: "text",
                required: true,
                placeholder: "8.*",
                description:
                  "The exact version for plugins (8.15.0); bundles accept a wildcard (8.*).",
              },
              {
                key: "downloadUrl",
                label: "Download URL",
                kind: "text",
                required: true,
                placeholder: "https://example.com/my-bundle.zip",
                description: "A public URL Elastic Cloud downloads the ZIP archive from.",
              },
              { key: "description", label: "Description", kind: "text", required: false },
            ],
          };
        case "budget": {
          const [orgs, names] = await Promise.all([
            listOrganizations(this.ctx),
            this.instanceNames().catch(() => new Map<string, string>()),
          ]);
          return {
            fields: [
              ...(orgs.length > 1
                ? [
                    {
                      key: "organizationId",
                      label: "Organization",
                      kind: "select" as const,
                      required: true,
                      defaultValue: orgs[0]?.id ?? "",
                      options: orgs.map((o) => ({ id: o.id!, label: o.name ?? o.id! })),
                    },
                  ]
                : [
                    {
                      key: "organizationId",
                      label: "Organization",
                      kind: "text" as const,
                      required: true,
                      hidden: true,
                      defaultValue: orgs[0]?.id ?? "",
                    },
                  ]),
              {
                key: "name",
                label: "Name",
                kind: "text",
                required: false,
                placeholder: "Production",
              },
              {
                key: "amount",
                label: "Monthly amount (ECU)",
                kind: "number",
                required: true,
                minValue: 1,
                description: "One ECU has a nominal value of $1.00.",
              },
              {
                key: "scope",
                label: "Applies to",
                kind: "select",
                required: true,
                defaultValue: "organization",
                options: [
                  { id: "organization", label: "The whole organization" },
                  ...[...names.entries()]
                    .sort((a, b) => a[1].localeCompare(b[1]))
                    .map(([id, name]) => ({ id, label: name })),
                ],
              },
              {
                key: "alertThresholds",
                label: "Alert at (% of budget)",
                kind: "string-list",
                required: false,
                defaultValue: "50,80,100",
                addLabel: "Add threshold",
              },
              {
                key: "recipients",
                label: "Who gets alerts",
                kind: "policy-picker",
                required: false,
                description:
                  "Organization and billing admins are notified when nothing is picked. Resource roles only apply to deployment and project budgets.",
                policies: RECIPIENT_GROUPS,
              },
            ],
          };
        }
        default:
          throw new Error(`Elastic Cloud plugin: cannot create "${typeId}" from Infrawrench`);
      }
    });
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      switch (typeId) {
        case "project": {
          const type = fields["projectType"] || "elasticsearch";
          if (!isProjectType(type)) throw new Error(`Unknown project type "${type}"`);
          const created = await this.ctx.projects.post(
            `/api/v1/serverless/projects/${pathEncode(type)}`,
            {
              body: {
                name: (fields["name"] ?? "").trim(),
                region_id: fields["region"],
                ...(type === "elasticsearch" && fields["optimizedFor"]
                  ? { optimized_for: fields["optimizedFor"] }
                  : {}),
                ...(type === "observability" && fields["productTier"]
                  ? { product_tier: fields["productTier"] }
                  : {}),
              },
            },
          );
          const resource = mapProject(accountId, type, created, "initializing");
          if (created.credentials?.password) {
            await this.services?.secrets?.setPlaintext?.(
              resource.id,
              "password",
              created.credentials.password,
            );
          }
          return resource;
        }
        case "traffic-filter": {
          const sources = splitList(fields["sources"]);
          const res = await this.ctx.cloud.post("/deployments/traffic-filter/rulesets", {
            body: {
              name: (fields["name"] ?? "").trim(),
              ...(fields["description"] ? { description: fields["description"] } : {}),
              type: "ip",
              region: fields["region"],
              include_by_default: fields["includeByDefault"] === "true",
              rules: sourcesToRules(sources),
            },
          });
          const rulesetId = res.id ?? "";
          const deploymentIds = parseJson<string[]>(fields["deploymentIds"]) ?? [];
          for (const d of deploymentIds) {
            await this.associate(rulesetId, d);
          }
          return runPluginEffect(
            this.getResource(
              "traffic-filter",
              `${accountId}:traffic-filter:${rulesetId}`,
              accountId,
            ),
          );
        }
        case "serverless-traffic-filter": {
          const created = await this.ctx.serverless.post("/api/v1/serverless/traffic-filters", {
            body: {
              name: (fields["name"] ?? "").trim(),
              ...(fields["description"] ? { description: fields["description"] } : {}),
              type: "ip",
              region: fields["region"],
              include_by_default: fields["includeByDefault"] === "true",
              rules: sourcesToRules(splitList(fields["sources"])),
            },
          });
          return mapServerlessTrafficFilter(accountId, created);
        }
        case "extension": {
          const e = await this.ctx.cloud.post("/deployments/extensions", {
            body: {
              name: (fields["name"] ?? "").trim(),
              extension_type: fields["extensionType"] || "bundle",
              version: (fields["version"] ?? "").trim(),
              download_url: (fields["downloadUrl"] ?? "").trim(),
              ...(fields["description"] ? { description: fields["description"] } : {}),
            },
          });
          return mapExtension(accountId, e);
        }
        case "budget": {
          const orgId = fields["organizationId"] || (await listOrganizations(this.ctx))[0]?.id;
          if (!orgId) throw new Error("This API key cannot see an Elastic Cloud organization.");
          const scope = fields["scope"] || "organization";
          const recipients = parseJson<string[]>(fields["recipients"]) ?? [];
          const amount = Math.round(Number(fields["amount"]));
          const body: ApiBody<BillingOperations["createBudgetV1"]> = {
            ...(fields["name"] ? { name: fields["name"].trim() } : {}),
            amount,
            period: "monthly",
            active: true,
            scope_type: scope === "organization" ? "organization" : "cloud_resource",
            scope_values: scope === "organization" ? [orgId] : [scope],
            alerts: thresholdsToAlerts(fields["alertThresholds"]),
            ...(recipients.length > 0 ? { recipient_group: recipients } : {}),
          };
          if (!Number.isFinite(amount) || amount <= 0) {
            throw new Error("Enter a monthly amount greater than zero.");
          }
          const res = await this.ctx.billing.post(
            `/api/v1/billing/organization/${pathEncode(orgId)}/budget`,
            { body },
          );
          return runPluginEffect(
            this.getResource(
              "budget",
              `${accountId}:budget:${orgId}/${String(res.id ?? "")}`,
              accountId,
            ),
          );
        }
        default:
          throw new Error(`Elastic Cloud plugin: cannot create "${typeId}" from Infrawrench`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      switch (typeId) {
        case "deployment":
          await this.updateDeployment(id, fields);
          return runPluginEffect(this.getResource("deployment", resourceId, accountId));
        case "project": {
          const { type, id: projectId } = parseProjectExternalId(id);
          const [t, i] = [pathEncode(type), pathEncode(projectId)];
          const body: {
            name?: string;
            search_lake?: { search_power: number };
            metadata?: { tags: Record<string, string | null> };
          } = {};
          if ("name" in fields) body.name = (fields["name"] ?? "").trim();
          if ("searchPower" in fields && fields["searchPower"] !== "") {
            if (type !== "elasticsearch" && type !== "vectordb") {
              throw new Error(
                "Search power only applies to Elasticsearch and Vector Database projects.",
              );
            }
            const power = Math.round(Number(fields["searchPower"]));
            if (!Number.isFinite(power) || power < 28 || power > 3000) {
              throw new Error("Search power must be between 28 and 3000.");
            }
            body.search_lake = { search_power: power };
          }
          if ("tags" in fields) {
            const current = await this.ctx.projects.get(`/api/v1/serverless/projects/${t}/${i}`);
            const next = new Map(parseTags(fields["tags"]).map((t) => [t.key, t.value]));
            const patch: Record<string, string | null> = {};
            for (const key of Object.keys(current.metadata?.tags ?? {})) {
              if (!next.has(key)) patch[key] = null;
            }
            for (const [k, v] of next) patch[k] = v || null;
            if (Object.keys(patch).length > 0) body.metadata = { tags: patch };
          }
          if (Object.keys(body).length > 0) {
            await this.ctx.projects.patch(`/api/v1/serverless/projects/${t}/${i}`, { body });
          }
          return runPluginEffect(this.getResource("project", resourceId, accountId));
        }
        case "traffic-filter": {
          const current = await this.ctx.cloud.get(
            `/deployments/traffic-filter/rulesets/${pathEncode(id)}`,
          );
          let rules: EcTrafficRule[] = current.rules ?? [];
          if ("sources" in fields) {
            if (!SOURCE_TYPES.has(current.type ?? "ip")) {
              throw new Error(
                "This filter's rules are private endpoint or remote cluster rules; change them in the Elastic Cloud console.",
              );
            }
            rules = sourcesToRules(splitList(fields["sources"]), rules).map((r) => ({
              ...r,
            }));
          }
          await this.ctx.cloud.put(`/deployments/traffic-filter/rulesets/${pathEncode(id)}`, {
            body: {
              name: "name" in fields ? (fields["name"] ?? "").trim() : current.name,
              description: "description" in fields ? fields["description"] : current.description,
              type: current.type,
              region: current.region,
              include_by_default:
                "includeByDefault" in fields
                  ? fields["includeByDefault"] === "true"
                  : (current.include_by_default ?? false),
              rules: rules.map(({ id: _id, ...rest }) => rest),
            },
          });
          return runPluginEffect(this.getResource("traffic-filter", resourceId, accountId));
        }
        case "serverless-traffic-filter": {
          const body: ApiBody<ServerlessOperations["patchTrafficFilter"]> = {};
          if ("name" in fields) body.name = (fields["name"] ?? "").trim();
          if ("description" in fields) body.description = fields["description"] ?? "";
          if ("includeByDefault" in fields)
            body.include_by_default = fields["includeByDefault"] === "true";
          if ("sources" in fields) {
            const current = await this.ctx.serverless.get(
              `/api/v1/serverless/traffic-filters/${pathEncode(id)}`,
            );
            if (current.type === "private_endpoint") {
              throw new Error(
                "Azure Private Link rules are not source lists; change them in the Elastic Cloud console.",
              );
            }
            body.rules = sourcesToRules(splitList(fields["sources"]), current.rules ?? []);
          }
          const t = await this.ctx.serverless.patch(
            `/api/v1/serverless/traffic-filters/${pathEncode(id)}`,
            { body },
          );
          return t?.id
            ? mapServerlessTrafficFilter(accountId, t)
            : runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "extension": {
          const current = await this.ctx.cloud.get(`/deployments/extensions/${pathEncode(id)}`);
          const e = await this.ctx.cloud.post(`/deployments/extensions/${pathEncode(id)}`, {
            body: {
              name: "name" in fields ? (fields["name"] ?? "").trim() : current.name,
              description: "description" in fields ? fields["description"] : current.description,
              version: "version" in fields ? (fields["version"] ?? "").trim() : current.version,
              extension_type: current.extension_type,
              ...(("downloadUrl" in fields ? fields["downloadUrl"] : current.download_url)
                ? {
                    download_url:
                      "downloadUrl" in fields ? fields["downloadUrl"] : current.download_url,
                  }
                : {}),
            },
          });
          return mapExtension(accountId, e);
        }
        case "budget": {
          const { orgId, budgetId } = parseBudgetExternalId(id);
          const current = await this.ctx.billing.get(
            `/api/v1/billing/organization/${pathEncode(orgId)}/budgets/${pathEncode(budgetId)}`,
          );
          const amount = "amount" in fields ? Math.round(Number(fields["amount"])) : current.amount;
          if (!Number.isFinite(amount) || (amount ?? 0) <= 0) {
            throw new Error("Enter a monthly amount greater than zero.");
          }
          const keptAmountAlerts = (current.alerts ?? [])
            .filter((a) => a.threshold_type === "amount")
            .map((a) => ({
              operator: a.operator,
              threshold: a.threshold,
              threshold_type: a.threshold_type,
            }));
          const alerts =
            "alertThresholds" in fields
              ? [...thresholdsToAlerts(fields["alertThresholds"]), ...keptAmountAlerts]
              : (current.alerts ?? []).map((a) => ({
                  operator: a.operator,
                  threshold: a.threshold,
                  threshold_type: a.threshold_type,
                }));
          await this.ctx.billing.post(
            `/api/v1/billing/organization/${pathEncode(orgId)}/budget/${pathEncode(budgetId)}`,
            {
              body: {
                ...("name" in fields
                  ? fields["name"]
                    ? { name: fields["name"].trim() }
                    : {}
                  : current.name
                    ? { name: current.name }
                    : {}),
                amount,
                period: current.period ?? "monthly",
                active: "active" in fields ? fields["active"] === "true" : (current.active ?? true),
                scope_type: current.scope_type ?? "organization",
                scope_values: current.scope_values ?? [orgId],
                alerts,
                ...(current.recipient_group?.length
                  ? { recipient_group: current.recipient_group }
                  : {}),
              },
            },
          );
          return runPluginEffect(this.getResource("budget", resourceId, accountId));
        }
        default:
          throw new Error(`Elastic Cloud plugin: "${typeId}" cannot be edited from Infrawrench`);
      }
    });
  }

  private async updateDeployment(id: string, fields: Record<string, string>): Promise<void> {
    const deployment = pathEncode(id);
    if ("name" in fields && (fields["name"] ?? "").trim()) {
      // Resources omitted from an update stay as they are; prune_orphans must
      // be false or Elastic Cloud would shut every unmentioned resource down.
      await this.ctx.cloud.put(`/deployments/${deployment}`, {
        body: { name: fields["name"]!.trim(), prune_orphans: false },
      });
    }
    if ("tags" in fields) {
      await this.ctx.cloud.put(`/deployments/${deployment}/tags`, {
        body: { tags: parseTags(fields["tags"]) },
      });
    }
    if (("hotSizeGb" in fields && fields["hotSizeGb"] !== "") || "hotZones" in fields) {
      const d = await this.fetchDeployment(id);
      const es = d.resources?.elasticsearch?.[0];
      if (!es?.ref_id) throw new Error("This deployment has no Elasticsearch resource to resize.");
      const ref = pathEncode(es.ref_id);
      const tiers = await this.ctx.cloud.get(
        `/deployments/${deployment}/elasticsearch/${ref}/tiers`,
      );
      const hot = tiers.hot_content;
      const current = hotTier(es.info?.plan_info?.current?.plan?.cluster_topology);
      const config: { memory_size?: number; zone_count?: number } = {};
      if ("hotSizeGb" in fields && fields["hotSizeGb"] !== "") {
        const mb = Math.round(Number(fields["hotSizeGb"]) * 1024);
        const sizes = hot?.available_sizes ?? [];
        if (!Number.isFinite(mb) || mb <= 0) throw new Error("Enter a hot tier size in GB.");
        if (sizes.length > 0 && !sizes.includes(mb)) {
          const options = sizes.map((s) => Math.round((s / 1024) * 100) / 100).join(", ");
          throw new Error(
            `Elastic Cloud offers these hot tier sizes for this deployment (GB RAM per zone): ${options}.`,
          );
        }
        config.memory_size = mb;
      }
      if ("hotZones" in fields && fields["hotZones"]) {
        config.zone_count = Number(fields["hotZones"]);
      }
      if (
        config.memory_size === (hot?.memory_size ?? current?.size?.value) &&
        (config.zone_count === undefined ||
          config.zone_count === (hot?.zone_count ?? current?.zone_count))
      ) {
        return;
      }
      await this.ctx.cloud.patch(`/deployments/${deployment}/elasticsearch/${ref}/tiers`, {
        body: { hot_content: config },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  deleteResource(typeId: string, resourceId: string, _accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      switch (typeId) {
        case "deployment":
          // Elastic Cloud has no hard delete for deployments: shutting one down
          // stops it and its billing, and it is removed after the retention period.
          await this.ctx.cloud.post(`/deployments/${pathEncode(id)}/_shutdown`);
          return;
        case "project": {
          const { type, id: projectId } = parseProjectExternalId(id);
          await this.ctx.projects.delete(
            `/api/v1/serverless/projects/${pathEncode(type)}/${pathEncode(projectId)}`,
          );
          return;
        }
        case "traffic-filter":
          await this.ctx.cloud.delete(`/deployments/traffic-filter/rulesets/${pathEncode(id)}`, {
            query: { ignore_associations: true },
          });
          return;
        case "serverless-traffic-filter":
          await this.ctx.serverless.delete(`/api/v1/serverless/traffic-filters/${pathEncode(id)}`);
          return;
        case "extension":
          await this.ctx.cloud.delete(`/deployments/extensions/${pathEncode(id)}`);
          return;
        case "budget": {
          const { orgId, budgetId } = parseBudgetExternalId(id);
          await this.ctx.billing.delete(
            `/api/v1/billing/organization/${pathEncode(orgId)}/budgets/${pathEncode(budgetId)}`,
          );
          return;
        }
        default:
          throw new Error(`Elastic Cloud plugin: "${typeId}" cannot be deleted from Infrawrench`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private async associate(rulesetId: string, deploymentId: string): Promise<void> {
    await this.ctx.cloud.post(
      `/deployments/traffic-filter/rulesets/${pathEncode(rulesetId)}/associations`,
      { body: { entity_type: "deployment", id: deploymentId } },
    );
  }

  private async dissociate(rulesetId: string, deploymentId: string): Promise<void> {
    await this.ctx.cloud.delete(
      `/deployments/traffic-filter/rulesets/${pathEncode(rulesetId)}/associations/${pathEncode("deployment")}/${pathEncode(deploymentId)}`,
    );
  }

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      if (typeId === "deployment") {
        if (actionId === "restart-elasticsearch" || actionId === "restart-kibana") {
          const kind = actionId === "restart-kibana" ? "kibana" : "elasticsearch";
          const d = await this.fetchDeployment(id);
          const ref = d.resources?.[kind]?.[0]?.ref_id;
          if (!ref)
            throw new Error(
              `This deployment has no ${kind === "kibana" ? "Kibana" : "Elasticsearch"} resource.`,
            );
          if (kind === "kibana") {
            await this.ctx.cloud.post(
              `/deployments/${pathEncode(id)}/${pathEncode(kind)}/${pathEncode(ref)}/_restart`,
            );
          } else {
            await this.ctx.cloud.post(
              `/deployments/${pathEncode(id)}/elasticsearch/${pathEncode(ref)}/_restart`,
            );
          }
          return;
        }
        if (actionId.startsWith("attach-filter:")) {
          await this.associate(actionId.slice("attach-filter:".length), id);
          return;
        }
        if (actionId.startsWith("detach-filter:")) {
          await this.dissociate(actionId.slice("detach-filter:".length), id);
          return;
        }
      }
      if (typeId === "traffic-filter" && actionId.startsWith("detach-deployment:")) {
        await this.dissociate(id, actionId.slice("detach-deployment:".length));
        return;
      }
      if (typeId === "project") {
        const { type, id: projectId } = parseProjectExternalId(id);
        const [t, i] = [pathEncode(type), pathEncode(projectId)];
        if (actionId === "resume") {
          await this.ctx.projects.post(`/api/v1/serverless/projects/${t}/${i}/_resume`);
          return;
        }
        if (actionId === "reset-credentials") {
          const creds = await this.ctx.projects.post(
            `/api/v1/serverless/projects/${t}/${i}/_reset-credentials`,
          );
          if (creds?.password) {
            if (!this.services?.secrets?.setPlaintext) {
              throw new Error(
                "The credentials were reset, but this host cannot store the new password. Reset them again from the Elastic Cloud console to see it.",
              );
            }
            await this.services.secrets.setPlaintext(resourceId, "password", creds.password);
          }
          return;
        }
      }
      throw new Error(`Elastic Cloud plugin: unknown action "${actionId}" for "${typeId}"`);
    });
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderElasticDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderElasticSidebar(resource);
  }
}
