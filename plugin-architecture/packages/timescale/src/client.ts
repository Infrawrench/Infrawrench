import type {
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
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { decodePromptArgs, externalIdOf, withMetricsCapability } from "@infrawrench/plugin-base";
import type { TigerContext } from "./api.js";
import { isUnavailable, statusOf, tigerFetch } from "./api.js";
import {
  AWS_REGIONS,
  DATADOG_SITES,
  DEFAULT_DATABASE,
  DEFAULT_ROLE,
  EXPORTER_TYPES,
  REGIONS,
  SIZE_OPTIONS,
  parseSizeId,
  sizeLabel,
} from "./catalog.js";
import {
  mapAllowList,
  mapBackup,
  mapExporter,
  mapPeering,
  mapProject,
  mapReplica,
  mapService,
  mapVpc,
  postgresUri,
  splitExternalId,
} from "./mappers.js";
import {
  CPU_PERCENT_LABEL,
  MEMORY_PERCENT_LABEL,
  METRICS_WINDOW_MS,
  SERVICE_METRICS,
  ratioSeries,
  toSeries,
} from "./metrics.js";
import { ENRICH, renderTimescaleDetail, renderTimescaleSidebar } from "./render.js";
import { RESOURCE_TYPES, T } from "./resource-types.js";
import type {
  TgAllowList,
  TgBackup,
  TgBackupRegion,
  TgExporter,
  TgLogs,
  TgMetricSeries,
  TgPeering,
  TgProject,
  TgService,
  TgVpc,
} from "./types.js";

/** Listings are reused for this long within one client so a sync does not re-list per type. */
const CACHE_MS = 20_000;
/** Most recent backups kept per service; a long retention would otherwise flood the inventory. */
const MAX_BACKUPS_PER_SERVICE = 40;
/** Secret-store field holding the tsdbadmin password Infrawrench knows for a service. */
export const PASSWORD_SECRET = "tsdbadminPassword";

function csv(raw: string | undefined): string[] {
  let values: string[] = [];
  const text = String(raw ?? "").trim();
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) values = parsed.map(String);
    } catch {
      /* fall through to splitting */
    }
  }
  if (!values.length) values = text.split(/[,\n]/);
  return values.map((s) => s.trim()).filter(Boolean);
}

function boolish(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === "") return undefined;
  return raw === "true" || raw === "1" || raw === "yes";
}

