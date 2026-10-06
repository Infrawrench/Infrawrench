import type {
  CostFetchRange,
  CostRow,
  CreateFieldConfig,
  CreateResourceConfig,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  QuotaUsage,
  RegionOption,
  ResourceInstance,
  ResourceTypeDefinition,
  SidebarItemSchema,
  SizeOption,
} from "@infrawrench/plugin-base";
import { QuotaAccessError, withMetricsCapability } from "@infrawrench/plugin-base";
import { KoyebApi } from "./api.js";
import { invoiceRows } from "./cost-data.js";
import {
  cached,
  enc,
  externalOf,
  isStatus,
  mapLimit,
  parseFormArg,
  str,
  type Cached,
} from "./kit.js";
import { fetchKoyebLogs } from "./logs.js";
import {
  mapApp,
  mapDeployment,
  mapDomain,
  mapInstance,
  mapOrganization,
  mapProject,
  mapSecret,
  mapService,
  mapSnapshot,
  mapVolume,
  num,
} from "./mappers.js";
import { DEFAULT_METRICS_WINDOW_MS, fetchKoyebMetrics } from "./metrics.js";
import { ENRICH, renderKoyebDetail, renderKoyebSidebarItem } from "./render.js";
import type {
  KyApp,
  KyDefinition,
  KyDeployment,
  KyDomain,
  KyInstance,
  KyInstanceType,
  KyNextInvoice,
  KyOrganization,
  KyProject,
  KyQuotaUsage,
  KyRegion,
  KySecret,
  KyService,
  KySnapshot,
  KyVolume,
} from "./types.js";

const TTL_MS = 60_000;
const DEPLOYMENTS_PER_SERVICE = 10;
const FAN_OUT = 6;

const FLAGS: Record<string, string> = {
  fra: "\u{1F1E9}\u{1F1EA}",
  par: "\u{1F1EB}\u{1F1F7}",
  was: "\u{1F1FA}\u{1F1F8}",
  sfo: "\u{1F1FA}\u{1F1F8}",
  sin: "\u{1F1F8}\u{1F1EC}",
  tyo: "\u{1F1EF}\u{1F1F5}",
};

/** Koyeb's memory strings ("512MB", "2GB") in MB. */
export function memoryMb(raw: string | undefined): number {
  const m = /^([\d.]+)\s*(MB|GB)$/i.exec((raw ?? "").trim());
  if (!m) return 0;
  return Math.round(Number(m[1]) * (m[2]!.toUpperCase() === "GB" ? 1024 : 1));
}

/** Postgres URL from a database service's latest deployment and its revealed role password. */
export function connectionUrl(
  d: KyDeployment,
  role: { name: string; password: string } | null,
): string {
  const info = d.database_info?.neon_postgres;
  const db = d.definition?.database?.neon_postgres?.databases?.[0]?.name ?? "koyebdb";
  if (!info?.server_host || !role) return "";
  const port = info.server_port ? `:${info.server_port}` : "";
  return `postgres://${encodeURIComponent(role.name)}:${encodeURIComponent(role.password)}@${info.server_host}${port}/${encodeURIComponent(db)}?sslmode=require`;
}

/**
 * Koyeb plugin client. One per organization token. Services carry their
 * live configuration in the latest deployment's `definition`, so the lister
 * fetches every latest deployment in one `ids=` query.
 */
export class KoyebClient implements PluginClient {
  readonly api: KoyebApi;
  private readonly resourceTypes: ResourceTypeDefinition[];
  private orgCache: Cached<KyOrganization> | undefined;
  private appsCache: Cached<KyApp[]> | undefined;
  private catalogCache: Cached<{ regions: KyRegion[]; instances: KyInstanceType[] }> | undefined;

  constructor(
    credentials: Record<string, string>,
    resourceTypes: ResourceTypeDefinition[],
    services?: HostServices,
  ) {
    const token = str(credentials["apiToken"]);
    if (!token) throw new Error("Koyeb plugin: missing apiToken credential");
    this.api = new KoyebApi(token, credentials["caCert"] ?? "", services);
    this.resourceTypes = resourceTypes;
  }

  // ── Discovery ────────────────────────────────────────────────────────

  organization(): Promise<KyOrganization> {
    this.orgCache = cached(
      this.orgCache,
      TTL_MS,
      async () =>
        (await this.api.request<{ organization: KyOrganization }>("/v1/account/organization"))
          .organization,
    );
    return this.orgCache.value;
  }

  apps(): Promise<KyApp[]> {
    this.appsCache = cached(this.appsCache, TTL_MS, () =>
      this.api.listAll<KyApp>("/v1/apps", "apps"),
    );
    return this.appsCache.value;
  }

  catalog(): Promise<{ regions: KyRegion[]; instances: KyInstanceType[] }> {
    this.catalogCache = cached(this.catalogCache, 10 * TTL_MS, async () => {
      const [regions, instances] = await Promise.all([
        this.api.listAll<KyRegion>("/v1/catalog/regions", "regions").catch(() => [] as KyRegion[]),
        this.api
          .listAll<KyInstanceType>("/v1/catalog/instances", "instances")
          .catch(() => [] as KyInstanceType[]),
      ]);
      return { regions, instances };
    });
    return this.catalogCache.value;
  }

