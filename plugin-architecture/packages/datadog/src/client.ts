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
  MetricSeries,
  PluginClient,
  PreflightResult,
  ResourceInstance,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import type { DatadogContext } from "./api.js";
import { ddFetch, ddPaged, statusOf } from "./api.js";
import { fetchCostAttribution } from "./attribution.js";
import {
  listDatadogMetricSourceOptions,
  runDatadogMetricSource,
} from "./business-metric-source.js";
import { fetchDatadogCostData, fetchDatadogCostSummary } from "./cost-data.js";
import type {
  DdApiKey,
  DdApplicationKey,
  DdDashboardSummary,
  DdDowntime,
  DdHost,
  DdMonitor,
  DdOrg,
  DdSlo,
  DdSyntheticsTest,
  DdUser,
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
import {
  ATTRIBUTION_KEY,
  COST_SUMMARY_KEY,
  renderDatadogDetail,
  renderDatadogSidebar,
} from "./render.js";
import type { DatadogSite } from "./sites.js";
import { resolveSite } from "./sites.js";

const MONITOR_PAGE = 1000;
const MAX_MONITOR_PAGES = 20;
const HOST_PAGE = 1000;
const MAX_HOST_PAGES = 20;
const DASHBOARD_PAGE = 100;
const MAX_DASHBOARD_PAGES = 50;
const SLO_PAGE = 1000;
const MAX_SLO_PAGES = 20;
const SYNTHETICS_PAGE = 100;
const MAX_SYNTHETICS_PAGES = 50;

const MONITOR_ACTIONS = new Set(["mute", "mute-1h", "mute-1d", "unmute"]);

export class DatadogClient implements PluginClient {
  private readonly ctx: DatadogContext;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    const appKey = (credentials["appKey"] ?? "").trim();
    if (!apiKey) throw new Error("Datadog plugin: missing apiKey credential");
    if (!appKey) throw new Error("Datadog plugin: missing appKey credential");
    const caCert = credentials["caCert"] ?? "";
    this.ctx = {
      apiKey,
      appKey,
      site: resolveSite(credentials["site"]),
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
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

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
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
        return this.scoped(async () => (await this.fetchHosts()).map((h) => mapHost(accountId, h)));
      case "user":
        return this.scoped(() => this.listUsers(accountId));
      case "api-key":
        return this.scoped(async () => {
          const { data, included } = await ddPaged<DdApiKey>(this.ctx, "/api/v2/api_keys", {
            include: "created_by",
          });
          const users = includedUsers(included);
          return data.map((k) => mapApiKey(accountId, k, users));
        });
      case "application-key":
        return this.scoped(async () => {
          const { data, included } = await ddPaged<DdApplicationKey>(
            this.ctx,
            "/api/v2/application_keys",
            { include: "owned_by" },
          );
          const users = includedUsers(included);
          return data.map((k) => mapApplicationKey(accountId, k, users));
        });
      default:
        throw new Error(`Datadog plugin: unknown resource type "${typeId}"`);
    }
  }

  private async fetchMonitors(): Promise<DdMonitor[]> {
    const out: DdMonitor[] = [];
    for (let page = 0; page < MAX_MONITOR_PAGES; page++) {
      const batch = await ddFetch<DdMonitor[]>(this.ctx, "/api/v1/monitor", {
        query: { page, page_size: MONITOR_PAGE, with_downtimes: true },
      });
      out.push(...(batch ?? []));
      if (!batch || batch.length < MONITOR_PAGE) break;
    }
    return out;
  }

  private async listDowntimes(accountId: string): Promise<ResourceInstance[]> {
    const res = await ddFetch<{ data?: DdDowntime[]; included?: unknown[] }>(
      this.ctx,
      "/api/v2/downtime",
      { query: { current_only: true, include: "monitor" } },
    );
    const names = new Map<string, string>();
    for (const inc of (res.included ?? []) as Array<{
      type?: string;
      id?: string | number;
      attributes?: { name?: string };
    }>) {
      if (inc.type === "monitors" && inc.id !== undefined && inc.attributes?.name) {
        names.set(String(inc.id), inc.attributes.name);
      }
    }
    return (res.data ?? []).map((d) => mapDowntime(accountId, d, names));
  }

  private async fetchDashboards(): Promise<DdDashboardSummary[]> {
    const out: DdDashboardSummary[] = [];
    for (let page = 0; page < MAX_DASHBOARD_PAGES; page++) {
      const res = await ddFetch<{ dashboards?: DdDashboardSummary[] }>(
        this.ctx,
        "/api/v1/dashboard",
        { query: { count: DASHBOARD_PAGE, start: page * DASHBOARD_PAGE } },
      );
      const batch = res.dashboards ?? [];
      out.push(...batch);
      if (batch.length < DASHBOARD_PAGE) break;
    }
    return out;
  }

  private async fetchSlos(): Promise<DdSlo[]> {
    const out: DdSlo[] = [];
    for (let page = 0; page < MAX_SLO_PAGES; page++) {
      const res = await ddFetch<{ data?: DdSlo[] }>(this.ctx, "/api/v1/slo", {
        query: { limit: SLO_PAGE, offset: page * SLO_PAGE },
      });
      const batch = res.data ?? [];
      out.push(...batch);
      if (batch.length < SLO_PAGE) break;
    }
    return out;
  }

  private async fetchSyntheticsTests(): Promise<DdSyntheticsTest[]> {
    const out: DdSyntheticsTest[] = [];
    for (let page = 0; page < MAX_SYNTHETICS_PAGES; page++) {
      const res = await ddFetch<{ tests?: DdSyntheticsTest[] }>(
        this.ctx,
        "/api/v1/synthetics/tests",
        { query: { page_size: SYNTHETICS_PAGE, page_number: page } },
      );
      const batch = res.tests ?? [];
      out.push(...batch);
      if (batch.length < SYNTHETICS_PAGE) break;
    }
    return out;
  }

  private async fetchHosts(filter?: string): Promise<DdHost[]> {
    const out: DdHost[] = [];
    for (let page = 0; page < MAX_HOST_PAGES; page++) {
      const res = await ddFetch<{ host_list?: DdHost[] }>(this.ctx, "/api/v1/hosts", {
        query: {
          count: HOST_PAGE,
          start: page * HOST_PAGE,
          include_muted_hosts_data: true,
          include_hosts_metadata: true,
          ...(filter ? { filter } : {}),
        },
      });
      const batch = res.host_list ?? [];
      out.push(...batch);
      if (batch.length < HOST_PAGE) break;
    }
    return out;
  }

  private async listUsers(accountId: string): Promise<ResourceInstance[]> {
    const { data, included } = await ddPaged<DdUser>(this.ctx, "/api/v2/users", {
      include: "roles",
    });
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
      ddFetch<{ orgs?: DdOrg[] }>(this.ctx, "/api/v1/org")
        .then((r) => r.orgs ?? [])
        .catch(() => [] as DdOrg[]),
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

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    switch (typeId) {
      case "monitor": {
        const m = await ddFetch<DdMonitor>(this.ctx, `/api/v1/monitor/${encodeURIComponent(id)}`, {
          query: { with_downtimes: true },
        });
        return mapMonitor(accountId, this.site, m);
      }
      case "slo": {
        const res = await ddFetch<{ data?: DdSlo }>(
          this.ctx,
          `/api/v1/slo/${encodeURIComponent(id)}`,
        );
        if (res.data) return mapSlo(accountId, this.site, res.data);
        break;
      }
      case "synthetics-test": {
        const t = await ddFetch<DdSyntheticsTest>(
          this.ctx,
          `/api/v1/synthetics/tests/${encodeURIComponent(id)}`,
        );
        return mapSyntheticsTest(accountId, this.site, t);
      }
      case "downtime": {
        const res = await ddFetch<{ data?: DdDowntime; included?: unknown[] }>(
          this.ctx,
          `/api/v2/downtime/${encodeURIComponent(id)}`,
          { query: { include: "monitor" } },
        );
        if (res.data) {
          const names = new Map<string, string>();
          for (const inc of (res.included ?? []) as Array<{
            type?: string;
            id?: string | number;
            attributes?: { name?: string };
          }>) {
            if (inc.type === "monitors" && inc.id !== undefined && inc.attributes?.name) {
              names.set(String(inc.id), inc.attributes.name);
            }
          }
          return mapDowntime(accountId, res.data, names);
        }
        break;
      }
      case "user": {
        const res = await ddFetch<{ data?: DdUser; included?: unknown[] }>(
          this.ctx,
          `/api/v2/users/${encodeURIComponent(id)}`,
        );
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
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId || r.externalId === id);
    if (!found) throw new Error(`Datadog plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const resource = await this.getResource(typeId, resourceId, accountId);
    const resolved = resource.resolvedOutputs[outputKey];
    if (resolved !== undefined) return resolved;
    const field = resource.fields[outputKey];
    if (field !== undefined) return String(field);
    throw new Error(`Datadog plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Stats, metrics and costs
  // -------------------------------------------------------------------------

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const r = await this.getResource(resourceTypeId, resourceId, accountId);
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
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const id = externalIdOf(resourceId);
    switch (resourceTypeId) {
      case "organization": {
        const range = rangeOrDefault(timeRange, USAGE_METRICS_WINDOW_MS);
        const org = await this.getResource("organization", resourceId, accountId).catch(
          () => undefined,
        );
        return usageSeries(this.ctx, String(org?.fields["publicId"] ?? ""), range);
      }
      case "host":
        return hostSeries(this.ctx, id, rangeOrDefault(timeRange, DEFAULT_METRICS_WINDOW_MS));
      case "monitor": {
        const m = await this.getResource("monitor", resourceId, accountId);
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
        const t = await this.getResource("synthetics-test", resourceId, accountId);
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
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchDatadogCostData(this.ctx, range);
  }

  async verifyCredentials(): Promise<PreflightResult> {
    return verifyDatadogCredentials(this.ctx);
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId !== "downtime") {
      throw new Error(`Datadog plugin: cannot create "${typeId}" from Infrawrench`);
    }
    const monitors = await this.fetchMonitors().catch(() => [] as DdMonitor[]);
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
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId !== "downtime") {
      throw new Error(`Datadog plugin: cannot create "${typeId}" from Infrawrench`);
    }
    const monitorId = (fields["monitorId"] ?? "").trim();
    const start = (fields["start"] ?? "").trim();
    const end = (fields["end"] ?? "").trim();
    const res = await ddFetch<{ data?: DdDowntime; included?: unknown[] }>(
      this.ctx,
      "/api/v2/downtime",
      {
        method: "POST",
        body: JSON.stringify({
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
        }),
      },
    );
    if (!res.data) throw new Error("Datadog plugin: downtime create returned no data");
    const names = new Map<string, string>();
    if (monitorId) {
      const m = await ddFetch<DdMonitor>(
        this.ctx,
        `/api/v1/monitor/${encodeURIComponent(monitorId)}`,
      ).catch(() => undefined);
      if (m?.name) names.set(monitorId, m.name);
    }
    return mapDowntime(accountId, res.data, names);
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    if (typeId === "monitor") {
      const body: Record<string, unknown> = {};
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
      const m = await ddFetch<DdMonitor>(this.ctx, `/api/v1/monitor/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      return mapMonitor(accountId, this.site, m);
    }
    if (typeId === "downtime") {
      const attributes: Record<string, unknown> = {};
      if ("scope" in fields) attributes["scope"] = (fields["scope"] ?? "").trim() || "*";
      if ("message" in fields) attributes["message"] = fields["message"] ?? "";
      await ddFetch<unknown>(this.ctx, `/api/v2/downtime/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ data: { id, type: "downtime", attributes } }),
      });
      return this.getResource("downtime", resourceId, accountId);
    }
    throw new Error(`Datadog plugin: "${typeId}" cannot be edited from Infrawrench`);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const id = encodeURIComponent(externalIdOf(resourceId));
    switch (typeId) {
      case "monitor":
        await ddFetch<unknown>(this.ctx, `/api/v1/monitor/${id}`, { method: "DELETE" });
        return;
      case "downtime":
        // Datadog keeps canceled downtimes for reference; DELETE cancels.
        await ddFetch<unknown>(this.ctx, `/api/v2/downtime/${id}`, { method: "DELETE" });
        return;
      case "dashboard":
        await ddFetch<unknown>(this.ctx, `/api/v1/dashboard/${id}`, { method: "DELETE" });
        return;
      case "slo":
        await ddFetch<unknown>(this.ctx, `/api/v1/slo/${id}`, { method: "DELETE" });
        return;
      case "synthetics-test":
        await ddFetch<unknown>(this.ctx, "/api/v1/synthetics/tests/delete", {
          method: "POST",
          body: JSON.stringify({ public_ids: [externalIdOf(resourceId)] }),
        });
        return;
      case "api-key":
        await ddFetch<unknown>(this.ctx, `/api/v2/api_keys/${id}`, { method: "DELETE" });
        return;
      case "application-key":
        await ddFetch<unknown>(this.ctx, `/api/v2/application_keys/${id}`, { method: "DELETE" });
        return;
      default:
        throw new Error(`Datadog plugin: "${typeId}" cannot be deleted from Infrawrench`);
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
    const id = externalIdOf(resourceId);
    if (typeId === "monitor" && MONITOR_ACTIONS.has(actionId)) {
      if (actionId === "unmute") return this.unmuteMonitor(id);
      const hours = actionId === "mute-1h" ? 1 : actionId === "mute-1d" ? 24 : 0;
      await ddFetch<unknown>(this.ctx, "/api/v2/downtime", {
        method: "POST",
        body: JSON.stringify({
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
        }),
      });
      return;
    }
    if (typeId === "synthetics-test") {
      if (actionId === "pause" || actionId === "resume") {
        await ddFetch<unknown>(
          this.ctx,
          `/api/v1/synthetics/tests/${encodeURIComponent(id)}/status`,
          {
            method: "PUT",
            body: JSON.stringify({ new_status: actionId === "pause" ? "paused" : "live" }),
          },
        );
        return;
      }
      if (actionId === "run") {
        await ddFetch<unknown>(this.ctx, "/api/v1/synthetics/tests/trigger", {
          method: "POST",
          body: JSON.stringify({ tests: [{ public_id: id }] }),
        });
        return;
      }
    }
    if (typeId === "host" && (actionId === "mute" || actionId === "unmute")) {
      await ddFetch<unknown>(this.ctx, `/api/v1/host/${encodeURIComponent(id)}/${actionId}`, {
        method: "POST",
        body: actionId === "mute" ? JSON.stringify({ message: "Muted from Infrawrench." }) : "{}",
      });
      return;
    }
    if (typeId === "user" && actionId === "disable") {
      // DELETE /api/v2/users/{id} disables the user; Datadog keeps the record.
      await ddFetch<unknown>(this.ctx, `/api/v2/users/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      return;
    }
    throw new Error(`Datadog plugin: unknown action "${actionId}" for "${typeId}"`);
  }

  /** Cancel every current downtime that targets this monitor by id. */
  private async unmuteMonitor(monitorId: string): Promise<void> {
    const res = await ddFetch<{ data?: DdDowntime[] }>(this.ctx, "/api/v2/downtime", {
      query: { current_only: true },
    });
    const targets = (res.data ?? []).filter(
      (d) => String(d.attributes?.monitor_identifier?.monitor_id ?? "") === monitorId,
    );
    if (targets.length === 0) {
      throw new Error(
        "This monitor is not muted by a downtime Infrawrench can cancel. It may be silenced by a downtime on its tags; cancel that downtime instead.",
      );
    }
    for (const d of targets) {
      if (!d.id) continue;
      await ddFetch<unknown>(this.ctx, `/api/v2/downtime/${encodeURIComponent(d.id)}`, {
        method: "DELETE",
      });
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

  async listBusinessMetricSourceOptions(
    _accountId: string,
    fieldKey: string,
    params: Record<string, string>,
  ): Promise<BusinessMetricSourceOption[]> {
    return listDatadogMetricSourceOptions(this.ctx, fieldKey, params);
  }

  async runBusinessMetricSource(
    _accountId: string,
    params: Record<string, string>,
    range: BusinessMetricSourceRange,
  ): Promise<BusinessMetricSourceResult> {
    return runDatadogMetricSource(this.ctx, params, range);
  }
}
