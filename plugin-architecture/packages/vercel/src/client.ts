import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
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
  requireListPage,
  joinSubtitle,
  pathEncode,
  renderDnsRecordDetail,
  renderDnsRecordSidebar,
} from "@infrawrench/plugin-base";
import {
  createVercelApi,
  hasStatus,
  type VercelDeployment,
  type VercelDeploymentDetail,
  type VercelDeploymentEvent,
  type VercelDnsRecord,
  type VercelDomain,
  type VercelEnvVar,
  type VercelProject,
  type VercelResponse,
  type VercelTeam,
  type VercelWebhook,
} from "./api.js";
import { fetchVercelCostData } from "./cost-data.js";
import {
  DNS_RECORD_TYPES,
  FRAMEWORK_OPTIONS,
  FUNCTION_REGIONS,
  WEBHOOK_EVENTS,
  frameworkLabel,
} from "./catalog.js";

/** Deployment actions: header buttons on the deployment detail view. */
const DEPLOYMENT_ACTIONS = new Set(["cancel", "redeploy", "promote", "rollback"]);
const PROJECT_ACTIONS = new Set(["pause", "unpause", "attack-mode-on", "attack-mode-off"]);

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

/** Each provider's link names the owner and repository its own way; the rest read as undefined. */
type ProjectLink = NonNullable<VercelProject["link"]> & {
  org?: string;
  owner?: string;
  projectNamespace?: string;
  repo?: string;
  slug?: string;
  name?: string;
  projectName?: string;
};

function gitRepoOf(link: ProjectLink | undefined): string | null {
  if (!link) return null;
  const owner = link.org ?? link.owner ?? link.projectNamespace;
  const repo = link.repo ?? link.slug ?? link.name ?? link.projectName;
  return [owner, repo].filter(Boolean).join("/") || null;
}

/**
 * What `mapDnsRecord` reads. A record just created has only what the form sent, and
 * the document does not promise it a `uid`.
 */
type DnsRecordFields = Partial<Omit<VercelDnsRecord, "id" | "type">> & {
  id: string | undefined;
  type?: string;
};

/**
 * What `mapDeployment` reads. The list route and the three shapes of the single
 * route each lack some of it, and only the list route documents `uid` and `created`.
 */
type DeploymentFields = Partial<
  Pick<
    VercelDeployment,
    | "name"
    | "url"
    | "state"
    | "readyState"
    | "target"
    | "source"
    | "projectId"
    | "created"
    | "createdAt"
    | "ready"
    | "inspectorUrl"
    | "errorMessage"
    | "isRollbackCandidate"
    | "meta"
    | "creator"
    | "projectSettings"
  >
> & { uid: string };

export class VercelClient implements PluginClient {
  private readonly accessToken: string;
  private readonly teamId: string | null;
  private readonly caCert: string;
  private readonly services: HostServices | undefined;
  private readonly api: ReturnType<typeof createVercelApi>["api"];
  private readonly projectPages: ReturnType<typeof createVercelApi>["projectPages"];
  private readonly accountPages: ReturnType<typeof createVercelApi>["accountPages"];
  private readonly envPages: ReturnType<typeof createVercelApi>["envPages"];

  constructor(credentials: Credentials, services?: HostServices) {
    const token = credentials["accessToken"];
    if (!token) throw new Error("Vercel plugin: missing accessToken credential");
    this.accessToken = token;
    this.teamId = credentials["teamId"] || null;
    this.caCert = credentials["caCert"] ?? "";
    this.services = services;
    const { api, projectPages, accountPages, envPages } = createVercelApi({
      accessToken: token,
      teamId: this.teamId,
      caCert: this.caCert,
      http: services?.http,
    });
    this.api = api;
    this.projectPages = projectPages;
    this.accountPages = accountPages;
    this.envPages = envPages;
  }