  private invalidate(): void {
    this.appsCache = undefined;
  }

  private async latestDeployments(ids: string[]): Promise<Map<string, KyDeployment>> {
    const out = new Map<string, KyDeployment>();
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const rows = await this.api.listAll<KyDeployment>("/v1/deployments", "deployments", {
        ids: chunk,
      });
      for (const d of rows) out.set(d.id, d);
    }
    return out;
  }

  private async services(): Promise<KyService[]> {
    return this.api.listAll<KyService>("/v1/services", "services");
  }

  // ── Listing ──────────────────────────────────────────────────────────

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "organization":
        return [await this.organizationInstance(accountId)];
      case "project":
        return (await this.api.listAll<KyProject>("/v1/projects", "projects")).map((p) =>
          mapProject(p, accountId),
        );
      case "app":
        return (await this.apps()).map((a) => mapApp(a, accountId));
      case "service": {
        const [services, apps] = await Promise.all([this.services(), this.apps()]);
        const latest = await this.latestDeployments(
          services.map((s) => s.latest_deployment_id).filter((x): x is string => Boolean(x)),
        );
        const byId = new Map(apps.map((a) => [a.id, a]));
        return services.map((s) =>
          mapService(
            s,
            byId.get(s.app_id),
            s.latest_deployment_id ? latest.get(s.latest_deployment_id) : undefined,
            accountId,
          ),
        );
      }
      case "deployment": {
        const services = await this.services();
        const lists = await mapLimit(services, FAN_OUT, async (s) => {
          const res = await this.api.request<{ deployments?: KyDeployment[] }>("/v1/deployments", {
            query: { service_id: s.id, limit: String(DEPLOYMENTS_PER_SERVICE) },
          });
          return (res?.deployments ?? []).map((d) =>
            mapDeployment(d, s.active_deployment_id ?? "", accountId),
          );
        });
        return lists.flat();
      }
      case "instance":
        return (
          await this.api.listAll<KyInstance>("/v1/instances", "instances", {
            statuses: ["ALLOCATING", "STARTING", "HEALTHY", "UNHEALTHY", "SLEEPING"],
          })
        ).map((i) => mapInstance(i, accountId));
      case "secret":
        return (await this.api.listAll<KySecret>("/v1/secrets", "secrets")).map((s) =>
          mapSecret(s, accountId),
        );
      case "domain": {
        const [domains, apps] = await Promise.all([
          this.api.listAll<KyDomain>("/v1/domains", "domains"),
          this.apps().catch(() => [] as KyApp[]),
        ]);
        const names = new Map(apps.map((a) => [a.id, a.name]));
        return domains.map((d) => mapDomain(d, names, accountId));
      }
      case "volume":
        return (await this.api.listAll<KyVolume>("/v1/volumes", "volumes")).map((v) =>
          mapVolume(v, accountId),
        );
      case "snapshot":
        return (await this.api.listAll<KySnapshot>("/v1/snapshots", "snapshots")).map((s) =>
          mapSnapshot(s, accountId),
        );
      default:
        throw new Error(`Koyeb plugin: unknown resource type "${typeId}"`);
    }
  }

  private async organizationInstance(accountId: string): Promise<ResourceInstance> {
    const org = await this.organization();
    const [budget, summary] = await Promise.all([
      this.api
        .request<{ budget?: { amount?: string } }>(`/v1/organizations/${enc(org.id)}/budget`)
        .then((r) => num(r?.budget?.amount))
        .catch(() => undefined),
      this.api
        .request<{
          summary?: {
            apps?: { total?: string };
            instances?: { total?: string };
            services?: Record<string, { total?: string }>;
          };
        }>(`/v1/organizations/${enc(org.id)}/summary`)
        .then((r) => r?.summary)
        .catch(() => undefined),
    ]);
    const services = summary?.services
      ? Object.values(summary.services).reduce((n, s) => n + (num(s.total) ?? 0), 0)
      : undefined;
    return mapOrganization(
      org,
      {
        ...(budget !== undefined ? { budgetCents: budget } : {}),
        ...(num(summary?.apps?.total) !== undefined ? { apps: num(summary?.apps?.total)! } : {}),
        ...(services !== undefined ? { services } : {}),
        ...(num(summary?.instances?.total) !== undefined
          ? { instances: num(summary?.instances?.total)! }
          : {}),
      },
      accountId,
    );
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalOf(resourceId);
    switch (typeId) {
      case "app":
        return mapApp(
          (await this.api.request<{ app: KyApp }>(`/v1/apps/${enc(id)}`)).app,
          accountId,
        );
      case "service": {
        const s = (await this.api.request<{ service: KyService }>(`/v1/services/${enc(id)}`))
          .service;
        const [app, latest] = await Promise.all([
          this.api
            .request<{ app: KyApp }>(`/v1/apps/${enc(s.app_id)}`)
            .then((r) => r.app)
            .catch(() => undefined),
          s.latest_deployment_id
            ? this.deployment(s.latest_deployment_id).catch(() => undefined)
            : undefined,
        ]);
        return mapService(s, app, latest, accountId);
      }
      case "deployment": {
        const d = await this.deployment(id);
        const s = d.service_id
          ? await this.api
              .request<{ service: KyService }>(`/v1/services/${enc(d.service_id)}`)
              .then((r) => r.service)
              .catch(() => null)
          : null;
        return mapDeployment(d, s?.active_deployment_id ?? "", accountId);
      }
      case "instance":
        return mapInstance(
          (await this.api.request<{ instance: KyInstance }>(`/v1/instances/${enc(id)}`)).instance,
          accountId,
        );
      case "secret":
        return mapSecret(
          (await this.api.request<{ secret: KySecret }>(`/v1/secrets/${enc(id)}`)).secret,
          accountId,
        );
      case "volume":
        return mapVolume(
          (await this.api.request<{ volume: KyVolume }>(`/v1/volumes/${enc(id)}`)).volume,
          accountId,
        );
      case "project":
        return mapProject(
          (await this.api.request<{ project: KyProject }>(`/v1/projects/${enc(id)}`)).project,
          accountId,
        );
      default: {
        const all = await this.listResources(typeId, accountId);
        const found = all.find((r) => r.id === resourceId || r.externalId === id);
        if (!found)
          throw Object.assign(new Error(`Koyeb plugin: ${typeId} ${id} not found`), {
            status: 404,
          });
        return found;
      }
    }
  }

  private async deployment(id: string): Promise<KyDeployment> {
    return (await this.api.request<{ deployment: KyDeployment }>(`/v1/deployments/${enc(id)}`))
      .deployment;
  }

  private async reveal(secretId: string): Promise<unknown> {
    return (
      await this.api.request<{ value?: unknown }>(`/v1/secrets/${enc(secretId)}/reveal`, {
        method: "POST",
        body: {},
      })
    )?.value;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const id = externalOf(resourceId);
    if (typeId === "secret" && outputKey === "value") {
      const v = await this.reveal(id);
      return typeof v === "string" ? v : JSON.stringify(v ?? "");
    }
    if (typeId === "service" && outputKey === "connectionString") {
      const s = (await this.api.request<{ service: KyService }>(`/v1/services/${enc(id)}`)).service;
      if (s.type !== "DATABASE" || !s.latest_deployment_id) return "";
      const d = await this.deployment(s.latest_deployment_id);
      const role = d.database_info?.neon_postgres?.roles?.[0];
      if (!role?.name || !role.secret_id) return "";
      const v = await this.reveal(role.secret_id);
      const password =
        typeof v === "string"
          ? v
          : typeof (v as { password?: unknown })?.password === "string"
            ? (v as { password: string }).password
            : "";
      return connectionUrl(d, password ? { name: role.name, password } : null);
    }
    const r = await this.getResource(typeId, resourceId, accountId);
    return r.resolvedOutputs[outputKey] ?? String(r.fields[outputKey] ?? "");
  }

  // ── Detail ───────────────────────────────────────────────────────────

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const extra: Record<string, string> = {};
    try {
      if (resource.resourceTypeId === "organization") {
        const [quotas, invoice] = await Promise.all([
          this.fetchQuotas(resource.accountId).catch(() => [] as QuotaUsage[]),
          this.api.request<KyNextInvoice>("/v1/billing/next_invoice").catch(() => null),
        ]);
        if (quotas.length) extra[ENRICH.quotas] = JSON.stringify(quotas);
        const lines = (invoice?.lines ?? [])
          .filter((l) => Number(l.amount_excluding_tax ?? 0) !== 0)
          .map((l) => ({
            label: l.plan_nickname ?? "Koyeb",
            amount: Number(l.amount_excluding_tax) / 100,
            ...(typeof l.quantity === "number" ? { quantity: l.quantity } : {}),
          }));
        if (lines.length) extra[ENRICH.invoice] = JSON.stringify(lines);
      } else if (resource.resourceTypeId === "service" && resource.fields["type"] === "DATABASE") {
        const latest = String(resource.fields["latestDeploymentId"] ?? "");
        if (latest) {
          const d = await this.deployment(latest);
          const roles = (d.database_info?.neon_postgres?.roles ?? [])
            .map((r) => r.name ?? "")
            .filter(Boolean);
          if (roles.length) extra[ENRICH.roles] = JSON.stringify(roles);
        }
      } else {
        return resource;
      }
    } catch {
      return resource;
    }
    return { ...resource, fields: { ...resource.fields, ...extra } };
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return withMetricsCapability(
      renderKoyebDetail(resource, this.resourceTypes),
      this.resourceTypes,
      resource.resourceTypeId,
      DEFAULT_METRICS_WINDOW_MS,
    );
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderKoyebSidebarItem(resource);
  }

  // ── Create ───────────────────────────────────────────────────────────

  private async pickers(): Promise<{
    regions: RegionOption[];
    sizes: SizeOption[];
    dbSizes: SizeOption[];
    dbRegions: RegionOption[];
  }> {
    const { regions, instances } = await this.catalog();
    const available = regions.filter((r) => r.status === "AVAILABLE" && r.scope !== "continental");
    const toRegion = (r: KyRegion): RegionOption => ({
      id: r.id,
      label: r.name,
      location: r.id.toUpperCase(),
      ...(FLAGS[r.id] ? { flag: FLAGS[r.id] } : {}),
    });
    const sizes = instances
      .filter(
        (i) =>
          i.status === "AVAILABLE" &&
          (i.service_types ?? []).some((t) => t === "web" || t === "worker"),
      )
      .map((i): SizeOption => ({
        id: i.id,
        label: i.display_name || i.id,
        vcpus: Number(i.vcpu_shares ?? i.vcpu ?? 0),
        memoryMb: memoryMb(i.memory),
        ...(num(i.price_monthly) !== undefined ? { priceMonthly: num(i.price_monthly)! } : {}),
        category: i.type ?? "standard",
        ...(i.regions?.length ? { availableFor: i.regions } : {}),
      }));
    const dbRegions = available
      .filter((r) => (r.instances ?? []).includes("database-compute"))
      .map(toRegion);
    return {
      regions: available
        .filter((r) =>
          (r.instances ?? []).some((t) => t !== "database-compute" && t !== "database-storage"),
        )
        .map(toRegion),
      sizes,
      dbSizes: [],
      dbRegions,
    };
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case "project":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            { key: "description", label: "Description", kind: "text", required: false },
          ],
        };
      case "app":
        return {
          fields: [
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              description: "Also the start of the app's koyeb.app domain.",
            },
          ],
        };
      case "service": {
        const fromApp = parentResourceId?.includes(":app:");
        const [apps, p] = await Promise.all([
          fromApp ? [] : this.apps().catch(() => [] as KyApp[]),
          this.pickers(),
        ]);
        const appField: CreateFieldConfig[] = fromApp
          ? []
          : [
              {
                key: "appId",
                label: "App",
                kind: "select",
                required: true,
                options: apps.map((a) => ({ id: a.id, label: a.name })),
                ...(apps[0] ? { defaultValue: apps[0].id } : {}),
              },
            ];
        const runtime = { fieldKey: "type", fieldValuesNot: ["DATABASE"] };
        return {
          fields: [
            ...appField,
            { key: "name", label: "Name", kind: "text", required: true },
            {
              key: "type",
              label: "Type",
              kind: "select",
              required: true,
              defaultValue: "WEB",
              options: [
                { id: "WEB", label: "Web service" },
                { id: "WORKER", label: "Worker" },
                { id: "DATABASE", label: "Postgres database" },
              ],
            },
            {
              key: "source",
              label: "Source",
              kind: "select",
              required: true,
              defaultValue: "docker",
              options: [
                { id: "docker", label: "Docker image" },
                { id: "git", label: "GitHub repository" },
              ],
              showWhen: runtime,
            },
            {
              key: "image",
              label: "Image",
              kind: "text",
              required: false,
              placeholder: "docker.io/koyeb/demo:latest",
              showWhen: { fieldKey: "source", fieldValue: "docker" },
            },
            {
              key: "repository",
              label: "Repository",
              kind: "text",
              required: false,
              placeholder: "github.com/acme/api",
              description: "A repository the Koyeb GitHub app can read.",
              showWhen: { fieldKey: "source", fieldValue: "git" },
            },
            {
              key: "branch",
              label: "Branch",
              kind: "text",
              required: false,
              placeholder: "main",
              showWhen: { fieldKey: "source", fieldValue: "git" },
            },
            {
              key: "buildCommand",
              label: "Build Command",
              kind: "text",
              required: false,
              showWhen: { fieldKey: "source", fieldValue: "git" },
            },
            {
              key: "runCommand",
              label: "Run Command",
              kind: "text",
              required: false,
              showWhen: runtime,
            },
            {
              key: "port",
              label: "Port",
              kind: "number",
              required: false,
              defaultValue: "8000",
              minValue: 1,
              maxValue: 65535,
              showWhen: { fieldKey: "type", fieldValue: "WEB" },
            },
            {
              key: "region",
              label: "Region",
              kind: "region-picker",
              required: true,
              regions: p.regions,
              ...(p.regions[0]
                ? { defaultValue: p.regions.find((r) => r.id === "fra")?.id ?? p.regions[0].id }
                : {}),
              showWhen: runtime,
            },
            {
              key: "instanceType",
              label: "Instance Type",
              kind: "size-picker",
              required: true,
              defaultValue: "nano",
              sizes: p.sizes,
              filterByFieldKey: "region",
              showWhen: runtime,
            },
            {
              key: "minScale",
              label: "Min Instances",
              kind: "number",
              required: false,
              defaultValue: "1",
              minValue: 0,
              showWhen: runtime,
            },
            {
              key: "maxScale",
              label: "Max Instances",
              kind: "number",
              required: false,
              defaultValue: "1",
              minValue: 1,
              showWhen: runtime,
            },
            {
              key: "dbRegion",
              label: "Database Region",
              kind: "region-picker",
              required: false,
              regions: p.dbRegions,
              ...(p.dbRegions[0] ? { defaultValue: p.dbRegions[0].id } : {}),
              showWhen: { fieldKey: "type", fieldValue: "DATABASE" },
            },
            {
              key: "dbInstanceType",
              label: "Database Size",
              kind: "select",
              required: false,
              defaultValue: "free",
              options: [
                { id: "free", label: "Free (0.25 vCPU, 1 GB, 5 compute hours a month)" },
                { id: "small", label: "Small (0.25 vCPU, 1 GB)" },
                { id: "medium", label: "Medium (0.5 vCPU, 2 GB)" },
                { id: "large", label: "Large (1 vCPU, 4 GB)" },
                { id: "xlarge", label: "XLarge (2 vCPU, 8 GB)" },
                { id: "2xlarge", label: "2XLarge (4 vCPU, 16 GB)" },
                { id: "3xlarge", label: "3XLarge (8 vCPU, 32 GB)" },
              ],
              showWhen: { fieldKey: "type", fieldValue: "DATABASE" },
            },
            {
              key: "pgVersion",
              label: "Postgres Version",
              kind: "select",
              required: false,
              defaultValue: "17",
              options: ["17", "16", "15", "14"].map((v) => ({ id: v, label: v })),
              showWhen: { fieldKey: "type", fieldValue: "DATABASE" },
            },
            {
              key: "dbName",
              label: "Database Name",
              kind: "text",
              required: false,
              defaultValue: "koyebdb",
              showWhen: { fieldKey: "type", fieldValue: "DATABASE" },
            },
            {
              key: "dbOwner",
              label: "Owner Role",
              kind: "text",
              required: false,
              defaultValue: "koyeb-adm",
              showWhen: { fieldKey: "type", fieldValue: "DATABASE" },
            },
          ],
        };
      }
      case "secret":
        return {
          fields: [
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "DATABASE_PASSWORD",
            },
            { key: "value", label: "Value", kind: "password", required: true },
          ],
        };
      case "domain": {
        const apps = await this.apps().catch(() => [] as KyApp[]);
        return {
          fields: [
            {
              key: "name",
              label: "Domain",
              kind: "text",
              required: true,
              placeholder: "api.example.com",
            },
            {
              key: "appId",
              label: "App",
              kind: "select",
              required: true,
              options: apps.map((a) => ({ id: a.id, label: a.name })),
              ...(apps[0] ? { defaultValue: apps[0].id } : {}),
            },
          ],
        };
      }
      case "volume": {
        const { regions } = await this.catalog();
        const vr = regions
          .filter((r) => r.volumes_enabled && r.status === "AVAILABLE")
          .map((r) => ({
            id: r.id,
            label: r.name,
            location: r.id.toUpperCase(),
            ...(FLAGS[r.id] ? { flag: FLAGS[r.id] } : {}),
          }));
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            {
              key: "region",
              label: "Region",
              kind: "region-picker",
              required: true,
              regions: vr,
              ...(vr[0] ? { defaultValue: vr[0].id } : {}),
            },
            {
              key: "sizeGb",
              label: "Size (GB)",
              kind: "number",
              required: true,
              defaultValue: "10",
              minValue: 1,
            },
          ],
        };
      }
      default:
        throw new Error(`Koyeb plugin: cannot create "${typeId}"`);
    }
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    switch (typeId) {
      case "project": {
        const r = await this.api.request<{ project: KyProject }>("/v1/projects", {
          method: "POST",
          body: { name: str(fields["name"]), description: str(fields["description"]) },
        });
        return mapProject(r.project, accountId);
      }
      case "app": {
        const r = await this.api.request<{ app: KyApp }>("/v1/apps", {
          method: "POST",
          body: { name: str(fields["name"]) },
        });
        this.invalidate();
        return mapApp(r.app, accountId);
      }
      case "service": {
        const appId = parentResourceId?.includes(":app:")
          ? externalOf(parentResourceId)
          : str(fields["appId"]);
        if (!appId) throw new Error("Koyeb plugin: choose an app");
        const r = await this.api.request<{ service: KyService }>("/v1/services", {
          method: "POST",
          body: { app_id: appId, definition: buildDefinition(fields) },
        });
        return this.getResource("service", `${accountId}:service:${r.service.id}`, accountId).catch(
          () => mapService(r.service, undefined, undefined, accountId),
        );
      }
      case "secret": {
        const r = await this.api.request<{ secret: KySecret }>("/v1/secrets", {
          method: "POST",
          body: { name: str(fields["name"]), type: "SIMPLE", value: fields["value"] ?? "" },
        });
        return mapSecret(r.secret, accountId);
      }
      case "domain": {
        const r = await this.api.request<{ domain: KyDomain }>("/v1/domains", {
          method: "POST",
          body: { name: str(fields["name"]), type: "CUSTOM", app_id: str(fields["appId"]) },
        });
        const apps = await this.apps().catch(() => [] as KyApp[]);
        return mapDomain(r.domain, new Map(apps.map((a) => [a.id, a.name])), accountId);
      }
      case "volume": {
        const r = await this.api.request<{ volume: KyVolume }>("/v1/volumes", {
          method: "POST",
          body: {
            name: str(fields["name"]),
            region: str(fields["region"]),
            max_size: Number(fields["sizeGb"] || 10),
            volume_type: "PERSISTENT_VOLUME_BACKING_STORE_LOCAL_BLK",
          },
        });
        return mapVolume(r.volume, accountId);
      }
      default:
        throw new Error(`Koyeb plugin: cannot create "${typeId}"`);
    }
  }

  // ── Update ───────────────────────────────────────────────────────────

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = externalOf(resourceId);
    switch (typeId) {
      case "organization": {
        if (fields["spendingAlert"] !== undefined) {
          const org = await this.organization();
          const path = `/v1/organizations/${enc(org.id)}/budget`;
          const dollars = str(fields["spendingAlert"]);
          if (!dollars || Number(dollars) === 0) {
            await this.api.request(path, { method: "DELETE" }).catch((e: unknown) => {
              if (!isStatus(e, 404)) throw e;
            });
          } else {
            if (!(Number(dollars) >= 5)) throw new Error("Koyeb spending alerts start at $5.");
            const body = { amount: String(Math.round(Number(dollars) * 100)) };
            await this.api.request(path, { method: "PUT", body }).catch(async (e: unknown) => {
              if (!isStatus(e, 404)) throw e;
              await this.api.request(path, { method: "POST", body });
            });
          }
        }
        return this.organizationInstance(accountId);
      }
      case "project": {
        const body: Record<string, unknown> = {};
        if (str(fields["name"])) body["name"] = str(fields["name"]);
        if (fields["description"] !== undefined) body["description"] = str(fields["description"]);
        if (Object.keys(body).length) {
          await this.api.request(`/v1/projects/${enc(id)}`, {
            method: "PATCH",
            body,
            query: { update_mask: Object.keys(body).join(",") },
          });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "app":
        if (str(fields["name"])) {
          await this.api.request(`/v1/apps/${enc(id)}`, {
            method: "PATCH",
            body: { name: str(fields["name"]) },
            query: { update_mask: "name" },
          });
          this.invalidate();
        }
        return this.getResource(typeId, resourceId, accountId);
      case "service": {
        const s = (await this.api.request<{ service: KyService }>(`/v1/services/${enc(id)}`))
          .service;
        if (!s.latest_deployment_id)
          throw new Error("Koyeb plugin: the service has no deployment to update");
        const current = (await this.deployment(s.latest_deployment_id)).definition ?? {};
        const next = applyServiceEdits(current, fields);
        if (next)
          await this.api.request(`/v1/services/${enc(id)}`, {
            method: "PATCH",
            body: { definition: next },
          });
        return this.getResource(typeId, resourceId, accountId);
      }
      case "secret":
        if (fields["value"]) {
          await this.api.request(`/v1/secrets/${enc(id)}`, {
            method: "PATCH",
            body: { value: fields["value"] },
            query: { update_mask: "value" },
          });
        }
        return this.getResource(typeId, resourceId, accountId);
      case "volume": {
        const body: Record<string, unknown> = {};
        if (str(fields["name"])) body["name"] = str(fields["name"]);
        if (str(fields["sizeGb"])) body["max_size"] = Number(fields["sizeGb"]);
        if (Object.keys(body).length)
          await this.api.request(`/v1/volumes/${enc(id)}`, { method: "POST", body });
        return this.getResource(typeId, resourceId, accountId);
      }
      default:
        throw new Error(`Koyeb plugin: cannot update "${typeId}"`);
    }
  }

  // ── Delete ───────────────────────────────────────────────────────────

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const id = externalOf(resourceId);
    const paths: Record<string, string> = {
      project: "/v1/projects/",
      app: "/v1/apps/",
      service: "/v1/services/",
      secret: "/v1/secrets/",
      domain: "/v1/domains/",
      volume: "/v1/volumes/",
      snapshot: "/v1/snapshots/",
    };
    const base = paths[typeId];
    if (!base) throw new Error(`Koyeb plugin: cannot delete "${typeId}"`);
    await this.api.request(`${base}${enc(id)}`, { method: "DELETE" });
    this.invalidate();
  }

  // ── Actions ──────────────────────────────────────────────────────────

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const id = externalOf(resourceId);
    if (
      (typeId === "app" || typeId === "service") &&
      (actionId === "pause" || actionId === "resume")
    ) {
      await this.api.request(`/v1/${typeId}s/${enc(id)}/${actionId}`, { method: "POST" });
      this.invalidate();
      return;
    }
    if (typeId === "service" && (actionId === "redeploy" || actionId === "redeploy-no-cache")) {
      await this.api.request(`/v1/services/${enc(id)}/redeploy`, {
        method: "POST",
        body: { use_cache: actionId === "redeploy" },
      });
      return;
    }
    if (typeId === "deployment" && actionId === "cancel") {
      await this.api.request(`/v1/deployments/${enc(id)}/cancel`, { method: "POST" });
      return;
    }
    if (typeId === "deployment" && actionId === "rollback") {
      const d = await this.deployment(id);
      if (!d.service_id || !d.definition)
        throw new Error("Koyeb plugin: this deployment has no definition to redeploy");
      await this.api.request(`/v1/services/${enc(d.service_id)}`, {
        method: "PATCH",
        body: { definition: pinDefinition(d) },
      });
      return;
    }
    if (typeId === "domain" && actionId === "refresh") {
      await this.api.request(`/v1/domains/${enc(id)}/refresh`, { method: "POST" });
      return;
    }
    throw new Error(`Koyeb plugin: action "${actionId}" is not supported for "${typeId}"`);
  }

  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const id = externalOf(resourceId);
    const v = parseFormArg(args[0]);
    if (typeId === "service" && command === "scale") {
      const n = Number(v["instances"]);
      if (!Number.isInteger(n) || n < 0) throw new Error("Enter a whole number of instances.");
      await this.api.request(`/v1/services/${enc(id)}/scale`, {
        method: "PUT",
        body: { scalings: [{ instances: n }] },
      });
      return null;
    }
    if (typeId === "volume" && command === "snapshot") {
      await this.api.request("/v1/snapshots", {
        method: "POST",
        body: { parent_volume_id: id, name: str(v["name"]) },
      });
      return null;
    }
    throw new Error(`Koyeb plugin: unknown command "${command}" for "${typeId}"`);
  }

  // ── Logs and metrics ─────────────────────────────────────────────────

  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    const id = externalOf(resourceId);
    const scope =
      typeId === "service"
        ? { service_id: id }
        : typeId === "deployment"
          ? { deployment_id: id }
          : typeId === "instance"
            ? { instance_ids: [id] }
            : null;
    if (!scope) throw new Error(`Koyeb plugin: no logs for "${typeId}"`);
    return fetchKoyebLogs(this.api, scope, params.tailLines, params.container);
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    if (resourceTypeId !== "service") return [];
    const s = await this.getResource(resourceTypeId, resourceId, accountId);
    if (s.fields["type"] === "DATABASE") return [];
    return fetchKoyebMetrics(
      this.api,
      externalOf(resourceId),
      s.fields["type"] === "WEB",
      timeRange,
    );
  }

  // ── Costs and quotas ─────────────────────────────────────────────────

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    let inv: KyNextInvoice;
    try {
      inv = await this.api.request<KyNextInvoice>("/v1/billing/next_invoice");
    } catch (e) {
      // Hobby and trial organizations have no upcoming invoice.
      if (isStatus(e, 400, 404, 412)) return [];
      throw e;
    }
    return invoiceRows(inv, range);
  }

  async fetchQuotas(_accountId: string): Promise<QuotaUsage[]> {
    const org = await this.organization();
    let u: KyQuotaUsage | undefined;
    try {
      u = (
        await this.api.request<{ usage?: KyQuotaUsage }>(
          `/v1/quotas/organizations/${enc(org.id)}/usage`,
        )
      ).usage;
    } catch (e) {
      if (isStatus(e, 401, 403))
        throw new QuotaAccessError("Koyeb refused the organization's quota usage for this token.");
      throw e;
    }
    return quotasFrom(u ?? {});
  }
}

