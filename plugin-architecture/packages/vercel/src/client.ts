import type {
  ActionNode,
  PluginClient,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  CreateResourceConfig,
  ResourceStatus,
  DashboardStat,
  HostServices,
  CostFetchRange,
  CostRow,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  SectionNode,
} from "@infrawrench/plugin-base";
import {
  dnsContentField,
  joinSubtitle,
  jsonRestFetch,
  renderDnsRecordDetail,
  renderDnsRecordSidebar,
} from "@infrawrench/plugin-base";
import { fetchVercelCostData } from "./cost-data.js";
import {
  DNS_RECORD_TYPES,
  FRAMEWORK_OPTIONS,
  FUNCTION_REGIONS,
  WEBHOOK_EVENTS,
  frameworkLabel,
} from "./catalog.js";

interface VercelProject {
  id: string;
  name: string;
  /** Owner of the project: the team id when the project belongs to a team. */
  accountId?: string;
  framework?: string | null;
  nodeVersion?: string;
  serverlessFunctionRegion?: string;
  rootDirectory?: string | null;
  buildCommand?: string | null;
  outputDirectory?: string | null;
  createdAt: number;
  updatedAt?: number;
  live?: boolean;
  installCommand?: string | null;
  devCommand?: string | null;
  paused?: boolean;
  security?: { attackModeEnabled?: boolean; attackModeActiveUntil?: number | null } | null;
  link?: {
    type?: string;
    repo?: string;
    repoId?: number;
    org?: string;
  };
  alias?: Array<{ domain: string }>;
  latestDeployments?: Array<{
    url?: string;
    readyState?: string;
  }>;
}

interface VercelDeployment {
  uid: string;
  name: string;
  url: string | null;
  state?: string;
  readyState?: string;
  target?: string | null;
  source?: string;
  projectId?: string;
  created: number;
  buildingAt?: number;
  ready?: number;
  inspectorUrl?: string | null;
  errorMessage?: string | null;
  isRollbackCandidate?: boolean | null;
  meta?: Record<string, string>;
  creator?: {
    uid: string;
    email?: string;
    username?: string;
  };
  projectSettings?: {
    framework?: string | null;
  };
}

interface VercelDomain {
  id?: string;
  name: string;
  verified: boolean;
  /** Set when the domain belongs to a team rather than a personal account. */
  teamId?: string | null;
  serviceType?: string;
  nameservers?: string[];
  intendedNameservers?: string[];
  renew?: boolean;
  expiresAt: number | null;
  boughtAt: number | null;
  createdAt: number;
}

interface VercelEnvVar {
  id?: string;
  key: string;
  value?: string;
  type: string;
  target?: string[] | string;
  gitBranch?: string;
  comment?: string;
  createdAt?: number;
  updatedAt?: number;
}

interface VercelDnsRecord {
  id: string;
  slug?: string;
  name?: string;
  type?: string;
  value?: string;
  ttl?: number;
  mxPriority?: number;
  priority?: number;
  comment?: string;
  creator?: string;
  createdAt?: number | null;
  updatedAt?: number | null;
}

interface VercelWebhook {
  id: string;
  url: string;
  events?: string[];
  projectIds?: string[];
  secret?: string;
  createdAt?: number;
  updatedAt?: number;
}

/** One entry of `GET /v3/deployments/{id}/events` (build output). */
interface VercelDeploymentEvent {
  type?: string;
  created?: number;
  text?: string;
  payload?: { text?: string; date?: number };
}

/** Deployment actions: header buttons on the deployment detail view. */
const DEPLOYMENT_ACTIONS = new Set(["cancel", "redeploy", "promote", "rollback"]);
const PROJECT_ACTIONS = new Set(["pause", "unpause", "attack-mode-on", "attack-mode-off"]);

interface VercelTeam {
  id: string;
  name: string;
  slug: string;
  createdAt: number;
  updatedAt: number;
  membership?: { role: string };
}

function deploymentStatus(state?: string): ResourceStatus {
  switch (state) {
    case "READY":
      return "healthy";
    case "BUILDING":
    case "INITIALIZING":
    case "QUEUED":
      return "provisioning";
    case "ERROR":
      return "error";
    case "CANCELED":
    case "DELETED":
      return "error";
    default:
      return "info";
  }
}

function domainVerificationStatus(verified: boolean): ResourceStatus {
  return verified ? "healthy" : "degraded";
}

function formatTimestamp(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return new Date(ms).toISOString();
}

function targetLabel(target: string[] | string | undefined): string {
  if (!target) return "—";
  if (Array.isArray(target)) return target.join(", ");
  return target;
}

/** Build a fields record, omitting entries whose value is null or undefined */
function fields(
  entries: Record<string, string | number | boolean | null | undefined>,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(entries)) {
    if (v != null) result[k] = v;
  }
  return result;
}

/** Default Metrics window: Web Analytics reports by hour or day, so a week reads well. */
const WEB_ANALYTICS_DEFAULT_RANGE_MS = 7 * 86_400_000;

/** One time bucket of a Web Analytics aggregate grouped by hour/day. */
interface WebAnalyticsRow {
  timestamp?: string;
  pageviews?: number;
  visitors?: number;
  count?: number;
}