  private async listRawTeams() {
    // No `limit` maximum is documented for this route; 20 is its own example, and 500 pages of
    // it is 10,000 teams.
    const read = (client: typeof this.api) => client.getAll("/v2/teams", "teams", { pageSize: 20 });
    try {
      return await read(this.accountPages);
    } catch (err) {
      // The document lists no `teamId` here but the plugin has always sent one, so a token
      // scoped to the team may only be answered with it.
      if (!this.teamId || !hasStatus(err, 403)) throw err;
      return read(this.api);
    }
  }

  private listRawProjects() {
    return this.projectPages.getAll("/v10/projects", "projects");
  }

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
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
    });
  }

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const externalId = resourceId.split(":").slice(2).join(":");

      if (typeId === "vercel-project") {
        const project = await this.api.get(`/v9/projects/${pathEncode(externalId)}`);
        return this.mapProject(project, accountId);
      }

      if (typeId === "vercel-deployment") {
        const deployment: VercelDeploymentDetail & { uid?: string } = await this.api.get(
          `/v13/deployments/${pathEncode(externalId)}`,
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
        const hook = await this.api.get(`/v1/webhooks/${pathEncode(externalId)}`);
        return this.mapWebhook(hook, accountId);
      }

      // Fallback: list all and find
      const all = await runPluginEffect(this.listResources(typeId, accountId));
      const found = all.find((r) => r.id === resourceId);
      if (!found) throw new Error(`Vercel plugin: resource ${typeId}/${resourceId} not found`);
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
      const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));

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
    });
  }

  fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<DashboardStat[]> {
    return attempt(async () => {
      const resource = await runPluginEffect(
        this.getResource(resourceTypeId, resourceId, accountId),
      );
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
    });
  }

  /**
   * Project traffic from the Web Analytics API
   * (`GET /v1/query/web-analytics/{visits,events}/aggregate`), bucketed by
   * hour for ranges up to three days and by day beyond that. The API filters
   * to production by default and only answers for projects with Web
   * Analytics enabled; a disabled project yields no series rather than an
   * error.
   */
  fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      if (resourceTypeId !== "vercel-project") return [];
      const projectId = resourceId.split(":").slice(2).join(":");
      if (!projectId) return [];

      const endMs = timeRange?.endMs ?? Date.now();
      const startMs = timeRange?.startMs ?? endMs - WEB_ANALYTICS_DEFAULT_RANGE_MS;
      const bucket = endMs - startMs <= 3 * 86_400_000 ? "hour" : "day";
      const query = { projectId, by: [bucket], since: startMs, until: endMs };

      const read = async <Row>(request: () => Promise<{ data: Row[] }>): Promise<Row[]> => {
        try {
          const res = await request();
          return Array.isArray(res.data) ? res.data : [];
        } catch {
          return [];
        }
      };
      const [visits, events] = await Promise.all([
        read(() => this.api.get("/v1/query/web-analytics/visits/aggregate", { query })),
        read(() => this.api.get("/v1/query/web-analytics/events/aggregate", { query })),
      ]);

      const toSeries = <Row extends { timestamp: string }>(
        rows: Row[],
        key: keyof Row,
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
    });
  }

  fetchCostData(_accountId: string, range: CostFetchRange): PluginEffect<CostRow[]> {
    return attempt(async () => {
      return fetchVercelCostData(
        {
          accessToken: this.accessToken,
          teamId: this.teamId,
          caCert: this.caCert,
          http: this.services?.http,
        },
        range,
      );
    });
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
      const state = resource.fields["state"];
      status = deploymentStatus(typeof state === "string" ? state : undefined);
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

  getCreateConfig(typeId: string, parentResourceId?: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
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
                options: (await this.api.getAll("/v5/domains", "domains")).map((d) => ({
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
        const projects = await this.listRawProjects().catch(() => []);
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
    });
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      if (typeId === "vercel-dns-record") {
        const domain =
          fields["domain"] ||
          (parentResourceId ? parentResourceId.split(":").slice(2).join(":") : "");
        if (!domain) throw new Error("Vercel plugin: a domain is required to create a DNS record");
        const type = fields["type"] || "A";
        const ttl = fields["ttl"] ? Number(fields["ttl"]) : undefined;
        const mxPriority = type === "MX" ? Number(fields["mxPriority"] || 10) : undefined;
        const res = await this.api.post(`/v2/domains/${pathEncode(domain)}/records`, {
          body: {
            type,
            name: fields["name"] ?? "",
            value: fields["value"] ?? "",
            ttl,
            mxPriority,
            comment: fields["comment"] || undefined,
          },
        });
        return this.mapDnsRecord(
          {
            id: res.uid,
            name: fields["name"] ?? "",
            type,
            value: fields["value"] ?? "",
            ...(ttl != null ? { ttl } : {}),
            ...(mxPriority !== undefined ? { mxPriority } : {}),
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
        const hook = await this.api.post("/v1/webhooks", {
          body: {
            url: fields["url"] ?? "",
            events,
            ...(projectIds.length > 0 ? { projectIds } : {}),
          },
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
        const project = await this.api.post("/v11/projects", {
          body: {
            name: fields["name"],
            framework: fields["framework"] || undefined,
            buildCommand: fields["buildCommand"] || undefined,
            outputDirectory: fields["outputDirectory"] || undefined,
            rootDirectory: fields["rootDirectory"] || undefined,
            installCommand: fields["installCommand"] || undefined,
            serverlessFunctionRegion: fields["serverlessFunctionRegion"] || undefined,
          },
        });

        return this.mapProject(project, accountId);
      }

      if (typeId === "vercel-domain") {
        const data = await this.api.post("/v7/domains", {
          body: { name: fields["name"], method: "add" },
        });
        const domain = data.domain ?? data;
        const name = String(domain.name ?? fields["name"]);
        const nameservers = Array.isArray(domain.nameservers) ? domain.nameservers.join(", ") : "";
        const intendedNameservers = Array.isArray(domain.intendedNameservers)
          ? domain.intendedNameservers.join(", ")
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
            verified: String(domain.verified ?? false),
            serviceType: String(domain.serviceType ?? ""),
            nameservers,
            intendedNameservers,
            renew: String(domain.renew ?? false),
            expiresAt: String(domain.expiresAt ?? ""),
            boughtAt: String(domain.boughtAt ?? ""),
            createdAt: String(domain.createdAt ?? now),
          },
          resolvedOutputs: { domainName: name, nameservers },
          secretStates: [],
          externalId: name,
          createdAt: String(domain.createdAt ?? now),
          updatedAt: now,
        };
      }

      if (typeId === "vercel-env-var") {
        const projectId = fields["projectId"] ?? "";
        if (!projectId)
          throw new Error("Vercel plugin: a project is required to create a variable");
        const key = fields["key"] ?? "";
        const data: VercelResponse<"createProjectEnv"> & { id?: string } = await this.api.post(
          `/v10/projects/${pathEncode(projectId)}/env`,
          {
            body: {
              key,
              value: fields["value"] ?? "",
              type: fields["type"] ?? "encrypted",
              target: [fields["target"] ?? "production"],
            },
          },
        );
        const envId = envVarId(projectId, createdEnv(data, key)?.id ?? data.id, key);
        const now = new Date().toISOString();
        return {
          id: `${accountId}:vercel-env-var:${projectId}/${envId}`,
          pluginId: "vercel",
          resourceTypeId: "vercel-env-var",
          accountId,
          displayName: key,
          fields: {
            key,
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
        const result = await this.api.post("/v1/teams", { body: { slug, name } });
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
    });
  }

  deleteResource(typeId: string, resourceId: string, _accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const externalId = requireExternalId(resourceId);

      if (typeId === "vercel-project") {
        await this.api.delete(`/v9/projects/${pathEncode(externalId)}`);
        return;
      }

      if (typeId === "vercel-deployment") {
        await this.api.delete(`/v13/deployments/${pathEncode(externalId)}`);
        return;
      }

      if (typeId === "vercel-domain") {
        await this.api.delete(`/v6/domains/${pathEncode(externalId)}`);
        return;
      }

      if (typeId === "vercel-dns-record") {
        const { domain, recordId } = splitRecordId(externalId);
        await this.api.delete(`/v2/domains/${pathEncode(domain)}/records/${pathEncode(recordId)}`);
        return;
      }

      if (typeId === "vercel-webhook") {
        await this.api.delete(`/v1/webhooks/${pathEncode(externalId)}`);
        return;
      }

      if (typeId === "vercel-env-var") {
        const { projectId, envId } = splitEnvId(externalId);
        await this.api.delete(`/v9/projects/${pathEncode(projectId)}/env/${pathEncode(envId)}`);
        return;
      }

      throw new Error(`Vercel plugin: deleteResource not supported for type "${typeId}"`);
    });
  }

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const externalId = requireExternalId(resourceId);

      if (typeId === "vercel-project") {
        // Blank clears an override back to the framework default (`null`).
        const override = (key: string) => (fields[key] === "" ? null : fields[key]);
        const path = `/v9/projects/${pathEncode(externalId)}` as const;
        const body = {
          name: fields["name"],
          framework: override("framework"),
          nodeVersion: override("nodeVersion"),
          serverlessFunctionRegion: override("serverlessFunctionRegion"),
          buildCommand: override("buildCommand"),
          installCommand: override("installCommand"),
          devCommand: override("devCommand"),
          outputDirectory: override("outputDirectory"),
          rootDirectory: override("rootDirectory"),
        };
        const project = await this.api.patch(path, { body }).catch((err: unknown) => {
          // The document allows no null here, though it does elsewhere, and a project always
          // has a version. If Vercel holds to that, the other fields should still go through.
          if (body.nodeVersion !== null || !hasStatus(err, 400)) throw err;
          return this.api.patch(path, { body: { ...body, nodeVersion: undefined } });
        });
        return this.mapProject(project, accountId);
      }

      if (typeId === "vercel-env-var") {
        const { projectId, envId } = splitEnvId(externalId);
        await this.api.patch(`/v9/projects/${pathEncode(projectId)}/env/${pathEncode(envId)}`, {
          body: {
            value: fields["newValue"] || undefined,
            type: fields["type"] || undefined,
            target: fields["target"]
              ?.split(",")
              .map((t) => t.trim())
              .filter(Boolean),
            gitBranch: fields["gitBranch"],
            comment: fields["comment"],
          },
        });
        return runPluginEffect(this.getResource(typeId, resourceId, accountId));
      }

      if (typeId === "vercel-domain") {
        if (fields["renew"] !== undefined) {
          await this.api.patch(`/v1/registrar/domains/${pathEncode(externalId)}/auto-renew`, {
            body: { autoRenew: fields["renew"] === "true" },
          });
        }
        return runPluginEffect(this.getResource(typeId, resourceId, accountId));
      }

      if (typeId === "vercel-dns-record") {
        const { recordId } = splitRecordId(externalId);
        await this.api.patch(`/v1/domains/records/${pathEncode(recordId)}`, {
          body: {
            name: fields["name"],
            value: fields["content"],
            ttl: fields["ttl"] ? Number(fields["ttl"]) : undefined,
            mxPriority: fields["priority"] ? Number(fields["priority"]) : undefined,
            comment: fields["comment"],
          },
        });
        return runPluginEffect(this.getResource(typeId, resourceId, accountId));
      }

      throw new Error(`Vercel plugin: updateResource not supported for type "${typeId}"`);
    });
  }

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      const externalId = requireExternalId(resourceId);

      if (typeId === "vercel-deployment" && DEPLOYMENT_ACTIONS.has(actionId)) {
        const id = pathEncode(externalId);
        if (actionId === "cancel") {
          await this.api.patch(`/v12/deployments/${id}/cancel`);
          return;
        }
        const deployment = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
        const projectId = String(deployment.fields["projectId"] ?? "");
        if (actionId === "redeploy") {
          const target = String(deployment.fields["target"] ?? "");
          await this.api.post("/v13/deployments", {
            body: {
              name: String(deployment.fields["name"] ?? ""),
              deploymentId: externalId,
              ...(projectId ? { project: projectId } : {}),
              ...(target === "production" ? { target: "production" } : {}),
            },
          });
          return;
        }
        if (!projectId) throw new Error("Vercel plugin: deployment has no project");
        const project = pathEncode(projectId);
        if (actionId === "promote") {
          await this.api.post(`/v10/projects/${project}/promote/${id}`);
        } else {
          await this.api.post(`/v1/projects/${project}/rollback/${id}`);
        }
        return;
      }

      if (typeId === "vercel-project" && PROJECT_ACTIONS.has(actionId)) {
        if (actionId === "pause" || actionId === "unpause") {
          await this.api.post(`/v1/projects/${pathEncode(externalId)}/${actionId}`);
          return;
        }
        await this.api.post("/v1/security/attack-mode", {
          body: {
            projectId: externalId,
            attackModeEnabled: actionId === "attack-mode-on",
          },
        });
        return;
      }

      throw new Error(`Vercel plugin: invokeAction "${actionId}" not supported for "${typeId}"`);
    });
  }

  /**
   * Build output for a deployment, from `GET /v3/deployments/{id}/events`.
   * Runtime logs are a long-lived stream (`application/stream+json`) that
   * the polling Logs tab cannot consume, so only the build is shown.
   */
  getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): PluginEffect<LogsFetchResult> {
    return attempt(async () => {
      if (typeId !== "vercel-deployment") return { text: "", containers: [], activeContainer: "" };
      const externalId = resourceId.split(":").slice(2).join(":");
      const limit = Math.min(Math.max(params.tailLines ?? 500, 1), 2000);
      const events = await this.api.get(`/v3/deployments/${pathEncode(externalId)}/events`, {
        query: { builds: 1, direction: "backward", limit },
      });
      const lines = (Array.isArray(events) ? events : [])
        .filter(
          (e): e is VercelDeploymentEvent =>
            e != null &&
            (e.type === "stdout" ||
              e.type === "stderr" ||
              e.type === "command" ||
              e.type === "fatal"),
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
    });
  }

  /** Domains: add the DNS configuration check (`misconfigured`). */
  enrichDetail(resource: ResourceInstance): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      if (resource.resourceTypeId !== "vercel-domain") return resource;
      try {
        const config = await this.api.get(
          `/v6/domains/${pathEncode(resource.externalId ?? "")}/config`,
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
    });
  }

  attachResource(
    sourceTypeId: string,
    sourceResourceId: string,
    targetTypeId: string,
    targetResourceId: string,
    accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      if (sourceTypeId === "vercel-domain" && targetTypeId === "vercel-project") {
        const [domain, project] = await Promise.all([
          runPluginEffect(this.getResource(sourceTypeId, sourceResourceId, accountId)),
          runPluginEffect(this.getResource(targetTypeId, targetResourceId, accountId)),
        ]);
        const domainName = String(domain.fields["name"] ?? domain.externalId ?? "");
        const projectIdOrName = String(project.externalId ?? project.fields["name"] ?? "");
        if (!domainName || !projectIdOrName) {
          throw new Error("Cannot determine Vercel domain or project identity for attachment");
        }
        await this.api.post(`/v10/projects/${pathEncode(projectIdOrName)}/domains`, {
          body: { name: domainName },
        });
        return;
      }

      if (sourceTypeId === "vercel-deployment" && targetTypeId === "vercel-project") {
        const [deployment, project] = await Promise.all([
          runPluginEffect(this.getResource(sourceTypeId, sourceResourceId, accountId)),
          runPluginEffect(this.getResource(targetTypeId, targetResourceId, accountId)),
        ]);
        const deploymentUrl = String(deployment.fields["url"] ?? "");
        const projectIdOrName = String(project.externalId ?? project.fields["name"] ?? "");
        if (!deploymentUrl || !projectIdOrName) {
          throw new Error(
            "Cannot determine Vercel deployment URL or project identity for env import",
          );
        }
        await this.api.post(`/v10/projects/${pathEncode(projectIdOrName)}/env`, {
          body: {
            key: "VERCEL_DEPLOYMENT_URL",
            value: deploymentUrl,
            type: "plain",
            target: ["production"],
          },
        });
        return;
      }

      throw new Error(
        `Vercel plugin: attachResource not supported for ${sourceTypeId} → ${targetTypeId}`,
      );
    });
  }

  private async listProjects(accountId: string): Promise<ResourceInstance[]> {
    const projects = await this.listRawProjects();
    return projects.map((p) => this.mapProject(p, accountId));
  }

  private async listDeployments(accountId: string): Promise<ResourceInstance[]> {
    const deployments = await this.api.getAll("/v7/deployments", "deployments", { pageSize: 50 });
    return deployments.map((d) => this.mapDeployment(d, accountId));
  }

  private async listDomains(accountId: string): Promise<ResourceInstance[]> {
    const domains = await this.api.getAll("/v5/domains", "domains");
    return domains.map((d) => this.mapDomain(d, accountId));
  }

  private async listAllEnvVars(accountId: string): Promise<ResourceInstance[]> {
    // Env vars are per-project; list projects first, then fetch envs for each
    const projects = await this.listRawProjects();
    const results: ResourceInstance[] = [];

    for (const project of projects) {
      try {
        const envs = await this.envPages.getAll(
          `/v10/projects/${pathEncode(project.id)}/env`,
          "envs",
        );
        for (const env of envs) {
          results.push(this.mapEnvVar(env, project, accountId));
        }
      } catch (err) {
        // No read permission, or the project went since the list. Anything else is not "no
        // variables": a sync would delete them all.
        if (!hasStatus(err, 403, 404)) throw err;
      }
    }

    return results;
  }

  private async listDnsRecordsForDomain(
    domain: string,
    accountId: string,
  ): Promise<ResourceInstance[]> {
    const records = await this.api.getAll(`/v5/domains/${pathEncode(domain)}/records`, "records");
    return records.map((r) => this.mapDnsRecord(r, domain, accountId));
  }

  private async listAllDnsRecords(accountId: string): Promise<ResourceInstance[]> {
    // Only domains on Vercel's nameservers have records here; the rest answer with a 4xx,
    // which just means "no records to show". A 5xx or a 429 does not, and a sync reading it
    // that way would delete the domain's records.
    const domains = await this.api.getAll("/v5/domains", "domains");
    const batches = await Promise.all(
      domains.map((d) =>
        this.listDnsRecordsForDomain(d.name, accountId).catch((err: unknown) => {
          if (!hasStatus(err, 400, 403, 404)) throw err;
          return [];
        }),
      ),
    );
    return batches.flat();
  }

  private async listWebhooks(accountId: string): Promise<ResourceInstance[]> {
    const hooks = requireListPage(webhooksIn(await this.api.get("/v1/webhooks")), {
      vendor: "Vercel",
      path: "/v1/webhooks",
      key: null,
    });
    return hooks.map((h) => this.mapWebhook(h, accountId));
  }

  private mapDnsRecord(r: DnsRecordFields, domain: string, accountId: string): ResourceInstance {
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
      const teams = await this.listRawTeams();
      return teams.map((t) => this.mapTeam(t, accountId));
    } catch (err) {
      // A token with no team access has none to show. Any other failure is not "no teams":
      // a sync would delete them all.
      if (hasStatus(err, 403)) return [];
      throw err;
    }
  }

  private mapProject(p: VercelProject, accountId: string): ResourceInstance {
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
        // The single-project route documents only the regions under `resourceConfig`.
        serverlessFunctionRegion:
          p.serverlessFunctionRegion ?? p.resourceConfig?.functionDefaultRegions?.[0],
        rootDirectory: p.rootDirectory,
        buildCommand: p.buildCommand,
        outputDirectory: p.outputDirectory,
        productionUrl: productionUrl,
        gitRepo: gitRepoOf(p.link),
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

  private mapDeployment(d: DeploymentFields, accountId: string): ResourceInstance {
    const meta = d.meta ?? {};
    const state = d.readyState ?? d.state ?? "UNKNOWN";
    // The single-deployment route documents only `createdAt`.
    const created = d.created ?? d.createdAt;

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
        createdAt: formatTimestamp(created),
        readyAt: formatTimestamp(d.ready),
        framework: d.projectSettings?.framework,
        errorMessage: d.errorMessage || null,
        rollbackCandidate: d.isRollbackCandidate ?? null,
      }),
      resolvedOutputs: {},
      secretStates: [],
      externalId: d.uid,
      createdAt: formatTimestamp(created),
      updatedAt: formatTimestamp(d.ready ?? created),
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
    const envId = envVarId(project.id, env.id, env.key);
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
      // The document lets `name` be null; every team has a slug.
      displayName: t.name ?? t.slug,
      fields: fields({
        name: t.name,
        slug: t.slug,
        createdAt: formatTimestamp(t.createdAt),
        updatedAt: formatTimestamp(t.updatedAt),
      }),
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

