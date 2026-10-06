import type {
  CreateFieldConfig,
  CreateResourceConfig,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  ResourceInstance,
  ResourceTypeDefinition,
  SelectOption,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { withMetricsCapability } from "@infrawrench/plugin-base";
import { RenderApi } from "./api.js";
import {
  EVICTION_POLICIES,
  KEY_VALUE_PLANS,
  POSTGRES_PLANS,
  POSTGRES_VERSIONS,
  REGION_OPTIONS,
  SERVICE_SIZES,
} from "./catalog.js";
import {
  cached,
  enc,
  externalOf,
  isStatus,
  mapLimit,
  parseFormArg,
  parseScopedId,
  str,
  type Cached,
} from "./kit.js";
import { LOG_FILTERS, fetchRenderLogs } from "./logs.js";
import {
  mapBlueprint,
  mapCustomDomain,
  mapDeploy,
  mapDisk,
  mapEnvGroup,
  mapEnvGroupVar,
  mapEnvironment,
  mapEnvVar,
  mapJob,
  mapKeyValue,
  mapMaintenance,
  mapPostgres,
  mapProject,
  mapService,
  mapWorkspace,
  parseIpAllowList,
} from "./mappers.js";
import { DEFAULT_METRICS_WINDOW_MS, fetchRenderMetrics, metricSpecsFor } from "./metrics.js";
import { ENRICH, renderRenderDetail, renderRenderSidebarItem } from "./render.js";
import type {
  RenderBlueprint,
  RenderBlueprintSync,
  RenderCustomDomain,
  RenderDeploy,
  RenderDisk,
  RenderEnvGroup,
  RenderEnvironment,
  RenderEnvVar,
  RenderJob,
  RenderKeyValue,
  RenderKeyValueConnection,
  RenderMaintenance,
  RenderOwner,
  RenderPostgres,
  RenderPostgresConnection,
  RenderProject,
  RenderService,
} from "./types.js";

const LIST_TTL_MS = 30_000;
const FAN_OUT = 6;
const DEPLOYS_PER_SERVICE = 10;
const JOBS_PER_SERVICE = 20;

/** Service types that run instances (and so take disks, scaling and jobs). */
const RUNTIME_TYPES = new Set(["web_service", "private_service", "background_worker"]);
const DOMAIN_TYPES = new Set(["web_service", "static_site"]);

/**
 * Render plugin client. One per account (one API key, optionally narrowed to
 * one workspace). Children of a service (deploys, env vars, custom domains,
 * one-off jobs) are listed per service with bounded fan-out.
 */
export class RenderClient implements PluginClient {
  readonly api: RenderApi;
  private readonly workspaceId: string;
  private readonly resourceTypes: ResourceTypeDefinition[];
  private ownersCache: Cached<RenderOwner[]> | undefined;
  private servicesCache: Cached<RenderService[]> | undefined;

  constructor(
    credentials: Record<string, string>,
    resourceTypes: ResourceTypeDefinition[],
    services?: HostServices,
  ) {
    const apiKey = str(credentials["apiKey"]);
    if (!apiKey) throw new Error("Render plugin: missing apiKey credential");
    this.workspaceId = str(credentials["workspaceId"]);
    this.api = new RenderApi(apiKey, credentials["caCert"] ?? "", services);
    this.resourceTypes = resourceTypes;
  }

  // ── Discovery ────────────────────────────────────────────────────────

  private ownerQuery(): { ownerId?: string[] } {
    return this.workspaceId ? { ownerId: [this.workspaceId] } : {};
  }

  owners(): Promise<RenderOwner[]> {
    this.ownersCache = cached(this.ownersCache, LIST_TTL_MS, async () => {
      const all = await this.api.listAll<RenderOwner>("/owners", "owner");
      return this.workspaceId ? all.filter((o) => o.id === this.workspaceId) : all;
    });
    return this.ownersCache.value;
  }

  services(): Promise<RenderService[]> {
    this.servicesCache = cached(this.servicesCache, LIST_TTL_MS, () =>
      this.api.listAll<RenderService>("/services", "service", this.ownerQuery()),
    );
    return this.servicesCache.value;
  }

  private invalidateServices(): void {
    this.servicesCache = undefined;
  }

  private async serviceById(id: string): Promise<RenderService> {
    const known = (await this.services().catch(() => [])).find((s) => s.id === id);
    return known ?? this.api.request<RenderService>(`/services/${enc(id)}`);
  }

  private async perService(
    filter: (s: RenderService) => boolean,
    load: (s: RenderService) => Promise<ResourceInstance[]>,
  ): Promise<ResourceInstance[]> {
    const services = (await this.services()).filter(filter);
    const lists = await mapLimit(services, FAN_OUT, async (s) => {
      try {
        return await load(s);
      } catch (e) {
        if (isStatus(e, 403, 404)) return [];
        throw e;
      }
    });
    return lists.flat();
  }

  private async projects(): Promise<RenderProject[]> {
    return this.api.listAll<RenderProject>("/projects", "project", this.ownerQuery());
  }

  private async environments(): Promise<Array<{ env: RenderEnvironment; projectName: string }>> {
    const projects = await this.projects();
    const lists = await mapLimit(projects, FAN_OUT, async (p) => {
      const envs = await this.api.listAll<RenderEnvironment>("/environments", "environment", {
        projectId: [p.id],
      });
      return envs.map((env) => ({ env, projectName: p.name }));
    });
    return lists.flat();
  }

  // ── Listing ──────────────────────────────────────────────────────────

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "workspace":
        return (await this.owners()).map((o) => mapWorkspace(o, accountId));
      case "service":
        return (await this.services()).map((s) => mapService(s, accountId));
      case "deploy":
        return this.perService(
          () => true,
          async (s) => {
            const rows = await this.api.request<Array<{ deploy: RenderDeploy }>>(
              `/services/${enc(s.id)}/deploys`,
              { query: { limit: DEPLOYS_PER_SERVICE } },
            );
            return (rows ?? []).map((r) => mapDeploy(r.deploy, s, accountId));
          },
        );
      case "env-var":
        return this.perService(
          () => true,
          async (s) =>
            (await this.api.listAll<RenderEnvVar>(`/services/${enc(s.id)}/env-vars`, "envVar")).map(
              (v) => mapEnvVar(v, s, accountId),
            ),
        );
      case "custom-domain":
        return this.perService(
          (s) => DOMAIN_TYPES.has(s.type),
          async (s) =>
            (
              await this.api.listAll<RenderCustomDomain>(
                `/services/${enc(s.id)}/custom-domains`,
                "customDomain",
              )
            ).map((c) => mapCustomDomain(c, s, accountId)),
        );
      case "job":
        return this.perService(
          (s) => s.type !== "static_site",
          async (s) => {
            const rows = await this.api.request<Array<{ job: RenderJob }>>(
              `/services/${enc(s.id)}/jobs`,
              { query: { limit: JOBS_PER_SERVICE } },
            );
            return (rows ?? []).map((r) => mapJob(r.job, s, accountId));
          },
        );
      case "disk": {
        const [disks, services] = await Promise.all([
          this.api.listAll<RenderDisk>("/disks", "disk", this.ownerQuery()),
          this.services().catch(() => [] as RenderService[]),
        ]);
        const names = new Map(services.map((s) => [s.id, s.name]));
        return disks.map((d) => mapDisk(d, names, accountId));
      }
      case "postgres":
        return (
          await this.api.listAll<RenderPostgres>("/postgres", "postgres", {
            ...this.ownerQuery(),
            includeReplicas: true,
          })
        ).map((p) => mapPostgres(p, accountId));
      case "key-value":
        return (
          await this.api.listAll<RenderKeyValue>("/key-value", "keyValue", this.ownerQuery())
        ).map((k) => mapKeyValue(k, accountId));
      case "env-group":
        return (
          await this.api.listAll<RenderEnvGroup>("/env-groups", "envGroup", this.ownerQuery())
        ).map((g) => mapEnvGroup(g, accountId));
      case "env-group-var": {
        const groups = await this.api.listAll<RenderEnvGroup>(
          "/env-groups",
          "envGroup",
          this.ownerQuery(),
        );
        const lists = await mapLimit(groups, FAN_OUT, async (g) => {
          const full = await this.api.request<RenderEnvGroup>(`/env-groups/${enc(g.id)}`);
          return (full?.envVars ?? []).map((v) => mapEnvGroupVar(v, g, accountId));
        });
        return lists.flat();
      }
      case "project":
        return (await this.projects()).map((p) => mapProject(p, accountId));
      case "environment":
        return (await this.environments()).map(({ env, projectName }) =>
          mapEnvironment(env, projectName, accountId),
        );
      case "blueprint":
        return (
          await this.api.listAll<RenderBlueprint>("/blueprints", "blueprint", this.ownerQuery())
        ).map((b) => mapBlueprint(b, accountId));
      case "maintenance":
        return this.listMaintenance(accountId);
      default:
        throw new Error(`Render plugin: unknown resource type "${typeId}"`);
    }
  }

  private async listMaintenance(accountId: string): Promise<ResourceInstance[]> {
    const [runs, services, pgs, kvs] = await Promise.all([
      this.api.request<RenderMaintenance[]>("/maintenance", { query: this.ownerQuery() }),
      this.services().catch(() => [] as RenderService[]),
      this.api
        .listAll<RenderPostgres>("/postgres", "postgres", this.ownerQuery())
        .catch(() => [] as RenderPostgres[]),
      this.api
        .listAll<RenderKeyValue>("/key-value", "keyValue", this.ownerQuery())
        .catch(() => [] as RenderKeyValue[]),
    ]);
    const names = new Map<string, string>();
    for (const r of [...services, ...pgs, ...kvs]) names.set(r.id, r.name);
    return (Array.isArray(runs) ? runs : []).map((m) => mapMaintenance(m, names, accountId));
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalOf(resourceId);
    switch (typeId) {
      case "service":
        return mapService(await this.api.request<RenderService>(`/services/${enc(id)}`), accountId);
      case "deploy": {
        const { scope, id: deployId } = parseScopedId(id);
        const [d, s] = await Promise.all([
          this.api.request<RenderDeploy>(`/services/${enc(scope)}/deploys/${enc(deployId)}`),
          this.serviceById(scope),
        ]);
        return mapDeploy(d, s, accountId);
      }
      case "custom-domain": {
        const { scope, id: domainId } = parseScopedId(id);
        const [c, s] = await Promise.all([
          this.api.request<RenderCustomDomain>(
            `/services/${enc(scope)}/custom-domains/${enc(domainId)}`,
          ),
          this.serviceById(scope),
        ]);
        return mapCustomDomain(c, s, accountId);
      }
      case "job": {
        const { scope, id: jobId } = parseScopedId(id);
        const [j, s] = await Promise.all([
          this.api.request<RenderJob>(`/services/${enc(scope)}/jobs/${enc(jobId)}`),
          this.serviceById(scope),
        ]);
        return mapJob(j, s, accountId);
      }
      case "env-var": {
        const { scope, id: key } = parseScopedId(id);
        const [v, s] = await Promise.all([
          this.api.request<RenderEnvVar>(`/services/${enc(scope)}/env-vars/${enc(key)}`),
          this.serviceById(scope),
        ]);
        return mapEnvVar(v ?? { key, value: "" }, s, accountId);
      }
      case "env-group-var": {
        const { scope, id: key } = parseScopedId(id);
        const g = await this.api.request<RenderEnvGroup>(`/env-groups/${enc(scope)}`);
        const v = (g.envVars ?? []).find((x) => x.key === key);
        if (!v)
          throw Object.assign(new Error(`Render plugin: variable ${key} not found`), {
            status: 404,
          });
        return mapEnvGroupVar(v, g, accountId);
      }
      case "disk": {
        const d = await this.api.request<RenderDisk>(`/disks/${enc(id)}`);
        const s = d.serviceId ? await this.serviceById(d.serviceId).catch(() => null) : null;
        return mapDisk(d, new Map(s ? [[s.id, s.name]] : []), accountId);
      }
      case "postgres":
        return mapPostgres(
          await this.api.request<RenderPostgres>(`/postgres/${enc(id)}`),
          accountId,
        );
      case "key-value":
        return mapKeyValue(
          await this.api.request<RenderKeyValue>(`/key-value/${enc(id)}`),
          accountId,
        );
      case "env-group":
        return mapEnvGroup(
          await this.api.request<RenderEnvGroup>(`/env-groups/${enc(id)}`),
          accountId,
        );
      case "project":
        return mapProject(await this.api.request<RenderProject>(`/projects/${enc(id)}`), accountId);
      case "environment": {
        const e = await this.api.request<RenderEnvironment>(`/environments/${enc(id)}`);
        const p = await this.api
          .request<RenderProject>(`/projects/${enc(e.projectId)}`)
          .catch(() => null);
        return mapEnvironment(e, p?.name ?? "", accountId);
      }
      case "blueprint":
        return mapBlueprint(
          await this.api.request<RenderBlueprint>(`/blueprints/${enc(id)}`),
          accountId,
        );
      default: {
        const all = await this.listResources(typeId, accountId);
        const found = all.find((r) => r.id === resourceId || r.externalId === id);
        if (!found) {
          throw Object.assign(new Error(`Render plugin: ${typeId} ${id} not found`), {
            status: 404,
          });
        }
        return found;
      }
    }
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const id = externalOf(resourceId);
    if (typeId === "postgres") {
      const c = await this.api.request<RenderPostgresConnection>(
        `/postgres/${enc(id)}/connection-info`,
      );
      switch (outputKey) {
        case "connectionString":
          return c.externalConnectionString ?? "";
        case "internalConnectionString":
          return c.internalConnectionString ?? "";
        case "poolConnectionString":
          return c.externalConnectionPoolString ?? c.internalConnectionPoolString ?? "";
        case "password":
          return c.password ?? "";
        case "psqlCommand":
          return c.psqlCommand ?? "";
      }
    }
    if (typeId === "key-value") {
      const c = await this.api.request<RenderKeyValueConnection>(
        `/key-value/${enc(id)}/connection-info`,
      );
      switch (outputKey) {
        case "connectionString":
          return c.externalConnectionString ?? "";
        case "internalConnectionString":
          return c.internalConnectionString ?? "";
        case "cliCommand":
          return c.cliCommand ?? "";
      }
    }
    if (typeId === "env-var" && outputKey === "value") {
      const { scope, id: key } = parseScopedId(id);
      const v = await this.api.request<RenderEnvVar>(
        `/services/${enc(scope)}/env-vars/${enc(key)}`,
      );
      return v?.value ?? "";
    }
    if (typeId === "env-group-var" && outputKey === "value") {
      const { scope, id: key } = parseScopedId(id);
      const v = await this.api.request<RenderEnvVar>(
        `/env-groups/${enc(scope)}/env-vars/${enc(key)}`,
      );
      return v?.value ?? "";
    }
    const resource = await this.getResource(typeId, resourceId, accountId);
    return resource.resolvedOutputs[outputKey] ?? String(resource.fields[outputKey] ?? "");
  }

  // ── Detail ───────────────────────────────────────────────────────────

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const id = resource.externalId ?? externalOf(resource.id);
    const extra: Record<string, string> = {};
    const stash = async (key: string, load: () => Promise<unknown>) => {
      try {
        const v = await load();
        if (v !== undefined && v !== null) extra[key] = JSON.stringify(v);
      } catch {
        /* optional panel */
      }
    };
    switch (resource.resourceTypeId) {
      case "service": {
        const runs = RUNTIME_TYPES.has(String(resource.fields["serviceType"] ?? ""));
        await Promise.all([
          stash(ENRICH.events, async () => {
            const rows = await this.api.request<
              Array<{ event: { timestamp?: string; type?: string } }>
            >(`/services/${enc(id)}/events`, {
              query: {
                limit: 20,
                startTime: new Date(Date.now() - 7 * 86_400_000).toISOString(),
              },
            });
            return (rows ?? []).map((r) => r.event);
          }),
          ...(runs
            ? [stash(ENRICH.instances, () => this.api.request(`/services/${enc(id)}/instances`))]
            : []),
        ]);
        break;
      }
      case "postgres":
        await Promise.all([
          stash(ENRICH.users, () => this.api.request(`/postgres/${enc(id)}/credentials`)),
          stash(ENRICH.recovery, () => this.api.request(`/postgres/${enc(id)}/recovery`)),
          stash(ENRICH.exports, () => this.api.request(`/postgres/${enc(id)}/export`)),
        ]);
        break;
      case "disk":
        await stash(ENRICH.snapshots, () => this.api.request(`/disks/${enc(id)}/snapshots`));
        break;
      case "env-group":
        await Promise.all([
          stash(ENRICH.secretFiles, async () => {
            const g = await this.api.request<RenderEnvGroup>(`/env-groups/${enc(id)}`);
            return (g.secretFiles ?? []).map((s) => s.name);
          }),
          stash(ENRICH.services, async () =>
            (await this.services()).map((s) => ({ id: s.id, name: s.name })),
          ),
        ]);
        break;
      case "blueprint":
        await stash(ENRICH.syncs, async () => {
          const rows = await this.api.request<Array<{ sync: RenderBlueprintSync }>>(
            `/blueprints/${enc(id)}/syncs`,
            { query: { limit: 10 } },
          );
          return (rows ?? []).map((r) => r.sync);
        });
        break;
      case "workspace":
        await stash(ENRICH.members, () => this.api.request(`/owners/${enc(id)}/members`));
        break;
      default:
        return resource;
    }
    return { ...resource, fields: { ...resource.fields, ...extra } };
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return withMetricsCapability(
      renderRenderDetail(resource, this.resourceTypes),
      this.resourceTypes,
      resource.resourceTypeId,
      DEFAULT_METRICS_WINDOW_MS,
    );
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderRenderSidebarItem(resource);
  }

  // ── Create ───────────────────────────────────────────────────────────

  private async workspaceField(): Promise<CreateFieldConfig[]> {
    if (this.workspaceId) return [];
    const owners = await this.owners().catch(() => [] as RenderOwner[]);
    if (owners.length === 1) return [];
    return [
      {
        key: "ownerId",
        label: "Workspace",
        kind: "select",
        required: true,
        options: owners.map((o) => ({ id: o.id, label: o.name || o.email || o.id })),
        ...(owners[0] ? { defaultValue: owners[0].id } : {}),
      },
    ];
  }

  private async resolveOwner(fields: Record<string, string>): Promise<string> {
    if (this.workspaceId) return this.workspaceId;
    const picked = str(fields["ownerId"]);
    if (picked) return picked;
    const owners = await this.owners();
    if (owners.length === 1) return owners[0]!.id;
    throw new Error("Render plugin: choose a workspace");
  }

  private async environmentField(): Promise<CreateFieldConfig[]> {
    const envs = await this.environments().catch(() => []);
    if (envs.length === 0) return [];
    return [
      {
        key: "environmentId",
        label: "Project Environment",
        kind: "select",
        required: false,
        options: [
          { id: "", label: "None" },
          ...envs.map(({ env, projectName }) => ({
            id: env.id,
            label: `${projectName} / ${env.name}`,
          })),
        ],
        defaultValue: "",
      },
    ];
  }

  private async servicePicker(
    parentResourceId: string | undefined,
    filter: (s: RenderService) => boolean,
    label = "Service",
  ): Promise<CreateFieldConfig[]> {
    if (parentResourceId?.includes(":service:")) return [];
    const services = (await this.services().catch(() => [] as RenderService[])).filter(filter);
    const options: SelectOption[] = services.map((s) => ({
      id: s.id,
      label: s.name,
      description: s.type.replace(/_/g, " "),
    }));
    return [
      {
        key: "serviceId",
        label,
        kind: "select",
        required: true,
        options,
        ...(options[0] ? { defaultValue: options[0].id } : {}),
      },
    ];
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case "service":
        return {
          fields: [
            ...(await this.workspaceField()),
            ...serviceCreateFields(),
            ...(await this.environmentField()),
          ],
        };
      case "env-var":
        return {
          fields: [
            ...(await this.servicePicker(parentResourceId, () => true)),
            { key: "key", label: "Key", kind: "text", required: true, placeholder: "DATABASE_URL" },
            {
              key: "value",
              label: "Value",
              kind: "password",
              required: false,
              description: "Leave blank and pick Generate to have Render create a random value.",
            },
            {
              key: "generate",
              label: "Generate a random value",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: [
                { id: "false", label: "No, use the value above" },
                { id: "true", label: "Yes" },
              ],
            },
          ],
        };
      case "custom-domain":
        return {
          fields: [
            ...(await this.servicePicker(parentResourceId, (s) => DOMAIN_TYPES.has(s.type))),
            {
              key: "name",
              label: "Domain",
              kind: "text",
              required: true,
              placeholder: "app.example.com",
              description:
                "Point a CNAME (or ALIAS/A record for an apex) at the service, then verify it.",
            },
          ],
        };
      case "job":
        return {
          fields: [
            ...(await this.servicePicker(parentResourceId, (s) => s.type !== "static_site")),
            {
              key: "startCommand",
              label: "Command",
              kind: "text",
              required: true,
              placeholder: "npm run migrate",
            },
            {
              key: "planId",
              label: "Instance Type",
              kind: "select",
              required: false,
              description: "Defaults to the service's own instance type.",
              defaultValue: "",
              options: [
                { id: "", label: "Same as the service" },
                ...SERVICE_SIZES.filter((s) => s.id !== "free").map((s) => ({
                  id: s.id,
                  label: s.label,
                })),
              ],
            },
          ],
        };
      case "disk":
        return {
          fields: [
            ...(await this.servicePicker(
              undefined,
              (s) => RUNTIME_TYPES.has(s.type) && !s.serviceDetails?.disk,
              "Attach To",
            )),
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "data" },
            {
              key: "sizeGB",
              label: "Size (GB)",
              kind: "number",
              required: true,
              minValue: 1,
              defaultValue: "10",
            },
            {
              key: "mountPath",
              label: "Mount Path",
              kind: "text",
              required: true,
              placeholder: "/var/data",
            },
          ],
        };
      case "postgres":
        return {
          fields: [
            ...(await this.workspaceField()),
            { key: "name", label: "Name", kind: "text", required: true },
            {
              key: "plan",
              label: "Instance Type",
              kind: "select",
              required: true,
              defaultValue: "basic_256mb",
              options: POSTGRES_PLANS,
            },
            {
              key: "region",
              label: "Region",
              kind: "region-picker",
              required: true,
              defaultValue: "oregon",
              regions: REGION_OPTIONS,
            },
            {
              key: "version",
              label: "Postgres Version",
              kind: "select",
              required: true,
              defaultValue: "17",
              options: POSTGRES_VERSIONS.map((v) => ({ id: v, label: v })),
            },
            { key: "databaseName", label: "Database Name", kind: "text", required: false },
            { key: "databaseUser", label: "User", kind: "text", required: false },
            {
              key: "diskSizeGB",
              label: "Storage (GB)",
              kind: "number",
              required: false,
              minValue: 1,
              description: "Paid instance types only. Storage can grow later but not shrink.",
            },
            {
              key: "enableHighAvailability",
              label: "High Availability",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: [
                { id: "false", label: "Off" },
                { id: "true", label: "On (Pro and Accelerated types)" },
              ],
            },
            {
              key: "allowedCidrs",
              label: "Allowed Sources",
              kind: "text",
              required: false,
              placeholder: "203.0.113.4/32, 198.51.100.0/24",
              description:
                "CIDR blocks that may connect from outside Render. Leave blank for private network only.",
            },
            ...(await this.environmentField()),
          ],
        };
      case "key-value":
        return {
          fields: [
            ...(await this.workspaceField()),
            { key: "name", label: "Name", kind: "text", required: true },
            {
              key: "plan",
              label: "Instance Type",
              kind: "select",
              required: true,
              defaultValue: "starter",
              options: KEY_VALUE_PLANS,
            },
            {
              key: "region",
              label: "Region",
              kind: "region-picker",
              required: true,
              defaultValue: "oregon",
              regions: REGION_OPTIONS,
            },
            {
              key: "maxmemoryPolicy",
              label: "Eviction Policy",
              kind: "select",
              required: false,
              defaultValue: "allkeys_lru",
              options: EVICTION_POLICIES,
            },
            {
              key: "persistenceMode",
              label: "Persistence",
              kind: "select",
              required: false,
              defaultValue: "",
              options: [
                { id: "", label: "Default for the instance type" },
                { id: "journal_snapshot", label: "Journal and snapshots" },
                { id: "snapshot", label: "Snapshots only" },
                { id: "off", label: "Off" },
              ],
            },
            {
              key: "allowedCidrs",
              label: "Allowed Sources",
              kind: "text",
              required: false,
              placeholder: "203.0.113.4/32",
              description:
                "CIDR blocks that may connect from outside Render. Leave blank for private network only.",
            },
            ...(await this.environmentField()),
          ],
        };
      case "env-group":
        return {
          fields: [
            ...(await this.workspaceField()),
            { key: "name", label: "Name", kind: "text", required: true },
            {
              key: "variables",
              label: "Variables",
              kind: "text",
              multiline: true,
              required: false,
              placeholder: "KEY=value",
              description: "One KEY=value per line.",
            },
            ...(await this.environmentField()),
          ],
        };
      case "env-group-var": {
        const groupField: CreateFieldConfig[] = parentResourceId?.includes(":env-group:")
          ? []
          : await this.api
              .listAll<RenderEnvGroup>("/env-groups", "envGroup", this.ownerQuery())
              .then((groups) => [
                {
                  key: "envGroupId",
                  label: "Environment Group",
                  kind: "select" as const,
                  required: true,
                  options: groups.map((g) => ({ id: g.id, label: g.name })),
                  ...(groups[0] ? { defaultValue: groups[0].id } : {}),
                },
              ]);
        return {
          fields: [
            ...groupField,
            { key: "key", label: "Key", kind: "text", required: true },
            { key: "value", label: "Value", kind: "password", required: true },
          ],
        };
      }
      case "project":
        return {
          fields: [
            ...(await this.workspaceField()),
            { key: "name", label: "Name", kind: "text", required: true },
            {
              key: "environments",
              label: "Environments",
              kind: "string-list",
              required: true,
              defaultValue: "production",
              addLabel: "Add environment",
            },
          ],
        };
      case "environment": {
        const projectField: CreateFieldConfig[] = parentResourceId?.includes(":project:")
          ? []
          : await this.projects().then((projects) => [
              {
                key: "projectId",
                label: "Project",
                kind: "select" as const,
                required: true,
                options: projects.map((p) => ({ id: p.id, label: p.name })),
                ...(projects[0] ? { defaultValue: projects[0].id } : {}),
              },
            ]);
        return {
          fields: [
            ...projectField,
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "staging" },
            {
              key: "protectedStatus",
              label: "Protection",
              kind: "select",
              required: false,
              defaultValue: "unprotected",
              options: [
                { id: "unprotected", label: "Unprotected" },
                { id: "protected", label: "Protected (admins only for destructive changes)" },
              ],
            },
            {
              key: "networkIsolationEnabled",
              label: "Network Isolation",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: [
                { id: "false", label: "Off" },
                { id: "true", label: "On" },
              ],
            },
          ],
        };
      }
      default:
        throw new Error(`Render plugin: cannot create "${typeId}"`);
    }
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    const parent = parentResourceId ? externalOf(parentResourceId) : "";
    const serviceId =
      str(fields["serviceId"]) || (parentResourceId?.includes(":service:") ? parent : "");
    switch (typeId) {
      case "service": {
        const ownerId = await this.resolveOwner(fields);
        const created = await this.api.request<{ service: RenderService }>("/services", {
          method: "POST",
          body: buildServiceCreateBody(fields, ownerId),
        });
        this.invalidateServices();
        return mapService(created.service, accountId);
      }
      case "env-var": {
        if (!serviceId) throw new Error("Render plugin: choose a service");
        const key = str(fields["key"]);
        if (!key) throw new Error("Render plugin: enter a key");
        const body =
          fields["generate"] === "true"
            ? { generateValue: true }
            : { value: fields["value"] ?? "" };
        await this.api.request(`/services/${enc(serviceId)}/env-vars/${enc(key)}`, {
          method: "PUT",
          body,
        });
        return mapEnvVar({ key, value: "" }, await this.serviceById(serviceId), accountId);
      }
      case "custom-domain": {
        if (!serviceId) throw new Error("Render plugin: choose a service");
        const rows = await this.api.request<RenderCustomDomain[]>(
          `/services/${enc(serviceId)}/custom-domains`,
          { method: "POST", body: { name: str(fields["name"]) } },
        );
        const created = (rows ?? []).find((c) => c.name === str(fields["name"])) ?? rows?.[0];
        if (!created) throw new Error("Render plugin: Render did not return the new domain");
        return mapCustomDomain(created, await this.serviceById(serviceId), accountId);
      }
      case "job": {
        if (!serviceId) throw new Error("Render plugin: choose a service");
        const job = await this.api.request<RenderJob>(`/services/${enc(serviceId)}/jobs`, {
          method: "POST",
          body: {
            startCommand: str(fields["startCommand"]),
            ...(str(fields["planId"]) ? { planId: str(fields["planId"]) } : {}),
          },
        });
        return mapJob(job, await this.serviceById(serviceId), accountId);
      }
      case "disk": {
        if (!serviceId) throw new Error("Render plugin: choose a service");
        const d = await this.api.request<RenderDisk>("/disks", {
          method: "POST",
          body: {
            name: str(fields["name"]),
            sizeGB: Number(fields["sizeGB"] || 10),
            mountPath: str(fields["mountPath"]),
            serviceId,
          },
        });
        const s = await this.serviceById(serviceId).catch(() => null);
        return mapDisk(d, new Map(s ? [[s.id, s.name]] : []), accountId);
      }
      case "postgres": {
        const ownerId = await this.resolveOwner(fields);
        const body: Record<string, unknown> = {
          name: str(fields["name"]),
          ownerId,
          plan: str(fields["plan"]) || "basic_256mb",
          region: str(fields["region"]) || "oregon",
          version: str(fields["version"]) || "17",
        };
        if (str(fields["databaseName"])) body["databaseName"] = str(fields["databaseName"]);
        if (str(fields["databaseUser"])) body["databaseUser"] = str(fields["databaseUser"]);
        if (str(fields["diskSizeGB"])) body["diskSizeGB"] = Number(fields["diskSizeGB"]);
        if (fields["enableHighAvailability"] === "true") body["enableHighAvailability"] = true;
        if (str(fields["allowedCidrs"]))
          body["ipAllowList"] = parseIpAllowList(fields["allowedCidrs"]!);
        if (str(fields["environmentId"])) body["environmentId"] = str(fields["environmentId"]);
        const p = await this.api.request<RenderPostgres>("/postgres", { method: "POST", body });
        return mapPostgres(p, accountId);
      }
      case "key-value": {
        const ownerId = await this.resolveOwner(fields);
        const body: Record<string, unknown> = {
          name: str(fields["name"]),
          ownerId,
          plan: str(fields["plan"]) || "starter",
          region: str(fields["region"]) || "oregon",
        };
        if (str(fields["maxmemoryPolicy"]))
          body["maxmemoryPolicy"] = str(fields["maxmemoryPolicy"]);
        if (str(fields["persistenceMode"]))
          body["persistenceMode"] = str(fields["persistenceMode"]);
        if (str(fields["allowedCidrs"]))
          body["ipAllowList"] = parseIpAllowList(fields["allowedCidrs"]!);
        if (str(fields["environmentId"])) body["environmentId"] = str(fields["environmentId"]);
        const k = await this.api.request<RenderKeyValue>("/key-value", { method: "POST", body });
        return mapKeyValue(k, accountId);
      }
      case "env-group": {
        const ownerId = await this.resolveOwner(fields);
        const g = await this.api.request<RenderEnvGroup>("/env-groups", {
          method: "POST",
          body: {
            name: str(fields["name"]),
            ownerId,
            envVars: parseDotenv(fields["variables"] ?? ""),
            ...(str(fields["environmentId"])
              ? { environmentId: str(fields["environmentId"]) }
              : {}),
          },
        });
        return mapEnvGroup(g, accountId);
      }
      case "env-group-var": {
        const groupId =
          str(fields["envGroupId"]) || (parentResourceId?.includes(":env-group:") ? parent : "");
        if (!groupId) throw new Error("Render plugin: choose an environment group");
        const key = str(fields["key"]);
        const g = await this.api.request<RenderEnvGroup>(
          `/env-groups/${enc(groupId)}/env-vars/${enc(key)}`,
          { method: "PUT", body: { value: fields["value"] ?? "" } },
        );
        return mapEnvGroupVar({ key, value: "" }, g ?? { id: groupId, name: "" }, accountId);
      }
      case "project": {
        const ownerId = await this.resolveOwner(fields);
        const names = (fields["environments"] || "production")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const p = await this.api.request<RenderProject>("/projects", {
          method: "POST",
          body: {
            name: str(fields["name"]),
            ownerId,
            environments: names.map((name) => ({ name })),
          },
        });
        return mapProject(p, accountId);
      }
      case "environment": {
        const projectId =
          str(fields["projectId"]) || (parentResourceId?.includes(":project:") ? parent : "");
        if (!projectId) throw new Error("Render plugin: choose a project");
        const e = await this.api.request<RenderEnvironment>("/environments", {
          method: "POST",
          body: {
            name: str(fields["name"]),
            projectId,
            protectedStatus: str(fields["protectedStatus"]) || "unprotected",
            networkIsolationEnabled: fields["networkIsolationEnabled"] === "true",
          },
        });
        return this.getResource("environment", `${accountId}:environment:${e.id}`, accountId).catch(
          () => mapEnvironment(e, "", accountId),
        );
      }
      default:
        throw new Error(`Render plugin: cannot create "${typeId}"`);
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
      case "service": {
        const current = await this.api.request<RenderService>(`/services/${enc(id)}`);
        const body = buildServicePatch(current, fields);
        if (Object.keys(body).length > 0) {
          await this.api.request(`/services/${enc(id)}`, { method: "PATCH", body });
          this.invalidateServices();
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "env-var": {
        const { scope, id: key } = parseScopedId(id);
        if (fields["value"]) {
          await this.api.request(`/services/${enc(scope)}/env-vars/${enc(key)}`, {
            method: "PUT",
            body: { value: fields["value"] },
          });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "env-group-var": {
        const { scope, id: key } = parseScopedId(id);
        if (fields["value"]) {
          await this.api.request(`/env-groups/${enc(scope)}/env-vars/${enc(key)}`, {
            method: "PUT",
            body: { value: fields["value"] },
          });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "disk": {
        const body: Record<string, unknown> = {};
        if (fields["name"] !== undefined) body["name"] = str(fields["name"]);
        if (fields["sizeGB"] !== undefined) body["sizeGB"] = Number(fields["sizeGB"]);
        if (fields["mountPath"] !== undefined) body["mountPath"] = str(fields["mountPath"]);
        if (Object.keys(body).length) {
          await this.api.request(`/disks/${enc(id)}`, { method: "PATCH", body });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "postgres": {
        const body: Record<string, unknown> = {};
        if (fields["name"] !== undefined) body["name"] = str(fields["name"]);
        if (fields["plan"]) body["plan"] = str(fields["plan"]);
        if (fields["diskSizeGB"]) body["diskSizeGB"] = Number(fields["diskSizeGB"]);
        if (fields["diskAutoscalingEnabled"] !== undefined) {
          body["enableDiskAutoscaling"] = fields["diskAutoscalingEnabled"] === "true";
        }
        if (fields["highAvailabilityEnabled"] !== undefined) {
          body["enableHighAvailability"] = fields["highAvailabilityEnabled"] === "true";
        }
        if (fields["allowedCidrs"] !== undefined) {
          body["ipAllowList"] = parseIpAllowList(fields["allowedCidrs"]);
        }
        if (Object.keys(body).length) {
          await this.api.request(`/postgres/${enc(id)}`, { method: "PATCH", body });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "key-value": {
        const body: Record<string, unknown> = {};
        for (const k of ["name", "plan", "maxmemoryPolicy", "persistenceMode"]) {
          if (fields[k]) body[k] = str(fields[k]);
        }
        if (fields["allowedCidrs"] !== undefined) {
          body["ipAllowList"] = parseIpAllowList(fields["allowedCidrs"]);
        }
        if (Object.keys(body).length) {
          await this.api.request(`/key-value/${enc(id)}`, { method: "PATCH", body });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "env-group":
      case "project":
        if (str(fields["name"])) {
          await this.api.request(
            `/${typeId === "project" ? "projects" : "env-groups"}/${enc(id)}`,
            {
              method: "PATCH",
              body: { name: str(fields["name"]) },
            },
          );
        }
        return this.getResource(typeId, resourceId, accountId);
      case "environment": {
        const body: Record<string, unknown> = {};
        if (str(fields["name"])) body["name"] = str(fields["name"]);
        if (fields["protectedStatus"]) body["protectedStatus"] = str(fields["protectedStatus"]);
        if (fields["networkIsolationEnabled"] !== undefined) {
          body["networkIsolationEnabled"] = fields["networkIsolationEnabled"] === "true";
        }
        if (Object.keys(body).length) {
          await this.api.request(`/environments/${enc(id)}`, { method: "PATCH", body });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "blueprint": {
        const body: Record<string, unknown> = {};
        if (str(fields["name"])) body["name"] = str(fields["name"]);
        if (fields["autoSync"] !== undefined) body["autoSync"] = fields["autoSync"] === "true";
        if (str(fields["path"])) body["path"] = str(fields["path"]);
        if (Object.keys(body).length) {
          await this.api.request(`/blueprints/${enc(id)}`, { method: "PATCH", body });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "maintenance": {
        const at = str(fields["scheduledAt"]);
        if (at) {
          const iso = new Date(at);
          if (Number.isNaN(iso.getTime()))
            throw new Error("Enter the new time as an ISO 8601 date.");
          await this.api.request(`/maintenance/${enc(id)}`, {
            method: "PATCH",
            body: { scheduledAt: iso.toISOString() },
          });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      default:
        throw new Error(`Render plugin: cannot update "${typeId}"`);
    }
  }

  // ── Delete ───────────────────────────────────────────────────────────

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const id = externalOf(resourceId);
    const del = (path: string) => this.api.request(path, { method: "DELETE" });
    switch (typeId) {
      case "service":
        await del(`/services/${enc(id)}`);
        this.invalidateServices();
        return;
      case "env-var": {
        const { scope, id: key } = parseScopedId(id);
        await del(`/services/${enc(scope)}/env-vars/${enc(key)}`);
        return;
      }
      case "custom-domain": {
        const { scope, id: domainId } = parseScopedId(id);
        await del(`/services/${enc(scope)}/custom-domains/${enc(domainId)}`);
        return;
      }
      case "env-group-var": {
        const { scope, id: key } = parseScopedId(id);
        await del(`/env-groups/${enc(scope)}/env-vars/${enc(key)}`);
        return;
      }
      case "disk":
        await del(`/disks/${enc(id)}`);
        return;
      case "postgres":
        await del(`/postgres/${enc(id)}`);
        return;
      case "key-value":
        await del(`/key-value/${enc(id)}`);
        return;
      case "env-group":
        await del(`/env-groups/${enc(id)}`);
        return;
      case "project":
        await del(`/projects/${enc(id)}`);
        return;
      case "environment":
        await del(`/environments/${enc(id)}`);
        return;
      case "blueprint":
        await del(`/blueprints/${enc(id)}`);
        return;
      default:
        throw new Error(`Render plugin: cannot delete "${typeId}"`);
    }
  }

  // ── Actions ──────────────────────────────────────────────────────────

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const id = externalOf(resourceId);
    const post = (path: string, body?: unknown) =>
      this.api.request(path, { method: "POST", ...(body !== undefined ? { body } : {}) });
    if (typeId === "service") {
      const base = `/services/${enc(id)}`;
      switch (actionId) {
        case "deploy":
          await post(`${base}/deploys`, { clearCache: "do_not_clear" });
          return;
        case "deploy-clear-cache":
          await post(`${base}/deploys`, { clearCache: "clear" });
          return;
        case "restart":
        case "suspend":
        case "resume":
          await post(`${base}/${actionId}`);
          this.invalidateServices();
          return;
        case "purge-cache":
          await post(`${base}/cache/purge`);
          return;
        case "run-cron":
          await post(`/cron-jobs/${enc(id)}/runs`);
          return;
        case "cancel-cron":
          await this.api.request(`/cron-jobs/${enc(id)}/runs`, { method: "DELETE" });
          return;
      }
    }
    if (typeId === "deploy") {
      const { scope, id: deployId } = parseScopedId(id);
      if (actionId === "cancel") {
        await post(`/services/${enc(scope)}/deploys/${enc(deployId)}/cancel`);
        return;
      }
      if (actionId === "rollback") {
        await post(`/services/${enc(scope)}/rollback`, { deployId });
        return;
      }
    }
    if (typeId === "custom-domain" && actionId === "verify") {
      const { scope, id: domainId } = parseScopedId(id);
      await post(`/services/${enc(scope)}/custom-domains/${enc(domainId)}/verify`);
      return;
    }
    if (typeId === "job" && actionId === "cancel") {
      const { scope, id: jobId } = parseScopedId(id);
      await post(`/services/${enc(scope)}/jobs/${enc(jobId)}/cancel`);
      return;
    }
    if (typeId === "postgres") {
      const paths: Record<string, string> = {
        suspend: "suspend",
        resume: "resume",
        restart: "restart",
        failover: "failover",
        export: "export",
      };
      if (paths[actionId]) {
        await post(`/postgres/${enc(id)}/${paths[actionId]}`);
        return;
      }
    }
    if (typeId === "key-value" && (actionId === "suspend" || actionId === "resume")) {
      await post(`/key-value/${enc(id)}/${actionId}`);
      return;
    }
    if (typeId === "maintenance" && actionId === "trigger") {
      await post(`/maintenance/${enc(id)}/trigger`);
      return;
    }
    throw new Error(`Render plugin: action "${actionId}" is not supported for "${typeId}"`);
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
    const post = (path: string, body?: unknown) =>
      this.api.request(path, { method: "POST", ...(body !== undefined ? { body } : {}) });
    switch (`${typeId}:${command}`) {
      case "service:deployVersion": {
        const commitId = str(v["commitId"]);
        const imageUrl = str(v["imageUrl"]);
        if (!commitId && !imageUrl) throw new Error("Enter a commit SHA or an image URL.");
        await post(`/services/${enc(id)}/deploys`, {
          ...(commitId ? { commitId } : {}),
          ...(imageUrl ? { imageUrl } : {}),
          clearCache: v["clearCache"] === "true" ? "clear" : "do_not_clear",
        });
        return null;
      }
      case "service:scale": {
        const n = Number(v["numInstances"]);
        if (!Number.isInteger(n) || n < 1) throw new Error("Enter a whole number of instances.");
        await post(`/services/${enc(id)}/scale`, { numInstances: n });
        this.invalidateServices();
        return null;
      }
      case "service:autoscaling": {
        const enabled = v["enabled"] === "true";
        if (!enabled) {
          await this.api.request(`/services/${enc(id)}/autoscaling`, { method: "DELETE" });
          this.invalidateServices();
          return null;
        }
        const min = Number(v["min"]);
        const max = Number(v["max"]);
        if (!(min >= 1) || !(max >= min)) throw new Error("Maximum must be at least the minimum.");
        const cpu = Number(v["cpuPercent"]);
        const mem = Number(v["memoryPercent"]);
        const cpuOn = v["cpuPercent"] !== "" && Number.isFinite(cpu) && cpu > 0;
        const memOn = v["memoryPercent"] !== "" && Number.isFinite(mem) && mem > 0;
        if (!cpuOn && !memOn) throw new Error("Set a CPU or memory target.");
        await this.api.request(`/services/${enc(id)}/autoscaling`, {
          method: "PUT",
          body: {
            enabled: true,
            min,
            max,
            criteria: {
              cpu: { enabled: cpuOn, percentage: cpuOn ? cpu : 70 },
              memory: { enabled: memOn, percentage: memOn ? mem : 70 },
            },
          },
        });
        this.invalidateServices();
        return null;
      }
      case "service:runJob":
        await post(`/services/${enc(id)}/jobs`, { startCommand: str(v["startCommand"]) });
        return null;
      case "service:maintenanceMode":
        await this.api.request(`/services/${enc(id)}`, {
          method: "PATCH",
          body: {
            serviceDetails: {
              maintenanceMode: { enabled: v["enabled"] === "true", uri: str(v["uri"]) },
            },
          },
        });
        this.invalidateServices();
        return null;
      case "postgres:recover": {
        const when = new Date(str(v["restoreTime"]));
        if (Number.isNaN(when.getTime())) throw new Error("Choose a time to restore to.");
        await post(`/postgres/${enc(id)}/recovery`, {
          restoreTime: when.toISOString(),
          ...(str(v["restoreName"]) ? { restoreName: str(v["restoreName"]) } : {}),
        });
        return null;
      }
      case "postgres:createUser":
        await post(`/postgres/${enc(id)}/credentials`, { username: str(v["username"]) });
        return null;
      case "postgres:deleteUser":
        await this.api.request(`/postgres/${enc(id)}/credentials/${enc(str(v["username"]))}`, {
          method: "DELETE",
        });
        return null;
      case "disk:restoreSnapshot":
        await post(`/disks/${enc(id)}/snapshots/restore`, { snapshotKey: str(v["snapshotKey"]) });
        return null;
      case "env-group:linkService":
        await post(`/env-groups/${enc(id)}/services/${enc(str(v["serviceId"]))}`);
        return null;
      case "env-group:unlinkService":
        await this.api.request(`/env-groups/${enc(id)}/services/${enc(str(v["serviceId"]))}`, {
          method: "DELETE",
        });
        return null;
      default:
        throw new Error(`Render plugin: unknown command "${command}" for "${typeId}"`);
    }
  }

  /** Drag an environment group onto a service to link it. */
  async attachResource(
    sourceTypeId: string,
    sourceResourceId: string,
    targetTypeId: string,
    targetResourceId: string,
    _accountId: string,
  ): Promise<void> {
    if (sourceTypeId !== "env-group" || targetTypeId !== "service") {
      throw new Error(`Render plugin: cannot attach ${sourceTypeId} to ${targetTypeId}`);
    }
    await this.api.request(
      `/env-groups/${enc(externalOf(sourceResourceId))}/services/${enc(externalOf(targetResourceId))}`,
      { method: "POST" },
    );
  }

  // ── Logs and metrics ─────────────────────────────────────────────────

  async getLogs(
    typeId: string,
    resourceId: string,
    accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    let target = externalOf(resourceId);
    let ownerId = "";
    if (typeId === "job") {
      const { scope, id } = parseScopedId(target);
      target = id;
      ownerId = (await this.serviceById(scope)).ownerId;
    } else {
      const resource = await this.getResource(typeId, resourceId, accountId);
      ownerId = String(resource.fields["ownerId"] ?? "");
    }
    if (!ownerId) throw new Error("Render plugin: cannot tell which workspace owns this resource");
    const filters = typeId === "service" ? LOG_FILTERS : [LOG_FILTERS[0]!];
    return fetchRenderLogs(this.api, ownerId, target, params.tailLines, params.container, filters);
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    let target = externalOf(resourceId);
    let serviceType = "";
    if (resourceTypeId === "service") {
      serviceType = (await this.serviceById(target)).type;
    } else if (resourceTypeId === "disk") {
      const disk = await this.getResource(resourceTypeId, resourceId, accountId);
      target = String(disk.fields["serviceId"] ?? "");
      if (!target) return [];
    }
    const specs = metricSpecsFor(resourceTypeId, serviceType);
    if (specs.length === 0) return [];
    return fetchRenderMetrics(this.api, specs, target, timeRange);
  }
}

// ── Body builders (pure, exported for tests) ───────────────────────────

const AUTO_DEPLOY_OPTIONS = [
  { id: "commit", label: "On every commit" },
  { id: "checksPass", label: "After CI checks pass" },
  { id: "off", label: "Off" },
];

function serviceCreateFields(): CreateFieldConfig[] {
  const runtimeTypes = ["web_service", "private_service", "background_worker", "cron_job"];
  const gitRuntime = { fieldKey: "runtime", fieldValuesNot: ["image"] };
  return [
    {
      key: "type",
      label: "Service Type",
      kind: "select",
      required: true,
      defaultValue: "web_service",
      options: [
        { id: "web_service", label: "Web service" },
        { id: "private_service", label: "Private service" },
        { id: "background_worker", label: "Background worker" },
        { id: "cron_job", label: "Cron job" },
        { id: "static_site", label: "Static site" },
      ],
    },
    { key: "name", label: "Name", kind: "text", required: true },
    {
      key: "runtime",
      label: "Runtime",
      kind: "select",
      required: true,
      defaultValue: "node",
      showWhen: { fieldKey: "type", fieldValues: runtimeTypes },
      options: [
        { id: "node", label: "Node" },
        { id: "python", label: "Python" },
        { id: "ruby", label: "Ruby" },
        { id: "go", label: "Go" },
        { id: "rust", label: "Rust" },
        { id: "elixir", label: "Elixir" },
        { id: "docker", label: "Docker (build a Dockerfile)" },
        { id: "image", label: "Prebuilt image" },
      ],
    },
    {
      key: "region",
      label: "Region",
      kind: "region-picker",
      required: true,
      defaultValue: "oregon",
      regions: REGION_OPTIONS,
      showWhen: { fieldKey: "type", fieldValues: runtimeTypes },
    },
    {
      key: "plan",
      label: "Instance Type",
      kind: "size-picker",
      required: true,
      defaultValue: "0.5c-512mb",
      sizes: SERVICE_SIZES,
      showWhen: { fieldKey: "type", fieldValues: runtimeTypes },
    },
    {
      key: "repo",
      label: "Git Repository URL",
      kind: "text",
      required: false,
      placeholder: "https://github.com/acme/api",
      description: "The repository must be reachable by the Git provider connected to Render.",
      showWhen: gitRuntime,
    },
    {
      key: "branch",
      label: "Branch",
      kind: "text",
      required: false,
      placeholder: "main",
      showWhen: gitRuntime,
    },
    {
      key: "rootDir",
      label: "Root Directory",
      kind: "text",
      required: false,
      showWhen: gitRuntime,
    },
    {
      key: "imageUrl",
      label: "Image",
      kind: "text",
      required: false,
      placeholder: "docker.io/acme/api:latest",
      showWhen: { fieldKey: "runtime", fieldValue: "image" },
    },
    {
      key: "buildCommand",
      label: "Build Command",
      kind: "text",
      required: false,
      placeholder: "npm ci && npm run build",
      showWhen: { fieldKey: "runtime", fieldValuesNot: ["docker", "image"] },
    },
    {
      key: "startCommand",
      label: "Start Command",
      kind: "text",
      required: false,
      placeholder: "npm start",
      description: "For Docker and image services, overrides the image's command.",
      showWhen: { fieldKey: "type", fieldValues: runtimeTypes },
    },
    {
      key: "publishPath",
      label: "Publish Directory",
      kind: "text",
      required: false,
      placeholder: "dist",
      showWhen: { fieldKey: "type", fieldValue: "static_site" },
    },
    {
      key: "schedule",
      label: "Schedule (cron, UTC)",
      kind: "text",
      required: false,
      placeholder: "0 * * * *",
      showWhen: { fieldKey: "type", fieldValue: "cron_job" },
    },
    {
      key: "healthCheckPath",
      label: "Health Check Path",
      kind: "text",
      required: false,
      placeholder: "/healthz",
      showWhen: { fieldKey: "type", fieldValue: "web_service" },
    },
    {
      key: "autoDeploy",
      label: "Auto-Deploy",
      kind: "select",
      required: false,
      defaultValue: "commit",
      options: AUTO_DEPLOY_OPTIONS,
      showWhen: gitRuntime,
    },
  ];
}

export function buildServiceCreateBody(
  fields: Record<string, string>,
  ownerId: string,
): Record<string, unknown> {
  const type = str(fields["type"]) || "web_service";
  const name = str(fields["name"]);
  if (!name) throw new Error("Render plugin: enter a name");
  const runtime = type === "static_site" ? "" : str(fields["runtime"]) || "node";
  const body: Record<string, unknown> = { type, name, ownerId };
  if (runtime === "image") {
    const imagePath = str(fields["imageUrl"]);
    if (!imagePath) throw new Error("Render plugin: enter the image to deploy");
    body["image"] = { ownerId, imagePath };
  } else {
    const repo = str(fields["repo"]);
    if (!repo) throw new Error("Render plugin: enter the Git repository URL");
    body["repo"] = repo;
    if (str(fields["branch"])) body["branch"] = str(fields["branch"]);
    if (str(fields["rootDir"])) body["rootDir"] = str(fields["rootDir"]);
    if (str(fields["autoDeploy"])) body["autoDeployTrigger"] = str(fields["autoDeploy"]);
  }
  if (str(fields["environmentId"])) body["environmentId"] = str(fields["environmentId"]);
  if (type === "static_site") {
    body["serviceDetails"] = {
      ...(str(fields["buildCommand"]) ? { buildCommand: str(fields["buildCommand"]) } : {}),
      publishPath: str(fields["publishPath"]) || "public",
    };
    return body;
  }
  const envSpecificDetails: Record<string, unknown> =
    runtime === "docker" || runtime === "image"
      ? str(fields["startCommand"])
        ? { dockerCommand: str(fields["startCommand"]) }
        : {}
      : {
          buildCommand: str(fields["buildCommand"]),
          startCommand: str(fields["startCommand"]),
        };
  if (runtime !== "docker" && runtime !== "image" && !str(fields["startCommand"])) {
    throw new Error("Render plugin: enter a start command");
  }
  const details: Record<string, unknown> = {
    runtime,
    plan: str(fields["plan"]) || "0.5c-512mb",
    region: str(fields["region"]) || "oregon",
    ...(Object.keys(envSpecificDetails).length ? { envSpecificDetails } : {}),
  };
  if (type === "cron_job") {
    const schedule = str(fields["schedule"]);
    if (!schedule) throw new Error("Render plugin: enter a cron schedule");
    details["schedule"] = schedule;
  }
  if (type === "web_service" && str(fields["healthCheckPath"])) {
    details["healthCheckPath"] = str(fields["healthCheckPath"]);
  }
  body["serviceDetails"] = details;
  return body;
}

/** Only the changed keys, in the shape `PATCH /services/{id}` takes. */
export function buildServicePatch(
  current: RenderService,
  fields: Record<string, string>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const details: Record<string, unknown> = {};
  const has = (k: string) => fields[k] !== undefined;
  if (has("name") && str(fields["name"])) body["name"] = str(fields["name"]);
  if (has("branch") && str(fields["branch"])) body["branch"] = str(fields["branch"]);
  if (has("rootDir")) body["rootDir"] = str(fields["rootDir"]);
  if (has("autoDeploy") && str(fields["autoDeploy"])) {
    body["autoDeployTrigger"] = str(fields["autoDeploy"]);
  }
  const isStatic = current.type === "static_site";
  const runtime = current.serviceDetails?.runtime || current.serviceDetails?.env || "";
  const isDocker = runtime === "docker" || runtime === "image";
  if (has("plan") && str(fields["plan"]) && !isStatic) details["plan"] = str(fields["plan"]);
  if (has("preDeployCommand") && !isStatic && current.type !== "cron_job")
    details["preDeployCommand"] = str(fields["preDeployCommand"]);
  if (has("healthCheckPath") && current.type === "web_service") {
    details["healthCheckPath"] = str(fields["healthCheckPath"]);
  }
  if (has("schedule") && current.type === "cron_job" && str(fields["schedule"])) {
    details["schedule"] = str(fields["schedule"]);
  }
  if (
    has("maxShutdownDelaySeconds") &&
    !isStatic &&
    current.type !== "cron_job" &&
    fields["maxShutdownDelaySeconds"] !== ""
  ) {
    details["maxShutdownDelaySeconds"] = Number(fields["maxShutdownDelaySeconds"]);
  }
  if (has("previews") && str(fields["previews"]) && current.type !== "cron_job") {
    details["previews"] = { generation: str(fields["previews"]) };
  }
  if (isStatic) {
    if (has("buildCommand")) details["buildCommand"] = str(fields["buildCommand"]);
    if (has("publishPath")) details["publishPath"] = str(fields["publishPath"]);
  } else if (has("buildCommand") || has("startCommand")) {
    const env = current.serviceDetails?.envSpecificDetails ?? {};
    details["envSpecificDetails"] = isDocker
      ? {
          dockerCommand: has("startCommand")
            ? str(fields["startCommand"])
            : (env.dockerCommand ?? ""),
        }
      : {
          buildCommand: has("buildCommand")
            ? str(fields["buildCommand"])
            : (env.buildCommand ?? ""),
          startCommand: has("startCommand")
            ? str(fields["startCommand"])
            : (env.startCommand ?? ""),
        };
  }
  if (Object.keys(details).length) body["serviceDetails"] = details;
  return body;
}

/** `KEY=value` lines (blank lines and `#` comments skipped). */
export function parseDotenv(raw: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    out.push({
      key: trimmed
        .slice(0, eq)
        .trim()
        .replace(/^export\s+/, ""),
      value,
    });
  }
  return out;
}