/** Quota pairs as `QuotaUsage`, skipping any the plan leaves unlimited (limit 0 or absent). */
export function quotasFrom(u: KyQuotaUsage): QuotaUsage[] {
  const out: QuotaUsage[] = [];
  const add = (
    id: string,
    name: string,
    used: unknown,
    limit: unknown,
    unit?: string,
    region?: string,
  ) => {
    const l = num(limit);
    const n = num(used) ?? 0;
    if (l === undefined || l <= 0) return;
    out.push({
      id,
      service: "Koyeb",
      name,
      used: n,
      limit: l,
      ...(unit ? { unit } : {}),
      ...(region ? { region } : {}),
      adjustable: true,
    });
  };
  add("apps", "Apps", u.apps_used, u.apps_limit);
  add("services", "Services", u.services_used, u.services_limit);
  add("memory", "Memory", u.memory_mb_used, u.memory_mb_limit, "MB");
  add("custom-domains", "Custom domains", u.custom_domains_used, u.custom_domains_limit);
  add("koyeb-domains", "Koyeb domains", u.koyeb_lb_domains_used, u.koyeb_lb_domains_limit);
  add("proxy-ports", "TCP proxy ports", u.proxy_ports_used, u.proxy_ports_limit);
  for (const i of u.instances_by_type ?? []) {
    add(`instances/${i.instance_type}`, `${i.instance_type} instances`, i.used, i.limit);
  }
  for (const v of u.persistent_volumes_by_region ?? []) {
    add(
      `volumes/${v.region}`,
      `Volume storage in ${v.region}`,
      v.total_size_gb_used,
      v.total_size_gb_limit,
      "GB",
      v.region,
    );
  }
  for (const s of u.instance_snapshots_by_type ?? []) {
    add(`snapshots/${s.type}`, `${s.type} instance snapshots`, s.used, s.limit);
  }
  return out;
}