/** The document says a bare array; `{ webhooks }` is an older shape the plugin still reads. */
function webhooksIn(data: VercelWebhook[] | { webhooks?: VercelWebhook[] }) {
  return Array.isArray(data) ? data : data.webhooks;
}

/** The id a write acts on. A blank one would address the collection, not a resource. */
function requireExternalId(resourceId: string): string {
  const externalId = resourceId.split(":").slice(2).join(":");
  if (!externalId) throw new Error(`Vercel plugin: resource id "${resourceId}" names no resource`);
  return externalId;
}

/** `{domain}/{recordId}`: the DNS record's external id. */
function splitRecordId(externalId: string): { domain: string; recordId: string } {
  const slash = externalId.lastIndexOf("/");
  if (slash <= 0) throw new Error(`Vercel plugin: cannot parse DNS record id "${externalId}"`);
  return { domain: externalId.slice(0, slash), recordId: externalId.slice(slash + 1) };
}

/**
 * The document makes `id` optional. With none, the row still needs an id that a sync
 * and a create agree on, and the `/` in this one is what {@link splitEnvId} refuses.
 */
function envVarId(projectId: string, id: string | undefined, key: string): string {
  return id ?? `${projectId}/${key}`;
}

/** `{projectId}/{envId}`: the env var resource id's compound part. */
function splitEnvId(compound: string): { projectId: string; envId: string } {
  const slash = compound.indexOf("/");
  const projectId = slash === -1 ? "" : compound.slice(0, slash);
  const envId = slash === -1 ? "" : compound.slice(slash + 1);
  if (!projectId || !envId) throw new Error("Invalid env var resource ID");
  // The routes take an env id, and a key in its place would reach the wrong thing or nothing.
  if (envId.includes("/")) {
    throw new Error("Vercel did not give this variable an id, so it cannot be changed from here");
  }
  return { projectId, envId };
}

/**
 * What `POST .../env` made: `created` is one variable or an array. It answers 201 with
 * an empty `created` and the reason in `failed`, which would otherwise read as success.
 */
function createdEnv(data: VercelResponse<"createProjectEnv">, key: string) {
  const created = data.created ?? [];
  const rows = Array.isArray(created) ? created : [created];
  const refused = data.failed?.[0]?.error;
  if (rows.length === 0 && refused) {
    throw new Error(`Vercel refused the variable: ${refused.message}`);
  }
  return rows.find((row) => row.key === key) ?? rows[0];
}

/** A `policy-picker` value: a JSON array of ids (tolerates a comma list). */
function parseJsonIds(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    /* fall through to comma-separated */
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
