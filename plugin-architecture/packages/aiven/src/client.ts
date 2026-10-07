import type {
  CostFetchRange,
  CostFetchResult,
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
  PublishMessagePayload,
  PublishMessageResult,
  ResourceInstance,
  SelectOption,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { decodePromptArgs, externalIdOf, withMetricsCapability } from "@infrawrench/plugin-base";
import type { AivenContext, Query } from "./api.js";
import { aivenFetch, enc, statusOf } from "./api.js";
import { fetchAivenCostData, serviceLabel } from "./cost-data.js";
import {
  chartsToSeries,
  mapAcl,
  mapBillingGroup,
  mapConnector,
  mapDatabase,
  mapIntegration,
  mapPeering,
  mapPool,
  mapProject,
  mapService,
  mapSubject,
  mapTopic,
  mapUser,
  mapVpc,
  parts,
  serviceConnectionString,
} from "./mappers.js";
import { ENRICH, renderAivenDetail, renderAivenSidebar } from "./render.js";
import { DAYS, RESOURCE_TYPES, T } from "./resource-types.js";
import type {
  AvBillingGroup,
  AvCloud,
  AvConnector,
  AvConnectorStatus,
  AvCredit,
  AvIntegration,
  AvInvoice,
  AvMetric,
  AvPlan,
  AvProject,
  AvService,
  AvTopic,
  AvVpc,
} from "./types.js";

const CACHE_MS = 30_000;
export const METRICS_WINDOW_MS = 60 * 60 * 1000;

/** Service types whose children (topics, connectors, …) the plugin lists. */
const KAFKA_TYPES = new Set(["kafka"]);
const CONNECT_TYPES = new Set(["kafka", "kafka_connect"]);
const DB_TYPES = new Set(["pg", "mysql"]);

function bool(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === "") return undefined;
  return raw === "true" || raw === "1" || raw === "yes";
}