/** A service definition from the create form. */
export function buildDefinition(fields: Record<string, string>): KyDefinition {
  const name = str(fields["name"]);
  if (!name) throw new Error("Koyeb plugin: enter a name");
  const type = str(fields["type"]) || "WEB";
  if (type === "DATABASE") {
    const owner = str(fields["dbOwner"]) || "koyeb-adm";
    const region = str(fields["dbRegion"]);
    if (!region) throw new Error("Koyeb plugin: choose a database region");
    return {
      name,
      type,
      database: {
        neon_postgres: {
          pg_version: Number(fields["pgVersion"] || 17),
          region,
          instance_type: str(fields["dbInstanceType"]) || "free",
          roles: [{ name: owner }],
          databases: [{ name: str(fields["dbName"]) || "koyebdb", owner }],
        },
      },
    };
  }
  const region = str(fields["region"]);
  if (!region) throw new Error("Koyeb plugin: choose a region");
  const def: KyDefinition = {
    name,
    type,
    regions: [region],
    instance_types: [{ type: str(fields["instanceType"]) || "nano" }],
    scalings: [
      {
        min: Number(fields["minScale"] || 1),
        max: Math.max(Number(fields["maxScale"] || 1), Number(fields["minScale"] || 1)),
      },
    ],
    env: [],
  };
  if (type === "WEB") {
    const port = Number(fields["port"] || 8000);
    def.ports = [{ port, protocol: "http" }];
    def.routes = [{ port, path: "/" }];
  }
  if ((str(fields["source"]) || "docker") === "git") {
    const repo = str(fields["repository"]);
    if (!repo) throw new Error("Koyeb plugin: enter the repository");
    def.git = {
      repository: repo.startsWith("github.com/")
        ? repo
        : `github.com/${repo.replace(/^https?:\/\/github\.com\//, "")}`,
      branch: str(fields["branch"]) || "main",
      buildpack: {
        ...(str(fields["buildCommand"]) ? { build_command: str(fields["buildCommand"]) } : {}),
        ...(str(fields["runCommand"]) ? { run_command: str(fields["runCommand"]) } : {}),
      },
    };
  } else {
    const image = str(fields["image"]);
    if (!image) throw new Error("Koyeb plugin: enter the image");
    def.docker = {
      image,
      ...(str(fields["runCommand"]) ? { command: str(fields["runCommand"]) } : {}),
    };
  }
  return def;
}

