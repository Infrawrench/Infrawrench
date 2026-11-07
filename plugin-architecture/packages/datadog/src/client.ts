import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
import type {
  BusinessMetricSourceOption,
  BusinessMetricSourceRange,
  BusinessMetricSourceResult,
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  IdleFindingRecord,
  IdleScanRequest,
  MetricSeries,
  PluginClient,
  PreflightResult,
  ResourceInstance,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { externalIdOf, pathEncode } from "@infrawrench/plugin-base";
import type { DatadogContext } from "./api.js";
import { createDatadogContext, ddPaged, readJsonApiPages, readPages, statusOf } from "./api.js";
import { fetchCostAttribution } from "./attribution.js";
import {
  listDatadogMetricSourceOptions,
  runDatadogMetricSource,
} from "./business-metric-source.js";
import { fetchDatadogCostData, fetchDatadogCostSummary } from "./cost-data.js";
import type {
  DdDashboardSummary,
  DdDowntimeUpdate,
  DdHost,
  DdMonitor,
  DdMonitorUpdate,
  DdOrg,
  DdSloListItem,
  DdSyntheticsTest,
  OrgRow,
} from "./mappers.js";
import {
  includedRoles,
  includedUsers,
  mapApiKey,
  mapApplicationKey,
  mapDashboard,
  mapDowntime,
  mapHost,
  mapMonitor,
  mapOrganization,
  mapSlo,
  mapSyntheticsTest,
  mapUser,
} from "./mappers.js";
import {
  DEFAULT_METRICS_WINDOW_MS,
  USAGE_METRICS_WINDOW_MS,
  hostSeries,
  monitorSeries,
  rangeOrDefault,
  sloSeries,
  syntheticsSeries,
  usageSeries,
} from "./metrics.js";
import { verifyDatadogCredentials } from "./preflight.js";
import { datadogMetricListFetch, fetchDatadogIdleFindings } from "./idle-findings.js";
import {
  ATTRIBUTION_KEY,
  COST_SUMMARY_KEY,
  renderDatadogDetail,
  renderDatadogSidebar,
} from "./render.js";
import type { DatadogSite } from "./sites.js";
import { resolveSite } from "./sites.js";

const MONITOR_PAGE = 1000;
const MAX_MONITOR_PAGES = 50;
const HOST_PAGE = 1000;
const MAX_HOST_PAGES = 50;
const DASHBOARD_PAGE = 100;
const MAX_DASHBOARD_PAGES = 500;
const SLO_PAGE = 1000;
const MAX_SLO_PAGES = 50;
const SYNTHETICS_PAGE = 100;
const MAX_SYNTHETICS_PAGES = 500;
// The document's default; it states no maximum.
const DOWNTIME_PAGE = 30;
const MAX_DOWNTIME_PAGES = 334;

const MONITOR_ACTIONS = new Set(["mute", "mute-1h", "mute-1d", "unmute"]);

export class DatadogClient implements PluginClient {
  private readonly ctx: DatadogContext;

  constructor(credentials: Credentials, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    const appKey = (credentials["appKey"] ?? "").trim();
    if (!apiKey) throw new Error("Datadog plugin: missing apiKey credential");
    if (!appKey) throw new Error("Datadog plugin: missing appKey credential");
    const caCert = credentials["caCert"] ?? "";
    this.ctx = createDatadogContext({
      apiKey,
      appKey,
      site: resolveSite(credentials["site"]),
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    });
  }

  get site(): DatadogSite {
    return this.ctx.site;
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  /**
   * A 403 on one list means the application key lacks that one scope; the
   * rest of the account still works, so that type lists empty rather than
   * failing the sync. A 401 (wrong keys) still throws.
   */
  private async scoped(load: () => Promise<ResourceInstance[]>): Promise<ResourceInstance[]> {
    try {
      return await load();
    } catch (err) {
      if (statusOf(err) === 403) return [];
      throw err;
    }
  }

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      switch (typeId) {
        case "organization":
          return this.listOrganizations(accountId);
        case "monitor":
          return this.scoped(async () =>
            (await this.fetchMonitors()).map((m) => mapMonitor(accountId, this.site, m)),
          );
        case "downtime":
          return this.scoped(() => this.listDowntimes(accountId));
        case "dashboard":
          return this.scoped(async () =>
            (await this.fetchDashboards()).map((d) => mapDashboard(accountId, this.site, d)),
          );
        case "slo":
          return this.scoped(async () =>
            (await this.fetchSlos()).map((s) => mapSlo(accountId, this.site, s)),
          );
        case "synthetics-test":
          return this.scoped(async () =>
            (await this.fetchSyntheticsTests()).map((t) =>
              mapSyntheticsTest(accountId, this.site, t),
            ),
          );
        case "host":
          return this.scoped(async () =>
            (await this.fetchHosts()).map((h) => mapHost(accountId, h)),
          );
        case "user":
          return this.scoped(() => this.listUsers(accountId));
        case "api-key":
          return this.scoped(async () => {
            const { data, included } = await ddPaged("/api/v2/api_keys", (page) =>
              this.ctx.v2.get("/api/v2/api_keys", {
                query: { include: "created_by", ...page },
              }),
            );
            const users = includedUsers(included);
            return data.map((k) => mapApiKey(accountId, k, users));
          });
        case "application-key":
          return this.scoped(async () => {
            const { data, included } = await ddPaged("/api/v2/application_keys", (page) =>
              this.ctx.v2.get("/api/v2/application_keys", {
                query: { include: "owned_by", ...page },
              }),
            );
            const users = includedUsers(included);
            return data.map((k) => mapApplicationKey(accountId, k, users));
          });
        default:
          throw new Error(`Datadog plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  private fetchMonitors(options: { partial?: boolean } = {}): Promise<DdMonitor[]> {
    return readPages(
      {
        path: "/api/v1/monitor",
        key: null,
        pageSize: MONITOR_PAGE,
        maxPages: MAX_MONITOR_PAGES,
        ...options,
      },
      (page) =>
        this.ctx.v1.get("/api/v1/monitor", {
          query: { page, page_size: MONITOR_PAGE, with_downtimes: true },
        }),
    );
  }

  private fetchCurrentDowntimes(query: { include?: string } = {}) {
    return readJsonApiPages(
      { path: "/api/v2/downtime", pageSize: DOWNTIME_PAGE, maxPages: MAX_DOWNTIME_PAGES },
      (page) =>
        this.ctx.v2.get("/api/v2/downtime", {
          query: {
            current_only: true,
            ...query,
            "page[limit]": DOWNTIME_PAGE,
            "page[offset]": page * DOWNTIME_PAGE,
          },
        }),
    );
  }

  private async listDowntimes(accountId: string): Promise<ResourceInstance[]> {
    const { data, included } = await this.fetchCurrentDowntimes({ include: "monitor" });
    const names = new Map<string, string>();
    for (const inc of included) {
      if (inc.type === "monitors" && inc.id !== undefined && inc.attributes?.name) {
        names.set(String(inc.id), inc.attributes.name);
      }
    }
    return data.map((d) => mapDowntime(accountId, d, names));
  }

  private fetchDashboards(): Promise<DdDashboardSummary[]> {
    return readPages(
      {
        path: "/api/v1/dashboard",
        key: "dashboards",
        pageSize: DASHBOARD_PAGE,
        maxPages: MAX_DASHBOARD_PAGES,
      },
      async (page) =>
        (
          await this.ctx.v1.get("/api/v1/dashboard", {
            query: { count: DASHBOARD_PAGE, start: page * DASHBOARD_PAGE },
          })
        ).dashboards,
    );
  }

  private fetchSlos(): Promise<DdSloListItem[]> {
    return readPages(
      { path: "/api/v1/slo", key: "data", pageSize: SLO_PAGE, maxPages: MAX_SLO_PAGES },
      async (page) =>
        (
          await this.ctx.v1.get("/api/v1/slo", {
            query: { limit: SLO_PAGE, offset: page * SLO_PAGE },
          })
        ).data,
    );
  }

  private fetchSyntheticsTests(): Promise<DdSyntheticsTest[]> {
    return readPages(
      {
        path: "/api/v1/synthetics/tests",
        key: "tests",
        pageSize: SYNTHETICS_PAGE,
        maxPages: MAX_SYNTHETICS_PAGES,
      },
      async (page) =>
        (
          await this.ctx.v1.get("/api/v1/synthetics/tests", {
            query: { page_size: SYNTHETICS_PAGE, page_number: page },
          })
        ).tests,
    );
  }

  private fetchHosts(filter?: string): Promise<DdHost[]> {
    return readPages(
      { path: "/api/v1/hosts", key: "host_list", pageSize: HOST_PAGE, maxPages: MAX_HOST_PAGES },
      async (page) =>
        (
          await this.ctx.v1.get("/api/v1/hosts", {
            query: {
              count: HOST_PAGE,
              start: page * HOST_PAGE,
              include_muted_hosts_data: true,
              include_hosts_metadata: true,
              ...(filter ? { filter } : {}),
            },
          })
        ).host_list,
    );
  }

  private async listUsers(accountId: string): Promise<ResourceInstance[]> {
    const { data, included } = await ddPaged("/api/v2/users", (page) =>
      this.ctx.v2.get("/api/v2/users", { query: { include: "roles", ...page } }),
    );
    const roles = includedRoles(included);
    return data.map((u) => mapUser(accountId, u, roles));
  }

  /**
   * One row per organization the cost endpoints report (the parent and every
   * child on a multi-org account), named and dated from `GET /api/v1/org`
   * where the key may read it. Without billing access the org list alone is
   * used; with neither, the API key's own organization still appears so the
   * account is never empty.
   */
  private async listOrganizations(accountId: string): Promise<ResourceInstance[]> {
    const [summary, orgs] = await Promise.all([
      fetchDatadogCostSummary(this.ctx).catch(() => []),
      this.ctx.v1
        .get("/api/v1/org")
        .then((r) => r.orgs ?? [])
        .catch((): DdOrg[] => []),
    ]);
    const rows = new Map<string, OrgRow>();
    for (const o of orgs) {
      const id = o.public_id ?? o.name ?? "";
      if (!id) continue;
      rows.set(id, {
        publicId: o.public_id ?? "",
        name: o.name ?? id,
        ...(o.subscription?.type ? { plan: o.subscription.type } : {}),
        ...(o.created ? { createdAt: o.created } : {}),
      });
    }
    for (const s of summary) {
      const id = s.publicId || s.orgName;
      if (!id) continue;
      const existing = rows.get(id);
      rows.set(id, {
        ...(existing ?? { publicId: s.publicId, name: s.orgName || id }),
        ...(s.region ? { region: s.region } : {}),
        ...(s.monthToDate !== undefined ? { monthToDate: s.monthToDate } : {}),
        ...(s.projected !== undefined ? { projected: s.projected } : {}),
      });
    }
    if (rows.size === 0) {
      // Nothing readable beyond the key itself: one row for "this org".
      rows.set("current", { publicId: "", name: `Datadog (${this.site.label})` });
    }
    return [...rows.values()].map((r) => mapOrganization(accountId, r));
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
        case "monitor": {
          const m = await this.ctx.v1.get(`/api/v1/monitor/${pathEncode(id)}`, {
            query: { with_downtimes: true },
          });
          return mapMonitor(accountId, this.site, m);
        }
        case "slo": {
          const res = await this.ctx.v1.get(`/api/v1/slo/${pathEncode(id)}`);
          if (res.data) return mapSlo(accountId, this.site, res.data);
          break;
        }
        case "synthetics-test": {
          const t = await this.ctx.v1.get(`/api/v1/synthetics/tests/${pathEncode(id)}`);
          return mapSyntheticsTest(accountId, this.site, t);
        }
        case "downtime": {
          const res = await this.ctx.v2.get(`/api/v2/downtime/${pathEncode(id)}`, {
            query: { include: "monitor" },
          });
          if (res.data) {
            const names = new Map<string, string>();
            for (const inc of res.included ?? []) {
              if (inc.type === "monitors" && inc.id !== undefined && inc.attributes?.name) {
                names.set(String(inc.id), inc.attributes.name);
              }
            }
            return mapDowntime(accountId, res.data, names);
          }
          break;
        }
        case "user": {
          const res = await this.ctx.v2.get(`/api/v2/users/${pathEncode(id)}`);
          if (res.data) return mapUser(accountId, res.data, includedRoles(res.included ?? []));
          break;
        }
        case "host": {
          const hosts = await this.fetchHosts(`host:${id}`);
          const found = hosts.find((h) => (h.host_name ?? h.name) === id);
          if (found) return mapHost(accountId, found);
          break;
        }
        case "organization": {
          const all = await this.listOrganizations(accountId);
          const found = all.find((r) => r.id === resourceId) ?? all[0];
          if (!found) break;
          const [summary, attribution] = await Promise.all([
            fetchDatadogCostSummary(this.ctx).catch(() => []),
            this.site.government
              ? Promise.resolve(undefined)
              : fetchCostAttribution(this.ctx).catch(() => undefined),
          ]);
          const own = summary.find(
            (s) => (s.publicId || s.orgName) === found.externalId || summary.length === 1,
          );
          const orgAttribution = attribution
            ? {
                ...attribution,
                rows:
                  found.fields["name"] && attribution.rows.some((r) => r.orgName)
                    ? attribution.rows.filter(
                        (r) => !r.orgName || r.orgName === String(found.fields["name"]),
                      )
                    : attribution.rows,
              }
            : undefined;
          return {
            ...found,
            resolvedOutputs: {
              ...found.resolvedOutputs,
              ...(own ? { [COST_SUMMARY_KEY]: JSON.stringify(own) } : {}),
              ...(orgAttribution ? { [ATTRIBUTION_KEY]: JSON.stringify(orgAttribution) } : {}),
            },
          };
        }
        default:
          break;
      }
      const all = await runPluginEffect(this.listResources(typeId, accountId));
      const found = all.find((r) => r.id === resourceId || r.externalId === id);
      if (!found) throw new Error(`Datadog plugin: resource ${typeId}/${resourceId} not found`);
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
      const resolved = resource.resolvedOutputs[outputKey];
      if (resolved !== undefined) return resolved;
      const field = resource.fields[outputKey];
      if (field !== undefined) return String(field);
      throw new Error(`Datadog plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
    });
  }

  // -------------------------------------------------------------------------
  // Stats, metrics and costs
  // -------------------------------------------------------------------------

  fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<DashboardStat[]> {
    return attempt(async () => {
      const r = await runPluginEffect(this.getResource(resourceTypeId, resourceId, accountId));
      const f = r.fields;
      const usd = (v: unknown) =>
        typeof v === "number" ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "—";
      switch (resourceTypeId) {
        case "organization":
          return [
            { label: "Month to Date", value: usd(f["monthToDate"]) },
            { label: "Projected", value: usd(f["projectedCost"]) },
          ];
        case "monitor": {
          const state = String(f["overallState"] ?? "");
          return [
            {
              label: "State",
              value: state || "—",
              variant:
                state === "OK"
                  ? "status-healthy"
                  : state === "Alert"
                    ? "status-error"
                    : state === "Warn"
                      ? "status-degraded"
                      : "default",
            },
            { label: "Muted", value: f["muted"] === true ? "Yes" : "No" },
          ];
        }
        case "host":
          return [
            {
              label: "Status",
              value: f["up"] === false ? "Not reporting" : "Up",
              variant: f["up"] === false ? "status-error" : "status-healthy",
            },
            { label: "CPU", value: f["cpu"] !== undefined ? `${String(f["cpu"])}%` : "—" },
            { label: "Load (15m)", value: String(f["load"] ?? "—") },
          ];
        case "slo":
          return [
            { label: "Target", value: f["target"] !== undefined ? `${String(f["target"])}%` : "—" },
            { label: "Timeframe", value: String(f["timeframe"] ?? "—") },
          ];
        case "synthetics-test":
          return [
            { label: "Status", value: String(f["status"] ?? "—") },
            { label: "Type", value: String(f["type"] ?? "—") },
          ];
        default:
          return [];
      }
    });
  }

  fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      switch (resourceTypeId) {
        case "organization": {
          const range = rangeOrDefault(timeRange, USAGE_METRICS_WINDOW_MS);
          const org = await runPluginEffect(
            this.getResource("organization", resourceId, accountId),
          ).catch(() => undefined);
          return usageSeries(this.ctx, String(org?.fields["publicId"] ?? ""), range);
        }
        case "host":
          return hostSeries(this.ctx, id, rangeOrDefault(timeRange, DEFAULT_METRICS_WINDOW_MS));
        case "monitor": {
          const m = await runPluginEffect(this.getResource("monitor", resourceId, accountId));
          return monitorSeries(
            this.ctx,
            String(m.fields["type"] ?? ""),
            String(m.fields["query"] ?? ""),
            String(m.fields["thresholdsJson"] ?? ""),
            rangeOrDefault(timeRange, DEFAULT_METRICS_WINDOW_MS),
          );
        }
        case "slo":
          return sloSeries(this.ctx, id, rangeOrDefault(timeRange, USAGE_METRICS_WINDOW_MS));
        case "synthetics-test": {
          const t = await runPluginEffect(
            this.getResource("synthetics-test", resourceId, accountId),
          );
          return syntheticsSeries(
            this.ctx,
            id,
            String(t.fields["type"] ?? ""),
            rangeOrDefault(timeRange, DEFAULT_METRICS_WINDOW_MS),
          );
        }
        default:
          return [];
      }
    });
  }

  fetchCostData(_accountId: string, range: CostFetchRange): PluginEffect<CostRow[]> {
    return attempt(async () => {
      return fetchDatadogCostData(this.ctx, range);
    });
  }

  verifyCredentials(): PluginEffect<PreflightResult> {
    return attempt(async () => {
      return verifyDatadogCredentials(this.ctx);
    });
  }

  fetchIdleFindings(
    _accountId: string,
    request: IdleScanRequest,
  ): PluginEffect<IdleFindingRecord[]> {
    return attempt(async () => {
      return fetchDatadogIdleFindings(request, {
        fetchPage: datadogMetricListFetch(this.ctx),
        apiUrl: this.ctx.site.apiUrl,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  getCreateConfig(typeId: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      if (typeId !== "downtime") {
        throw new Error(`Datadog plugin: cannot create "${typeId}" from Infrawrench`);
      }
      const monitors = await this.fetchMonitors({ partial: true }).catch((): DdMonitor[] => []);
      return {
        fields: [
          {
            key: "monitorId",
            label: "Monitor",
            kind: "select",
            required: false,
            description:
              "The monitor to silence. Leave on All monitors to silence every monitor that matches the scope.",
            defaultValue: "",
            options: [
              { id: "", label: "All monitors" },
              ...monitors
                .filter((m) => m.id !== undefined)
                .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))
                .map((m) => ({
                  id: String(m.id),
                  label: m.name ?? String(m.id),
                  ...(m.type ? { description: m.type } : {}),
                })),
            ],
          },
          {
            key: "scope",
            label: "Scope",
            kind: "text",
            required: true,
            defaultValue: "*",
            placeholder: "env:prod",
            description:
              "Which groups to silence: * for all of them, or tags such as env:prod or host:web-1.",
          },
          {
            key: "start",
            label: "Start",
            kind: "datetime",
            required: false,
            description: "Leave empty to start now.",
          },
          {
            key: "end",
            label: "End",
            kind: "datetime",
            required: false,
            description: "Leave empty to keep the downtime until it is canceled.",
          },
          {
            key: "message",
            label: "Message",
            kind: "text",
            required: false,
            multiline: true,
            description: "Included with the notifications the downtime sends, if any.",
          },
        ],
      };
    });
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      if (typeId !== "downtime") {
        throw new Error(`Datadog plugin: cannot create "${typeId}" from Infrawrench`);
      }
      const monitorId = (fields["monitorId"] ?? "").trim();
      const start = (fields["start"] ?? "").trim();
      const end = (fields["end"] ?? "").trim();
      const res = await this.ctx.v2.post("/api/v2/downtime", {
        body: {
          data: {
            type: "downtime",
            attributes: {
              scope: (fields["scope"] ?? "").trim() || "*",
              ...(fields["message"] ? { message: fields["message"] } : {}),
              monitor_identifier: monitorId
                ? { monitor_id: Number(monitorId) }
                : { monitor_tags: ["*"] },
              ...(start || end
                ? { schedule: { ...(start ? { start } : {}), ...(end ? { end } : {}) } }
                : {}),
            },
          },
        },
      });
      if (!res.data) throw new Error("Datadog plugin: downtime create returned no data");
      const names = new Map<string, string>();
      if (monitorId) {
        const m = await this.ctx.v1
          .get(`/api/v1/monitor/${pathEncode(monitorId)}`)
          .catch(() => undefined);
        if (m?.name) names.set(monitorId, m.name);
      }
      return mapDowntime(accountId, res.data, names);
    });
  }

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      if (typeId === "monitor") {
        const body: DdMonitorUpdate = {};
        if ("name" in fields) body["name"] = fields["name"];
        if ("message" in fields) body["message"] = fields["message"];
        if ("priority" in fields) {
          body["priority"] = fields["priority"] ? Number(fields["priority"]) : null;
        }
        if ("tags" in fields) {
          body["tags"] = (fields["tags"] ?? "")
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);
        }
        const m = await this.ctx.v1.put(`/api/v1/monitor/${pathEncode(id)}`, { body });
        return mapMonitor(accountId, this.site, m);
      }
      if (typeId === "downtime") {
        const attributes: DdDowntimeUpdate = {};
        if ("scope" in fields) attributes["scope"] = (fields["scope"] ?? "").trim() || "*";
        if ("message" in fields) attributes["message"] = fields["message"] ?? "";
        await this.ctx.v2.patch(`/api/v2/downtime/${pathEncode(id)}`, {
          body: { data: { id, type: "downtime", attributes } },
        });
        return runPluginEffect(this.getResource("downtime", resourceId, accountId));
      }
      throw new Error(`Datadog plugin: "${typeId}" cannot be edited from Infrawrench`);
    });
  }

  deleteResource(typeId: string, resourceId: string, _accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const id = pathEncode(externalIdOf(resourceId));
      switch (typeId) {
        case "monitor":
          await this.ctx.v1.delete(`/api/v1/monitor/${id}`);
          return;
        case "downtime":
          // Datadog keeps canceled downtimes for reference; DELETE cancels.
          await this.ctx.v2.delete(`/api/v2/downtime/${id}`);
          return;
        case "dashboard":
          await this.ctx.v1.delete(`/api/v1/dashboard/${id}`);
          return;
        case "slo":
          await this.ctx.v1.delete(`/api/v1/slo/${id}`);
          return;
        case "synthetics-test":
          await this.ctx.v1.post("/api/v1/synthetics/tests/delete", {
            body: { public_ids: [externalIdOf(resourceId)] },
          });
          return;
        case "api-key":
          await this.ctx.v2.delete(`/api/v2/api_keys/${id}`);
          return;
        case "application-key":
          await this.ctx.v2.delete(`/api/v2/application_keys/${id}`);
          return;
        default:
          throw new Error(`Datadog plugin: "${typeId}" cannot be deleted from Infrawrench`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      if (typeId === "monitor" && MONITOR_ACTIONS.has(actionId)) {
        if (actionId === "unmute") return this.unmuteMonitor(id);
        const hours = actionId === "mute-1h" ? 1 : actionId === "mute-1d" ? 24 : 0;
        await this.ctx.v2.post("/api/v2/downtime", {
          body: {
            data: {
              type: "downtime",
              attributes: {
                scope: "*",
                monitor_identifier: { monitor_id: Number(id) },
                message: "Muted from Infrawrench.",
                ...(hours > 0
                  ? { schedule: { end: new Date(Date.now() + hours * 3600_000).toISOString() } }
                  : {}),
              },
            },
          },
        });
        return;
      }
      if (typeId === "synthetics-test") {
        if (actionId === "pause" || actionId === "resume") {
          await this.ctx.v1.put(`/api/v1/synthetics/tests/${pathEncode(id)}/status`, {
            body: { new_status: actionId === "pause" ? "paused" : "live" },
          });
          return;
        }
        if (actionId === "run") {
          await this.ctx.v1.post("/api/v1/synthetics/tests/trigger", {
            body: { tests: [{ public_id: id }] },
          });
          return;
        }
      }
      if (typeId === "host" && actionId === "mute") {
        await this.ctx.v1.post(`/api/v1/host/${pathEncode(id)}/mute`, {
          body: { message: "Muted from Infrawrench." },
        });
        return;
      }
      if (typeId === "host" && actionId === "unmute") {
        await this.ctx.v1.post(`/api/v1/host/${pathEncode(id)}/unmute`, { body: {} });
        return;
      }
      if (typeId === "user" && actionId === "disable") {
        // DELETE /api/v2/users/{id} disables the user; Datadog keeps the record.
        await this.ctx.v2.delete(`/api/v2/users/${pathEncode(id)}`);
        return;
      }
      throw new Error(`Datadog plugin: unknown action "${actionId}" for "${typeId}"`);
    });
  }

  /** Cancel every current downtime that targets this monitor by id. */
  private async unmuteMonitor(monitorId: string): Promise<void> {
    const { data } = await this.fetchCurrentDowntimes();
    const targets = data.filter(
      (d) => String(d.attributes?.monitor_identifier?.monitor_id ?? "") === monitorId,
    );
    if (targets.length === 0) {
      throw new Error(
        "This monitor is not muted by a downtime Infrawrench can cancel. It may be silenced by a downtime on its tags; cancel that downtime instead.",
      );
    }
    for (const d of targets) {
      if (!d.id) continue;
      await this.ctx.v2.delete(`/api/v2/downtime/${pathEncode(d.id)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderDatadogDetail(resource, this.site.appUrl);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderDatadogSidebar(resource);
  }

  // -------------------------------------------------------------------------
  // Business metric source (see `business-metric-source.ts`)
  // -------------------------------------------------------------------------

  listBusinessMetricSourceOptions(
    _accountId: string,
    fieldKey: string,
    params: Record<string, string>,
  ): PluginEffect<BusinessMetricSourceOption[]> {
    return attempt(async () => {
      return listDatadogMetricSourceOptions(this.ctx, fieldKey, params);
    });
  }

  runBusinessMetricSource(
    _accountId: string,
    params: Record<string, string>,
    range: BusinessMetricSourceRange,
  ): PluginEffect<BusinessMetricSourceResult> {
    return attempt(async () => {
      return runDatadogMetricSource(this.ctx, params, range);
    });
  }
}