function num(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function list(raw: string | undefined): string[] {
  return String(raw ?? "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseTags(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of list(raw)) {
    const idx = t.indexOf("=");
    if (idx <= 0) throw new Error(`Tag "${t}" must be key=value.`);
    out[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return out;
}

function stamp(raw: string | undefined): string {
  if (!raw) return "";
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toISOString().replace("T", " ").slice(0, 16);
}

/** The metrics `period` that covers a time range. */
export function metricsPeriod(rangeMs: number): string {
  const h = 3_600_000;
  if (rangeMs <= h) return "hour";
  if (rangeMs <= 24 * h) return "day";
  if (rangeMs <= 7 * 24 * h) return "week";
  if (rangeMs <= 31 * 24 * h) return "month";
  return "year";
}

export class AivenClient implements PluginClient {
  readonly ctx: AivenContext;
  private cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const token = (credentials["apiToken"] ?? "").trim();
    if (!token) throw new Error("Aiven plugin: missing apiToken credential");
    const caCert = (credentials["caCert"] ?? "").trim();
    this.ctx = {
      token,
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

  private api<V>(method: string, path: string, body?: unknown, query?: Query): Promise<V> {
    return aivenFetch<V>(this.ctx, method, path, {
      ...(body !== undefined ? { body } : {}),
      ...(query ? { query } : {}),
    });
  }

  private svcPath(project: string, service: string, rest = ""): string {
    return `/project/${enc(project)}/service/${enc(service)}${rest}`;
  }

  // -------------------------------------------------------------------------
  // Listings
  // -------------------------------------------------------------------------

  projects(): Promise<AvProject[]> {
    return this.cached(
      "projects",
      async () => (await this.api<{ projects?: AvProject[] }>("GET", "/project"))?.projects ?? [],
    );
  }

  /** Every service in every project, with users, pools and ACLs embedded. */
  services(): Promise<Array<{ project: string; svc: AvService }>> {
    return this.cached("services", async () => {
      const out: Array<{ project: string; svc: AvService }> = [];
      for (const p of await this.projects()) {
        if (!p.project_name) continue;
        const res = await this.api<{ services?: AvService[] }>(
          "GET",
          `/project/${enc(p.project_name)}/service`,
        );
        for (const svc of res?.services ?? []) out.push({ project: p.project_name, svc });
      }
      return out;
    });
  }

  private servicesOf(types: Set<string>) {
    return this.services().then((all) =>
      all.filter((s) => types.has(s.svc.service_type ?? "") && s.svc.state === "RUNNING"),
    );
  }

  private vpcs(): Promise<Array<{ project: string; vpc: AvVpc }>> {
    return this.cached("vpcs", async () => {
      const out: Array<{ project: string; vpc: AvVpc }> = [];
      for (const p of await this.projects()) {
        if (!p.project_name) continue;
        const res = await this.api<{ vpcs?: AvVpc[] }>(
          "GET",
          `/project/${enc(p.project_name)}/vpcs`,
        );
        for (const vpc of res?.vpcs ?? [])
          if (vpc.state !== "DELETED") out.push({ project: p.project_name, vpc });
      }
      return out;
    });
  }

  private billingGroups(): Promise<AvBillingGroup[]> {
    return this.cached(
      "billing-groups",
      async () =>
        (await this.api<{ billing_groups?: AvBillingGroup[] }>("GET", "/billing-group"))
          ?.billing_groups ?? [],
    );
  }

  private clouds(project?: string): Promise<AvCloud[]> {
    return this.cached(`clouds-${project ?? ""}`, async () => {
      const path = project ? `/project/${enc(project)}/clouds` : "/clouds";
      return (await this.api<{ clouds?: AvCloud[] }>("GET", path))?.clouds ?? [];
    });
  }

  private async cloudOptions(project?: string): Promise<SelectOption[]> {
    return (await this.clouds(project)).map((c) => ({
      id: c.cloud_name ?? "",
      label: c.cloud_name ?? "",
      description: c.cloud_description ?? c.geo_region ?? "",
    }));
  }

  private plans(project: string, type: string): Promise<AvPlan[]> {
    return this.cached(
      `plans-${project}-${type}`,
      async () =>
        (
          await this.api<{ service_plans?: AvPlan[] }>(
            "GET",
            `/project/${enc(project)}/service-types/${enc(type)}/plans`,
          )
        )?.service_plans ?? [],
    );
  }

  private async planOptions(project: string, type: string, cloud: string): Promise<SelectOption[]> {
    const plans = await this.plans(project, type);
    const price = (p: AvPlan) => Number(p.regions?.[cloud]?.price_usd ?? NaN);
    return plans
      .slice()
      .sort((a, b) => (price(a) || 0) - (price(b) || 0))
      .map((p) => {
        const region = p.regions?.[cloud];
        const hourly = price(p);
        return {
          id: p.service_plan ?? "",
          label: p.service_plan ?? "",
          description: [
            p.node_count ? `${p.node_count} node${p.node_count === 1 ? "" : "s"}` : "",
            region?.node_memory_mb ? `${Math.round(region.node_memory_mb / 1024)} GB RAM` : "",
            region?.disk_space_mb ? `${Math.round(region.disk_space_mb / 1024)} GB disk` : "",
            Number.isFinite(hourly) ? `~$${(hourly * 730).toFixed(0)}/mo` : "",
          ]
            .filter(Boolean)
            .join(" · "),
        };
      });
  }

  private projectCa(project: string): Promise<string> {
    return this.cached(
      `ca-${project}`,
      async () =>
        (await this.api<{ certificate?: string }>("GET", `/project/${enc(project)}/kms/ca`))
          ?.certificate ?? "",
    );
  }

  private async service(project: string, name: string, secrets = false): Promise<AvService> {
    const res = await this.api<{ service?: AvService }>(
      "GET",
      this.svcPath(project, name),
      undefined,
      secrets ? { include_secrets: true } : undefined,
    );
    if (!res?.service)
      throw Object.assign(new Error(`Aiven plugin: service ${project}/${name} not found`), {
        status: 404,
      });
    return res.service;
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case T.project:
        return (await this.projects()).map((p) => mapProject(accountId, p));
      case T.service:
        return (await this.services()).map(({ project, svc }) =>
          mapService(accountId, project, svc),
        );
      case T.user:
        return (await this.services()).flatMap(({ project, svc }) =>
          (svc.users ?? []).map((u) =>
            mapUser(accountId, project, svc.service_name ?? "", u, svc.service_type),
          ),
        );
      case T.database:
        return (await this.services())
          .filter(({ svc }) => DB_TYPES.has(svc.service_type ?? ""))
          .flatMap(({ project, svc }) =>
            (svc.databases ?? []).map((d) =>
              mapDatabase(accountId, project, svc.service_name ?? "", d, svc.service_type),
            ),
          );
      case T.pool:
        return (await this.services()).flatMap(({ project, svc }) =>
          (svc.connection_pools ?? []).map((p) =>
            mapPool(accountId, project, svc.service_name ?? "", p),
          ),
        );
      case T.acl:
        return (await this.services())
          .filter(({ svc }) => svc.service_type === "kafka")
          .flatMap(({ project, svc }) =>
            (svc.acl ?? []).map((a) => mapAcl(accountId, project, svc.service_name ?? "", a)),
          );
      case T.topic: {
        const out: ResourceInstance[] = [];
        for (const { project, svc } of await this.servicesOf(KAFKA_TYPES)) {
          const res = await this.api<{ topics?: AvTopic[] }>(
            "GET",
            this.svcPath(project, svc.service_name ?? "", "/topic"),
          ).catch(() => undefined);
          for (const t of res?.topics ?? [])
            out.push(mapTopic(accountId, project, svc.service_name ?? "", t));
        }
        return out;
      }
      case T.connector: {
        const out: ResourceInstance[] = [];
        for (const { project, svc } of await this.servicesOf(CONNECT_TYPES)) {
          if (svc.service_type === "kafka" && !(svc.user_config?.["kafka_connect"] === true))
            continue;
          const res = await this.api<{ connectors?: AvConnector[] }>(
            "GET",
            this.svcPath(project, svc.service_name ?? "", "/connectors"),
          ).catch(() => undefined);
          for (const c of res?.connectors ?? [])
            out.push(mapConnector(accountId, project, svc.service_name ?? "", c));
        }
        return out;
      }
      case T.subject: {
        const out: ResourceInstance[] = [];
        for (const { project, svc } of await this.servicesOf(KAFKA_TYPES)) {
          if (!(svc.user_config?.["schema_registry"] === true)) continue;
          const res = await this.api<{ subjects?: string[] }>(
            "GET",
            this.svcPath(project, svc.service_name ?? "", "/kafka/schema/subjects"),
          ).catch(() => undefined);
          for (const s of res?.subjects ?? [])
            out.push(mapSubject(accountId, project, svc.service_name ?? "", s));
        }
        return out;
      }
      case T.integration: {
        const seen = new Map<string, ResourceInstance>();
        for (const { project, svc } of await this.services()) {
          for (const i of svc.service_integrations ?? []) {
            if (!i.service_integration_id || seen.has(i.service_integration_id)) continue;
            seen.set(i.service_integration_id, mapIntegration(accountId, project, i));
          }
        }
        return [...seen.values()];
      }
      case T.vpc:
        return (await this.vpcs()).map(({ project, vpc }) => mapVpc(accountId, project, vpc));
      case T.peering: {
        const out: ResourceInstance[] = [];
        for (const { project, vpc } of await this.vpcs()) {
          const full = await this.api<AvVpc>(
            "GET",
            `/project/${enc(project)}/vpcs/${enc(vpc.project_vpc_id ?? "")}`,
          ).catch(() => undefined);
          for (const p of full?.peering_connections ?? [])
            out.push(mapPeering(accountId, project, vpc.project_vpc_id ?? "", p));
        }
        return out;
      }
      case T.billingGroup:
        return (await this.billingGroups()).map((b) => mapBillingGroup(accountId, b));
      default:
        throw new Error(`Aiven plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const ext = externalIdOf(resourceId);
    if (typeId === T.service) {
      const [project, name] = parts(ext, 2) as [string, string];
      return mapService(accountId, project, await this.service(project, name));
    }
    if (typeId === T.topic) {
      const [project, service, topic] = parts(ext, 3) as [string, string, string];
      const res = await this.api<{ topic?: AvTopic & { config?: unknown } }>(
        "GET",
        this.svcPath(project, service, `/topic/${enc(topic)}`),
      );
      return mapTopic(accountId, project, service, { topic_name: topic, ...(res?.topic ?? {}) });
    }
    const found = (await this.listResources(typeId, accountId)).find((r) => r.id === resourceId);
    if (!found)
      throw Object.assign(new Error(`Aiven plugin: resource ${typeId}/${ext} not found`), {
        status: 404,
      });
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    _accountId: string,
  ): Promise<string> {
    const ext = externalIdOf(resourceId);
    if (typeId === T.service) {
      const [project, name] = parts(ext, 2) as [string, string];
      if (outputKey === "caCertificate") return this.projectCa(project);
      const svc = await this.service(project, name, true);
      const params = svc.service_uri_params ?? {};
      const admin = (svc.users ?? []).find((u) => u.type === "primary") ?? svc.users?.[0];
      switch (outputKey) {
        case "connectionString": {
          const ca =
            svc.service_type === "kafka"
              ? await this.projectCa(project).catch(() => "")
              : undefined;
          const uri = serviceConnectionString(svc, ca);
          if (!uri) {
            throw new Error(
              svc.service_type === "kafka"
                ? "This Kafka service has no SASL endpoint. Enable kafka_authentication_methods.sasl to connect with a username and password."
                : "This service has no connection URI (it may be powered off).",
            );
          }
          return uri;
        }
        case "host":
          return params["host"] ?? "";
        case "port":
          return params["port"] ?? "";
        case "username":
          return params["user"] ?? admin?.username ?? "";
        case "password":
          return params["password"] ?? admin?.password ?? "";
        case "database":
          return params["dbname"] ?? "";
      }
    }
    if (typeId === T.user) {
      const [project, service, username] = parts(ext, 3) as [string, string, string];
      const svc = await this.service(project, service, true);
      const u = (svc.users ?? []).find((x) => x.username === username);
      if (outputKey === "password") return u?.password ?? "";
      if (outputKey === "accessCert") return u?.access_cert ?? "";
      if (outputKey === "accessKey") return u?.access_key ?? "";
    }
    if (typeId === T.pool && outputKey === "connectionString") {
      const [project, service, pool] = parts(ext, 3) as [string, string, string];
      const svc = await this.service(project, service, true);
      return (svc.connection_pools ?? []).find((p) => p.pool_name === pool)?.connection_uri ?? "";
    }
    throw new Error(`Aiven plugin: cannot resolve "${outputKey}" for "${typeId}"`);
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
    const creditRows = (credits: AvCredit[] | undefined) =>
      credits?.map((c) => ({
        code: c.code ?? "",
        type: c.type ?? "",
        remaining: c.remaining_value ?? "",
        expires: stamp(c.expire_time),
      }));
    switch (resource.resourceTypeId) {
      case T.project: {
        const [alerts, credits, groups, clouds] = await Promise.all([
          settle(
            this.api<{ alerts?: Array<Record<string, string>> }>(
              "GET",
              `/project/${enc(ext)}/alerts`,
            ),
          ),
          settle(this.api<{ credits?: AvCredit[] }>("GET", `/project/${enc(ext)}/credits`)),
          settle(this.billingGroups()),
          settle(this.cloudOptions(ext)),
        ]);
        put(
          ENRICH.alerts,
          alerts?.alerts?.map((a) => ({
            time: stamp(a["create_time"]),
            service: a["service_name"] ?? "",
            severity: a["severity"] ?? "",
            event: a["event"] ?? "",
          })),
        );
        put(ENRICH.credits, creditRows(credits?.credits));
        put(
          ENRICH.billingGroups,
          groups?.map((g) => ({
            id: g.billing_group_id ?? "",
            label: g.billing_group_name ?? g.billing_group_id ?? "",
          })),
        );
        put(ENRICH.clouds, clouds);
        break;
      }
      case T.service: {
        const [project, name] = parts(ext, 2) as [string, string];
        const type = String(resource.fields["serviceType"] ?? "");
        const cloud = String(resource.fields["cloud"] ?? "");
        const [svc, plans, clouds, alerts] = await Promise.all([
          settle(this.service(project, name)),
          settle(this.planOptions(project, type, cloud)),
          settle(this.cloudOptions(project)),
          settle(
            this.api<{ alerts?: Array<Record<string, string>> }>(
              "GET",
              this.svcPath(project, name, "/alerts"),
            ),
          ),
        ]);
        put(ENRICH.plans, plans);
        put(ENRICH.clouds, clouds);
        put(
          ENRICH.alerts,
          alerts?.alerts?.map((a) => ({
            time: stamp(a["create_time"]),
            severity: a["severity"] ?? "",
            event: a["event"] ?? "",
            node: a["node_name"] ?? "",
          })),
        );
        if (svc) {
          put(
            ENRICH.nodes,
            svc.node_states?.map((n) => ({
              name: n.name ?? "",
              role: n.role ?? "",
              state: n.state ?? "",
            })),
          );
          put(
            ENRICH.backups,
            svc.backups
              ?.slice(-10)
              .reverse()
              .map((b) => ({
                name: b.backup_name ?? "",
                time: stamp(b.backup_time),
                size: b.data_size ? `${Math.round(b.data_size / 1048576)} MB` : "",
              })),
          );
          put(
            ENRICH.maintenance,
            svc.maintenance?.updates?.map((u) => ({
              description: u.description ?? "",
              deadline: stamp(u.deadline),
            })),
          );
        }
        break;
      }
      case T.connector: {
        const [project, service, name] = parts(ext, 3) as [string, string, string];
        const st = await settle(
          this.api<{ status?: AvConnectorStatus }>(
            "GET",
            this.svcPath(project, service, `/connectors/${enc(name)}/status`),
          ),
        );
        put(ENRICH.connectorStatus, st?.status);
        break;
      }
      case T.subject: {
        const [project, service, subject] = parts(ext, 3) as [string, string, string];
        const base = this.svcPath(
          project,
          service,
          `/kafka/schema/subjects/${enc(subject)}/versions`,
        );
        const versions =
          (await settle(this.api<{ versions?: number[] }>("GET", base)))?.versions ?? [];
        const latest = versions.length ? Math.max(...versions) : undefined;
        if (latest !== undefined) {
          const v = await settle(
            this.api<{ version?: { version?: number; schema?: string; schemaType?: string } }>(
              "GET",
              `${base}/${latest}`,
            ),
          );
          put(ENRICH.schema, {
            version: latest,
            versions,
            schema: v?.version?.schema,
            schemaType: v?.version?.schemaType,
          });
        }
        break;
      }
      case T.vpc: {
        const [project, vpcId] = parts(ext, 2) as [string, string];
        const v = await settle(
          this.api<AvVpc>("GET", `/project/${enc(project)}/vpcs/${enc(vpcId)}`),
        );
        put(
          ENRICH.peerings,
          v?.peering_connections?.map((p) => ({
            peer: `${p.peer_cloud_account ?? ""} / ${p.peer_vpc ?? ""}`,
            state: p.state ?? "",
            info: p.state_info?.message ?? "",
          })),
        );
        break;
      }
      case T.billingGroup: {
        const [invoices, credits] = await Promise.all([
          settle(this.api<{ invoices?: AvInvoice[] }>("GET", `/billing-group/${enc(ext)}/invoice`)),
          settle(this.api<{ credits?: AvCredit[] }>("GET", `/billing-group/${enc(ext)}/credits`)),
        ]);
        put(
          ENRICH.invoices,
          invoices?.invoices?.slice(0, 12).map((i) => ({
            number: i.invoice_number ?? "",
            period: `${(i.period_begin ?? "").slice(0, 10)} to ${(i.period_end ?? "").slice(0, 10)}`,
            state: i.state ?? "",
            total: `${i.total_inc_vat ?? ""} ${i.currency ?? ""}`.trim(),
          })),
        );
        put(ENRICH.credits, creditRows(credits?.credits));
        break;
      }
    }
    return out;
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return withMetricsCapability(
      renderAivenDetail(resource),
      RESOURCE_TYPES,
      resource.resourceTypeId,
      METRICS_WINDOW_MS,
    );
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderAivenSidebar(resource);
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  private async projectField(parentResourceId?: string): Promise<CreateFieldConfig[]> {
    if (parentResourceId) return [];
    const projects = await this.projects();
    return [
      {
        key: "project",
        label: "Project",
        kind: "select",
        required: true,
        options: projects.map((p) => ({
          id: p.project_name ?? "",
          label: p.project_name ?? "",
          description: p.default_cloud ?? "",
        })),
        defaultValue: projects[0]?.project_name ?? "",
      },
    ];
  }

  /** Parent service from the create context: `{project}/{service}`. */
  private async serviceField(
    parentResourceId: string | undefined,
    types: Set<string>,
  ): Promise<CreateFieldConfig[]> {
    if (parentResourceId) return [];
    const services = (await this.services()).filter((s) => types.has(s.svc.service_type ?? ""));
    return [
      {
        key: "service",
        label: "Service",
        kind: "select",
        required: true,
        options: services.map((s) => ({
          id: `${s.project}/${s.svc.service_name}`,
          label: s.svc.service_name ?? "",
          description: s.project,
        })),
      },
    ];
  }

  private serviceOf(fields: Record<string, string>, parentResourceId?: string): [string, string] {
    const raw = fields["service"] || (parentResourceId ? externalIdOf(parentResourceId) : "");
    if (!raw) throw new Error("Pick a service.");
    return parts(raw, 2) as [string, string];
  }

  private projectOf(fields: Record<string, string>, parentResourceId?: string): string {
    const p =
      fields["project"] || (parentResourceId ? externalIdOf(parentResourceId).split("/")[0] : "");
    if (!p) throw new Error("Pick a project.");
    return p;
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case T.project: {
        const [groups, clouds] = await Promise.all([
          this.billingGroups().catch(() => []),
          this.cloudOptions().catch(() => []),
        ]);
        return {
          fields: [
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "my-project",
              description: "Globally unique and cannot be renamed.",
            },
            {
              key: "cloud",
              label: "Default cloud",
              kind: "select",
              required: false,
              options: clouds,
            },
            {
              key: "billingGroupId",
              label: "Billing group",
              kind: "select",
              required: false,
              options: groups.map((g) => ({
                id: g.billing_group_id ?? "",
                label: g.billing_group_name ?? "",
              })),
            },
          ],
        };
      }
      case T.service: {
        const project = parentResourceId
          ? externalIdOf(parentResourceId)
          : ((await this.projects())[0]?.project_name ?? "");
        const projectField = await this.projectField(parentResourceId);
        if (!project) return { fields: [...projectField] };
        const typesRes = await this.api<Record<string, { description?: string }>>(
          "GET",
          `/project/${enc(project)}/service-types`,
        ).catch(() => ({}) as Record<string, { description?: string }>);
        const types = Object.entries(typesRes)
          .filter(([k, v]) => k !== "errors" && k !== "message" && v && typeof v === "object")
          .map(([k, v]) => ({ id: k, label: serviceLabel(k), description: v.description ?? "" }));
        const defaultCloud =
          (await this.projects()).find((p) => p.project_name === project)?.default_cloud ?? "";
        const [clouds, perType] = await Promise.all([
          this.cloudOptions(project).catch(() => [] as SelectOption[]),
          Promise.all(
            types.map(async (t) => ({
              type: t.id,
              plans: await this.planOptions(project, t.id, defaultCloud).catch(
                () => [] as SelectOption[],
              ),
            })),
          ),
        ]);
        return {
          fields: [
            ...projectField,
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "pg-main" },
            {
              key: "serviceType",
              label: "Service",
              kind: "select",
              required: true,
              options: types,
              defaultValue: types.some((t) => t.id === "pg") ? "pg" : (types[0]?.id ?? ""),
            },
            ...perType
              .filter((p) => p.plans.length)
              .map((p): CreateFieldConfig => ({
                key: `plan__${p.type}`,
                label: "Plan",
                kind: "select",
                required: false,
                options: p.plans,
                defaultValue:
                  p.plans.find((x) => /startup|hobbyist/.test(x.id))?.id ?? p.plans[0]?.id ?? "",
                showWhen: { fieldKey: "serviceType", fieldValue: p.type },
                description: `Prices are for ${defaultCloud || "the project's default cloud"}.`,
              })),
            {
              key: "cloud",
              label: "Cloud",
              kind: "select",
              required: true,
              options: clouds,
              defaultValue: defaultCloud,
            },
            {
              key: "terminationProtection",
              label: "Termination protection",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: [
                { id: "false", label: "Off" },
                { id: "true", label: "On (block deletion and power off)" },
              ],
            },
          ],
        };
      }
      case T.user:
        return {
          fields: [
            ...(await this.serviceField(
              parentResourceId,
              new Set([
                "pg",
                "mysql",
                "kafka",
                "valkey",
                "opensearch",
                "dragonfly",
                "clickhouse",
                "grafana",
              ]),
            )),
            { key: "username", label: "Username", kind: "text", required: true },
          ],
        };
      case T.database:
        return {
          fields: [
            ...(await this.serviceField(parentResourceId, DB_TYPES)),
            { key: "name", label: "Database name", kind: "text", required: true },
          ],
        };
      case T.pool: {
        const svcFields = await this.serviceField(parentResourceId, new Set(["pg"]));
        let dbOptions: SelectOption[] = [];
        let userOptions: SelectOption[] = [];
        if (parentResourceId) {
          const [project, name] = parts(externalIdOf(parentResourceId), 2) as [string, string];
          const svc = await this.service(project, name).catch(() => undefined);
          dbOptions = (svc?.databases ?? []).map((d) => ({ id: d, label: d }));
          userOptions = (svc?.users ?? []).map((u) => ({
            id: u.username ?? "",
            label: u.username ?? "",
          }));
        }
        return {
          fields: [
            ...svcFields,
            { key: "name", label: "Pool name", kind: "text", required: true },
            dbOptions.length
              ? {
                  key: "database",
                  label: "Database",
                  kind: "select",
                  required: true,
                  options: dbOptions,
                  defaultValue: "defaultdb",
                }
              : {
                  key: "database",
                  label: "Database",
                  kind: "text",
                  required: true,
                  defaultValue: "defaultdb",
                },
            userOptions.length
              ? {
                  key: "username",
                  label: "User",
                  kind: "select",
                  required: false,
                  options: userOptions,
                }
              : {
                  key: "username",
                  label: "User",
                  kind: "text",
                  required: false,
                  placeholder: "avnadmin",
                },
            {
              key: "poolMode",
              label: "Pool mode",
              kind: "select",
              required: false,
              defaultValue: "transaction",
              options: ["transaction", "session", "statement"].map((m) => ({ id: m, label: m })),
            },
            {
              key: "poolSize",
              label: "Pool size",
              kind: "number",
              required: false,
              defaultValue: "10",
              minValue: 1,
            },
          ],
        };
      }
      case T.topic:
        return {
          fields: [
            ...(await this.serviceField(parentResourceId, KAFKA_TYPES)),
            { key: "name", label: "Topic name", kind: "text", required: true },
            {
              key: "partitions",
              label: "Partitions",
              kind: "number",
              required: true,
              defaultValue: "3",
              minValue: 1,
            },
            {
              key: "replication",
              label: "Replication",
              kind: "number",
              required: true,
              defaultValue: "3",
              minValue: 2,
            },
            {
              key: "retentionHours",
              label: "Retention (hours, -1 for forever)",
              kind: "number",
              required: false,
              defaultValue: "168",
            },
            {
              key: "cleanupPolicy",
              label: "Cleanup policy",
              kind: "select",
              required: false,
              defaultValue: "delete",
              options: [
                { id: "delete", label: "Delete old segments" },
                { id: "compact", label: "Compact (keep latest per key)" },
                { id: "compact,delete", label: "Compact and delete" },
              ],
            },
          ],
        };
      case T.acl: {
        let users: SelectOption[] = [];
        let topics: string[] = [];
        if (parentResourceId) {
          const [project, name] = parts(externalIdOf(parentResourceId), 2) as [string, string];
          const svc = await this.service(project, name).catch(() => undefined);
          users = (svc?.users ?? []).map((u) => ({
            id: u.username ?? "",
            label: u.username ?? "",
          }));
          topics = (
            (
              await this.api<{ topics?: AvTopic[] }>(
                "GET",
                this.svcPath(project, name, "/topic"),
              ).catch(() => undefined)
            )?.topics ?? []
          ).map((t) => t.topic_name ?? "");
        }
        return {
          fields: [
            ...(await this.serviceField(parentResourceId, KAFKA_TYPES)),
            {
              key: "username",
              label: "User (or pattern)",
              kind: "text",
              required: true,
              description: users.length
                ? `Users: ${users.map((u) => u.label).join(", ")}. Wildcards like app-* are allowed.`
                : "Wildcards like app-* are allowed.",
            },
            {
              key: "topic",
              label: "Topic (or pattern)",
              kind: "text",
              required: true,
              description: topics.length
                ? `Topics: ${topics.slice(0, 20).join(", ")}. Wildcards are allowed.`
                : "Wildcards are allowed.",
            },
            {
              key: "permission",
              label: "Permission",
              kind: "select",
              required: true,
              defaultValue: "read",
              options: ["read", "write", "readwrite", "admin"].map((p) => ({ id: p, label: p })),
            },
          ],
        };
      }
      case T.connector: {
        let available: SelectOption[] = [];
        if (parentResourceId) {
          const [project, name] = parts(externalIdOf(parentResourceId), 2) as [string, string];
          const res = await this.api<{
            plugins?: Array<{ class?: string; title?: string; type?: string }>;
          }>("GET", this.svcPath(project, name, "/available-connectors")).catch(() => undefined);
          available = (res?.plugins ?? []).map((c) => ({
            id: c.class ?? "",
            label: c.title ?? c.class ?? "",
            description: c.type ?? "",
          }));
        }
        return {
          fields: [
            ...(await this.serviceField(parentResourceId, CONNECT_TYPES)),
            { key: "name", label: "Connector name", kind: "text", required: true },
            available.length
              ? {
                  key: "connectorClass",
                  label: "Connector",
                  kind: "select",
                  required: true,
                  options: available,
                }
              : {
                  key: "connectorClass",
                  label: "Connector class",
                  kind: "text",
                  required: true,
                  placeholder: "io.debezium.connector.postgresql.PostgresConnector",
                },
            {
              key: "config",
              label: "Configuration (JSON)",
              kind: "code",
              codeLanguage: "json",
              required: false,
              defaultValue: "{\n}",
              description:
                "Everything except name and connector.class, which are filled in for you.",
            },
          ],
        };
      }
      case T.subject:
        return {
          fields: [
            ...(await this.serviceField(parentResourceId, KAFKA_TYPES)),
            {
              key: "name",
              label: "Subject",
              kind: "text",
              required: true,
              placeholder: "orders-value",
            },
            {
              key: "schemaType",
              label: "Type",
              kind: "select",
              required: true,
              defaultValue: "AVRO",
              options: [
                { id: "AVRO", label: "Avro" },
                { id: "JSON", label: "JSON Schema" },
                { id: "PROTOBUF", label: "Protobuf" },
              ],
            },
            { key: "schema", label: "Schema", kind: "code", codeLanguage: "json", required: true },
          ],
        };
      case T.integration: {
        const projectField = await this.projectField(parentResourceId);
        const services = await this.services();
        const types = [
          "metrics",
          "dashboard",
          "logs",
          "datasource",
          "read_replica",
          "kafka_connect",
          "kafka_logs",
          "kafka_mirrormaker",
          "clickhouse_kafka",
          "clickhouse_postgresql",
          "flink",
          "m3aggregator",
          "prometheus",
          "schema_registry_proxy",
        ];
        const svcOptions = services
          .filter((s) => !parentResourceId || s.project === externalIdOf(parentResourceId))
          .map((s) => ({
            id: s.svc.service_name ?? "",
            label: s.svc.service_name ?? "",
            description: `${s.svc.service_type} · ${s.project}`,
          }));
        return {
          fields: [
            ...projectField,
            {
              key: "integrationType",
              label: "Type",
              kind: "select",
              required: true,
              options: types.map((t) => ({ id: t, label: t.replace(/_/g, " ") })),
            },
            {
              key: "source",
              label: "Source service",
              kind: "select",
              required: true,
              options: svcOptions,
            },
            {
              key: "destination",
              label: "Destination service",
              kind: "select",
              required: true,
              options: svcOptions,
            },
          ],
        };
      }
      case T.vpc: {
        const project = parentResourceId ? externalIdOf(parentResourceId) : "";
        return {
          fields: [
            ...(await this.projectField(parentResourceId)),
            {
              key: "cloud",
              label: "Cloud",
              kind: "select",
              required: true,
              options: await this.cloudOptions(project || undefined).catch(() => []),
            },
            {
              key: "networkCidr",
              label: "Network CIDR",
              kind: "text",
              required: true,
              defaultValue: "10.10.0.0/24",
              description: "Must not overlap the networks you will peer with.",
            },
          ],
        };
      }
      case T.peering:
        return {
          fields: [
            ...(parentResourceId
              ? []
              : [
                  {
                    key: "vpc",
                    label: "Project VPC",
                    kind: "select" as const,
                    required: true,
                    options: (await this.vpcs()).map((v) => ({
                      id: `${v.project}/${v.vpc.project_vpc_id}`,
                      label: `${v.vpc.cloud_name} ${v.vpc.network_cidr}`,
                      description: v.project,
                    })),
                  },
                ]),
            {
              key: "peerCloudAccount",
              label: "Peer account",
              kind: "text",
              required: true,
              description:
                "AWS account ID, Google Cloud project ID, Azure subscription ID, or upcloud.",
            },
            {
              key: "peerVpc",
              label: "Peer network",
              kind: "text",
              required: true,
              description:
                "AWS VPC ID, Google network name, Azure VNet name or UpCloud network ID.",
            },
            {
              key: "peerRegion",
              label: "Peer region (AWS, if different)",
              kind: "text",
              required: false,
            },
            {
              key: "peerResourceGroup",
              label: "Resource group (Azure)",
              kind: "text",
              required: false,
            },
            { key: "cidrs", label: "Extra routed CIDRs", kind: "string-list", required: false },
          ],
        };
      default:
        throw new Error(`Aiven plugin: creating "${typeId}" is not supported`);
    }
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    this.invalidate();
    const done = (type: string, ext: string) =>
      this.getResource(type, `${accountId}:${type}:${ext}`, accountId);
    switch (typeId) {
      case T.project: {
        const name = (fields["name"] ?? "").trim();
        if (!name) throw new Error("Give the project a name.");
        const res = await this.api<{ project?: AvProject }>("POST", "/project", {
          project: name,
          ...(fields["cloud"] ? { cloud: fields["cloud"] } : {}),
          ...(fields["billingGroupId"] ? { billing_group_id: fields["billingGroupId"] } : {}),
        });
        return mapProject(accountId, res?.project ?? { project_name: name });
      }
      case T.service: {
        const project = this.projectOf(fields, parentResourceId);
        const type = fields["serviceType"] ?? "";
        const plan = fields[`plan__${type}`] || fields["plan"];
        if (!type || !plan) throw new Error("Pick a service type and plan.");
        const res = await this.api<{ service?: AvService }>(
          "POST",
          `/project/${enc(project)}/service`,
          {
            service_name: fields["name"],
            service_type: type,
            plan,
            ...(fields["cloud"] ? { cloud: fields["cloud"] } : {}),
            ...(bool(fields["terminationProtection"]) ? { termination_protection: true } : {}),
          },
        );
        return mapService(
          accountId,
          project,
          res?.service ?? { service_name: fields["name"] ?? "", service_type: type, plan },
        );
      }
      case T.user: {
        const [project, service] = this.serviceOf(fields, parentResourceId);
        await this.api("POST", this.svcPath(project, service, "/user"), {
          username: fields["username"],
        });
        return done(T.user, `${project}/${service}/${fields["username"]}`);
      }
      case T.database: {
        const [project, service] = this.serviceOf(fields, parentResourceId);
        await this.api("POST", this.svcPath(project, service, "/db"), { database: fields["name"] });
        return done(T.database, `${project}/${service}/${fields["name"]}`);
      }
      case T.pool: {
        const [project, service] = this.serviceOf(fields, parentResourceId);
        await this.api("POST", this.svcPath(project, service, "/connection_pool"), {
          pool_name: fields["name"],
          database: fields["database"],
          ...(fields["username"] ? { username: fields["username"] } : {}),
          ...(fields["poolMode"] ? { pool_mode: fields["poolMode"] } : {}),
          ...(num(fields["poolSize"]) !== undefined ? { pool_size: num(fields["poolSize"]) } : {}),
        });
        return done(T.pool, `${project}/${service}/${fields["name"]}`);
      }
      case T.topic: {
        const [project, service] = this.serviceOf(fields, parentResourceId);
        const hours = num(fields["retentionHours"]);
        await this.api("POST", this.svcPath(project, service, "/topic"), {
          topic_name: fields["name"],
          partitions: num(fields["partitions"]) ?? 3,
          replication: num(fields["replication"]) ?? 3,
          config: {
            ...(fields["cleanupPolicy"] ? { cleanup_policy: fields["cleanupPolicy"] } : {}),
            ...(hours !== undefined ? { retention_ms: hours < 0 ? -1 : hours * 3_600_000 } : {}),
          },
        });
        return mapTopic(accountId, project, service, {
          topic_name: fields["name"] ?? "",
          partitions: num(fields["partitions"]) ?? 3,
          replication: num(fields["replication"]) ?? 3,
          state: "CONFIGURING",
        });
      }
      case T.acl: {
        const [project, service] = this.serviceOf(fields, parentResourceId);
        const res = await this.api<{
          acl?: Array<{ id?: string; permission?: string; topic?: string; username?: string }>;
        }>("POST", this.svcPath(project, service, "/acl"), {
          username: fields["username"],
          topic: fields["topic"],
          permission: fields["permission"] || "read",
        });
        const created = (res?.acl ?? []).find(
          (a) =>
            a.username === fields["username"] &&
            a.topic === fields["topic"] &&
            a.permission === fields["permission"],
        );
        if (!created?.id) throw new Error("Aiven did not return the new ACL entry.");
        return mapAcl(accountId, project, service, created);
      }
      case T.connector: {
        const [project, service] = this.serviceOf(fields, parentResourceId);
        let extra: Record<string, unknown> = {};
        if (fields["config"]?.trim()) {
          try {
            extra = JSON.parse(fields["config"]) as Record<string, unknown>;
          } catch {
            throw new Error("The configuration is not valid JSON.");
          }
        }
        const config = Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)]));
        await this.api("POST", this.svcPath(project, service, "/connectors"), {
          ...config,
          name: fields["name"],
          "connector.class": fields["connectorClass"],
        });
        return done(T.connector, `${project}/${service}/${fields["name"]}`);
      }
      case T.subject: {
        const [project, service] = this.serviceOf(fields, parentResourceId);
        await this.api(
          "POST",
          this.svcPath(
            project,
            service,
            `/kafka/schema/subjects/${enc(fields["name"] ?? "")}/versions`,
          ),
          {
            schema: fields["schema"],
            schemaType: fields["schemaType"] || "AVRO",
          },
        );
        return mapSubject(accountId, project, service, fields["name"] ?? "");
      }
      case T.integration: {
        const project = this.projectOf(fields, parentResourceId);
        const res = await this.api<{ service_integration?: AvIntegration }>(
          "POST",
          `/project/${enc(project)}/integration`,
          {
            integration_type: fields["integrationType"],
            source_service: fields["source"],
            dest_service: fields["destination"],
          },
        );
        return mapIntegration(accountId, project, res?.service_integration ?? {});
      }
      case T.vpc: {
        const project = this.projectOf(fields, parentResourceId);
        const vpc = await this.api<AvVpc>("POST", `/project/${enc(project)}/vpcs`, {
          cloud_name: fields["cloud"],
          network_cidr: fields["networkCidr"],
          peering_connections: [],
        });
        return mapVpc(accountId, project, vpc);
      }
      case T.peering: {
        const [project, vpcId] = parts(
          fields["vpc"] || (parentResourceId ? externalIdOf(parentResourceId) : ""),
          2,
        ) as [string, string];
        const p = await this.api<{ peer_cloud_account?: string }>(
          "POST",
          `/project/${enc(project)}/vpcs/${enc(vpcId)}/peering-connections`,
          {
            peer_cloud_account: fields["peerCloudAccount"],
            peer_vpc: fields["peerVpc"],
            ...(fields["peerRegion"] ? { peer_region: fields["peerRegion"] } : {}),
            ...(fields["peerResourceGroup"]
              ? { peer_resource_group: fields["peerResourceGroup"] }
              : {}),
            ...(list(fields["cidrs"]).length
              ? { user_peer_network_cidrs: list(fields["cidrs"]) }
              : {}),
          },
        );
        return mapPeering(accountId, project, vpcId, {
          ...(p ?? {}),
          peer_cloud_account: fields["peerCloudAccount"] ?? "",
          peer_vpc: fields["peerVpc"] ?? "",
        });
      }
      default:
        throw new Error(`Aiven plugin: creating "${typeId}" is not supported`);
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
      case T.project:
        if (fields["techEmails"] !== undefined) {
          await this.api("PUT", `/project/${enc(ext)}`, {
            tech_emails: list(fields["techEmails"]).map((email) => ({ email })),
          });
        }
        break;
      case T.service: {
        const [project, name] = parts(ext, 2) as [string, string];
        const body: Record<string, unknown> = {};
        if (fields["terminationProtection"] !== undefined)
          body["termination_protection"] = bool(fields["terminationProtection"]);
        if (num(fields["diskSpaceMb"]) !== undefined)
          body["disk_space_mb"] = num(fields["diskSpaceMb"]);
        if (fields["maintenanceDow"] || fields["maintenanceTime"]) {
          const dow = fields["maintenanceDow"];
          if (dow && !DAYS.includes(dow)) throw new Error("Pick a weekday for maintenance.");
          const time = fields["maintenanceTime"];
          if (time && !/^\d{2}:\d{2}(:\d{2})?$/.test(time))
            throw new Error("Maintenance time is HH:MM:SS in UTC.");
          body["maintenance"] = {
            ...(dow ? { dow } : {}),
            ...(time ? { time: time.length === 5 ? `${time}:00` : time } : {}),
          };
        }
        if (Object.keys(body).length) await this.api("PUT", this.svcPath(project, name), body);
        break;
      }
      case T.pool: {
        const [project, service, pool] = parts(ext, 3) as [string, string, string];
        const body: Record<string, unknown> = {};
        if (fields["database"]) body["database"] = fields["database"];
        if (fields["username"] !== undefined) body["username"] = fields["username"];
        if (fields["poolMode"]) body["pool_mode"] = fields["poolMode"];
        if (num(fields["poolSize"]) !== undefined) body["pool_size"] = num(fields["poolSize"]);
        if (Object.keys(body).length)
          await this.api(
            "PUT",
            this.svcPath(project, service, `/connection_pool/${enc(pool)}`),
            body,
          );
        break;
      }
      case T.topic: {
        const [project, service, topic] = parts(ext, 3) as [string, string, string];
        const body: Record<string, unknown> = {};
        const config: Record<string, unknown> = {};
        if (num(fields["partitions"]) !== undefined) body["partitions"] = num(fields["partitions"]);
        if (num(fields["replication"]) !== undefined)
          body["replication"] = num(fields["replication"]);
        if (fields["description"] !== undefined) body["topic_description"] = fields["description"];
        const hours = num(fields["retentionHours"]);
        if (hours !== undefined) config["retention_ms"] = hours < 0 ? -1 : hours * 3_600_000;
        if (num(fields["minInsyncReplicas"]) !== undefined)
          config["min_insync_replicas"] = num(fields["minInsyncReplicas"]);
        if (fields["cleanupPolicy"]) config["cleanup_policy"] = fields["cleanupPolicy"];
        if (Object.keys(config).length) body["config"] = config;
        if (Object.keys(body).length)
          await this.api("PUT", this.svcPath(project, service, `/topic/${enc(topic)}`), body);
        break;
      }
      default:
        throw new Error(`Aiven plugin: updating "${typeId}" is not supported`);
    }
    this.invalidate();
    return this.getResource(typeId, resourceId, accountId);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const ext = externalIdOf(resourceId);
    this.invalidate();
    const three = () => parts(ext, 3) as [string, string, string];
    switch (typeId) {
      case T.project:
        return void (await this.api("DELETE", `/project/${enc(ext)}`));
      case T.service: {
        const [project, name] = parts(ext, 2) as [string, string];
        return void (await this.api("DELETE", this.svcPath(project, name)));
      }
      case T.user: {
        const [p, s, u] = three();
        return void (await this.api("DELETE", this.svcPath(p, s, `/user/${enc(u)}`)));
      }
      case T.database: {
        const [p, s, d] = three();
        return void (await this.api("DELETE", this.svcPath(p, s, `/db/${enc(d)}`)));
      }
      case T.pool: {
        const [p, s, n] = three();
        return void (await this.api("DELETE", this.svcPath(p, s, `/connection_pool/${enc(n)}`)));
      }
      case T.topic: {
        const [p, s, n] = three();
        return void (await this.api("DELETE", this.svcPath(p, s, `/topic/${enc(n)}`)));
      }
      case T.acl: {
        const [p, s, id] = three();
        return void (await this.api("DELETE", this.svcPath(p, s, `/acl/${enc(id)}`)));
      }
      case T.connector: {
        const [p, s, n] = three();
        return void (await this.api("DELETE", this.svcPath(p, s, `/connectors/${enc(n)}`)));
      }
      case T.subject: {
        const [p, s, n] = three();
        return void (await this.api(
          "DELETE",
          this.svcPath(p, s, `/kafka/schema/subjects/${enc(n)}`),
        ));
      }
      case T.integration: {
        const [p, id] = parts(ext, 2) as [string, string];
        return void (await this.api("DELETE", `/project/${enc(p)}/integration/${enc(id)}`));
      }
      case T.vpc: {
        const [p, id] = parts(ext, 2) as [string, string];
        return void (await this.api("DELETE", `/project/${enc(p)}/vpcs/${enc(id)}`));
      }
      case T.peering: {
        const segs = ext.split("/");
        const [p, vpc, account, peerVpc, extra] = segs;
        let path = `/project/${enc(p ?? "")}/vpcs/${enc(vpc ?? "")}/peering-connections/peer-accounts/${enc(account ?? "")}/peer-vpcs/${enc(peerVpc ?? "")}`;
        if (extra?.startsWith("region:")) path += `/peer-regions/${enc(extra.slice(7))}`;
        if (extra?.startsWith("rg:")) {
          path = `/project/${enc(p ?? "")}/vpcs/${enc(vpc ?? "")}/peering-connections/peer-accounts/${enc(account ?? "")}/peer-resource-groups/${enc(extra.slice(3))}/peer-vpcs/${enc(peerVpc ?? "")}`;
        }
        return void (await this.api("DELETE", path));
      }
      default:
        throw new Error(`Aiven plugin: deleting "${typeId}" is not supported`);
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
    const ext = externalIdOf(resourceId);
    this.invalidate();
    if (typeId === T.service) {
      const [project, name] = parts(ext, 2) as [string, string];
      if (actionId === "power-on" || actionId === "power-off") {
        await this.api("PUT", this.svcPath(project, name), { powered: actionId === "power-on" });
        return;
      }
      if (actionId === "start-maintenance") {
        await this.api("PUT", this.svcPath(project, name, "/maintenance/start"));
        return;
      }
    }
    if (typeId === T.user) {
      const [project, service, username] = parts(ext, 3) as [string, string, string];
      if (actionId === "acknowledge-renewal") {
        await this.api("PUT", this.svcPath(project, service, `/user/${enc(username)}`), {
          operation: "acknowledge-renewal",
        });
        return;
      }
    }
    if (typeId === T.connector) {
      const [project, service, name] = parts(ext, 3) as [string, string, string];
      const base = this.svcPath(project, service, `/connectors/${enc(name)}`);
      if (["pause", "resume", "restart"].includes(actionId)) {
        await this.api("POST", `${base}/${actionId}`, {});
        return;
      }
      const m = /^restart-task:(\d+)$/.exec(actionId);
      if (m) {
        await this.api("POST", `${base}/tasks/${m[1]}/restart`, {});
        return;
      }
    }
    if (typeId === T.peering && actionId === "refresh-peerings") {
      const [project, vpcId] = ext.split("/");
      await this.api(
        "POST",
        `/project/${enc(project ?? "")}/vpcs/${enc(vpcId ?? "")}/peering-connections/refresh`,
        {},
      );
      return;
    }
    throw new Error(`Aiven plugin: unknown action "${actionId}" for "${typeId}"`);
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
    switch (`${typeId}:${command}`) {
      case `${T.project}:set-cloud`:
        await this.api("PUT", `/project/${enc(ext)}`, { cloud: form["cloud"] });
        return { ok: true, message: "Default cloud saved." };
      case `${T.project}:set-billing-group`:
        if (!form["billingGroupId"]) throw new Error("Pick a billing group.");
        await this.api(
          "POST",
          `/billing-group/${enc(form["billingGroupId"])}/project-assign/${enc(ext)}`,
          {},
        );
        return { ok: true, message: "Project moved." };
      case `${T.project}:claim-credit`:
        await this.api("POST", `/project/${enc(ext)}/credits`, { code: form["code"] });
        return { ok: true, message: "Credit claimed." };
      case `${T.billingGroup}:claim-credit`:
        await this.api("POST", `/billing-group/${enc(ext)}/credits`, { code: form["code"] });
        return { ok: true, message: "Credit claimed." };
      case `${T.service}:change-plan`:
      case `${T.service}:move-cloud`:
      case `${T.service}:set-tags`: {
        const [project, name] = parts(ext, 2) as [string, string];
        if (command === "set-tags") {
          await this.api("PUT", this.svcPath(project, name, "/tags"), {
            tags: parseTags(form["tags"]),
          });
          return { ok: true, message: "Tags saved." };
        }
        const body = command === "change-plan" ? { plan: form["plan"] } : { cloud: form["cloud"] };
        if (!Object.values(body)[0]) throw new Error("Pick a value.");
        await this.api("PUT", this.svcPath(project, name), body);
        return {
          ok: true,
          message: command === "change-plan" ? "Plan change started." : "Migration started.",
        };
      }
      case `${T.user}:set-password`: {
        const [project, service, username] = parts(ext, 3) as [string, string, string];
        await this.api(
          "PUT",
          this.svcPath(project, service, `/user/${enc(username)}`),
          form["password"]
            ? { operation: "reset-credentials", new_password: form["password"] }
            : { operation: "reset-credentials" },
        );
        return { ok: true, message: "Password changed." };
      }
      case `${T.connector}:set-config`: {
        const [project, service, name] = parts(ext, 3) as [string, string, string];
        let config: Record<string, unknown>;
        try {
          config = JSON.parse(form["config"] ?? "") as Record<string, unknown>;
        } catch {
          throw new Error("The configuration is not valid JSON.");
        }
        await this.api("PUT", this.svcPath(project, service, `/connectors/${enc(name)}`), {
          ...Object.fromEntries(Object.entries(config).map(([k, v]) => [k, String(v)])),
          name,
        });
        return { ok: true, message: "Connector updated." };
      }
      case `${T.subject}:register`: {
        const [project, service, subject] = parts(ext, 3) as [string, string, string];
        const res = await this.api<{ id?: number }>(
          "POST",
          this.svcPath(project, service, `/kafka/schema/subjects/${enc(subject)}/versions`),
          { schema: form["schema"], schemaType: form["schemaType"] || "AVRO" },
        );
        return { ok: true, message: `Registered schema id ${res?.id ?? "?"}.` };
      }
    }
    throw new Error(`Aiven plugin: command "${command}" is not supported for "${typeId}"`);
  }

  async publishMessage(
    typeId: string,
    resourceId: string,
    _accountId: string,
    payload: PublishMessagePayload,
  ): Promise<PublishMessageResult> {
    if (typeId !== T.topic) throw new Error("Aiven plugin: only Kafka topics accept messages.");
    const [project, service, topic] = parts(externalIdOf(resourceId), 3) as [
      string,
      string,
      string,
    ];
    let value: unknown;
    try {
      value = JSON.parse(payload.body);
    } catch {
      value = payload.body;
    }
    const key = typeof payload.extras["key"] === "string" ? payload.extras["key"] : "";
    const partition =
      typeof payload.extras["partition"] === "string"
        ? num(payload.extras["partition"])
        : undefined;
    const res = await this.api<{
      offsets?: Array<{ partition?: number; offset?: number; error?: string }>;
    }>("POST", this.svcPath(project, service, `/kafka/rest/topics/${enc(topic)}/produce`), {
      format: "json",
      records: [
        { value, ...(key ? { key } : {}), ...(partition !== undefined ? { partition } : {}) },
      ],
    });
    const o = res?.offsets?.[0];
    if (o?.error) throw new Error(o.error);
    return {
      summary: `Produced to partition ${o?.partition ?? "?"} at offset ${o?.offset ?? "?"}.`,
    };
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
    const ext = externalIdOf(resourceId);
    let path: string;
    let body: Record<string, unknown>;
    const period = metricsPeriod(
      timeRange ? timeRange.endMs - timeRange.startMs : METRICS_WINDOW_MS,
    );
    if (resourceTypeId === T.service) {
      const [project, name] = parts(ext, 2) as [string, string];
      path = this.svcPath(project, name, "/metrics");
      body = { period };
    } else if (resourceTypeId === T.topic) {
      const [project, service, topic] = parts(ext, 3) as [string, string, string];
      path = this.svcPath(project, service, "/metrics");
      body = { period, kafka_topic_name: topic };
    } else {
      return [];
    }
    const res = await this.api<{ metrics?: Record<string, AvMetric> }>("POST", path, body);
    return chartsToSeries(res?.metrics);
  }

  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    const ext = externalIdOf(resourceId);
    const limit = Math.min(Math.max(params.tailLines ?? 200, 1), 500);
    if (typeId === T.project) {
      const res = await this.api<{
        events?: Array<{
          time?: string;
          actor?: string;
          event_desc?: string;
          service_name?: string;
        }>;
      }>("GET", `/project/${enc(ext)}/events`);
      const text = (res?.events ?? [])
        .slice(0, limit)
        .reverse()
        .map(
          (e) =>
            `${stamp(e.time)}  ${e.actor ?? ""}  ${e.service_name ? `[${e.service_name}] ` : ""}${e.event_desc ?? ""}\n`,
        )
        .join("");
      return {
        text: text || "No events.\n",
        containers: ["Event log"],
        activeContainer: "Event log",
      };
    }
    if (typeId === T.service) {
      const [project, name] = parts(ext, 2) as [string, string];
      const severities = ["All", "Warnings and errors", "Errors"];
      const active =
        params.container && severities.includes(params.container) ? params.container : "All";
      const severity =
        active === "Errors" ? "err" : active === "Warnings and errors" ? "warning" : undefined;
      const res = await this.api<{
        logs?: Array<{ time?: string; msg?: string; unit?: string; severity?: string }>;
      }>("POST", this.svcPath(project, name, "/logs"), {
        limit,
        sort_order: "desc",
        ...(severity ? { severity } : {}),
      });
      const text = (res?.logs ?? [])
        .slice()
        .reverse()
        .map((l) => `${stamp(l.time)}  ${l.unit ? `${l.unit}: ` : ""}${l.msg ?? ""}\n`)
        .join("");
      return { text: text || "No log entries.\n", containers: severities, activeContainer: active };
    }
    throw new Error("Aiven plugin: logs are available for projects (event log) and services.");
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const r = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = r.fields;
    if (resourceTypeId === T.service) {
      return [
        {
          label: "State",
          value: String(f["state"] ?? ""),
          variant: f["state"] === "RUNNING" ? "status-healthy" : "status-degraded",
        },
        { label: "Plan", value: String(f["plan"] ?? "") },
        { label: "Cloud", value: String(f["cloud"] ?? "") },
        { label: "Nodes", value: String(f["nodeCount"] ?? "") },
      ];
    }
    return [{ label: "State", value: String(f["state"] ?? "") }];
  }

  fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[] | CostFetchResult> {
    return fetchAivenCostData(this.ctx, range);
  }

  async fetchCreditBalance(_accountId: string): Promise<CreditBalance[]> {
    const out: CreditBalance[] = [];
    for (const g of await this.billingGroups()) {
      if (!g.billing_group_id) continue;
      let credits: AvCredit[] = [];
      try {
        credits =
          (
            await this.api<{ credits?: AvCredit[] }>(
              "GET",
              `/billing-group/${enc(g.billing_group_id)}/credits`,
            )
          )?.credits ?? [];
      } catch (err) {
        if (statusOf(err) === 403) continue;
        throw err;
      }
      for (const c of credits) {
        const remaining = Number(c.remaining_value);
        if (!Number.isFinite(remaining)) continue;
        if (c.expire_time && Date.parse(c.expire_time) < Date.now()) continue;
        out.push({
          key: `${g.billing_group_id}/${c.code ?? c.type ?? "credit"}`,
          label: `${g.billing_group_name ?? g.billing_group_id}: ${c.code ?? c.type ?? "credit"}`,
          remaining,
          currency: (g.billing_currency ?? "USD").toUpperCase(),
          ...(Number.isFinite(Number(c.value)) ? { granted: Number(c.value) } : {}),
          ...(c.expire_time ? { expiresAt: c.expire_time } : {}),
        });
      }
    }
    return out;
  }
}