/** Apply edit-form changes to the live definition; null when nothing changed. */
export function applyServiceEdits(
  current: KyDefinition,
  fields: Record<string, string>,
): KyDefinition | null {
  const def: KyDefinition = JSON.parse(JSON.stringify(current)) as KyDefinition;
  let changed = false;
  const has = (k: string) => fields[k] !== undefined && str(fields[k]) !== "";
  if (has("instanceType")) {
    if (def.database?.neon_postgres)
      def.database.neon_postgres.instance_type = str(fields["instanceType"]);
    else def.instance_types = [{ type: str(fields["instanceType"]) }];
    changed = true;
  }
  if (has("regions") && !def.database) {
    def.regions = str(fields["regions"])
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
    changed = true;
  }
  if (has("minScale") || has("maxScale")) {
    const cur = def.scalings?.[0] ?? {};
    const min = has("minScale") ? Number(fields["minScale"]) : Number(cur.min ?? 1);
    const max = has("maxScale") ? Number(fields["maxScale"]) : Number(cur.max ?? min);
    if (max < min) throw new Error("Max instances must be at least min instances.");
    def.scalings = [{ ...cur, min, max }];
    changed = true;
  }
  if (has("image") && def.docker) {
    def.docker = { ...def.docker, image: str(fields["image"]) };
    changed = true;
  }
  if (has("branch") && def.git) {
    def.git = { ...def.git, branch: str(fields["branch"]) };
    changed = true;
  }
  if (fields["buildCommand"] !== undefined && def.git) {
    def.git = {
      ...def.git,
      buildpack: { ...def.git.buildpack, build_command: str(fields["buildCommand"]) },
    };
    changed = true;
  }
  if (fields["runCommand"] !== undefined) {
    if (def.git)
      def.git = {
        ...def.git,
        buildpack: { ...def.git.buildpack, run_command: str(fields["runCommand"]) },
      };
    else if (def.docker) def.docker = { ...def.docker, command: str(fields["runCommand"]) };
    changed = true;
  }
  return changed ? def : null;
}

/** An old deployment's definition, pinned to the commit it built, for a rollback. */
export function pinDefinition(d: KyDeployment): KyDefinition {
  const def: KyDefinition = JSON.parse(JSON.stringify(d.definition ?? {})) as KyDefinition;
  const sha = d.provisioning_info?.sha || d.metadata?.trigger?.git?.sha;
  if (def.git && sha) def.git = { ...def.git, sha };
  return def;
}