/** 24 characters from an unambiguous alphabet, from the platform CSPRNG. */
export function generatePassword(length = 24): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export class TimescaleClient implements PluginClient {
  readonly ctx: TigerContext;
  private readonly services: HostServices | undefined;
  private cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const accessKey = (credentials["accessKey"] ?? "").trim();
    const secretKey = (credentials["secretKey"] ?? "").trim();
    if (!accessKey) throw new Error("Tiger Cloud plugin: missing accessKey credential");
    if (!secretKey) throw new Error("Tiger Cloud plugin: missing secretKey credential");
    this.services = services;
    this.ctx = { accessKey, secretKey, ...(services?.http ? { http: services.http } : {}) };
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

  private req<V>(
    method: string,
    path: string,
    body?: unknown,
    query?: Array<[string, string | number | undefined]>,
  ): Promise<V> {
    return tigerFetch<V>(this.ctx, method, path, body, query);
  }

  private svcPath(projectId: string, serviceId: string): string {
    return `/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}`;
  }

  /** Preview endpoints: an unavailable feature reads as nothing rather than an error. */
  private async optional<V>(load: () => Promise<V>, fallback: V): Promise<V> {
    try {
      return await load();
    } catch (err) {
      if (isUnavailable(err)) return fallback;
      throw err;
    }
  }

  projects(): Promise<TgProject[]> {
    return this.cached(
      "projects",
      async () => (await this.req<TgProject[]>("GET", "/projects")) ?? [],
    );
  }

  servicesOf(projectId: string): Promise<TgService[]> {
    return this.cached(`services-${projectId}`, async () => {
      const list = await this.req<TgService[]>(
        "GET",
        `/projects/${encodeURIComponent(projectId)}/services`,
      );
      return (list ?? []).map((s) => ({ ...s, project_id: s.project_id || projectId }));
    });
  }

  async allServices(): Promise<TgService[]> {
    const projects = await this.projects();
    const lists = await Promise.all(projects.map((p) => this.servicesOf(p.id)));
    return lists.flat();
  }

  private vpcsOf(projectId: string): Promise<TgVpc[]> {
    return this.cached(`vpcs-${projectId}`, async () =>
      this.optional(
        async () =>
          (await this.req<TgVpc[]>("GET", `/projects/${encodeURIComponent(projectId)}/vpcs`)) ?? [],
        [],
      ),
    );
  }

  private exportersOf(projectId: string): Promise<TgExporter[]> {
    return this.cached(`exporters-${projectId}`, async () =>
      this.optional(
        async () =>
          (await this.req<TgExporter[]>(
            "GET",
            `/projects/${encodeURIComponent(projectId)}/exporters`,
          )) ?? [],
        [],
      ),
    );
  }

  private allowListsOf(projectId: string): Promise<TgAllowList[]> {
    return this.cached(`allow-lists-${projectId}`, async () =>
      this.optional(
        async () =>
          (await this.req<TgAllowList[]>(
            "GET",
            `/projects/${encodeURIComponent(projectId)}/allow-lists`,
          )) ?? [],
        [],
      ),
    );
  }

  private async retentionOf(s: TgService): Promise<number | undefined> {
    try {
      const r = await this.req<{ retention_days?: number }>(
        "GET",
        `${this.svcPath(s.project_id, s.service_id)}/backup-retention`,
      );
      return typeof r?.retention_days === "number" ? r.retention_days : undefined;
    } catch (err) {
      if (statusOf(err) === 401) throw err;
      return undefined;
    }
  }

  private async findService(projectId: string, serviceId: string): Promise<TgService> {
    const svc = await this.req<TgService>("GET", this.svcPath(projectId, serviceId));
    return { ...svc, project_id: svc.project_id || projectId };
  }

  // -------------------------------------------------------------------------
  // Inventory
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case T.project: {
        const projects = await this.projects();
        return Promise.all(
          projects.map(async (p) => {
            const services = await this.servicesOf(p.id).catch(() => undefined);
            return mapProject(accountId, p, services?.length);
          }),
        );
      }
      case T.service: {
        const services = await this.allServices();
        return Promise.all(
          services.map(async (s) =>
            mapService(accountId, s, { backupRetentionDays: await this.retentionOf(s) }),
          ),
        );
      }
      case T.replica:
        return (await this.allServices()).flatMap((s) =>
          (s.read_replica_sets ?? []).map((r) => mapReplica(accountId, s, r)),
        );
      case T.vpc: {
        const out: ResourceInstance[] = [];
        for (const p of await this.projects()) {
          for (const v of await this.vpcsOf(p.id)) out.push(mapVpc(accountId, p.id, v));
        }
        return out;
      }
      case T.peering: {
        const out: ResourceInstance[] = [];
        for (const p of await this.projects()) {
          for (const v of await this.vpcsOf(p.id)) {
            const peerings = await this.optional(
              async () =>
                (await this.req<TgPeering[]>(
                  "GET",
                  `/projects/${encodeURIComponent(p.id)}/vpcs/${encodeURIComponent(v.id)}/peerings`,
                )) ?? [],
              [] as TgPeering[],
            );
            for (const peering of peerings) out.push(mapPeering(accountId, p.id, v.id, peering));
          }
        }
        return out;
      }
      case T.exporter: {
        const out: ResourceInstance[] = [];
        for (const p of await this.projects()) {
          const [exporters, services] = await Promise.all([
            this.exportersOf(p.id),
            this.servicesOf(p.id),
          ]);
          for (const e of exporters) {
            const attached = services
              .filter(
                (s) =>
                  s.metric_exporter_id === e.exporter_id || s.log_exporter_id === e.exporter_id,
              )
              .map((s) => s.name ?? s.service_id);
            out.push(mapExporter(accountId, p.id, e, attached));
          }
        }
        return out;
      }
      case T.allowList: {
        const out: ResourceInstance[] = [];
        for (const p of await this.projects()) {
          for (const a of await this.allowListsOf(p.id)) out.push(mapAllowList(accountId, p.id, a));
        }
        return out;
      }
      case T.backup: {
        const services = await this.allServices();
        const lists = await Promise.all(
          services.map(async (s) => {
            const backups = await this.optional(
              async () =>
                (await this.req<TgBackup[]>(
                  "GET",
                  `${this.svcPath(s.project_id, s.service_id)}/backups`,
                )) ?? [],
              [] as TgBackup[],
            );
            return backups
              .slice()
              .sort((a, b) => String(b.started_at ?? "").localeCompare(String(a.started_at ?? "")))
              .slice(0, MAX_BACKUPS_PER_SERVICE)
              .map((b) => mapBackup(accountId, s, b));
          }),
        );
        return lists.flat();
      }
      default:
        throw new Error(`Tiger Cloud plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const ext = externalIdOf(resourceId);
    if (typeId === T.service) {
      const [projectId, serviceId] = splitExternalId(ext, 2) as [string, string];
      const svc = await this.findService(projectId, serviceId);
      return mapService(accountId, svc, { backupRetentionDays: await this.retentionOf(svc) });
    }
    const found = (await this.listResources(typeId, accountId)).find((r) => r.externalId === ext);
    if (!found) {
      const err = new Error(`Tiger Cloud plugin: ${typeId} ${ext} not found`) as Error & {
        status: number;
      };
      err.status = 404;
      throw err;
    }
    return found;
  }

  // -------------------------------------------------------------------------
  // Outputs
  // -------------------------------------------------------------------------

  private secretKeyFor(accountId: string, projectId: string, serviceId: string): string {
    return `${accountId}:${T.service}:${projectId}/${serviceId}`;
  }

  private async storedPassword(accountId: string, projectId: string, serviceId: string) {
    return (
      (await this.services?.secrets?.getPlaintext(
        this.secretKeyFor(accountId, projectId, serviceId),
        PASSWORD_SECRET,
      )) ?? null
    );
  }

  private async storePassword(
    accountId: string,
    projectId: string,
    serviceId: string,
    password: string,
  ) {
    const secrets = this.services?.secrets;
    if (!secrets?.setPlaintext) return false;
    await secrets.setPlaintext(
      this.secretKeyFor(accountId, projectId, serviceId),
      PASSWORD_SECRET,
      password,
    );
    return true;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const ext = externalIdOf(resourceId);
    if (typeId === T.exporter && outputKey === "prometheusEndpoint") {
      const r = await this.getResource(typeId, resourceId, accountId);
      return String(r.fields["prometheusEndpoint"] ?? "");
    }
    if (typeId === T.replica) {
      const [projectId, serviceId, replicaId] = splitExternalId(ext, 3) as [string, string, string];
      const svc = await this.findService(projectId, serviceId);
      const replica = (svc.read_replica_sets ?? []).find((r) => r.id === replicaId);
      const host = replica?.endpoint?.host ?? "";
      const port = replica?.endpoint?.port ?? "";
      if (outputKey === "host") return host;
      if (outputKey === "port") return String(port);
      if (outputKey === "connectionString") {
        if (!host) throw new Error("This read replica set has no endpoint yet.");
        const password = await this.storedPassword(accountId, projectId, serviceId);
        if (!password) throw new Error(noPasswordMessage);
        return postgresUri(host, port, DEFAULT_ROLE, password, DEFAULT_DATABASE);
      }
      throw new Error(`Tiger Cloud plugin: unknown output "${outputKey}"`);
    }
    if (typeId !== T.service) {
      throw new Error(`Tiger Cloud plugin: cannot resolve "${outputKey}" for "${typeId}"`);
    }
    const [projectId, serviceId] = splitExternalId(ext, 2) as [string, string];
    const svc = await this.findService(projectId, serviceId);
    const host = svc.endpoint?.host ?? "";
    const port = svc.endpoint?.port ?? "";
    switch (outputKey) {
      case "host":
        return host;
      case "port":
        return String(port);
      case "database":
        return DEFAULT_DATABASE;
      case "username":
        return DEFAULT_ROLE;
      case "password": {
        const password = await this.storedPassword(accountId, projectId, serviceId);
        if (!password) throw new Error(noPasswordMessage);
        return password;
      }
      case "connectionString":
      case "poolerConnectionString": {
        const pooler = svc.connection_pooler?.endpoint;
        const target = outputKey === "poolerConnectionString" ? pooler : svc.endpoint;
        if (!target?.host) {
          throw new Error(
            outputKey === "poolerConnectionString"
              ? "The connection pooler is not enabled for this service."
              : "This service has no endpoint yet.",
          );
        }
        const password = await this.storedPassword(accountId, projectId, serviceId);
        if (!password) throw new Error(noPasswordMessage);
        return postgresUri(
          target.host,
          target.port ?? "",
          DEFAULT_ROLE,
          password,
          DEFAULT_DATABASE,
        );
      }
      default:
        throw new Error(`Tiger Cloud plugin: unknown output "${outputKey}"`);
    }
  }

  async rerollOutput(typeId: string, resourceId: string, _outputKey: string, accountId: string) {
    if (typeId !== T.service) throw new Error("Only a service's password can be reissued.");
    await this.setPassword(resourceId, accountId, "");
  }

  private async setPassword(resourceId: string, accountId: string, requested: string) {
    const [projectId, serviceId] = splitExternalId(externalIdOf(resourceId), 2) as [string, string];
    const password = requested.trim() || generatePassword();
    if (password.length < 8) throw new Error("Use at least 8 characters.");
    await this.req("POST", `${this.svcPath(projectId, serviceId)}/updatePassword`, { password });
    const stored = await this.storePassword(accountId, projectId, serviceId, password);
    return {
      ok: true,
      message: stored
        ? "Password set. The PostgreSQL tab and connection string outputs use it now."
        : "Password set, but this host cannot store it; note it down now.",
    };
  }

  // -------------------------------------------------------------------------
  // Detail
  // -------------------------------------------------------------------------

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    if (resource.resourceTypeId !== T.service) return resource;
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
    const [projectId, serviceId] = splitExternalId(
      resource.externalId ?? externalIdOf(resource.id),
      2,
    ) as [string, string];
    const [vpcs, exporters, allowLists, backupRegions] = await Promise.all([
      settle(this.vpcsOf(projectId)),
      settle(this.req<TgExporter[]>("GET", `/projects/${encodeURIComponent(projectId)}/exporters`)),
      settle(
        this.req<TgAllowList[]>("GET", `/projects/${encodeURIComponent(projectId)}/allow-lists`),
      ),
      settle(
        this.req<TgBackupRegion[]>("GET", `${this.svcPath(projectId, serviceId)}/backup-regions`),
      ),
    ]);
    put(
      ENRICH.vpcs,
      vpcs?.map((v) => ({
        id: v.id,
        label: `${v.name ?? v.id} (${v.cidr ?? "?"})`,
        region: v.region_code,
      })),
    );
    put(
      ENRICH.exporters,
      exporters?.map((e) => ({
        id: e.exporter_id,
        label: e.name ?? e.exporter_id,
        region: e.region_code,
        type: e.type,
      })),
    );
    put(
      ENRICH.allowLists,
      allowLists?.map((a) => ({
        id: a.allow_list_id,
        label: `${a.description || a.allow_list_id} (${(a.cidr_blocks ?? []).length} ranges)`,
      })),
    );
    put(
      ENRICH.backupRegions,
      backupRegions?.map((r) => r.region_code),
    );
    return out;
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return withMetricsCapability(
      renderTimescaleDetail(resource),
      RESOURCE_TYPES,
      resource.resourceTypeId,
      METRICS_WINDOW_MS,
    );
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderTimescaleSidebar(resource);
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
        options: projects.map((p) => ({ id: p.id, label: p.name ?? p.id, description: p.id })),
        ...(projects.length === 1 ? { defaultValue: projects[0]!.id } : {}),
      },
    ];
  }

  private async projectOf(
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<string> {
    if (parentResourceId) {
      const ext = externalIdOf(parentResourceId);
      return ext.split("/")[0]!;
    }
    if (fields["projectId"]) return fields["projectId"];
    const projects = await this.projects();
    if (projects.length === 1) return projects[0]!.id;
    throw new Error("Pick a project.");
  }

  private async serviceOptions() {
    return (await this.allServices()).map((s) => ({
      id: `${s.project_id}/${s.service_id}`,
      label: s.name ?? s.service_id,
      description: `${s.region_code ?? ""} · ${s.service_id}`,
    }));
  }

  private async vpcOptions() {
    const out: Array<{ id: string; label: string; description?: string }> = [];
    for (const p of await this.projects()) {
      for (const v of await this.vpcsOf(p.id)) {
        out.push({
          id: `${p.id}/${v.id}`,
          label: v.name ?? v.id,
          description: `${v.region_code ?? ""} · ${v.cidr ?? ""}`,
        });
      }
    }
    return out;
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case T.service:
        return {
          fields: [
            ...(await this.projectField(parentResourceId)),
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "metrics-prod",
            },
            {
              key: "serviceType",
              label: "Type",
              kind: "select",
              required: true,
              options: [
                {
                  id: "TIMESCALEDB",
                  label: "TimescaleDB",
                  description: "PostgreSQL with hypertables, compression and continuous aggregates",
                },
                { id: "POSTGRES", label: "PostgreSQL", description: "Plain PostgreSQL" },
              ],
              defaultValue: "TIMESCALEDB",
            },
            {
              key: "region",
              label: "Region",
              kind: "region-picker",
              required: false,
              regions: REGIONS,
              defaultValue: "us-east-1",
            },
            {
              key: "computeSize",
              label: "Compute",
              kind: "select",
              required: true,
              options: [
                { id: "shared", label: "Shared CPU / memory", description: "Free and trial plans" },
                ...SIZE_OPTIONS,
              ],
              defaultValue: "500/2",
            },
            {
              key: "haReplicas",
              label: "HA replicas",
              kind: "select",
              required: false,
              options: [
                { id: "0", label: "None" },
                { id: "1", label: "1 (high availability)" },
                { id: "2", label: "2 (highest availability)" },
              ],
              defaultValue: "0",
            },
            {
              key: "environment",
              label: "Environment",
              kind: "select",
              required: false,
              options: [
                { id: "DEV", label: "Development" },
                { id: "PROD", label: "Production" },
              ],
              defaultValue: "DEV",
            },
          ],
        };
      case T.replica:
        return {
          fields: [
            ...(parentResourceId
              ? []
              : [
                  {
                    key: "service",
                    label: "Primary service",
                    kind: "select" as const,
                    required: true,
                    options: await this.serviceOptions(),
                  },
                ]),
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "reporting" },
            {
              key: "nodes",
              label: "Nodes",
              kind: "number",
              required: true,
              minValue: 1,
              maxValue: 10,
              stepValue: 1,
              defaultValue: "1",
            },
            {
              key: "computeSize",
              label: "Compute per node",
              kind: "select",
              required: true,
              options: SIZE_OPTIONS,
              defaultValue: "500/2",
            },
          ],
        };
      case T.vpc:
        return {
          fields: [
            ...(await this.projectField(parentResourceId)),
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "prod-vpc" },
            {
              key: "cidr",
              label: "CIDR",
              kind: "text",
              required: true,
              placeholder: "10.0.0.0/24",
              description:
                "A private IPv4 range that does not overlap the AWS VPCs you will peer with.",
            },
            {
              key: "region",
              label: "Region",
              kind: "region-picker",
              required: true,
              regions: AWS_REGIONS,
              defaultValue: "us-east-1",
            },
          ],
        };
      case T.peering:
        return {
          fields: [
            ...(parentResourceId
              ? []
              : [
                  {
                    key: "vpc",
                    label: "Tiger Cloud VPC",
                    kind: "select" as const,
                    required: true,
                    options: await this.vpcOptions(),
                  },
                ]),
            {
              key: "peerAccountId",
              label: "Your AWS account ID",
              kind: "text",
              required: true,
              placeholder: "123456789012",
            },
            {
              key: "peerVpcId",
              label: "Your VPC ID",
              kind: "text",
              required: true,
              placeholder: "vpc-0123456789abcdef0",
            },
            {
              key: "peerRegion",
              label: "Your VPC's region",
              kind: "region-picker",
              required: true,
              regions: AWS_REGIONS,
            },
          ],
        };
      case T.exporter:
        return {
          fields: [...(await this.projectField(parentResourceId)), ...exporterCreateFields()],
        };
      case T.allowList:
        return {
          fields: [
            ...(await this.projectField(parentResourceId)),
            {
              key: "description",
              label: "Description",
              kind: "text",
              required: true,
              placeholder: "Office and CI runners",
            },
            {
              key: "cidrBlocks",
              label: "CIDR blocks",
              kind: "string-list",
              required: true,
              placeholder: "203.0.113.0/24",
              description:
                "Public ranges, each /17 or smaller. Attach the list to a service from the service's page.",
            },
          ],
        };
      default:
        throw new Error(`Tiger Cloud plugin: creating "${typeId}" is not supported`);
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
      case T.service: {
        const projectId = await this.projectOf(fields, parentResourceId);
        const name = (fields["name"] ?? "").trim();
        if (!name || name.length > 128) throw new Error("Name must be 1 to 128 characters.");
        const body: Record<string, unknown> = {
          name,
          addons: fields["serviceType"] === "POSTGRES" ? [] : ["time-series"],
        };
        if (fields["region"]) body["region_code"] = fields["region"];
        if (fields["computeSize"] === "shared") {
          body["cpu_millis"] = "shared";
          body["memory_gbs"] = "shared";
        } else if (fields["computeSize"]) {
          const size = parseSizeId(fields["computeSize"]);
          if (!size) throw new Error("Pick a compute size from the list.");
          body["cpu_millis"] = String(size.cpuMillis);
          body["memory_gbs"] = String(size.memoryGbs);
        }
        const ha = Number(fields["haReplicas"] || 0);
        if (ha > 0) body["replica_count"] = ha;
        if (fields["environment"]) body["environment_tag"] = fields["environment"];
        const svc = await this.req<TgService>(
          "POST",
          `/projects/${encodeURIComponent(projectId)}/services`,
          body,
        );
        const created = { ...svc, project_id: svc.project_id || projectId };
        if (created.initial_password) {
          await this.storePassword(
            accountId,
            projectId,
            created.service_id,
            created.initial_password,
          ).catch(() => false);
        }
        return mapService(accountId, created);
      }
      case T.replica: {
        const svcExt = parentResourceId
          ? externalIdOf(parentResourceId)
          : (fields["service"] ?? "");
        const [projectId, serviceId] = splitExternalId(svcExt, 2) as [string, string];
        const size = parseSizeId(fields["computeSize"] ?? "");
        if (!size) throw new Error("Pick a compute size from the list.");
        const nodes = Number(fields["nodes"] || 1);
        if (!Number.isInteger(nodes) || nodes < 1)
          throw new Error("Nodes must be a whole number of at least 1.");
        await this.req("POST", `${this.svcPath(projectId, serviceId)}/replicaSets`, {
          name: (fields["name"] ?? "").trim(),
          nodes,
          cpu_millis: size.cpuMillis,
          memory_gbs: size.memoryGbs,
        });
        const svc = await this.findService(projectId, serviceId);
        const replica = (svc.read_replica_sets ?? []).find(
          (r) => r.name === fields["name"]?.trim(),
        );
        return mapReplica(
          accountId,
          svc,
          replica ?? { id: "pending", name: fields["name"] ?? "", status: "creating" },
        );
      }
      case T.vpc: {
        const projectId = await this.projectOf(fields, parentResourceId);
        const vpc = await this.req<TgVpc>(
          "POST",
          `/projects/${encodeURIComponent(projectId)}/vpcs`,
          {
            name: (fields["name"] ?? "").trim(),
            cidr: (fields["cidr"] ?? "").trim(),
            region_code: fields["region"],
          },
        );
        return mapVpc(accountId, projectId, vpc);
      }
      case T.peering: {
        const vpcExt = parentResourceId ? externalIdOf(parentResourceId) : (fields["vpc"] ?? "");
        const [projectId, vpcId] = splitExternalId(vpcExt, 2) as [string, string];
        const accountIdAws = (fields["peerAccountId"] ?? "").trim();
        if (!/^\d{12}$/.test(accountIdAws)) throw new Error("The AWS account ID is 12 digits.");
        const peering = await this.req<TgPeering>(
          "POST",
          `/projects/${encodeURIComponent(projectId)}/vpcs/${encodeURIComponent(vpcId)}/peerings`,
          {
            peer_account_id: accountIdAws,
            peer_region_code: fields["peerRegion"],
            peer_vpc_id: (fields["peerVpcId"] ?? "").trim(),
          },
        );
        return mapPeering(accountId, projectId, vpcId, peering);
      }
      case T.exporter: {
        const projectId = await this.projectOf(fields, parentResourceId);
        const exporter = await this.req<TgExporter>(
          "POST",
          `/projects/${encodeURIComponent(projectId)}/exporters`,
          exporterCreateBody(fields),
        );
        return mapExporter(accountId, projectId, exporter, []);
      }
      case T.allowList: {
        const projectId = await this.projectOf(fields, parentResourceId);
        const blocks = csv(fields["cidrBlocks"]);
        if (!blocks.length) throw new Error("Add at least one CIDR block.");
        const list = await this.req<TgAllowList>(
          "POST",
          `/projects/${encodeURIComponent(projectId)}/allow-lists`,
          {
            description: (fields["description"] ?? "").trim(),
            cidr_blocks: blocks,
          },
        );
        return mapAllowList(accountId, projectId, list);
      }
      default:
        throw new Error(`Tiger Cloud plugin: creating "${typeId}" is not supported`);
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
      case T.service: {
        const [projectId, serviceId] = splitExternalId(ext, 2) as [string, string];
        const base = this.svcPath(projectId, serviceId);
        if (fields["name"] !== undefined && fields["name"].trim()) {
          await this.req("POST", `${base}/rename`, { name: fields["name"].trim() });
        }
        if (fields["environment"]) {
          await this.req("POST", `${base}/setEnvironment`, { environment: fields["environment"] });
        }
        if (fields["computeSize"]) {
          const size = parseSizeId(fields["computeSize"]);
          if (!size) throw new Error("Pick a compute size from the list.");
          await this.req("POST", `${base}/resize`, {
            cpu_millis: String(size.cpuMillis),
            memory_gbs: String(size.memoryGbs),
          });
        }
        if (fields["haReplicas"] !== undefined || fields["syncReplicas"] !== undefined) {
          const body: Record<string, number> = {};
          if (fields["haReplicas"] !== undefined && fields["haReplicas"] !== "") {
            body["replica_count"] = Number(fields["haReplicas"]);
          }
          if (fields["syncReplicas"] !== undefined && fields["syncReplicas"] !== "") {
            body["sync_replica_count"] = Number(fields["syncReplicas"]);
          }
          if (
            body["sync_replica_count"] === 1 &&
            body["replica_count"] !== undefined &&
            body["replica_count"] < 2
          ) {
            throw new Error("A synchronous replica needs HA replicas set to 2.");
          }
          if (Object.keys(body).length) await this.req("POST", `${base}/setHA`, body);
        }
        const pooler = boolish(fields["poolerEnabled"]);
        if (pooler !== undefined) {
          await this.req("POST", `${base}/${pooler ? "enablePooler" : "disablePooler"}`);
        }
        const tiering = boolish(fields["dataTiering"]);
        if (tiering === true) await this.req("POST", `${base}/enableDataTiering`);
        if (tiering === false) {
          throw new Error(
            "Tiered storage cannot be turned off through the API; contact Tiger Data support.",
          );
        }
        if (fields["backupRetentionDays"] !== undefined && fields["backupRetentionDays"] !== "") {
          const days = Number(fields["backupRetentionDays"]);
          if (!Number.isInteger(days) || days < 1)
            throw new Error("Backup retention is a whole number of days, at least 1.");
          await this.req("PUT", `${base}/backup-retention`, { type: "TIME", retention_days: days });
        }
        break;
      }
      case T.replica: {
        const [projectId, serviceId, replicaId] = splitExternalId(ext, 3) as [
          string,
          string,
          string,
        ];
        const base = `${this.svcPath(projectId, serviceId)}/replicaSets/${encodeURIComponent(replicaId)}`;
        if (fields["computeSize"]) {
          const size = parseSizeId(fields["computeSize"]);
          if (!size) throw new Error("Pick a compute size from the list.");
          await this.req("POST", `${base}/resize`, {
            cpu_millis: String(size.cpuMillis),
            memory_gbs: String(size.memoryGbs),
          });
        }
        if (fields["environment"]) {
          await this.req("POST", `${base}/setEnvironment`, { environment: fields["environment"] });
        }
        const pooler = boolish(fields["poolerEnabled"]);
        if (pooler !== undefined) {
          await this.req("POST", `${base}/${pooler ? "enablePooler" : "disablePooler"}`);
        }
        break;
      }
      case T.vpc: {
        const [projectId, vpcId] = splitExternalId(ext, 2) as [string, string];
        if (fields["name"]?.trim()) {
          await this.req(
            "POST",
            `/projects/${encodeURIComponent(projectId)}/vpcs/${encodeURIComponent(vpcId)}/rename`,
            {
              name: fields["name"].trim(),
            },
          );
        }
        break;
      }
      case T.exporter: {
        const [projectId, exporterId] = splitExternalId(ext, 2) as [string, string];
        const path = `/projects/${encodeURIComponent(projectId)}/exporters/${encodeURIComponent(exporterId)}`;
        const current = await this.req<TgExporter>("GET", path);
        const body: Record<string, unknown> = { type: current.type };
        if (fields["name"]?.trim()) body["name"] = fields["name"].trim();
        const include = boolish(fields["includePgMetrics"]);
        if (include !== undefined) {
          if (current.type === "CLOUDWATCH_LOGS") {
            throw new Error("Log exporters have no PostgreSQL metrics setting.");
          }
          const config = configUpdateFrom(current, {});
          if (!config) throw new Error("Log exporters have no PostgreSQL metrics setting.");
          config["include_pg_metrics"] = include;
          body["config"] = config;
        }
        await this.req("PATCH", path, body);
        break;
      }
      case T.allowList: {
        const [projectId, listId] = splitExternalId(ext, 2) as [string, string];
        const body: Record<string, unknown> = {};
        if (fields["description"] !== undefined) body["description"] = fields["description"].trim();
        if (fields["cidrBlocks"] !== undefined) {
          const blocks = csv(fields["cidrBlocks"]);
          if (!blocks.length)
            throw new Error("An IP allow list needs at least one CIDR block; delete it instead.");
          body["cidr_blocks"] = blocks;
        }
        if (Object.keys(body).length) {
          await this.req(
            "PATCH",
            `/projects/${encodeURIComponent(projectId)}/allow-lists/${encodeURIComponent(listId)}`,
            body,
          );
        }
        break;
      }
      default:
        throw new Error(`Tiger Cloud plugin: updating "${typeId}" is not supported`);
    }
    this.invalidate();
    return this.getResource(typeId, resourceId, accountId);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const ext = externalIdOf(resourceId);
    this.invalidate();
    switch (typeId) {
      case T.service: {
        const [p, s] = splitExternalId(ext, 2) as [string, string];
        await this.req("DELETE", this.svcPath(p, s));
        return;
      }
      case T.replica: {
        const [p, s, r] = splitExternalId(ext, 3) as [string, string, string];
        await this.req("DELETE", `${this.svcPath(p, s)}/replicaSets/${encodeURIComponent(r)}`);
        return;
      }
      case T.vpc: {
        const [p, v] = splitExternalId(ext, 2) as [string, string];
        await this.req(
          "DELETE",
          `/projects/${encodeURIComponent(p)}/vpcs/${encodeURIComponent(v)}`,
        );
        return;
      }
      case T.peering: {
        const [p, v, id] = splitExternalId(ext, 3) as [string, string, string];
        await this.req(
          "DELETE",
          `/projects/${encodeURIComponent(p)}/vpcs/${encodeURIComponent(v)}/peerings/${encodeURIComponent(id)}`,
        );
        return;
      }
      case T.exporter: {
        const [p, id] = splitExternalId(ext, 2) as [string, string];
        await this.req(
          "DELETE",
          `/projects/${encodeURIComponent(p)}/exporters/${encodeURIComponent(id)}`,
        );
        return;
      }
      case T.allowList: {
        const [p, id] = splitExternalId(ext, 2) as [string, string];
        await this.req(
          "DELETE",
          `/projects/${encodeURIComponent(p)}/allow-lists/${encodeURIComponent(id)}`,
        );
        return;
      }
      default:
        throw new Error(`Tiger Cloud plugin: deleting "${typeId}" is not supported`);
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
    if (typeId !== T.service) throw new Error(`Tiger Cloud plugin: unknown action "${actionId}"`);
    const [p, s] = splitExternalId(externalIdOf(resourceId), 2) as [string, string];
    const base = this.svcPath(p, s);
    this.invalidate();
    switch (actionId) {
      case "pause":
        await this.req("POST", `${base}/stop`);
        return;
      case "resume":
        await this.req("POST", `${base}/start`);
        return;
      case "enable-tiering":
        await this.req("POST", `${base}/enableDataTiering`);
        return;
      case "detach-vpc": {
        const svc = await this.findService(p, s);
        const vpcId = (svc.vpc_endpoint ?? svc.vpcEndpoint)?.vpc_id;
        if (!vpcId) throw new Error("This service is not attached to a VPC.");
        await this.req("POST", `${base}/detachFromVPC`, { vpc_id: vpcId });
        return;
      }
      default:
        throw new Error(`Tiger Cloud plugin: unknown action "${actionId}"`);
    }
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
    if (typeId === T.exporter && command === "rotate-exporter-secret") {
      const [p, id] = splitExternalId(ext, 2) as [string, string];
      const path = `/projects/${encodeURIComponent(p)}/exporters/${encodeURIComponent(id)}`;
      const current = await this.req<TgExporter>("GET", path);
      const config = configUpdateFrom(current, form);
      if (!config) throw new Error("This exporter has no credential to rotate.");
      await this.req("PATCH", path, { type: current.type, config });
      return { ok: true, message: "Credentials replaced." };
    }
    if (typeId !== T.service) {
      throw new Error(`Tiger Cloud plugin: command "${command}" is not supported for "${typeId}"`);
    }
    const [p, s] = splitExternalId(ext, 2) as [string, string];
    const base = this.svcPath(p, s);
    switch (command) {
      case "set-password":
        return this.setPassword(resourceId, accountId, form["password"] ?? "");
      case "fork": {
        const strategy = form["strategy"] || "NOW";
        const body: Record<string, unknown> = { fork_strategy: strategy };
        if (form["name"]?.trim()) body["name"] = form["name"].trim();
        if (strategy === "PITR") {
          if (!form["targetTime"]) throw new Error("Pick the point in time to recover to.");
          body["target_time"] = form["targetTime"];
        }
        if (form["computeSize"]) {
          const size = parseSizeId(form["computeSize"]);
          if (!size) throw new Error("Pick a compute size from the list.");
          body["cpu_millis"] = String(size.cpuMillis);
          body["memory_gbs"] = String(size.memoryGbs);
        }
        if (form["environment"]) body["environment_tag"] = form["environment"];
        const fork = await this.req<TgService>("POST", `${base}/forkService`, body);
        if (fork?.service_id) {
          // A fork inherits the parent's password; keep it for the fork too when known.
          const parentPassword = await this.storedPassword(accountId, p, s);
          const password = fork.initial_password || parentPassword;
          if (password)
            await this.storePassword(
              accountId,
              fork.project_id || p,
              fork.service_id,
              password,
            ).catch(() => false);
        }
        return {
          ok: true,
          message: `Fork ${fork?.name ?? ""} is being created.`.replace("  ", " "),
        };
      }
      case "attach-vpc":
        if (!form["vpcId"]) throw new Error("Pick a VPC.");
        await this.req("POST", `${base}/attachToVPC`, { vpc_id: form["vpcId"] });
        return { ok: true, message: "Attach requested; the endpoint moves within a few minutes." };
      case "attach-exporter":
        if (!form["exporterId"]) throw new Error("Pick an exporter.");
        await this.req("POST", `${base}/attachToExporter`, { exporter_id: form["exporterId"] });
        return { ok: true, message: "Exporter attached." };
      case "detach-exporter":
        if (!form["exporterId"]) throw new Error("Pick an exporter.");
        await this.req("POST", `${base}/detachFromExporter`, { exporter_id: form["exporterId"] });
        return { ok: true, message: "Exporter detached." };
      case "set-allow-list":
        return this.setAllowList(p, base, form["allowListId"] ?? "");
      case "backup-regions": {
        if (!form["add"] && !form["remove"]) return { ok: true, message: "Nothing changed." };
        if (form["add"])
          await this.req("POST", `${base}/backup-regions`, { region_code: form["add"] });
        if (form["remove"]) {
          await this.req("DELETE", `${base}/backup-regions/${encodeURIComponent(form["remove"])}`);
        }
        return { ok: true, message: "Cross-region backups updated." };
      }
      default:
        throw new Error(`Tiger Cloud plugin: command "${command}" is not supported`);
    }
  }

  /**
   * The service object does not say which IP allow list is attached, so
   * removing the restriction detaches every list in the project (a list that
   * is not attached answers 4xx, which is ignored), and attaching a new one
   * clears the old first when the API refuses a second.
   */
  private async setAllowList(projectId: string, base: string, wanted: string) {
    const lists = await this.allowListsOf(projectId);
    const detachOthers = async () => {
      for (const l of lists) {
        if (l.allow_list_id === wanted) continue;
        try {
          await this.req("POST", `${base}/detachFromAllowList`, { allow_list_id: l.allow_list_id });
        } catch (err) {
          const st = statusOf(err);
          if (st === 401 || st === 0 || st >= 500) throw err;
        }
      }
    };
    if (!wanted) {
      await detachOthers();
      return { ok: true, message: "IP restriction removed." };
    }
    try {
      await this.req("POST", `${base}/attachToAllowList`, { allow_list_id: wanted });
    } catch (err) {
      const st = statusOf(err);
      if (st !== 400 && st !== 409 && st !== 422) throw err;
      await detachOthers();
      await this.req("POST", `${base}/attachToAllowList`, { allow_list_id: wanted });
    }
    return { ok: true, message: "IP allow list attached." };
  }

  // -------------------------------------------------------------------------
  // Observability
  // -------------------------------------------------------------------------

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    if (resourceTypeId !== T.service) return [];
    const [p, s] = splitExternalId(externalIdOf(resourceId), 2) as [string, string];
    const end = timeRange?.endMs ?? Date.now();
    const start = timeRange?.startMs ?? end - METRICS_WINDOW_MS;
    const from = new Date(start).toISOString();
    const to = new Date(end).toISOString();
    const results = await Promise.all(
      SERVICE_METRICS.map(async (pick) => {
        try {
          const raw = await this.req<TgMetricSeries[]>(
            "POST",
            `${this.svcPath(p, s)}/metrics/series`,
            {
              metric_name: pick.name,
              from,
              to,
            },
          );
          return { pick, series: toSeries(pick, raw ?? []) };
        } catch (err) {
          if (statusOf(err) === 401) throw err;
          return { pick, series: [] as MetricSeries[] };
        }
      }),
    );
    const byName = new Map(results.map((r) => [r.pick.name, r.series]));
    const out = results.flatMap((r) => r.series).filter((s) => s.points.length > 0);
    const cpu = ratioSeries(
      CPU_PERCENT_LABEL,
      byName.get("timescale_cloud_system_cpu_usage_millicores")?.[0],
      byName.get("timescale_cloud_system_cpu_total_millicores")?.[0],
    );
    const mem = ratioSeries(
      MEMORY_PERCENT_LABEL,
      byName.get("timescale_cloud_system_memory_usage_bytes")?.[0],
      byName.get("timescale_cloud_system_memory_total_bytes")?.[0],
    );
    return [...(cpu ? [cpu] : []), ...(mem ? [mem] : []), ...out];
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const r = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = r.fields;
    const status = String(f["status"] ?? "");
    const variant: DashboardStat["variant"] =
      status === "READY" || status === "active"
        ? "status-healthy"
        : status === "PAUSED"
          ? "status-degraded"
          : "default";
    if (resourceTypeId === T.service) {
      return [
        { label: "Status", value: status, variant },
        {
          label: "Compute",
          value: f["cpuMillis"]
            ? sizeLabel(Number(f["cpuMillis"]), Number(f["memoryGb"] ?? 0))
            : "Shared",
        },
        {
          label: "Storage",
          value:
            f["storageUsedMb"] !== undefined
              ? `${Math.round((Number(f["storageUsedMb"]) / 1024) * 10) / 10} GB`
              : "",
        },
        { label: "Region", value: String(f["region"] ?? "") },
      ];
    }
    return [{ label: "Status", value: status, variant }];
  }

  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    const containers = ["All", "Warnings and errors"];
    const active =
      params.container && containers.includes(params.container) ? params.container : "All";
    if (typeId !== T.service) return { text: "", containers, activeContainer: active };
    const [p, s] = splitExternalId(externalIdOf(resourceId), 2) as [string, string];
    const tail = Math.min(Math.max(params.tailLines ?? 200, 1), 2000);
    const lines: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5 && lines.length < tail; page++) {
      const query: Array<[string, string | number | undefined]> = [["cursor", cursor]];
      if (active !== "All") {
        for (const sev of ["WARNING", "ERROR", "FATAL", "PANIC"]) query.push(["severities", sev]);
      }
      const res = await this.req<TgLogs>("GET", `${this.svcPath(p, s)}/logs`, undefined, query);
      const entries = res?.entries?.length
        ? res.entries.map(
            (e) =>
              `${(e.timestamp ?? "").replace("T", " ").replace(/Z$/, "")}  ${(e.severity ?? "").padEnd(7)}  ${e.message ?? ""}`,
          )
        : (res?.logs ?? []);
      lines.push(...entries);
      cursor = res?.last_cursor;
      if (!cursor || entries.length === 0) break;
    }
    // Newest first from the API; the tab reads oldest first.
    const text = lines
      .slice(0, tail)
      .reverse()
      .map((l) => `${l}\n`)
      .join("");
    return {
      text: text || "No log lines in the retention window.\n",
      containers,
      activeContainer: active,
    };
  }
}

const noPasswordMessage =
  "Tiger Cloud does not return a service's password after it is created. Use “Set password” on the service and Infrawrench keeps the new one for the PostgreSQL tab and connection strings.";

function exporterCreateFields(): CreateFieldConfig[] {
  const metrics = [
    "DATADOG_METRICS",
    "PROMETHEUS_METRICS",
    "CLOUDWATCH_METRICS",
    "AZURE_MONITOR_METRICS",
  ];
  const cloudwatch = ["CLOUDWATCH_METRICS", "CLOUDWATCH_LOGS"];
  return [
    { key: "name", label: "Name", kind: "text", required: true, placeholder: "datadog-prod" },
    {
      key: "type",
      label: "Destination",
      kind: "select",
      required: true,
      options: EXPORTER_TYPES,
      defaultValue: "DATADOG_METRICS",
    },
    {
      key: "region",
      label: "Region",
      kind: "region-picker",
      required: true,
      regions: REGIONS,
      description:
        "Only services in this region can send to the exporter; it cannot be changed later.",
    },
    {
      key: "includePgMetrics",
      label: "Include PostgreSQL metrics",
      kind: "select",
      required: false,
      options: [
        { id: "false", label: "No, operational metrics only" },
        { id: "true", label: "Yes, add per-table and per-index statistics" },
      ],
      defaultValue: "false",
      showWhen: { fieldKey: "type", fieldValues: metrics },
    },
    {
      key: "datadogApiKey",
      label: "Datadog API key",
      kind: "password",
      required: true,
      showWhen: { fieldKey: "type", fieldValue: "DATADOG_METRICS" },
    },
    {
      key: "datadogSite",
      label: "Datadog site",
      kind: "select",
      required: true,
      options: DATADOG_SITES,
      defaultValue: "datadoghq.com",
      showWhen: { fieldKey: "type", fieldValue: "DATADOG_METRICS" },
    },
    {
      key: "promUser",
      label: "Scrape username",
      kind: "text",
      required: true,
      showWhen: { fieldKey: "type", fieldValue: "PROMETHEUS_METRICS" },
    },
    {
      key: "promPassword",
      label: "Scrape password",
      kind: "password",
      required: true,
      showWhen: { fieldKey: "type", fieldValue: "PROMETHEUS_METRICS" },
    },
    {
      key: "azureConnectionString",
      label: "Azure Monitor connection string",
      kind: "password",
      required: true,
      showWhen: { fieldKey: "type", fieldValue: "AZURE_MONITOR_METRICS" },
    },
    {
      key: "namespace",
      label: "CloudWatch namespace",
      kind: "text",
      required: true,
      placeholder: "TigerCloud",
      showWhen: { fieldKey: "type", fieldValue: "CLOUDWATCH_METRICS" },
    },
    {
      key: "logGroup",
      label: "Log group (must exist)",
      kind: "text",
      required: true,
      showWhen: { fieldKey: "type", fieldValues: cloudwatch },
    },
    {
      key: "logStream",
      label: "Log stream",
      kind: "text",
      required: true,
      showWhen: { fieldKey: "type", fieldValues: cloudwatch },
    },
    {
      key: "awsRegion",
      label: "AWS region of the log group",
      kind: "region-picker",
      required: true,
      regions: AWS_REGIONS,
      showWhen: { fieldKey: "type", fieldValues: cloudwatch },
    },
    {
      key: "awsAuth",
      label: "Authenticate with",
      kind: "select",
      required: true,
      options: [
        { id: "IAM_ROLE", label: "An IAM role Tiger Cloud assumes" },
        { id: "ACCESS_KEY", label: "An access key pair" },
      ],
      defaultValue: "IAM_ROLE",
      showWhen: { fieldKey: "type", fieldValues: cloudwatch },
    },
    {
      key: "roleArn",
      label: "IAM role ARN",
      kind: "text",
      required: true,
      placeholder: "arn:aws:iam::123456789012:role/tiger-exporter",
      showWhen: {
        allOf: [
          { fieldKey: "type", fieldValues: cloudwatch },
          { fieldKey: "awsAuth", fieldValue: "IAM_ROLE" },
        ],
      },
    },
    {
      key: "accessKey",
      label: "Access key ID",
      kind: "text",
      required: true,
      showWhen: {
        allOf: [
          { fieldKey: "type", fieldValues: cloudwatch },
          { fieldKey: "awsAuth", fieldValue: "ACCESS_KEY" },
        ],
      },
    },
    {
      key: "secretKey",
      label: "Secret access key",
      kind: "password",
      required: true,
      showWhen: {
        allOf: [
          { fieldKey: "type", fieldValues: cloudwatch },
          { fieldKey: "awsAuth", fieldValue: "ACCESS_KEY" },
        ],
      },
    },
  ];
}

function awsCredentials(form: Record<string, string>, update: boolean) {
  if ((form["awsAuth"] || "IAM_ROLE") === "IAM_ROLE") {
    if (!form["roleArn"]?.trim()) throw new Error("Give the IAM role ARN.");
    return { type: "IAM_ROLE", aws_role_arn: form["roleArn"].trim() };
  }
  if (!update && (!form["accessKey"] || !form["secretKey"]))
    throw new Error("Give both halves of the access key.");
  return {
    type: "ACCESS_KEY",
    ...(form["accessKey"] ? { aws_access_key: form["accessKey"].trim() } : {}),
    ...(form["secretKey"] ? { aws_secret_key: form["secretKey"] } : {}),
  };
}

export function exporterCreateBody(form: Record<string, string>): Record<string, unknown> {
  const type = form["type"] ?? "";
  const name = (form["name"] ?? "").trim();
  if (!name) throw new Error("Give the exporter a name.");
  if (!form["region"]) throw new Error("Pick a region.");
  const include = form["includePgMetrics"] === "true";
  let config: Record<string, unknown>;
  switch (type) {
    case "DATADOG_METRICS":
      if (!form["datadogApiKey"]) throw new Error("Give a Datadog API key.");
      config = {
        api_key: form["datadogApiKey"],
        site: form["datadogSite"] || "datadoghq.com",
        include_pg_metrics: include,
      };
      break;
    case "PROMETHEUS_METRICS":
      if (!form["promUser"] || !form["promPassword"])
        throw new Error("Give a scrape username and password.");
      config = {
        username: form["promUser"],
        password: form["promPassword"],
        include_pg_metrics: include,
      };
      break;
    case "AZURE_MONITOR_METRICS":
      if (!form["azureConnectionString"])
        throw new Error("Give the Azure Monitor connection string.");
      config = { connection_string: form["azureConnectionString"], include_pg_metrics: include };
      break;
    case "CLOUDWATCH_METRICS":
    case "CLOUDWATCH_LOGS":
      config = {
        log_group_name: form["logGroup"],
        log_stream_name: form["logStream"],
        aws_region: form["awsRegion"],
        credentials: awsCredentials(form, false),
        ...(type === "CLOUDWATCH_METRICS"
          ? { namespace: form["namespace"], include_pg_metrics: include }
          : {}),
      };
      break;
    default:
      throw new Error("Pick a destination.");
  }
  return { name, type, region_code: form["region"], config };
}

/**
 * A full replacement `config` for PATCH, rebuilt from the exporter as read
 * plus any new secret in `form`. Secrets left out keep the stored value, which
 * is what the API documents for every update shape.
 */
export function configUpdateFrom(
  current: TgExporter,
  form: Record<string, string>,
): Record<string, unknown> | null {
  const c = current.config ?? {};
  const include = c.include_pg_metrics ?? false;
  switch (current.type) {
    case "DATADOG_METRICS":
      return {
        site: c.site ?? "datadoghq.com",
        include_pg_metrics: include,
        ...(form["apiKey"] ? { api_key: form["apiKey"] } : {}),
      };
    case "PROMETHEUS_METRICS":
      return {
        username: c.username ?? "",
        include_pg_metrics: include,
        ...(form["password"] ? { password: form["password"] } : {}),
      };
    case "AZURE_MONITOR_METRICS":
      return {
        include_pg_metrics: include,
        ...(form["connectionString"] ? { connection_string: form["connectionString"] } : {}),
      };
    case "CLOUDWATCH_METRICS":
    case "CLOUDWATCH_LOGS": {
      const credentials = form["awsAuth"]
        ? awsCredentials(form, true)
        : c.credentials?.type === "IAM_ROLE"
          ? { type: "IAM_ROLE", aws_role_arn: c.credentials.aws_role_arn }
          : { type: "ACCESS_KEY" };
      return {
        log_group_name: c.log_group_name,
        log_stream_name: c.log_stream_name,
        aws_region: c.aws_region,
        credentials,
        ...(current.type === "CLOUDWATCH_METRICS"
          ? { namespace: c.namespace, include_pg_metrics: include }
          : {}),
      };
    }
    default:
      return null;
  }
}