export class VercelClient implements PluginClient {
  private readonly accessToken: string;
  private readonly teamId: string | null;
  private readonly baseUrl = "https://api.vercel.com";
  private readonly caCert: string;
  private readonly services: HostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const token = credentials["accessToken"];
    if (!token) throw new Error("Vercel plugin: missing accessToken credential");
    this.accessToken = token;
    this.teamId = credentials["teamId"] || null;
    this.caCert = credentials["caCert"] ?? "";
    this.services = services;
  }

  /** Append teamId query param if configured */
  private teamQuery(path: string): string {
    if (!this.teamId) return path;
    const sep = path.includes("?") ? "&" : "?";
    return `${path}${sep}teamId=${encodeURIComponent(this.teamId)}`;
  }

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${this.teamQuery(path)}`;
    return jsonRestFetch<T>({
      vendor: "Vercel",
      url,
      errorPath: path,
      headers: { Authorization: `Bearer ${this.accessToken}` },
      ...(options ? { init: options } : {}),
      ...(this.caCert && this.services?.http
        ? { caCert: this.caCert, http: this.services.http }
        : {}),
    });
  }

  /**
   * Paginate Vercel's cursor endpoints. Most take the previous page's
   * `pagination.next` timestamp as `until`; `GET /v10/projects` returns a
   * continuation token instead and takes it as `from`.
   */
  private async paginate<T>(
    path: string,
    dataKey: string,
    limit = 100,
    cursorParam: "until" | "from" = "until",
  ): Promise<T[]> {
    const results: T[] = [];
    let cursor: number | string | null = null;

    for (let page = 0; page < 100; page++) {
      const sep = path.includes("?") ? "&" : "?";
      let url = `${path}${sep}limit=${limit}`;
      if (cursor != null) url += `&${cursorParam}=${encodeURIComponent(String(cursor))}`;

      const res = await this.fetch<Record<string, unknown>>(url);
      const items = res[dataKey];
      if (!Array.isArray(items) || items.length === 0) break;
      results.push(...(items as T[]));

      const pagination = res["pagination"] as { next: number | string | null } | undefined;
      if (!pagination?.next) break;
      cursor = pagination.next;
    }

    return results;
  }

  private listRawProjects(): Promise<VercelProject[]> {
    return this.paginate<VercelProject>("/v10/projects", "projects", 100, "from");
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "vercel-project":
        return this.listProjects(accountId);
      case "vercel-deployment":
        return this.listDeployments(accountId);
      case "vercel-domain":
        return this.listDomains(accountId);
      case "vercel-env-var":
        return this.listAllEnvVars(accountId);
      case "vercel-team":
        return this.listTeams(accountId);
      case "vercel-dns-record":
        return this.listAllDnsRecords(accountId);
      case "vercel-webhook":
        return this.listWebhooks(accountId);
      default:
        throw new Error(`Vercel plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const externalId = resourceId.split(":").slice(2).join(":");

    if (typeId === "vercel-project") {
      const project = await this.fetch<VercelProject>(`/v9/projects/${externalId}`);
      return this.mapProject(project, accountId);
    }

    if (typeId === "vercel-deployment") {
      const deployment = await this.fetch<VercelDeployment & { id?: string }>(
        `/v13/deployments/${encodeURIComponent(externalId)}`,
      );
      // The single-deployment route names the id `id`; the list route, `uid`.
      return this.mapDeployment(
        { ...deployment, uid: deployment.uid ?? deployment.id ?? externalId },
        accountId,
      );
    }

    if (typeId === "vercel-dns-record") {
      const { domain } = splitRecordId(externalId);
      const found = (await this.listDnsRecordsForDomain(domain, accountId)).find(
        (r) => r.id === resourceId,
      );
      if (!found) throw new Error(`Vercel plugin: resource ${typeId}/${resourceId} not found`);
      return found;
    }

    if (typeId === "vercel-webhook") {
      const hook = await this.fetch<VercelWebhook>(
        `/v1/webhooks/${encodeURIComponent(externalId)}`,
      );
      return this.mapWebhook(hook, accountId);
    }

    // Fallback: list all and find
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`Vercel plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const resource = await this.getResource(typeId, resourceId, accountId);

    if (typeId === "vercel-project") {
      if (outputKey === "projectId") return resource.externalId ?? "";
      if (outputKey === "projectName") return String(resource.fields["name"] ?? "");
      if (outputKey === "productionUrl") return String(resource.fields["productionUrl"] ?? "");
    }

    if (typeId === "vercel-deployment") {
      if (outputKey === "deploymentId") return resource.externalId ?? "";
      if (outputKey === "url") return String(resource.fields["url"] ?? "");
      if (outputKey === "inspectorUrl") return String(resource.fields["inspectorUrl"] ?? "");
    }

    if (typeId === "vercel-domain") {
      if (outputKey === "domainName") return String(resource.fields["name"] ?? "");
      if (outputKey === "nameservers") return String(resource.fields["nameservers"] ?? "");
    }

    if (typeId === "vercel-env-var") {
      if (outputKey === "envKey") return String(resource.fields["key"] ?? "");
      if (outputKey === "envValue") return String(resource.fields["value"] ?? "");
    }

    if (typeId === "vercel-team") {
      if (outputKey === "teamId") return resource.externalId ?? "";
      if (outputKey === "teamSlug") return String(resource.fields["slug"] ?? "");
    }

    if (typeId === "vercel-dns-record") {
      if (outputKey === "recordId") return splitRecordId(resource.externalId ?? "").recordId;
      if (outputKey === "fqdn") {
        const name = String(resource.fields["name"] ?? "");
        const domain = String(resource.fields["domain"] ?? "");
        return name ? `${name}.${domain}` : domain;
      }
    }

    if (typeId === "vercel-webhook") {
      if (outputKey === "webhookId") return resource.externalId ?? "";
      // Vercel only returns the secret from the create call.
      if (outputKey === "secret") return resource.resolvedOutputs["secret"] ?? "";
    }

    throw new Error(`Vercel plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = resource.fields;

    switch (resourceTypeId) {
      case "vercel-project": {
        const stats: DashboardStat[] = [];
        if (f["framework"]) stats.push({ label: "Framework", value: String(f["framework"]) });
        if (f["serverlessFunctionRegion"])
          stats.push({ label: "Region", value: String(f["serverlessFunctionRegion"]) });
        if (f["nodeVersion"]) stats.push({ label: "Node.js", value: String(f["nodeVersion"]) });
        const liveStr = f["live"] === true || f["live"] === "true" ? "Yes" : "No";
        stats.push({
          label: "Live",
          value: liveStr,
          variant: liveStr === "Yes" ? "status-healthy" : "status-degraded",
        });
        if (f["paused"] === true) {
          stats.push({ label: "Paused", value: "Yes", variant: "status-error" });
        }
        if (f["attackModeEnabled"] === true) {
          stats.push({ label: "Attack Mode", value: "On", variant: "status-degraded" });
        }
        return stats;
      }
      case "vercel-deployment": {
        const state = String(f["state"] ?? "unknown");
        const variant =
          state === "READY"
            ? "status-healthy"
            : state === "BUILDING" || state === "QUEUED"
              ? "status-degraded"
              : state === "ERROR" || state === "CANCELED"
                ? "status-error"
                : "default";
        const stats: DashboardStat[] = [{ label: "State", value: state, variant }];
        if (f["target"]) stats.push({ label: "Target", value: String(f["target"]) });
        return stats;
      }
      case "vercel-domain": {
        const verified = f["verified"] === "true" || f["verified"] === true;
        return [
          {
            label: "Verified",
            value: verified ? "Yes" : "No",
            variant: verified ? "status-healthy" : "status-error",
          },
          { label: "Service", value: String(f["serviceType"] ?? "—") },
        ];
      }
      default:
        return [];
    }
  }

  /**
   * Project traffic from the Web Analytics API
   * (`GET /v1/query/web-analytics/{visits,events}/aggregate`), bucketed by
   * hour for ranges up to three days and by day beyond that. The API filters
   * to production by default and only answers for projects with Web
   * Analytics enabled; a disabled project yields no series rather than an
   * error.
   */
  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    if (resourceTypeId !== "vercel-project") return [];
    const projectId = resourceId.split(":").slice(2).join(":");
    if (!projectId) return [];

    const endMs = timeRange?.endMs ?? Date.now();
    const startMs = timeRange?.startMs ?? endMs - WEB_ANALYTICS_DEFAULT_RANGE_MS;
    const bucket = endMs - startMs <= 3 * 86_400_000 ? "hour" : "day";
    const query = (dataset: "visits" | "events") =>
      `/v1/query/web-analytics/${dataset}/aggregate?projectId=${encodeURIComponent(projectId)}` +
      `&by=${bucket}&since=${startMs}&until=${endMs}`;

    const read = async (dataset: "visits" | "events"): Promise<WebAnalyticsRow[]> => {
      try {
        const res = await this.fetch<{ data?: unknown }>(query(dataset));
        return Array.isArray(res.data) ? (res.data as WebAnalyticsRow[]) : [];
      } catch {
        return [];
      }
    };
    const [visits, events] = await Promise.all([read("visits"), read("events")]);

    const toSeries = (
      rows: WebAnalyticsRow[],
      key: "pageviews" | "visitors" | "count",
      label: string,
      unit: string,
    ): MetricSeries | null => {
      const points = rows
        .map((r) => ({ timestamp: Date.parse(String(r.timestamp ?? "")), value: Number(r[key]) }))
        .filter((pt) => Number.isFinite(pt.timestamp) && Number.isFinite(pt.value))
        .sort((a, b) => a.timestamp - b.timestamp);
      return points.length > 0 ? { label, unit, points } : null;
    };

    return [
      toSeries(visits, "pageviews", "Page Views", "views"),
      toSeries(visits, "visitors", "Visitors", "visitors"),
      toSeries(events, "count", "Custom Events", "events"),
      toSeries(events, "visitors", "Event Visitors", "visitors"),
    ].filter((s): s is MetricSeries => s != null);
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchVercelCostData(
      {
        accessToken: this.accessToken,
        teamId: this.teamId,
        caCert: this.caCert,
        http: this.services?.http,
      },
      range,
    );
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    switch (resource.resourceTypeId) {
      case "vercel-project":
        return this.renderProjectDetail(resource);
      case "vercel-deployment":
        return this.renderDeploymentDetail(resource);
      case "vercel-domain":
        return this.renderDomainDetail(resource);
      case "vercel-env-var":
        return this.renderEnvVarDetail(resource);
      case "vercel-team":
        return this.renderTeamDetail(resource);
      case "vercel-dns-record":
        return renderDnsRecordDetail(resource, {
          extraInfoItems: [{ key: "Domain", value: String(resource.fields["domain"] ?? "") }],
        });
      case "vercel-webhook":
        return this.renderWebhookDetail(resource);
      default:
        return this.renderGenericDetail(resource);
    }
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    if (resource.resourceTypeId === "vercel-dns-record") {
      return renderDnsRecordSidebar(resource);
    }
    let status: ResourceStatus = "info";

    if (resource.resourceTypeId === "vercel-deployment") {
      status = deploymentStatus(resource.fields["state"] as string | undefined);
    } else if (resource.resourceTypeId === "vercel-domain") {
      const verified =
        resource.fields["verified"] === "true" || resource.fields["verified"] === true;
      status = domainVerificationStatus(verified);
    } else if (resource.resourceTypeId === "vercel-project") {
      const live = resource.fields["live"] === true || resource.fields["live"] === "true";
      status = resource.fields["paused"] === true ? "error" : live ? "healthy" : "degraded";
    } else if (resource.resourceTypeId === "vercel-team") {
      status = "healthy";
    } else if (
      resource.resourceTypeId === "vercel-env-var" ||
      resource.resourceTypeId === "vercel-webhook"
    ) {
      status = "healthy";
    }

    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status },
    };
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    if (typeId === "vercel-project") {
      return {
        fields: [
          { key: "name", label: "Project Name", kind: "text", required: true },
          {
            key: "framework",
            label: "Framework",
            kind: "select",
            required: false,
            options: FRAMEWORK_OPTIONS,
          },
          {
            key: "serverlessFunctionRegion",
            label: "Function Region",
            kind: "region-picker",
            required: false,
            defaultValue: "iad1",
            regions: FUNCTION_REGIONS.map((r) => ({
              id: r.id,
              label: r.id,
              location: r.location,
              flag: r.flag,
            })),
          },
          { key: "buildCommand", label: "Build Command", kind: "text", required: false },
          { key: "installCommand", label: "Install Command", kind: "text", required: false },
          { key: "outputDirectory", label: "Output Directory", kind: "text", required: false },
          { key: "rootDirectory", label: "Root Directory", kind: "text", required: false },
        ],
      };
    }

    if (typeId === "vercel-domain") {
      return {
        fields: [
          {
            key: "name",
            label: "Domain Name",
            kind: "text",
            required: true,
            description: "e.g. example.com or sub.example.com",
          },
        ],
      };
    }

    if (typeId === "vercel-env-var") {
      const projects = await this.listRawProjects();
      return {
        fields: [
          {
            key: "projectId",
            label: "Project",
            kind: "select",
            required: true,
            options: projects.map((p) => ({ id: p.id, label: p.name })),
          },
          { key: "key", label: "Key", kind: "text", required: true },
          { key: "value", label: "Value", kind: "text", required: true },
          {
            key: "type",
            label: "Type",
            kind: "select",
            required: true,
            options: [
              { id: "encrypted", label: "Encrypted" },
              { id: "sensitive", label: "Sensitive (write-only)" },
              { id: "plain", label: "Plain" },
            ],
            defaultValue: "encrypted",
          },
          {
            key: "target",
            label: "Target",
            kind: "select",
            required: true,
            options: [
              { id: "production", label: "Production" },
              { id: "preview", label: "Preview" },
              { id: "development", label: "Development" },
            ],
            defaultValue: "production",
          },
        ],
      };
    }

    if (typeId === "vercel-dns-record") {
      const domainField = parentResourceId
        ? []
        : [
            {
              key: "domain",
              label: "Domain",
              kind: "select" as const,
              required: true,
              options: (await this.paginate<VercelDomain>("/v5/domains", "domains")).map((d) => ({
                id: d.name,
                label: d.name,
              })),
            },
          ];
      return {
        fields: [
          ...domainField,
          {
            key: "type",
            label: "Type",
            kind: "select",
            required: true,
            defaultValue: "A",
            options: DNS_RECORD_TYPES.map((t) => ({ id: t, label: t })),
          },
          {
            key: "name",
            label: "Name",
            kind: "text",
            required: false,
            description: "Subdomain, e.g. www. Leave blank for the apex.",
          },
          ...dnsContentField({ key: "value", label: "Value", placeholder: "e.g. 76.76.21.21" }),
          {
            key: "mxPriority",
            label: "MX Priority",
            kind: "number",
            required: true,
            defaultValue: "10",
            showWhen: { fieldKey: "type", fieldValues: ["MX"] },
          },
          {
            key: "ttl",
            label: "TTL (seconds)",
            kind: "number",
            required: false,
            description: "Leave blank for Vercel's default (60)",
          },
          { key: "comment", label: "Comment", kind: "text", required: false },
        ],
      };
    }

    if (typeId === "vercel-webhook") {
      const projects = await this.listRawProjects().catch(() => [] as VercelProject[]);
      return {
        fields: [
          {
            key: "url",
            label: "Endpoint URL",
            kind: "text",
            required: true,
            description: "HTTPS URL Vercel POSTs events to",
          },
          {
            key: "events",
            label: "Events",
            kind: "policy-picker",
            required: true,
            policies: WEBHOOK_EVENTS.map((e) => ({
              id: e.id,
              label: e.label,
              description: e.id,
              category: e.category,
            })),
          },
          {
            key: "projectIds",
            label: "Projects",
            kind: "policy-picker",
            required: false,
            description: "Limit the webhook to these projects. Leave empty for every project.",
            policies: projects.map((p) => ({ id: p.id, label: p.name })),
          },
        ],
      };
    }

    if (typeId === "vercel-team") {
      return {
        fields: [
          { key: "name", label: "Team Name", kind: "text", required: true },
          {
            key: "slug",
            label: "Slug",
            kind: "text",
            required: true,
            description: "URL-friendly identifier (e.g. my-team)",
          },
        ],
      };
    }

    throw new Error(`Vercel plugin: no create config for type "${typeId}"`);
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    if (typeId === "vercel-dns-record") {
      const domain =
        fields["domain"] ||
        (parentResourceId ? parentResourceId.split(":").slice(2).join(":") : "");
      if (!domain) throw new Error("Vercel plugin: a domain is required to create a DNS record");
      const type = fields["type"] || "A";
      const body: Record<string, unknown> = {
        type,
        name: fields["name"] ?? "",
        value: fields["value"] ?? "",
      };
      if (fields["ttl"]) body["ttl"] = Number(fields["ttl"]);
      if (type === "MX") body["mxPriority"] = Number(fields["mxPriority"] || 10);
      if (fields["comment"]) body["comment"] = fields["comment"];
      const res = await this.fetch<{ uid: string }>(
        `/v2/domains/${encodeURIComponent(domain)}/records`,
        { method: "POST", body: JSON.stringify(body) },
      );
      return this.mapDnsRecord(
        {
          id: res.uid,
          name: fields["name"] ?? "",
          type,
          value: fields["value"] ?? "",
          ...(body["ttl"] != null ? { ttl: Number(body["ttl"]) } : {}),
          ...(type === "MX" ? { mxPriority: Number(body["mxPriority"]) } : {}),
          ...(fields["comment"] ? { comment: fields["comment"] } : {}),
          createdAt: Date.now(),
        },
        domain,
        accountId,
      );
    }

    if (typeId === "vercel-webhook") {
      const events = parseJsonIds(fields["events"]);
      if (events.length === 0) throw new Error("Vercel plugin: pick at least one webhook event");
      const projectIds = parseJsonIds(fields["projectIds"]);
      const hook = await this.fetch<VercelWebhook>("/v1/webhooks", {
        method: "POST",
        body: JSON.stringify({
          url: fields["url"] ?? "",
          events,
          ...(projectIds.length > 0 ? { projectIds } : {}),
        }),
      });
      const mapped = this.mapWebhook(hook, accountId);
      return {
        ...mapped,
        resolvedOutputs: {
          ...mapped.resolvedOutputs,
          ...(hook.secret ? { secret: hook.secret } : {}),
        },
      };
    }

    if (typeId === "vercel-project") {
      const body: Record<string, unknown> = { name: fields["name"] };
      if (fields["framework"]) body["framework"] = fields["framework"];
      if (fields["buildCommand"]) body["buildCommand"] = fields["buildCommand"];
      if (fields["outputDirectory"]) body["outputDirectory"] = fields["outputDirectory"];
      if (fields["rootDirectory"]) body["rootDirectory"] = fields["rootDirectory"];
      if (fields["installCommand"]) body["installCommand"] = fields["installCommand"];
      if (fields["serverlessFunctionRegion"]) {
        body["serverlessFunctionRegion"] = fields["serverlessFunctionRegion"];
      }

      const project = await this.fetch<VercelProject>("/v11/projects", {
        method: "POST",
        body: JSON.stringify(body),
      });

      return this.mapProject(project, accountId);
    }

    if (typeId === "vercel-domain") {
      const data = await this.fetch<Record<string, unknown>>("/v7/domains", {
        method: "POST",
        body: JSON.stringify({ name: fields["name"], method: "add" }),
      });
      const domain = (data["domain"] ?? data) as Record<string, unknown>;
      const name = String(domain["name"] ?? fields["name"]);
      const nameservers = Array.isArray(domain["nameservers"])
        ? domain["nameservers"].join(", ")
        : "";
      const intendedNameservers = Array.isArray(domain["intendedNameservers"])
        ? domain["intendedNameservers"].join(", ")
        : "";
      const now = new Date().toISOString();
      return {
        id: `${accountId}:vercel-domain:${name}`,
        pluginId: "vercel",
        resourceTypeId: "vercel-domain",
        accountId,
        displayName: name,
        fields: {
          name,
          verified: String(domain["verified"] ?? false),
          serviceType: String(domain["serviceType"] ?? ""),
          nameservers,
          intendedNameservers,
          renew: String(domain["renew"] ?? false),
          expiresAt: String(domain["expiresAt"] ?? ""),
          boughtAt: String(domain["boughtAt"] ?? ""),
          createdAt: String(domain["createdAt"] ?? now),
        },
        resolvedOutputs: { domainName: name, nameservers },
        secretStates: [],
        externalId: name,
        createdAt: String(domain["createdAt"] ?? now),
        updatedAt: now,
      };
    }

    if (typeId === "vercel-env-var") {
      const projectId = fields["projectId"] ?? "";
      const data = await this.fetch<Record<string, unknown>>(`/v10/projects/${projectId}/env`, {
        method: "POST",
        body: JSON.stringify({
          key: fields["key"] ?? "",
          value: fields["value"] ?? "",
          type: fields["type"] ?? "encrypted",
          target: [fields["target"] ?? "production"],
        }),
      });
      const envId = String(data["id"] ?? `${projectId}/${fields["key"]}`);
      const now = new Date().toISOString();
      return {
        id: `${accountId}:vercel-env-var:${envId}`,
        pluginId: "vercel",
        resourceTypeId: "vercel-env-var",
        accountId,
        displayName: fields["key"] ?? "",
        fields: {
          key: fields["key"] ?? "",
          value: fields["value"] ?? "",
          type: fields["type"] ?? "encrypted",
          target: fields["target"] ?? "production",
          projectName: "",
          gitBranch: "",
          createdAt: now,
          updatedAt: now,
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: envId,
        parentResourceId: `${accountId}:vercel-project:${projectId}`,
        createdAt: now,
        updatedAt: now,
      };
    }

    if (typeId === "vercel-team") {
      const name = fields["name"] ?? "";
      const slug = fields["slug"] ?? "";
      const result = await this.fetch<{ id: string; slug: string; name: string }>("/v1/teams", {
        method: "POST",
        body: JSON.stringify({ slug, name }),
      });
      const now = new Date().toISOString();
      return {
        id: `${accountId}:vercel-team:${result.id}`,
        pluginId: "vercel",
        resourceTypeId: "vercel-team",
        accountId,
        displayName: name,
        fields: { name, slug: result.slug ?? slug, createdAt: now, updatedAt: now },
        resolvedOutputs: { teamId: result.id, teamSlug: result.slug ?? slug },
        secretStates: [],
        externalId: result.id,
        createdAt: now,
        updatedAt: now,
      };
    }

    throw new Error(`Vercel plugin: createResource not supported for type "${typeId}"`);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const externalId = resourceId.split(":").slice(2).join(":");

    if (typeId === "vercel-project") {
      await this.fetch<unknown>(`/v9/projects/${externalId}`, { method: "DELETE" });
      return;
    }

    if (typeId === "vercel-deployment") {
      await this.fetch<unknown>(`/v13/deployments/${externalId}`, { method: "DELETE" });
      return;
    }

    if (typeId === "vercel-domain") {
      await this.fetch<unknown>(`/v6/domains/${externalId}`, { method: "DELETE" });
      return;
    }

    if (typeId === "vercel-dns-record") {
      const { domain, recordId } = splitRecordId(externalId);
      await this.fetch<unknown>(
        `/v2/domains/${encodeURIComponent(domain)}/records/${encodeURIComponent(recordId)}`,
        { method: "DELETE" },
      );
      return;
    }

    if (typeId === "vercel-webhook") {
      await this.fetch<unknown>(`/v1/webhooks/${encodeURIComponent(externalId)}`, {
        method: "DELETE",
      });
      return;
    }

    if (typeId === "vercel-env-var") {
      // resourceId format: {accountId}:vercel-env-var:{projectId}/{envId}
      // externalId is envId, but we need the projectId from the compound part
      const compound = resourceId.split(":").slice(2).join(":");
      const slashIdx = compound.indexOf("/");
      if (slashIdx === -1) throw new Error("Invalid env var resource ID");
      const projectId = compound.slice(0, slashIdx);
      const envId = compound.slice(slashIdx + 1);
      if (!projectId || !envId) throw new Error("Invalid env var resource ID");
      await this.fetch<unknown>(`/v9/projects/${projectId}/env/${envId}`, { method: "DELETE" });
      return;
    }

    throw new Error(`Vercel plugin: deleteResource not supported for type "${typeId}"`);
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const externalId = resourceId.split(":").slice(2).join(":");

    if (typeId === "vercel-project") {
      const body: Record<string, unknown> = {};
      for (const key of [
        "name",
        "framework",
        "nodeVersion",
        "serverlessFunctionRegion",
        "buildCommand",
        "installCommand",
        "devCommand",
        "outputDirectory",
        "rootDirectory",
      ]) {
        if (fields[key] === undefined) continue;
        // Blank clears an override back to the framework default (`null`).
        body[key] = fields[key] === "" && key !== "name" ? null : fields[key];
      }
      const project = await this.fetch<VercelProject>(
        `/v9/projects/${encodeURIComponent(externalId)}`,
        { method: "PATCH", body: JSON.stringify(body) },
      );
      return this.mapProject(project, accountId);
    }

    if (typeId === "vercel-env-var") {
      const { projectId, envId } = splitEnvId(externalId);
      const body: Record<string, unknown> = {};
      if (fields["newValue"]) body["value"] = fields["newValue"];
      if (fields["type"]) body["type"] = fields["type"];
      if (fields["target"] !== undefined) {
        body["target"] = fields["target"]
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
      }
      if (fields["gitBranch"] !== undefined) body["gitBranch"] = fields["gitBranch"];
      if (fields["comment"] !== undefined) body["comment"] = fields["comment"];
      await this.fetch<unknown>(
        `/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(envId)}`,
        { method: "PATCH", body: JSON.stringify(body) },
      );
      return this.getResource(typeId, resourceId, accountId);
    }

    if (typeId === "vercel-domain") {
      if (fields["renew"] !== undefined) {
        await this.fetch<unknown>(
          `/v1/registrar/domains/${encodeURIComponent(externalId)}/auto-renew`,
          { method: "PATCH", body: JSON.stringify({ autoRenew: fields["renew"] === "true" }) },
        );
      }
      return this.getResource(typeId, resourceId, accountId);
    }

    if (typeId === "vercel-dns-record") {
      const { recordId } = splitRecordId(externalId);
      const body: Record<string, unknown> = {};
      if (fields["name"] !== undefined) body["name"] = fields["name"];
      if (fields["content"] !== undefined) body["value"] = fields["content"];
      if (fields["ttl"]) body["ttl"] = Number(fields["ttl"]);
      if (fields["priority"]) body["mxPriority"] = Number(fields["priority"]);
      if (fields["comment"] !== undefined) body["comment"] = fields["comment"];
      await this.fetch<unknown>(`/v1/domains/records/${encodeURIComponent(recordId)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      return this.getResource(typeId, resourceId, accountId);
    }

    throw new Error(`Vercel plugin: updateResource not supported for type "${typeId}"`);
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): Promise<void> {
    const externalId = resourceId.split(":").slice(2).join(":");

    if (typeId === "vercel-deployment" && DEPLOYMENT_ACTIONS.has(actionId)) {
      const id = encodeURIComponent(externalId);
      if (actionId === "cancel") {
        await this.fetch<unknown>(`/v12/deployments/${id}/cancel`, { method: "PATCH" });
        return;
      }
      const deployment = await this.getResource(typeId, resourceId, accountId);
      const projectId = String(deployment.fields["projectId"] ?? "");
      if (actionId === "redeploy") {
        const target = String(deployment.fields["target"] ?? "");
        await this.fetch<unknown>("/v13/deployments", {
          method: "POST",
          body: JSON.stringify({
            name: String(deployment.fields["name"] ?? ""),
            deploymentId: externalId,
            ...(projectId ? { project: projectId } : {}),
            ...(target === "production" ? { target: "production" } : {}),
          }),
        });
        return;
      }
      if (!projectId) throw new Error("Vercel plugin: deployment has no project");
      const path =
        actionId === "promote"
          ? `/v10/projects/${encodeURIComponent(projectId)}/promote/${id}`
          : `/v1/projects/${encodeURIComponent(projectId)}/rollback/${id}`;
      await this.fetch<unknown>(path, { method: "POST" });
      return;
    }

    if (typeId === "vercel-project" && PROJECT_ACTIONS.has(actionId)) {
      if (actionId === "pause" || actionId === "unpause") {
        await this.fetch<unknown>(`/v1/projects/${encodeURIComponent(externalId)}/${actionId}`, {
          method: "POST",
        });
        return;
      }
      await this.fetch<unknown>("/v1/security/attack-mode", {
        method: "POST",
        body: JSON.stringify({
          projectId: externalId,
          attackModeEnabled: actionId === "attack-mode-on",
        }),
      });
      return;
    }

    throw new Error(`Vercel plugin: invokeAction "${actionId}" not supported for "${typeId}"`);
  }

  /**
   * Build output for a deployment, from `GET /v3/deployments/{id}/events`.
   * Runtime logs are a long-lived stream (`application/stream+json`) that
   * the polling Logs tab cannot consume, so only the build is shown.
   */
  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    if (typeId !== "vercel-deployment") return { text: "", containers: [], activeContainer: "" };
    const externalId = resourceId.split(":").slice(2).join(":");
    const limit = Math.min(Math.max(params.tailLines ?? 500, 1), 2000);
    const events = await this.fetch<VercelDeploymentEvent[]>(
      `/v3/deployments/${encodeURIComponent(externalId)}/events?builds=1&direction=backward&limit=${limit}`,
    );
    const lines = (Array.isArray(events) ? events : [])
      .filter(
        (e) =>
          e.type === "stdout" || e.type === "stderr" || e.type === "command" || e.type === "fatal",
      )
      .map((e) => ({
        at: e.created ?? e.payload?.date ?? 0,
        text: e.text ?? e.payload?.text ?? "",
      }))
      .sort((a, b) => a.at - b.at)
      .map((e) => `${e.at ? new Date(e.at).toISOString() : ""}  ${e.text}`.trimEnd());
    const text =
      lines.length > 0 ? lines.join("\n") + "\n" : "No build output for this deployment.\n";
    return { text, containers: ["build"], activeContainer: "build" };
  }

  /** Domains: add the DNS configuration check (`misconfigured`). */
  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    if (resource.resourceTypeId !== "vercel-domain") return resource;
    try {
      const config = await this.fetch<{ misconfigured?: boolean; configuredBy?: string | null }>(
        `/v6/domains/${encodeURIComponent(resource.externalId ?? "")}/config`,
      );
      return {
        ...resource,
        fields: {
          ...resource.fields,
          __misconfigured__: config.misconfigured === true,
          __configuredBy__: config.configuredBy ?? "",
        },
      };
    } catch {
      return resource;
    }
  }

  async attachResource(
    sourceTypeId: string,
    sourceResourceId: string,
    targetTypeId: string,
    targetResourceId: string,
    accountId: string,
  ): Promise<void> {
    if (sourceTypeId === "vercel-domain" && targetTypeId === "vercel-project") {
      const [domain, project] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const domainName = String(domain.fields["name"] ?? domain.externalId ?? "");
      const projectIdOrName = String(project.externalId ?? project.fields["name"] ?? "");
      if (!domainName || !projectIdOrName) {
        throw new Error("Cannot determine Vercel domain or project identity for attachment");
      }
      await this.fetch<unknown>(`/v10/projects/${encodeURIComponent(projectIdOrName)}/domains`, {
        method: "POST",
        body: JSON.stringify({ name: domainName }),
      });
      return;
    }

    if (sourceTypeId === "vercel-deployment" && targetTypeId === "vercel-project") {
      const [deployment, project] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const deploymentUrl = String(deployment.fields["url"] ?? "");
      const projectIdOrName = String(project.externalId ?? project.fields["name"] ?? "");
      if (!deploymentUrl || !projectIdOrName) {
        throw new Error(
          "Cannot determine Vercel deployment URL or project identity for env import",
        );
      }
      await this.fetch<unknown>(`/v10/projects/${encodeURIComponent(projectIdOrName)}/env`, {
        method: "POST",
        body: JSON.stringify({
          key: "VERCEL_DEPLOYMENT_URL",
          value: deploymentUrl,
          type: "plain",
          target: ["production"],
        }),
      });
      return;
    }

    throw new Error(
      `Vercel plugin: attachResource not supported for ${sourceTypeId} → ${targetTypeId}`,
    );
  }

  private async listProjects(accountId: string): Promise<ResourceInstance[]> {
    const projects = await this.listRawProjects();
    return projects.map((p) => this.mapProject(p, accountId));
  }

  private async listDeployments(accountId: string): Promise<ResourceInstance[]> {
    const deployments = await this.paginate<VercelDeployment>("/v7/deployments", "deployments", 50);
    return deployments.map((d) => this.mapDeployment(d, accountId));
  }

  private async listDomains(accountId: string): Promise<ResourceInstance[]> {
    const domains = await this.paginate<VercelDomain>("/v5/domains", "domains");
    return domains.map((d) => this.mapDomain(d, accountId));
  }

  private async listAllEnvVars(accountId: string): Promise<ResourceInstance[]> {
    // Env vars are per-project; list projects first, then fetch envs for each
    const projects = await this.listRawProjects();
    const results: ResourceInstance[] = [];

    for (const project of projects) {
      try {
        const data = await this.fetch<{ envs: VercelEnvVar[] }>(`/v10/projects/${project.id}/env`);
        const envs = data.envs ?? [];
        for (const env of envs) {
          results.push(this.mapEnvVar(env, project, accountId));
        }
      } catch {
        /* skip projects where we lack env read permissions */
      }
    }

    return results;
  }

  private async listDnsRecordsForDomain(
    domain: string,
    accountId: string,
  ): Promise<ResourceInstance[]> {
    const records = await this.paginate<VercelDnsRecord>(
      `/v5/domains/${encodeURIComponent(domain)}/records`,
      "records",
    );
    return records.map((r) => this.mapDnsRecord(r, domain, accountId));
  }

  private async listAllDnsRecords(accountId: string): Promise<ResourceInstance[]> {
    // Only domains on Vercel's nameservers have records here; the rest
    // answer with an error, which just means "no records to show".
    const domains = await this.paginate<VercelDomain>("/v5/domains", "domains");
    const batches = await Promise.all(
      domains.map((d) => this.listDnsRecordsForDomain(d.name, accountId).catch(() => [])),
    );
    return batches.flat();
  }

  private async listWebhooks(accountId: string): Promise<ResourceInstance[]> {
    const data = await this.fetch<VercelWebhook[] | { webhooks?: VercelWebhook[] }>("/v1/webhooks");
    const hooks = Array.isArray(data) ? data : (data.webhooks ?? []);
    return hooks.map((h) => this.mapWebhook(h, accountId));
  }

  private mapDnsRecord(r: VercelDnsRecord, domain: string, accountId: string): ResourceInstance {
    const created = formatTimestamp(r.createdAt ?? null);
    const priority = r.mxPriority ?? r.priority;
    return {
      id: `${accountId}:vercel-dns-record:${domain}/${r.id}`,
      pluginId: "vercel",
      resourceTypeId: "vercel-dns-record",
      accountId,
      displayName: `${r.type ?? ""} ${r.name ? `${r.name}.${domain}` : domain}`.trim(),
      fields: fields({
        name: r.name ?? "",
        type: r.type,
        content: r.value ?? "",
        ttl: r.ttl,
        priority,
        comment: r.comment || null,
        domain,
        creator: r.creator,
        createdAt: r.createdAt ? created : null,
      }),
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${domain}/${r.id}`,
      parentResourceId: `${accountId}:vercel-domain:${domain}`,
      createdAt: created,
      updatedAt: formatTimestamp(r.updatedAt ?? r.createdAt ?? null),
    };
  }

  private mapWebhook(h: VercelWebhook, accountId: string): ResourceInstance {
    return {
      id: `${accountId}:vercel-webhook:${h.id}`,
      pluginId: "vercel",
      resourceTypeId: "vercel-webhook",
      accountId,
      displayName: h.url,
      fields: fields({
        url: h.url,
        events: (h.events ?? []).join(", "),
        projects: (h.projectIds ?? []).join(", ") || null,
        createdAt: h.createdAt ? formatTimestamp(h.createdAt) : null,
        updatedAt: h.updatedAt ? formatTimestamp(h.updatedAt) : null,
      }),
      resolvedOutputs: { webhookId: h.id },
      secretStates: [],
      externalId: h.id,
      createdAt: formatTimestamp(h.createdAt ?? null),
      updatedAt: formatTimestamp(h.updatedAt ?? h.createdAt ?? null),
    };
  }

  private async listTeams(accountId: string): Promise<ResourceInstance[]> {
    try {
      const data = await this.fetch<{ teams: VercelTeam[] }>("/v2/teams");
      const teams = data.teams ?? [];
      return teams.map((t) => this.mapTeam(t, accountId));
    } catch {
      // Personal accounts may not have team access
      return [];
    }
  }

  private mapProject(p: VercelProject, accountId: string): ResourceInstance {
    const gitRepo = p.link
      ? `${p.link.org ?? ""}/${p.link.repo ?? ""}`.replace(/^\//, "")
      : undefined;
    const productionAlias = p.alias?.find((a) => a.domain)?.domain;
    const productionUrl = productionAlias
      ? `https://${productionAlias}`
      : p.latestDeployments?.[0]?.url
        ? `https://${p.latestDeployments[0].url}`
        : undefined;

    return {
      id: `${accountId}:vercel-project:${p.id}`,
      pluginId: "vercel",
      resourceTypeId: "vercel-project",
      accountId,
      displayName: p.name,
      fields: fields({
        name: p.name,
        framework: p.framework,
        nodeVersion: p.nodeVersion,
        serverlessFunctionRegion: p.serverlessFunctionRegion,
        rootDirectory: p.rootDirectory,
        buildCommand: p.buildCommand,
        outputDirectory: p.outputDirectory,
        productionUrl: productionUrl,
        gitRepo: gitRepo || null,
        ownerId: p.accountId,
        installCommand: p.installCommand,
        devCommand: p.devCommand,
        createdAt: formatTimestamp(p.createdAt),
        updatedAt: formatTimestamp(p.updatedAt),
        live: p.live ?? null,
        paused: p.paused ?? null,
        attackModeEnabled: p.security?.attackModeEnabled ?? null,
      }),
      resolvedOutputs: {},
      secretStates: [],
      externalId: p.id,
      createdAt: formatTimestamp(p.createdAt),
      updatedAt: formatTimestamp(p.updatedAt),
    };
  }

  private mapDeployment(d: VercelDeployment, accountId: string): ResourceInstance {
    const meta = d.meta ?? {};
    const state = d.readyState ?? d.state ?? "UNKNOWN";

    return {
      id: `${accountId}:vercel-deployment:${d.uid}`,
      pluginId: "vercel",
      resourceTypeId: "vercel-deployment",
      accountId,
      displayName: d.url ?? d.name ?? d.uid,
      fields: fields({
        name: d.name,
        url: d.url ? `https://${d.url}` : null,
        state,
        target: d.target,
        source: d.source,
        projectId: d.projectId,
        creatorEmail: d.creator?.email ?? d.creator?.username,
        gitBranch: meta["githubCommitRef"] ?? meta["gitlabCommitRef"],
        gitCommitSha: meta["githubCommitSha"] ?? meta["gitlabCommitSha"],
        gitCommitMessage: meta["githubCommitMessage"] ?? meta["gitlabCommitMessage"],
        inspectorUrl: d.inspectorUrl,
        createdAt: formatTimestamp(d.created),
        readyAt: formatTimestamp(d.ready),
        framework: d.projectSettings?.framework,
        errorMessage: d.errorMessage || null,
        rollbackCandidate: d.isRollbackCandidate ?? null,
      }),
      resolvedOutputs: {},
      secretStates: [],
      externalId: d.uid,
      createdAt: formatTimestamp(d.created),
      updatedAt: formatTimestamp(d.ready ?? d.created),
    };
  }

  private mapDomain(d: VercelDomain, accountId: string): ResourceInstance {
    const nameservers = d.nameservers ?? [];
    const intendedNameservers = d.intendedNameservers ?? [];
    return {
      id: `${accountId}:vercel-domain:${d.name}`,
      pluginId: "vercel",
      resourceTypeId: "vercel-domain",
      accountId,
      displayName: d.name,
      fields: fields({
        name: d.name,
        verified: String(d.verified),
        serviceType: d.serviceType,
        nameservers: nameservers.join(", "),
        intendedNameservers: intendedNameservers.join(", "),
        renew: d.renew != null ? String(d.renew) : null,
        expiresAt: formatTimestamp(d.expiresAt),
        boughtAt: formatTimestamp(d.boughtAt),
        teamId: d.teamId,
        createdAt: formatTimestamp(d.createdAt),
      }),
      resolvedOutputs: {},
      secretStates: [],
      externalId: d.name,
      createdAt: formatTimestamp(d.createdAt),
      updatedAt: formatTimestamp(d.createdAt),
    };
  }

  private mapEnvVar(
    env: VercelEnvVar,
    project: VercelProject,
    accountId: string,
  ): ResourceInstance {
    const envId = env.id ?? `${project.id}/${env.key}`;
    return {
      id: `${accountId}:vercel-env-var:${project.id}/${envId}`,
      pluginId: "vercel",
      resourceTypeId: "vercel-env-var",
      accountId,
      displayName: `${env.key} (${project.name})`,
      fields: fields({
        key: env.key,
        value: env.value,
        type: env.type,
        target: targetLabel(env.target),
        projectName: project.name,
        gitBranch: env.gitBranch,
        comment: env.comment || null,
        createdAt: formatTimestamp(env.createdAt),
        updatedAt: formatTimestamp(env.updatedAt),
      }),
      resolvedOutputs: {},
      secretStates: [],
      externalId: envId,
      parentResourceId: `${accountId}:vercel-project:${project.id}`,
      createdAt: formatTimestamp(env.createdAt),
      updatedAt: formatTimestamp(env.updatedAt),
    };
  }

  private mapTeam(t: VercelTeam, accountId: string): ResourceInstance {
    return {
      id: `${accountId}:vercel-team:${t.id}`,
      pluginId: "vercel",
      resourceTypeId: "vercel-team",
      accountId,
      displayName: t.name,
      fields: {
        name: t.name,
        slug: t.slug,
        createdAt: formatTimestamp(t.createdAt),
        updatedAt: formatTimestamp(t.updatedAt),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: t.id,
      createdAt: formatTimestamp(t.createdAt),
      updatedAt: formatTimestamp(t.updatedAt),
    };
  }

  private renderProjectDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const framework = f["framework"] ? frameworkLabel(String(f["framework"])) : "—";
    const productionUrl = String(f["productionUrl"] ?? "");
    const paused = f["paused"] === true;
    const attackMode = f["attackModeEnabled"] === true;

    return {
      title: resource.displayName,
      subtitle: `Vercel Project${framework !== "—" ? ` · ${framework}` : ""}`,
      metricsCapability: { defaultTimeRangeMs: WEB_ANALYTICS_DEFAULT_RANGE_MS },
      status: {
        kind: "status-dot",
        status: paused
          ? "error"
          : f["live"] === true || f["live"] === "true"
            ? "healthy"
            : "degraded",
      },
      sections: [
        {
          kind: "section",
          title: "Project Info",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Project ID", value: String(resource.externalId ?? "—"), copyable: true },
                { key: "Name", value: String(f["name"] ?? "—") },
                { key: "Framework", value: framework },
                { key: "Node.js", value: String(f["nodeVersion"] ?? "—") },
                {
                  key: "Region",
                  value: String(f["serverlessFunctionRegion"] ?? "—"),
                },
                { key: "Paused", value: paused ? "Yes (serving 503s)" : "No" },
                { key: "Attack Challenge Mode", value: attackMode ? "On" : "Off" },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Build Configuration",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Build Command", value: String(f["buildCommand"] ?? "—") },
                { key: "Install Command", value: String(f["installCommand"] ?? "—") },
                { key: "Development Command", value: String(f["devCommand"] ?? "—") },
                { key: "Output Directory", value: String(f["outputDirectory"] ?? "—") },
                { key: "Root Directory", value: String(f["rootDirectory"] ?? "—") },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Git & URLs",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Git Repository", value: String(f["gitRepo"] ?? "—") },
                {
                  key: "Production URL",
                  value: productionUrl || "—",
                  copyable: productionUrl !== "",
                },
                { key: "Created", value: String(f["createdAt"] ?? "—") },
                { key: "Updated", value: String(f["updatedAt"] ?? "—") },
              ],
            },
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        paused
          ? {
              kind: "action",
              label: "Resume",
              action: {
                type: "plugin-action",
                actionId: "unpause",
                successMessage: "Project resumed.",
              },
            }
          : {
              kind: "action",
              label: "Pause",
              variant: "danger",
              action: {
                type: "plugin-action",
                actionId: "pause",
                confirmMessage:
                  "Pause this project? Every request to its deployments returns a 503 until you resume it.",
                successMessage: "Project paused.",
              },
            },
        attackMode
          ? {
              kind: "action",
              label: "Disable Attack Mode",
              action: {
                type: "plugin-action",
                actionId: "attack-mode-off",
                successMessage: "Attack Challenge Mode disabled.",
              },
            }
          : {
              kind: "action",
              label: "Enable Attack Mode",
              action: {
                type: "plugin-action",
                actionId: "attack-mode-on",
                confirmMessage:
                  "Enable Attack Challenge Mode? Every visitor will have to pass a browser challenge, which also blocks API clients and bots you rely on.",
                successMessage: "Attack Challenge Mode enabled.",
              },
            },
        {
          kind: "action",
          label: "Open in Vercel",
          action: {
            type: "open-url",
            url: `https://vercel.com/${this.teamId ? `${this.teamId}/` : ""}${String(f["name"] ?? "")}`,
          },
        },
        ...(productionUrl
          ? [
              {
                kind: "action" as const,
                label: "Visit Site",
                action: { type: "open-url" as const, url: productionUrl },
              },
            ]
          : []),
      ],
    };
  }

  private renderDeploymentDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const state = String(f["state"] ?? "UNKNOWN");
    const url = String(f["url"] ?? "");
    const inspectorUrl = String(f["inspectorUrl"] ?? "");
    const inProgress = state === "BUILDING" || state === "QUEUED" || state === "INITIALIZING";
    const actions: ActionNode[] = [];
    if (inProgress) {
      actions.push({
        kind: "action",
        label: "Cancel",
        variant: "danger",
        action: {
          type: "plugin-action",
          actionId: "cancel",
          confirmMessage: "Cancel this deployment's build?",
          successMessage: "Deployment canceled.",
        },
      });
    } else {
      actions.push({
        kind: "action",
        label: "Redeploy",
        action: {
          type: "plugin-action",
          actionId: "redeploy",
          confirmMessage: "Start a new build from this deployment's source and settings?",
          successMessage: "Redeploy started.",
        },
      });
    }
    if (state === "READY" && f["projectId"]) {
      if (f["target"] === "production" && f["rollbackCandidate"] === true) {
        actions.push({
          kind: "action",
          label: "Instant Rollback",
          action: {
            type: "plugin-action",
            actionId: "rollback",
            confirmMessage:
              "Point production traffic back to this deployment? Automatic production promotion stays off until you promote a deployment again.",
            successMessage: "Production rolled back.",
          },
        });
      } else {
        actions.push({
          kind: "action",
          label: "Promote to Production",
          action: {
            type: "plugin-action",
            actionId: "promote",
            confirmMessage: "Point the project's production domains at this deployment?",
            successMessage: "Promotion started.",
          },
        });
      }
    }
    const errorMessage = String(f["errorMessage"] ?? "");

    return {
      title: resource.displayName,
      subtitle: `Deployment · ${state}${f["target"] ? ` · ${String(f["target"])}` : ""}`,
      status: { kind: "status-dot", status: deploymentStatus(state) },
      sections: [
        {
          kind: "section",
          title: "Deployment Info",
          children: [
            {
              kind: "key-value-list",
              items: [
                {
                  key: "Deployment ID",
                  value: String(resource.externalId ?? "—"),
                  copyable: true,
                },
                { key: "State", value: state },
                { key: "Target", value: String(f["target"] ?? "—") },
                { key: "Source", value: String(f["source"] ?? "—") },
                { key: "URL", value: url || "—", copyable: url !== "" },
                { key: "Creator", value: String(f["creatorEmail"] ?? "—") },
                { key: "Framework", value: String(f["framework"] ?? "—") },
                ...(errorMessage ? [{ key: "Error", value: errorMessage }] : []),
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Git Info",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Branch", value: String(f["gitBranch"] ?? "—") },
                {
                  key: "Commit SHA",
                  value: String(f["gitCommitSha"] ?? "—"),
                  copyable: f["gitCommitSha"] != null,
                },
                { key: "Commit Message", value: String(f["gitCommitMessage"] ?? "—") },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Timing",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Created", value: String(f["createdAt"] ?? "—") },
                { key: "Ready", value: String(f["readyAt"] ?? "—") },
              ],
            },
          ],
        },
      ],
      logs: { defaultTailLines: 500 },
      headerActions: [
        ...actions,
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        ...(inspectorUrl
          ? [
              {
                kind: "action" as const,
                label: "Open Inspector",
                action: { type: "open-url" as const, url: inspectorUrl },
              },
            ]
          : []),
        ...(url
          ? [
              {
                kind: "action" as const,
                label: "Visit Deployment",
                action: { type: "open-url" as const, url },
              },
            ]
          : []),
      ],
    };
  }

  private renderDomainDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const verified = f["verified"] === "true" || f["verified"] === true;

    return {
      title: resource.displayName,
      subtitle: `Domain · ${verified ? "Verified" : "Unverified"}`,
      status: {
        kind: "status-dot",
        status: domainVerificationStatus(verified),
      },
      sections: [
        {
          kind: "section",
          title: "Domain Info",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Domain", value: String(f["name"] ?? "—"), copyable: true },
                {
                  key: "Verified",
                  value: verified ? "Yes" : "No",
                },
                { key: "Service Type", value: String(f["serviceType"] ?? "—") },
                { key: "Auto-Renew", value: String(f["renew"] ?? "—") },
                ...(f["__misconfigured__"] !== undefined
                  ? [
                      {
                        key: "DNS Configuration",
                        value:
                          f["__misconfigured__"] === true
                            ? "Misconfigured: records do not point at Vercel"
                            : `OK${f["__configuredBy__"] ? ` (via ${String(f["__configuredBy__"])})` : ""}`,
                      },
                    ]
                  : []),
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "DNS",
          children: [
            {
              kind: "key-value-list",
              items: [
                {
                  key: "Nameservers",
                  value: String(f["nameservers"] ?? "—"),
                  copyable: true,
                },
                {
                  key: "Intended Nameservers",
                  value: String(f["intendedNameservers"] ?? "—"),
                },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Dates",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Created", value: String(f["createdAt"] ?? "—") },
                { key: "Expires", value: String(f["expiresAt"] ?? "—") },
                { key: "Bought", value: String(f["boughtAt"] ?? "—") },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderEnvVarDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;

    return {
      title: resource.displayName,
      subtitle: joinSubtitle("Env Variable", f["type"]),
      status: { kind: "status-dot", status: "healthy" },
      sections: [
        {
          kind: "section",
          title: "Variable Info",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Key", value: String(f["key"] ?? "—"), copyable: true },
                { key: "Type", value: String(f["type"] ?? "—") },
                { key: "Target", value: String(f["target"] ?? "—") },
                { key: "Project", value: String(f["projectName"] ?? "—") },
                { key: "Git Branch", value: String(f["gitBranch"] ?? "—") },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Value",
          children: [
            {
              kind: "key-value-list",
              items: [
                {
                  key: "Value",
                  value: String(f["value"] ?? "(encrypted)"),
                  sensitive: true,
                },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Dates",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Created", value: String(f["createdAt"] ?? "—") },
                { key: "Updated", value: String(f["updatedAt"] ?? "—") },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderTeamDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;

    return {
      title: resource.displayName,
      subtitle: joinSubtitle("Team", f["slug"]),
      status: { kind: "status-dot", status: "healthy" },
      sections: [
        {
          kind: "section",
          title: "Team Info",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Team ID", value: String(resource.externalId ?? "—"), copyable: true },
                { key: "Name", value: String(f["name"] ?? "—") },
                { key: "Slug", value: String(f["slug"] ?? "—"), copyable: true },
                { key: "Created", value: String(f["createdAt"] ?? "—") },
                { key: "Updated", value: String(f["updatedAt"] ?? "—") },
              ],
            },
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        {
          kind: "action",
          label: "Open in Vercel",
          action: {
            type: "open-url",
            url: `https://vercel.com/${String(f["slug"] ?? "")}`,
          },
        },
      ],
    };
  }

  private renderWebhookDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const events = String(f["events"] ?? "")
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);
    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Webhook",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Webhook ID", value: String(resource.externalId ?? "—"), copyable: true },
              { key: "URL", value: String(f["url"] ?? "—"), copyable: true },
              { key: "Projects", value: String(f["projects"] ?? "All projects") },
              { key: "Created", value: String(f["createdAt"] ?? "—") },
            ],
          },
        ],
      },
    ];
    if (events.length > 0) {
      sections.push({
        kind: "section",
        title: "Events",
        children: [
          {
            kind: "table",
            columns: [{ key: "event", label: "Event", mono: true }],
            rows: events.map((event) => ({ cells: { event } })),
          },
        ],
      });
    }
    return {
      title: resource.displayName,
      subtitle: joinSubtitle("Webhook", `${events.length} events`),
      status: { kind: "status-dot", status: "healthy" },
      sections,
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderGenericDetail(resource: ResourceInstance): DetailViewSchema {
    return {
      title: resource.displayName,
      subtitle: resource.resourceTypeId,
      status: { kind: "status-dot", status: "info" },
      sections: [
        {
          kind: "section",
          title: "Details",
          children: [
            {
              kind: "key-value-list",
              items: Object.entries(resource.fields).map(([key, value]) => ({
                key,
                value: String(value),
              })),
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }
}

/** `{domain}/{recordId}`: the DNS record's external id. */
function splitRecordId(externalId: string): { domain: string; recordId: string } {
  const slash = externalId.lastIndexOf("/");
  if (slash <= 0) throw new Error(`Vercel plugin: cannot parse DNS record id "${externalId}"`);
  return { domain: externalId.slice(0, slash), recordId: externalId.slice(slash + 1) };
}

/** `{projectId}/{envId}`: the env var resource id's compound part. */
function splitEnvId(compound: string): { projectId: string; envId: string } {
  const slash = compound.indexOf("/");
  const projectId = slash === -1 ? "" : compound.slice(0, slash);
  const envId = slash === -1 ? "" : compound.slice(slash + 1);
  if (!projectId || !envId) throw new Error("Invalid env var resource ID");
  return { projectId, envId };
}

/** A `policy-picker` value: a JSON array of ids (tolerates a comma list). */
function parseJsonIds(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    /* fall through to comma-separated */
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
