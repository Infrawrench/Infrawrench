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
import { externalIdOf } from "@infrawrench/plugin-base";
import type { EcContext } from "./api.js";
import { billingApi, cloudApi, statusOf } from "./api.js";
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
  EcExtension,
  EcInstanceCosts,
  EcOrganization,
  EcProject,
  EcServerlessRegion,
  EcServerlessTrafficFilter,
  EcTiers,
  EcTrafficRule,
  EcTrafficRuleset,
  ProjectType,
} from "./types.js";
import { PROJECT_TYPES } from "./types.js";

const DEPLOYMENT_CONCURRENCY = 4;
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

/** Sources to rules, keeping each existing rule's description when its source is kept. */
export function sourcesToRules(sources: string[], existing: EcTrafficRule[] = []): EcTrafficRule[] {
  const known = new Map(existing.filter((r) => r.source).map((r) => [r.source as string, r]));
  return sources.map((source) => {
    const prev = known.get(source);
    return prev?.description ? { source, description: prev.description } : { source };
  });
}

export class ElasticCloudClient implements PluginClient {
  private readonly ctx: EcContext;
  private readonly services: HostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    if (!apiKey) throw new Error("Elastic Cloud plugin: missing apiKey credential");
    const caCert = credentials["caCert"] ?? "";
    this.services = services;
    this.ctx = {
      apiKey,
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
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

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
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
        return this.scoped(async () =>
          (await this.fetchServerlessFilters()).map((t) =>
            mapServerlessTrafficFilter(accountId, t),
          ),
        );
      case "extension":
        return this.scoped(async () => {
          const res = await cloudApi<{ extensions?: EcExtension[] }>(
            this.ctx,
            "/api/v1/deployments/extensions",
          );
          return (res.extensions ?? []).map((e) => mapExtension(accountId, e));
        });
      case "budget":
        return this.listBudgets(accountId);
      default:
        throw new Error(`Elastic Cloud plugin: unknown resource type "${typeId}"`);
    }
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
    return cloudApi<EcDeployment>(this.ctx, `/api/v1/deployments/${encodeURIComponent(id)}`, {
      query: { show_plans: true, show_instance_metrics: true },
    });
  }

  private async fetchDeployments(): Promise<EcDeployment[]> {
    const res = await cloudApi<{ deployments?: EcDeploymentListing[] }>(
      this.ctx,
      "/api/v1/deployments",
    );
    const listing = (res.deployments ?? []).filter((d) => d.id);
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
      const res = await cloudApi<{ items?: EcProject[] }>(
        this.ctx,
        `/api/v1/serverless/projects/${type}`,
      );
      return res.items ?? [];
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
    const res = await cloudApi<{ rulesets?: EcTrafficRuleset[] }>(
      this.ctx,
      "/api/v1/deployments/traffic-filter/rulesets",
      { query: { include_associations: true, ...(region ? { region } : {}) } },
    );
    return res.rulesets ?? [];
  }

  private async fetchServerlessFilters(): Promise<EcServerlessTrafficFilter[]> {
    const res = await cloudApi<{ items?: EcServerlessTrafficFilter[] }>(
      this.ctx,
      "/api/v1/serverless/traffic-filters",
    );
    return res.items ?? [];
  }

  private async fetchBudgets(orgId: string): Promise<EcBudget[]> {
    const res = await billingApi<EcBudget[]>(
      this.ctx,
      `/api/v1/billing/organization/${encodeURIComponent(orgId)}/budgets`,
    );
    return Array.isArray(res) ? res : [];
  }

  /** Deployment and project names by id, for labelling budgets and associations. */
  private async instanceNames(): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const [deployments, projects] = await Promise.all([
      cloudApi<{ deployments?: EcDeploymentListing[] }>(this.ctx, "/api/v1/deployments")
        .then((r) => r.deployments ?? [])
        .catch(() => [] as EcDeploymentListing[]),
      Promise.all(PROJECT_TYPES.map((t) => this.fetchProjectsOfType(t).catch(() => []))),
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
        const budgets = await this.fetchBudgets(o.id!).catch((err) => {
          if (statusOf(err) === 403 || statusOf(err) === 404) return [] as EcBudget[];
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

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    switch (typeId) {
      case "organization":
        return this.getOrganization(accountId, id);
      case "deployment":
        return this.getDeployment(accountId, id);
      case "project":
        return this.getProject(accountId, id);
      case "traffic-filter": {
        const r = await cloudApi<EcTrafficRuleset>(
          this.ctx,
          `/api/v1/deployments/traffic-filter/rulesets/${encodeURIComponent(id)}`,
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
        const t = await cloudApi<EcServerlessTrafficFilter>(
          this.ctx,
          `/api/v1/serverless/traffic-filters/${encodeURIComponent(id)}`,
        );
        return mapServerlessTrafficFilter(accountId, t);
      }
      case "extension": {
        const e = await cloudApi<EcExtension>(
          this.ctx,
          `/api/v1/deployments/extensions/${encodeURIComponent(id)}`,
          { query: { include_deployments: true } },
        );
        return mapExtension(accountId, e);
      }
      case "budget": {
        const { orgId, budgetId } = parseBudgetExternalId(id);
        const b = await billingApi<EcBudget>(
          this.ctx,
          `/api/v1/billing/organization/${encodeURIComponent(orgId)}/budgets/${encodeURIComponent(budgetId)}`,
        );
        const names = await this.instanceNames().catch(() => new Map<string, string>());
        return mapBudget(accountId, orgId, b, names);
      }
      default:
        throw new Error(`Elastic Cloud plugin: unknown resource type "${typeId}"`);
    }
  }

  private async getOrganization(accountId: string, orgId: string): Promise<ResourceInstance> {
    const orgs = await listOrganizations(this.ctx);
    const org: EcOrganization = orgs.find((o) => o.id === orgId) ?? { id: orgId, name: orgId };
    const [overview, costs] = await Promise.all([
      fetchCostsOverview(this.ctx, orgId).catch(() => undefined),
      billingApi<EcInstanceCosts>(
        this.ctx,
        `/api/v2/billing/organizations/${encodeURIComponent(orgId)}/costs/instances`,
        { query: { from: startOfMonthIso(), to: new Date().toISOString(), include_names: true } },
      ).catch(() => undefined),
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
        ? cloudApi<EcTiers>(
            this.ctx,
            `/api/v1/deployments/${encodeURIComponent(id)}/elasticsearch/${encodeURIComponent(esRef)}/tiers`,
          ).catch(() => undefined)
        : Promise.resolve(undefined),
      this.fetchRulesets(region || undefined).catch(() => [] as EcTrafficRuleset[]),
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
    const base = `/api/v1/serverless/projects/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;
    const [p, status] = await Promise.all([
      cloudApi<EcProject>(this.ctx, base),
      cloudApi<{ phase?: string }>(this.ctx, `${base}/status`).catch(() => undefined),
    ]);
    return mapProject(accountId, type, p, status?.phase);
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "project" && outputKey === "password") {
      const stored = await this.services?.secrets?.getPlaintext(resourceId, "password");
      if (stored) return stored;
      throw new Error(
        "Elastic Cloud only shows a project's admin password when the project is created or its credentials are reset. Use Reset credentials to issue a new one.",
      );
    }
    const resource = await this.getResource(typeId, resourceId, accountId);
    const resolved = resource.resolvedOutputs[outputKey];
    if (resolved !== undefined) return resolved;
    const field = resource.fields[outputKey];
    if (field !== undefined) return String(field);
    throw new Error(
      `Elastic Cloud plugin: cannot resolve output "${outputKey}" for type "${typeId}"`,
    );
  }

  // -------------------------------------------------------------------------
  // Stats, metrics, costs, credits
  // -------------------------------------------------------------------------

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const r = await this.getResource(resourceTypeId, resourceId, accountId);
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

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const id = externalIdOf(resourceId);
    const range = rangeOrDefault(timeRange, COST_METRICS_WINDOW_MS);
    switch (resourceTypeId) {
      case "organization":
        return organizationCostSeries(this.ctx, id, range);
      case "deployment":
        return this.instanceCharts(id, "deployments", undefined, range);
      case "project": {
        const { type, id: projectId } = parseProjectExternalId(id);
        const p = await cloudApi<EcProject>(
          this.ctx,
          `/api/v1/serverless/projects/${encodeURIComponent(type)}/${encodeURIComponent(projectId)}`,
        ).catch(() => undefined);
        return this.instanceCharts(projectId, "projects", p?.metadata?.organization_id, range);
      }
      default:
        return [];
    }
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchElasticCostData(this.ctx, range);
  }

  async fetchCreditBalance(): Promise<CreditBalance[]> {
    return fetchElasticCreditBalance(this.ctx);
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  private async serverlessRegions(): Promise<EcServerlessRegion[]> {
    const res = await cloudApi<EcServerlessRegion[] | { items?: EcServerlessRegion[] }>(
      this.ctx,
      "/api/v1/serverless/regions",
    ).catch(() => [] as EcServerlessRegion[]);
    const list = Array.isArray(res) ? res : (res.items ?? []);
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
      cloudApi<{ deployments?: EcDeploymentListing[] }>(this.ctx, "/api/v1/deployments")
        .then((r) => r.deployments ?? [])
        .catch(() => [] as EcDeploymentListing[]),
      this.fetchRulesets().catch(() => [] as EcTrafficRuleset[]),
    ]);
    const regions = new Set<string>();
    for (const d of deployments)
      for (const r of d.resources ?? []) if (r.region) regions.add(r.region);
    for (const r of rulesets) if (r.region) regions.add(r.region);
    return [...regions].sort();
  }

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case "project": {
        const regions = await this.serverlessRegions();
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "my-project" },
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
          cloudApi<{ deployments?: EcDeploymentListing[] }>(this.ctx, "/api/v1/deployments")
            .then((r) => r.deployments ?? [])
            .catch(() => [] as EcDeploymentListing[]),
        ]);
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "office-ips" },
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
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "office-ips" },
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
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    switch (typeId) {
      case "project": {
        const type = (fields["projectType"] || "elasticsearch") as ProjectType;
        if (!PROJECT_TYPES.includes(type)) throw new Error(`Unknown project type "${type}"`);
        const body: Record<string, unknown> = {
          name: (fields["name"] ?? "").trim(),
          region_id: fields["region"],
        };
        if (type === "elasticsearch" && fields["optimizedFor"]) {
          body["optimized_for"] = fields["optimizedFor"];
        }
        if (type === "observability" && fields["productTier"]) {
          body["product_tier"] = fields["productTier"];
        }
        const created = await cloudApi<
          EcProject & { credentials?: { username?: string; password?: string } }
        >(this.ctx, `/api/v1/serverless/projects/${type}`, {
          method: "POST",
          body: JSON.stringify(body),
        });
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
        const res = await cloudApi<{ id?: string }>(
          this.ctx,
          "/api/v1/deployments/traffic-filter/rulesets",
          {
            method: "POST",
            body: JSON.stringify({
              name: (fields["name"] ?? "").trim(),
              ...(fields["description"] ? { description: fields["description"] } : {}),
              type: "ip",
              region: fields["region"],
              include_by_default: fields["includeByDefault"] === "true",
              rules: sourcesToRules(sources),
            }),
          },
        );
        const rulesetId = res.id ?? "";
        const deploymentIds = parseJson<string[]>(fields["deploymentIds"]) ?? [];
        for (const d of deploymentIds) {
          await this.associate(rulesetId, d);
        }
        return this.getResource(
          "traffic-filter",
          `${accountId}:traffic-filter:${rulesetId}`,
          accountId,
        );
      }
      case "serverless-traffic-filter": {
        const created = await cloudApi<EcServerlessTrafficFilter>(
          this.ctx,
          "/api/v1/serverless/traffic-filters",
          {
            method: "POST",
            body: JSON.stringify({
              name: (fields["name"] ?? "").trim(),
              ...(fields["description"] ? { description: fields["description"] } : {}),
              type: "ip",
              region: fields["region"],
              include_by_default: fields["includeByDefault"] === "true",
              rules: sourcesToRules(splitList(fields["sources"])),
            }),
          },
        );
        return mapServerlessTrafficFilter(accountId, created);
      }
      case "extension": {
        const e = await cloudApi<EcExtension>(this.ctx, "/api/v1/deployments/extensions", {
          method: "POST",
          body: JSON.stringify({
            name: (fields["name"] ?? "").trim(),
            extension_type: fields["extensionType"] || "bundle",
            version: (fields["version"] ?? "").trim(),
            download_url: (fields["downloadUrl"] ?? "").trim(),
            ...(fields["description"] ? { description: fields["description"] } : {}),
          }),
        });
        return mapExtension(accountId, e);
      }
      case "budget": {
        const orgId = fields["organizationId"] || (await listOrganizations(this.ctx))[0]?.id;
        if (!orgId) throw new Error("This API key cannot see an Elastic Cloud organization.");
        const scope = fields["scope"] || "organization";
        const recipients = parseJson<string[]>(fields["recipients"]) ?? [];
        const body = {
          ...(fields["name"] ? { name: fields["name"].trim() } : {}),
          amount: Math.round(Number(fields["amount"])),
          period: "monthly",
          active: true,
          scope_type: scope === "organization" ? "organization" : "cloud_resource",
          scope_values: scope === "organization" ? [orgId] : [scope],
          alerts: thresholdsToAlerts(fields["alertThresholds"]),
          ...(recipients.length > 0 ? { recipient_group: recipients } : {}),
        };
        if (!Number.isFinite(body.amount) || body.amount <= 0) {
          throw new Error("Enter a monthly amount greater than zero.");
        }
        const res = await billingApi<{ id?: number }>(
          this.ctx,
          `/api/v1/billing/organization/${encodeURIComponent(orgId)}/budget`,
          { method: "POST", body: JSON.stringify(body) },
        );
        return this.getResource(
          "budget",
          `${accountId}:budget:${orgId}/${String(res.id ?? "")}`,
          accountId,
        );
      }
      default:
        throw new Error(`Elastic Cloud plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    switch (typeId) {
      case "deployment":
        await this.updateDeployment(id, fields);
        return this.getResource("deployment", resourceId, accountId);
      case "project": {
        const { type, id: projectId } = parseProjectExternalId(id);
        const path = `/api/v1/serverless/projects/${encodeURIComponent(type)}/${encodeURIComponent(projectId)}`;
        const body: Record<string, unknown> = {};
        if ("name" in fields) body["name"] = (fields["name"] ?? "").trim();
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
          body["search_lake"] = { search_power: power };
        }
        if ("tags" in fields) {
          const current = await cloudApi<EcProject>(this.ctx, path);
          const next = new Map(parseTags(fields["tags"]).map((t) => [t.key, t.value]));
          const patch: Record<string, string | null> = {};
          for (const key of Object.keys(current.metadata?.tags ?? {})) {
            if (!next.has(key)) patch[key] = null;
          }
          for (const [k, v] of next) patch[k] = v || null;
          if (Object.keys(patch).length > 0) body["metadata"] = { tags: patch };
        }
        if (Object.keys(body).length > 0) {
          await cloudApi<unknown>(this.ctx, path, { method: "PATCH", body: JSON.stringify(body) });
        }
        return this.getResource("project", resourceId, accountId);
      }
      case "traffic-filter": {
        const path = `/api/v1/deployments/traffic-filter/rulesets/${encodeURIComponent(id)}`;
        const current = await cloudApi<EcTrafficRuleset>(this.ctx, path);
        let rules = current.rules ?? [];
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
        await cloudApi<unknown>(this.ctx, path, {
          method: "PUT",
          body: JSON.stringify({
            name: "name" in fields ? (fields["name"] ?? "").trim() : current.name,
            description: "description" in fields ? fields["description"] : current.description,
            type: current.type,
            region: current.region,
            include_by_default:
              "includeByDefault" in fields
                ? fields["includeByDefault"] === "true"
                : (current.include_by_default ?? false),
            rules: rules.map(({ id: _id, ...rest }) => rest),
          }),
        });
        return this.getResource("traffic-filter", resourceId, accountId);
      }
      case "serverless-traffic-filter": {
        const path = `/api/v1/serverless/traffic-filters/${encodeURIComponent(id)}`;
        const body: Record<string, unknown> = {};
        if ("name" in fields) body["name"] = (fields["name"] ?? "").trim();
        if ("description" in fields) body["description"] = fields["description"] ?? "";
        if ("includeByDefault" in fields)
          body["include_by_default"] = fields["includeByDefault"] === "true";
        if ("sources" in fields) {
          const current = await cloudApi<EcServerlessTrafficFilter>(this.ctx, path);
          if (current.type === "private_endpoint") {
            throw new Error(
              "Azure Private Link rules are not source lists; change them in the Elastic Cloud console.",
            );
          }
          body["rules"] = sourcesToRules(splitList(fields["sources"]), current.rules ?? []);
        }
        const t = await cloudApi<EcServerlessTrafficFilter>(this.ctx, path, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        return t?.id
          ? mapServerlessTrafficFilter(accountId, t)
          : this.getResource(typeId, resourceId, accountId);
      }
      case "extension": {
        const path = `/api/v1/deployments/extensions/${encodeURIComponent(id)}`;
        const current = await cloudApi<EcExtension>(this.ctx, path);
        const e = await cloudApi<EcExtension>(this.ctx, path, {
          method: "POST",
          body: JSON.stringify({
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
          }),
        });
        return mapExtension(accountId, e);
      }
      case "budget": {
        const { orgId, budgetId } = parseBudgetExternalId(id);
        const current = await billingApi<EcBudget>(
          this.ctx,
          `/api/v1/billing/organization/${encodeURIComponent(orgId)}/budgets/${encodeURIComponent(budgetId)}`,
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
        await billingApi<unknown>(
          this.ctx,
          `/api/v1/billing/organization/${encodeURIComponent(orgId)}/budget/${encodeURIComponent(budgetId)}`,
          {
            method: "POST",
            body: JSON.stringify({
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
            }),
          },
        );
        return this.getResource("budget", resourceId, accountId);
      }
      default:
        throw new Error(`Elastic Cloud plugin: "${typeId}" cannot be edited from Infrawrench`);
    }
  }

  private async updateDeployment(id: string, fields: Record<string, string>): Promise<void> {
    const base = `/api/v1/deployments/${encodeURIComponent(id)}`;
    if ("name" in fields && (fields["name"] ?? "").trim()) {
      // Resources omitted from an update stay as they are; prune_orphans must
      // be false or Elastic Cloud would shut every unmentioned resource down.
      await cloudApi<unknown>(this.ctx, base, {
        method: "PUT",
        body: JSON.stringify({ name: fields["name"]!.trim(), prune_orphans: false }),
      });
    }
    if ("tags" in fields) {
      await cloudApi<unknown>(this.ctx, `${base}/tags`, {
        method: "PUT",
        body: JSON.stringify({ tags: parseTags(fields["tags"]) }),
      });
    }
    if (("hotSizeGb" in fields && fields["hotSizeGb"] !== "") || "hotZones" in fields) {
      const d = await this.fetchDeployment(id);
      const es = d.resources?.elasticsearch?.[0];
      if (!es?.ref_id) throw new Error("This deployment has no Elasticsearch resource to resize.");
      const tiersPath = `${base}/elasticsearch/${encodeURIComponent(es.ref_id)}/tiers`;
      const tiers = await cloudApi<EcTiers>(this.ctx, tiersPath);
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
      await cloudApi<unknown>(this.ctx, tiersPath, {
        method: "PATCH",
        body: JSON.stringify({ hot_content: config }),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const id = externalIdOf(resourceId);
    switch (typeId) {
      case "deployment":
        // Elastic Cloud has no hard delete for deployments: shutting one down
        // stops it and its billing, and it is removed after the retention period.
        await cloudApi<unknown>(
          this.ctx,
          `/api/v1/deployments/${encodeURIComponent(id)}/_shutdown`,
          {
            method: "POST",
          },
        );
        return;
      case "project": {
        const { type, id: projectId } = parseProjectExternalId(id);
        await cloudApi<unknown>(
          this.ctx,
          `/api/v1/serverless/projects/${encodeURIComponent(type)}/${encodeURIComponent(projectId)}`,
          { method: "DELETE" },
        );
        return;
      }
      case "traffic-filter":
        await cloudApi<unknown>(
          this.ctx,
          `/api/v1/deployments/traffic-filter/rulesets/${encodeURIComponent(id)}`,
          { method: "DELETE", query: { ignore_associations: true } },
        );
        return;
      case "serverless-traffic-filter":
        await cloudApi<unknown>(
          this.ctx,
          `/api/v1/serverless/traffic-filters/${encodeURIComponent(id)}`,
          {
            method: "DELETE",
          },
        );
        return;
      case "extension":
        await cloudApi<unknown>(
          this.ctx,
          `/api/v1/deployments/extensions/${encodeURIComponent(id)}`,
          {
            method: "DELETE",
          },
        );
        return;
      case "budget": {
        const { orgId, budgetId } = parseBudgetExternalId(id);
        await billingApi<unknown>(
          this.ctx,
          `/api/v1/billing/organization/${encodeURIComponent(orgId)}/budgets/${encodeURIComponent(budgetId)}`,
          { method: "DELETE" },
        );
        return;
      }
      default:
        throw new Error(`Elastic Cloud plugin: "${typeId}" cannot be deleted from Infrawrench`);
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private associate(rulesetId: string, deploymentId: string): Promise<unknown> {
    return cloudApi<unknown>(
      this.ctx,
      `/api/v1/deployments/traffic-filter/rulesets/${encodeURIComponent(rulesetId)}/associations`,
      { method: "POST", body: JSON.stringify({ entity_type: "deployment", id: deploymentId }) },
    );
  }

  private dissociate(rulesetId: string, deploymentId: string): Promise<unknown> {
    return cloudApi<unknown>(
      this.ctx,
      `/api/v1/deployments/traffic-filter/rulesets/${encodeURIComponent(rulesetId)}/associations/deployment/${encodeURIComponent(deploymentId)}`,
      { method: "DELETE" },
    );
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
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
        await cloudApi<unknown>(
          this.ctx,
          `/api/v1/deployments/${encodeURIComponent(id)}/${kind}/${encodeURIComponent(ref)}/_restart`,
          { method: "POST" },
        );
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
      const base = `/api/v1/serverless/projects/${encodeURIComponent(type)}/${encodeURIComponent(projectId)}`;
      if (actionId === "resume") {
        await cloudApi<unknown>(this.ctx, `${base}/_resume`, { method: "POST" });
        return;
      }
      if (actionId === "reset-credentials") {
        const creds = await cloudApi<{ username?: string; password?: string }>(
          this.ctx,
          `${base}/_reset-credentials`,
          { method: "POST" },
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
