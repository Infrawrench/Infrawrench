import type {
  CreateResourceConfig,
  CredentialExport,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  PreflightResult,
  QuotaUsage,
  ResourceInstance,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import type { SplunkContext } from "./api.js";
import { appUrl, normalizeRealm, offsetList, sfFetch, statusOf } from "./api.js";
import type {
  SfChart,
  SfDashboard,
  SfDashboardGroup,
  SfDetector,
  SfIncident,
  SfIntegration,
  SfMember,
  SfMutingRule,
  SfOrganization,
  SfRule,
  SfSlo,
  SfTeam,
  SfTest,
  SfToken,
} from "./mappers.js";
import {
  detectLabels,
  instance,
  isoMs,
  mapChart,
  mapDashboard,
  mapDetector,
  mapGroup,
  mapIncident,
  mapIntegration,
  mapMember,
  mapMutingRule,
  mapSlo,
  mapTeam,
  mapTest,
  mapToken,
} from "./mappers.js";
import {
  APP_KEY,
  MUTING_FILTER_HELP,
  RUNS_KEY,
  renderSplunkDetail,
  renderSplunkSidebar,
} from "./render.js";
import { METRICS_WINDOW_MS, rangeOrDefault, runSignalFlow } from "./signalflow.js";
import { verifySplunkCredentials } from "./preflight.js";

const SEVERITIES = ["Critical", "Major", "Minor", "Warning", "Info"];
const SYNTH = "/v2/synthetics";

/** The organization's usage metrics, from "View organization metrics" (2026-10). */
export const ORG_USAGE_PROGRAM = [
  "data('sf.org.numActiveTimeSeries').sum().publish(label='Active MTS')",
  "data('sf.org.limit.activeTimeSeries').max().publish(label='Active MTS limit')",
  "data('sf.org.numDatapointsReceived').sum().publish(label='Data points received')",
  "data('sf.org.numResourcesMonitored', filter=filter('resourceType', 'hosts')).sum().publish(label='Hosts monitored')",
  "data('sf.org.numResourcesMonitored', filter=filter('resourceType', 'containers')).sum().publish(label='Containers monitored')",
  "data('sf.org.numCustomMetrics').sum().publish(label='Custom MTS')",
].join("\n");

/** Used/limit pairs for `fetchQuotas`; both halves are org metrics. */
export const QUOTA_PAIRS: Array<{ id: string; name: string; used: string; limit: string }> = [
  {
    id: "active-mts",
    name: "Active metric time series",
    used: "sf.org.numActiveTimeSeries",
    limit: "sf.org.limit.activeTimeSeries",
  },
  {
    id: "custom-mts",
    name: "Active custom metric time series",
    used: "sf.org.numCustomMetrics",
    limit: "sf.org.limit.customMetricMaxLimit",
  },
  {
    id: "detectors",
    name: "Detectors",
    used: "sf.org.num.detector",
    limit: "sf.org.limit.detector",
  },
];

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const csv = (v: string | undefined): string[] =>
  (v ?? "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

/** `host=web-1, !env=dev` → Splunk muting filters. */
export function parseMutingFilters(
  raw: string,
): Array<{ property: string; propertyValue: string; NOT: boolean }> {
  return csv(raw).map((part) => {
    const not = part.startsWith("!");
    const body = not ? part.slice(1) : part;
    const eq = body.indexOf("=");
    if (eq <= 0) throw new Error(`Filter "${part}" must be written property=value.`);
    return {
      property: body.slice(0, eq).trim(),
      propertyValue: body.slice(eq + 1).trim(),
      NOT: not,
    };
  });
}

/** Keep one rule per detect label of a (possibly edited) program. */
export function reconcileRules(program: string, rules: SfRule[], severity = "Warning"): SfRule[] {
  const labels = detectLabels(program);
  if (labels.length === 0) return rules;
  return labels.map(
    (label) =>
      rules.find((r) => r.detectLabel === label) ?? {
        detectLabel: label,
        severity,
        notifications: [],
      },
  );
}

export class SplunkObservabilityClient implements PluginClient {
  private readonly ctx: SplunkContext;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const token = (credentials["token"] ?? "").trim();
    if (!token) throw new Error("Splunk Observability plugin: missing token credential");
    const caCert = credentials["caCert"] ?? "";
    this.ctx = {
      realm: normalizeRealm(credentials["realm"] ?? "us0"),
      token,
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
  }

  get context(): SplunkContext {
    return this.ctx;
  }

  private app(): string {
    return appUrl(this.ctx);
  }

  private async scoped(load: () => Promise<ResourceInstance[]>): Promise<ResourceInstance[]> {
    try {
      return await load();
    } catch (err) {
      // A token without the admin or API rights for this one list.
      if (statusOf(err) === 403) return [];
      throw err;
    }
  }

  private async organization(accountId: string): Promise<ResourceInstance> {
    const o = await sfFetch<SfOrganization>(this.ctx, "/v2/organization");
    const id = o.id ?? "organization";
    return instance(
      accountId,
      "organization",
      id,
      o.organizationName ?? id,
      {
        organizationName: o.organizationName,
        orgId: id,
        realm: this.ctx.realm,
        accountType: o.accountType,
        accountStatus: o.accountStatus,
        accountRenews: o.accountRenews,
        accountValidUntil: isoMs(o.accountValidUntil),
        dpmLimit: o.dpmLimit,
        tokensExpiringSoon: (o.tokensExpiringInSevenDays ?? []).join(", "),
        tokensExpiringMonth: (o.tokensExpiringInThirtyDays ?? []).join(", "),
        created: isoMs(o.created),
      },
      { orgId: id, realm: this.ctx.realm, appUrl: o.url?.[0] ?? this.app() },
    );
  }

  private async tests(): Promise<SfTest[]> {
    const out: SfTest[] = [];
    for (let page = 1; page <= 20; page++) {
      const res = await sfFetch<{ tests?: SfTest[]; totalCount?: number }>(
        this.ctx,
        `${SYNTH}/tests`,
        {
          query: { page, perPage: 100 },
        },
      );
      out.push(...(res.tests ?? []));
      if (
        (res.tests ?? []).length < 100 ||
        (res.totalCount !== undefined && out.length >= res.totalCount)
      )
        break;
    }
    return out;
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    const app = this.app();
    switch (typeId) {
      case "organization":
        return [await this.organization(accountId)];
      case "detector":
        return this.scoped(async () =>
          (await offsetList<SfDetector>(this.ctx, "/v2/detector")).map((d) =>
            mapDetector(accountId, d, app),
          ),
        );
      case "incident":
        return this.scoped(async () =>
          (await offsetList<SfIncident>(this.ctx, "/v2/incident", { includeResolved: false }))
            .filter((i) => i.incidentId)
            .map((i) => mapIncident(accountId, i)),
        );
      case "muting-rule":
        return this.scoped(async () =>
          (await offsetList<SfMutingRule>(this.ctx, "/v2/alertmuting")).map((m) =>
            mapMutingRule(accountId, m),
          ),
        );
      case "dashboard-group":
        return this.scoped(async () =>
          (await offsetList<SfDashboardGroup>(this.ctx, "/v2/dashboardgroup")).map((g) =>
            mapGroup(accountId, g, app),
          ),
        );
      case "dashboard":
        return this.scoped(async () =>
          (await offsetList<SfDashboard>(this.ctx, "/v2/dashboard")).map((d) =>
            mapDashboard(accountId, d, app),
          ),
        );
      case "chart":
        return this.scoped(async () => {
          const [charts, dashboards] = await Promise.all([
            offsetList<SfChart>(this.ctx, "/v2/chart"),
            offsetList<SfDashboard>(this.ctx, "/v2/dashboard").catch(() => [] as SfDashboard[]),
          ]);
          const owner = new Map<string, string>();
          for (const d of dashboards)
            for (const c of d.charts ?? []) if (c.chartId && d.id) owner.set(c.chartId, d.id);
          return charts.map((c) => mapChart(accountId, c, owner.get(c.id ?? "")));
        });
      case "team":
        return this.scoped(async () =>
          (await offsetList<SfTeam>(this.ctx, "/v2/team")).map((t) => mapTeam(accountId, t)),
        );
      case "member":
        return this.scoped(async () =>
          (await offsetList<SfMember>(this.ctx, "/v2/organization/member")).map((m) =>
            mapMember(accountId, m),
          ),
        );
      case "integration":
        return this.scoped(async () =>
          (await offsetList<SfIntegration>(this.ctx, "/v2/integration")).map((i) =>
            mapIntegration(accountId, i),
          ),
        );
      case "org-token":
        return this.scoped(async () =>
          (await offsetList<SfToken>(this.ctx, "/v2/token", {}, 500)).map((t) =>
            mapToken(accountId, t),
          ),
        );
      case "slo":
        return this.scoped(async () => {
          const res = await sfFetch<{ results?: SfSlo[] }>(this.ctx, "/v2/slo/search", {
            method: "POST",
            query: { limit: 1000, offset: 0 },
            body: JSON.stringify({}),
          });
          return (res.results ?? []).map((s) => mapSlo(accountId, s));
        });
      case "synthetic-test":
        return this.scoped(async () => (await this.tests()).map((t) => mapTest(accountId, t)));
      default:
        throw new Error(`Splunk Observability plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId) || resourceId;
    const e = encodeURIComponent(id);
    const app = this.app();
    switch (typeId) {
      case "organization":
        return this.organization(accountId);
      case "detector":
        return mapDetector(
          accountId,
          await sfFetch<SfDetector>(this.ctx, `/v2/detector/${e}`),
          app,
        );
      case "incident":
        return mapIncident(accountId, await sfFetch<SfIncident>(this.ctx, `/v2/incident/${e}`));
      case "muting-rule":
        return mapMutingRule(
          accountId,
          await sfFetch<SfMutingRule>(this.ctx, `/v2/alertmuting/${e}`),
        );
      case "dashboard-group":
        return mapGroup(
          accountId,
          await sfFetch<SfDashboardGroup>(this.ctx, `/v2/dashboardgroup/${e}`),
          app,
        );
      case "dashboard":
        return mapDashboard(
          accountId,
          await sfFetch<SfDashboard>(this.ctx, `/v2/dashboard/${e}`),
          app,
        );
      case "chart":
        // The chart itself does not say which dashboard holds it; the list does.
        return mapChart(accountId, await sfFetch<SfChart>(this.ctx, `/v2/chart/${e}`));
      case "team":
        return mapTeam(accountId, await sfFetch<SfTeam>(this.ctx, `/v2/team/${e}`));
      case "member":
        return mapMember(
          accountId,
          await sfFetch<SfMember>(this.ctx, `/v2/organization/member/${e}`),
        );
      case "integration":
        return mapIntegration(
          accountId,
          await sfFetch<SfIntegration>(this.ctx, `/v2/integration/${e}`),
        );
      case "org-token":
        return mapToken(accountId, await sfFetch<SfToken>(this.ctx, `/v2/token/${e}`));
      case "slo":
        return mapSlo(accountId, await sfFetch<SfSlo>(this.ctx, `/v2/slo/${e}`));
      default: {
        const all = await this.listResources(typeId, accountId);
        const found = all.find((r) => r.id === resourceId || r.externalId === id);
        if (!found) throw new Error(`Splunk Observability plugin: ${typeId} ${id} not found`);
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
    const r = await this.getResource(typeId, resourceId, accountId);
    const v = r.resolvedOutputs[outputKey] ?? r.fields[outputKey];
    if (v === undefined)
      throw new Error(`Splunk Observability plugin: cannot resolve "${outputKey}" for "${typeId}"`);
    return String(v);
  }

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    if (resource.resourceTypeId !== "synthetic-test" || !resource.externalId) return resource;
    const res = await sfFetch<{ runs?: unknown[] }>(
      this.ctx,
      `${SYNTH}/tests/${encodeURIComponent(resource.externalId)}/runs`,
      { query: { page: 1, perPage: 25 } },
    ).catch(() => ({ runs: [] }));
    return {
      ...resource,
      resolvedOutputs: { ...resource.resolvedOutputs, [RUNS_KEY]: JSON.stringify(res.runs ?? []) },
    };
  }

  // -------------------------------------------------------------------------
  // Metrics, quotas, preflight
  // -------------------------------------------------------------------------

  async fetchMetricSeries(
    typeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const range = rangeOrDefault(timeRange, METRICS_WINDOW_MS);
    if (typeId === "organization") return runSignalFlow(this.ctx, ORG_USAGE_PROGRAM, range);
    if (typeId === "detector" || typeId === "chart") {
      const r = await this.getResource(typeId, resourceId, accountId);
      const program = str(r.fields["programText"]);
      return program ? runSignalFlow(this.ctx, program, range) : [];
    }
    return [];
  }

  async fetchQuotas(): Promise<QuotaUsage[]> {
    const endMs = Date.now();
    const program = QUOTA_PAIRS.flatMap((q) => [
      `data('${q.used}').sum().publish(label='${q.id}:used')`,
      `data('${q.limit}').max().publish(label='${q.id}:limit')`,
    ]).join("\n");
    const series = await runSignalFlow(this.ctx, program, { startMs: endMs - 2 * 3600_000, endMs });
    const latest = new Map<string, number>();
    for (const s of series) {
      const last = s.points[s.points.length - 1];
      const key = s.label.split(" ")[0] ?? s.label;
      if (last) latest.set(key, last.value);
    }
    return QUOTA_PAIRS.flatMap((q) => {
      const used = latest.get(`${q.id}:used`);
      const limit = latest.get(`${q.id}:limit`);
      if (used === undefined || limit === undefined || limit <= 0) return [];
      return [
        {
          id: q.id,
          service: "Splunk Observability Cloud",
          name: q.name,
          used,
          limit,
          region: this.ctx.realm,
        },
      ];
    });
  }

  async verifyCredentials(): Promise<PreflightResult> {
    return verifySplunkCredentials(this.ctx);
  }

  async fetchDashboardStats(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const r = await this.getResource(typeId, resourceId, accountId);
    if (typeId === "detector")
      return [{ label: "Rules", value: str(r.fields["ruleCount"]) || "0" }];
    if (typeId === "organization") return [{ label: "Realm", value: this.ctx.realm }];
    return [];
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case "detector": {
        const teams = await offsetList<SfTeam>(this.ctx, "/v2/team").catch(() => [] as SfTeam[]);
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "High CPU" },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "programText",
              label: "SignalFlow program",
              kind: "code",
              required: true,
              defaultValue:
                "A = data('cpu.utilization').mean(by=['host']).publish(label='A')\ndetect(when(A > threshold(90), lasting='5m')).publish('CPU over 90%')",
              description: "Each detect(...).publish('label') becomes an alert rule.",
            },
            {
              key: "severity",
              label: "Severity",
              kind: "select",
              required: true,
              defaultValue: "Warning",
              options: SEVERITIES.map((s) => ({ id: s, label: s })),
            },
            { key: "tags", label: "Tags", kind: "string-list", required: false },
            {
              key: "teams",
              label: "Teams",
              kind: "policy-picker",
              required: false,
              policies: teams
                .filter((t) => t.id)
                .map((t) => ({ id: t.id ?? "", label: t.name ?? t.id ?? "" })),
            },
          ],
        };
      }
      case "muting-rule":
        return {
          fields: [
            {
              key: "description",
              label: "Description",
              kind: "text",
              required: true,
              placeholder: "Release window",
            },
            {
              key: "filters",
              label: "Filters",
              kind: "text",
              required: false,
              multiline: true,
              description: MUTING_FILTER_HELP,
            },
            {
              key: "startTime",
              label: "Starts",
              kind: "datetime",
              datetimeMode: "epoch-ms",
              required: true,
            },
            {
              key: "stopTime",
              label: "Ends",
              kind: "datetime",
              datetimeMode: "epoch-ms",
              required: false,
              description: "Leave empty to mute until ended by hand.",
            },
            {
              key: "sendAlertsAfter",
              label: "Alert on still-active alerts when it ends",
              kind: "select",
              required: true,
              defaultValue: "true",
              options: [
                { id: "true", label: "Yes" },
                { id: "false", label: "No" },
              ],
            },
          ],
        };
      case "dashboard-group":
      case "team":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            { key: "description", label: "Description", kind: "text", required: false },
          ],
        };
      case "member":
        return {
          fields: [
            {
              key: "email",
              label: "Email",
              kind: "text",
              required: true,
              placeholder: "jane@example.com",
            },
            { key: "fullName", label: "Name", kind: "text", required: false },
            {
              key: "admin",
              label: "Admin",
              kind: "select",
              required: true,
              defaultValue: "false",
              options: [
                { id: "false", label: "No" },
                { id: "true", label: "Yes" },
              ],
            },
          ],
        };
      default:
        throw new Error(`Splunk Observability plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const app = this.app();
    switch (typeId) {
      case "detector": {
        const program = fields["programText"] ?? "";
        const labels = detectLabels(program);
        if (labels.length === 0)
          throw new Error("The program needs at least one detect(...).publish('label').");
        let teams: string[] = [];
        try {
          teams = JSON.parse(fields["teams"] || "[]") as string[];
        } catch {
          teams = csv(fields["teams"]);
        }
        const d = await sfFetch<SfDetector>(this.ctx, "/v2/detector", {
          method: "POST",
          body: JSON.stringify({
            name: (fields["name"] ?? "").trim(),
            description: fields["description"] ?? "",
            programText: program,
            rules: labels.map((detectLabel) => ({
              detectLabel,
              severity: fields["severity"] || "Warning",
              notifications: [],
            })),
            tags: csv(fields["tags"]),
            teams,
          }),
        });
        return mapDetector(accountId, d, app);
      }
      case "muting-rule": {
        const stop = fields["stopTime"] ? Number(fields["stopTime"]) : 0;
        const m = await sfFetch<SfMutingRule>(this.ctx, "/v2/alertmuting", {
          method: "POST",
          body: JSON.stringify({
            description: (fields["description"] ?? "").trim(),
            filters: parseMutingFilters(fields["filters"] ?? ""),
            startTime: Number(fields["startTime"]) || Date.now(),
            ...(stop ? { stopTime: stop } : {}),
            sendAlertsOnceMutingPeriodHasEnded: fields["sendAlertsAfter"] !== "false",
          }),
        });
        return mapMutingRule(accountId, m);
      }
      case "dashboard-group": {
        const g = await sfFetch<SfDashboardGroup>(this.ctx, "/v2/dashboardgroup", {
          method: "POST",
          body: JSON.stringify({
            name: (fields["name"] ?? "").trim(),
            description: fields["description"] ?? "",
          }),
        });
        return mapGroup(accountId, g, app);
      }
      case "team": {
        const t = await sfFetch<SfTeam>(this.ctx, "/v2/team", {
          method: "POST",
          body: JSON.stringify({
            name: (fields["name"] ?? "").trim(),
            description: fields["description"] ?? "",
            members: [],
          }),
        });
        return mapTeam(accountId, t);
      }
      case "member": {
        const m = await sfFetch<SfMember>(this.ctx, "/v2/organization/member", {
          method: "POST",
          body: JSON.stringify({
            email: (fields["email"] ?? "").trim(),
            ...(fields["fullName"]?.trim() ? { fullName: fields["fullName"].trim() } : {}),
            admin: fields["admin"] === "true",
          }),
        });
        return mapMember(accountId, m);
      }
      default:
        throw new Error(`Splunk Observability plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  // -------------------------------------------------------------------------
  // Update / delete / actions
  // -------------------------------------------------------------------------

  /** GET, merge, PUT: Splunk's object updates replace the whole object. */
  private async replace<T extends object>(path: string, patch: (current: T) => T): Promise<T> {
    const current = await sfFetch<T>(this.ctx, path);
    return sfFetch<T>(this.ctx, path, { method: "PUT", body: JSON.stringify(patch(current)) });
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const e = encodeURIComponent(externalIdOf(resourceId) || resourceId);
    const named = <T extends { name?: string; description?: string }>(c: T): T => ({
      ...c,
      ...(fields["name"]?.trim() ? { name: fields["name"].trim() } : {}),
      ...("description" in fields ? { description: fields["description"] ?? "" } : {}),
    });
    switch (typeId) {
      case "detector":
        await this.replace<SfDetector>(`/v2/detector/${e}`, (c) => {
          const next = named(c);
          if ("tags" in fields) next.tags = csv(fields["tags"]);
          if (fields["programText"]?.trim()) {
            next.programText = fields["programText"];
            next.rules = reconcileRules(next.programText, c.rules ?? []);
          }
          return next;
        });
        break;
      case "muting-rule":
        await this.replace<SfMutingRule>(`/v2/alertmuting/${e}`, (c) => ({
          ...c,
          ...("description" in fields ? { description: fields["description"] ?? "" } : {}),
        }));
        break;
      case "dashboard-group":
        await this.replace<SfDashboardGroup>(`/v2/dashboardgroup/${e}`, named);
        break;
      case "dashboard":
        await this.replace<SfDashboard>(`/v2/dashboard/${e}`, named);
        break;
      case "chart":
        await this.replace<SfChart>(`/v2/chart/${e}`, (c) => ({
          ...named(c),
          ...(fields["programText"]?.trim() ? { programText: fields["programText"] } : {}),
        }));
        break;
      case "team":
        await this.replace<SfTeam>(`/v2/team/${e}`, named);
        break;
      case "member":
        if ("admin" in fields) {
          await sfFetch(this.ctx, `/v2/organization/member/${e}`, {
            method: "PUT",
            body: JSON.stringify({ admin: fields["admin"] === "true" }),
          });
        }
        break;
      case "org-token":
        await this.replace<SfToken & { secret?: string }>(`/v2/token/${e}`, (c) => {
          const { secret: _secret, ...rest } = c;
          return {
            ...rest,
            ...("description" in fields ? { description: fields["description"] ?? "" } : {}),
            ...("disabled" in fields ? { disabled: fields["disabled"] === "true" } : {}),
          };
        });
        break;
      default:
        throw new Error(
          `Splunk Observability plugin: "${typeId}" cannot be edited from Infrawrench`,
        );
    }
    return this.getResource(typeId, resourceId, accountId);
  }

  async deleteResource(typeId: string, resourceId: string): Promise<void> {
    const e = encodeURIComponent(externalIdOf(resourceId) || resourceId);
    const path: Record<string, string> = {
      detector: `/v2/detector/${e}`,
      "muting-rule": `/v2/alertmuting/${e}`,
      "dashboard-group": `/v2/dashboardgroup/${e}`,
      dashboard: `/v2/dashboard/${e}`,
      chart: `/v2/chart/${e}`,
      team: `/v2/team/${e}`,
      member: `/v2/organization/member/${e}`,
      integration: `/v2/integration/${e}`,
      "org-token": `/v2/token/${e}`,
      slo: `/v2/slo/${e}`,
      "synthetic-test": `${SYNTH}/tests/${e}`,
    };
    const target = path[typeId];
    if (!target)
      throw new Error(
        `Splunk Observability plugin: "${typeId}" cannot be deleted from Infrawrench`,
      );
    await sfFetch(this.ctx, target, { method: "DELETE" });
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): Promise<void> {
    const id = externalIdOf(resourceId) || resourceId;
    const e = encodeURIComponent(id);
    const key = `${typeId}:${actionId}`;
    switch (key) {
      case "detector:enable":
      case "detector:disable": {
        const d = await sfFetch<SfDetector>(this.ctx, `/v2/detector/${e}`);
        const labels = (d.rules ?? [])
          .map((r) => r.detectLabel)
          .filter((l): l is string => Boolean(l));
        await sfFetch(this.ctx, `/v2/detector/${e}/${actionId}`, {
          method: "PUT",
          body: JSON.stringify(labels),
        });
        return;
      }
      case "incident:clear":
        await sfFetch(this.ctx, `/v2/incident/${e}/clear`, { method: "PUT" });
        return;
      case "muting-rule:unmute":
        await sfFetch(this.ctx, `/v2/alertmuting/${e}/unmute`, { method: "PUT" });
        return;
      case "integration:enable":
      case "integration:disable":
        await this.replace<SfIntegration>(`/v2/integration/${e}`, (c) => ({
          ...c,
          enabled: actionId === "enable",
        }));
        return;
      case "integration:validate":
        await sfFetch(this.ctx, `/v2/integration/validate/${e}`);
        return;
      case "org-token:enable":
      case "org-token:disable":
        await this.updateResource("org-token", resourceId, accountId, {
          disabled: String(actionId === "disable"),
        });
        return;
      case "synthetic-test:pause":
      case "synthetic-test:resume":
        await sfFetch(this.ctx, `${SYNTH}/tests/${actionId === "pause" ? "pause" : "play"}`, {
          method: "PUT",
          body: JSON.stringify({ testIds: [Number(id)] }),
        });
        return;
      case "synthetic-test:run":
        await sfFetch(this.ctx, `${SYNTH}/tests/${e}/run_now`, { method: "POST" });
        return;
      default:
        throw new Error(
          `Splunk Observability plugin: unknown action "${actionId}" for "${typeId}"`,
        );
    }
  }

  async exportCredential(
    typeId: string,
    resourceId: string,
    _accountId: string,
    formatId: string,
  ): Promise<CredentialExport> {
    if (typeId !== "org-token" || formatId !== "rotate") {
      throw new Error(`Splunk Observability plugin: no credential "${formatId}" for "${typeId}"`);
    }
    const name = externalIdOf(resourceId) || resourceId;
    const t = await sfFetch<SfToken & { secret?: string }>(
      this.ctx,
      `/v2/token/${encodeURIComponent(name)}/rotate`,
      { method: "POST" },
    );
    if (!t.secret) throw new Error("Splunk did not return the new secret.");
    return {
      content: t.secret,
      filename: `${name}.token`,
      mimeType: "text/plain",
      fields: [
        { label: "Token name", value: name },
        { label: "Secret", value: t.secret, sensitive: true, hint: "Only shown once" },
      ],
      warning: "The old secret stopped working. Save this one now: it cannot be shown again.",
    };
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderSplunkDetail({
      ...resource,
      resolvedOutputs: { ...resource.resolvedOutputs, [APP_KEY]: this.app() },
    });
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderSplunkSidebar(resource);
  }
}
