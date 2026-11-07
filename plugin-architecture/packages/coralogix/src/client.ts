import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { ApiBody, PluginEffect } from "@infrawrench/plugin-base";
import type {
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
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
import {
  ListTruncatedError,
  QuotaAccessError,
  externalIdOf,
  pathEncode,
  rethrowIncompleteList,
} from "@infrawrench/plugin-base";
import type { CoralogixContext } from "./api.js";
import { apiV4, apiV5, isPermissionError, listIn, statusOf } from "./api.js";
import type { operations } from "./api-types.v5.gen.js";
import { fetchCoralogixCostData, parseUnitPrice } from "./cost-data.js";
import type {
  CxAlertDef,
  CxCustomEnrichment,
  CxE2M,
  CxEnrichment,
  CxPolicy,
  CxQuotaRuleSet,
  CxTeam,
} from "./mappers.js";
import {
  alertPriorityValue,
  instance,
  mapAlert,
  mapCustomEnrichment,
  mapDashboard,
  mapE2M,
  mapEnrichment,
  mapPolicy,
  mapQuotaRule,
  mapRuleGroup,
  mapWebhook,
  policyPriorityValue,
} from "./mappers.js";
import {
  ALERT_METRICS_WINDOW_MS,
  TEAM_METRICS_WINDOW_MS,
  alertSeries,
  policySeries,
  rangeOrDefault,
  teamSeries,
} from "./metrics.js";
import { verifyCoralogixCredentials } from "./preflight.js";
import type { CoralogixRegion } from "./regions.js";
import { resolveRegion } from "./regions.js";
import type { TeamLimit, TeamSummary, UsageBreakdownRow } from "./render.js";
import { TEAM_SUMMARY_KEY, renderCoralogixDetail, renderCoralogixSidebar } from "./render.js";
import type { UsageCell } from "./usage.js";
import { PILLAR_LABELS, PRIORITY_LABELS, fetchUsageCells } from "./usage.js";

const ALERT_PAGE = 100;
const ALERT_MAX_PAGES = 100;
const TEAM_EXTERNAL_ID = "team";

type PolicyUpdate = ApiBody<operations["PoliciesService_UpdatePolicy"]>;

interface TeamInfo {
  teamId?: string;
  team?: CxTeam;
}

export class CoralogixClient implements PluginClient {
  private readonly ctx: CoralogixContext;
  private readonly unitPriceRaw: string;

  constructor(credentials: Credentials, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    if (!apiKey) throw new Error("Coralogix plugin: missing apiKey credential");
    const caCert = credentials["caCert"] ?? "";
    this.unitPriceRaw = credentials["unitPrice"] ?? "";
    this.ctx = {
      apiKey,
      region: resolveRegion(credentials["region"]),
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
  }

  get region(): CoralogixRegion {
    return this.ctx.region;
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  /**
   * A 403 on one list means the key lacks that one permission; the rest of
   * the account still works, so that type lists empty rather than failing the
   * sync. A 401 (wrong key or region) still throws.
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
        case "team":
          return [await this.teamInstance(accountId)];
        case "alert":
          return this.scoped(async () =>
            (await this.fetchAlerts()).map((a) => mapAlert(accountId, a)),
          );
        case "dashboard":
          return this.scoped(async () => {
            const path = "/dashboards/dashboards/v1/catalog/list";
            const res = await apiV5(this.ctx).get(path);
            return listIn(res, "items", path).map((d) => mapDashboard(accountId, d));
          });
        case "tco-policy":
          return this.scoped(async () =>
            (await this.fetchPolicies())
              .filter((p) => !p.deleted)
              .map((p) => mapPolicy(accountId, p)),
          );
        case "parsing-rule-group":
          return this.scoped(async () => {
            const path = "/parsing-rules/rule-groups/v1";
            const res = await apiV5(this.ctx).get(path);
            return listIn(res, "ruleGroups", path)
              .filter((g) => !g.hidden)
              .map((g) => mapRuleGroup(accountId, g));
          });
        case "enrichment":
          return this.scoped(async () => {
            const [enrichments, custom] = await Promise.all([
              this.fetchEnrichments(),
              this.fetchCustomEnrichments().catch((err): CxCustomEnrichment[] => {
                rethrowIncompleteList(err);
                return [];
              }),
            ]);
            const names = new Map<number, string>();
            for (const c of custom) if (c.id !== undefined && c.name) names.set(c.id, c.name);
            return enrichments.map((e) => mapEnrichment(accountId, e, names));
          });
        case "custom-enrichment":
          return this.scoped(async () =>
            (await this.fetchCustomEnrichments()).map((c) => mapCustomEnrichment(accountId, c)),
          );
        case "outgoing-webhook":
          return this.scoped(async () => {
            const path = "/integrations/webhooks/v1";
            const res = await apiV5(this.ctx).get(path);
            return listIn(res, "deployed", path).map((w) => mapWebhook(accountId, w));
          });
        case "quota-rule":
          return this.scoped(async () => {
            const path = "/dataplan/quota-rules/v1";
            const res = await apiV5(this.ctx).get(path);
            // A team with no rule set has no rules; no answer at all says nothing.
            return listIn(res && (res.ruleSet ?? {}), "rules", path)
              .filter((r) => r.entityType)
              .map((r) => mapQuotaRule(accountId, r));
          });
        case "events2metrics":
          return this.scoped(async () =>
            (await this.fetchE2Ms()).filter((e) => !e.isInternal).map((e) => mapE2M(accountId, e)),
          );
        default:
          throw new Error(`Coralogix plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  /**
   * Coralogix's token pagination (`pagination.pageSize` / `pagination.pageToken`
   * in, `pagination.nextPageToken` out). Throws at the page cap, so a misbehaving
   * token cannot spin forever and a longer list is not read as part of one.
   */
  private async fetchAlerts(): Promise<CxAlertDef[]> {
    const out: CxAlertDef[] = [];
    let token: string | undefined;
    for (let page = 0; page < ALERT_MAX_PAGES; page++) {
      const res = await apiV5(this.ctx).get("/alerts/alerts/v3", {
        query: { pagination: { pageSize: ALERT_PAGE, ...(token ? { pageToken: token } : {}) } },
      });
      out.push(...listIn(res, "alertDefs", "/alerts/alerts/v3"));
      token = res?.pagination?.nextPageToken || undefined;
      if (!token) return out;
    }
    throw new ListTruncatedError({
      vendor: "Coralogix",
      path: "/alerts/alerts/v3",
      items: out.length,
      maxPages: ALERT_MAX_PAGES,
    });
  }

  private async fetchPolicies(): Promise<CxPolicy[]> {
    const path = "/dataplans/policies/v1";
    return listIn(await apiV5(this.ctx).get(path), "policies", path);
  }

  private async fetchEnrichments(): Promise<CxEnrichment[]> {
    const path = "/enrichment-rules/enrichment-rules/v1";
    return listIn(await apiV5(this.ctx).get(path), "enrichments", path);
  }

  private async fetchCustomEnrichments(): Promise<CxCustomEnrichment[]> {
    const path = "/enrichment-rules/custom-enrichment-rules/v1";
    return listIn(await apiV5(this.ctx).get(path), "customEnrichments", path);
  }

  private async fetchQuotaRuleSet(): Promise<CxQuotaRuleSet | undefined> {
    const res = await apiV5(this.ctx).get("/dataplan/quota-rules/v1");
    return res?.ruleSet;
  }

  private async fetchE2Ms(): Promise<CxE2M[]> {
    const path = "/events2metrics/events2metrics/v2";
    return listIn(await apiV5(this.ctx).get(path), "e2m", path);
  }

  // -------------------------------------------------------------------------
  // Team
  // -------------------------------------------------------------------------

  /**
   * The key's team id. The management API has no "who am I"; the team id is
   * the `companyId` several responses carry, so the cheapest readable one
   * wins: Events2Metrics limits, then parsing-rule limits, then policies.
   */
  private async resolveTeamId(): Promise<string | undefined> {
    const attempts: Array<() => Promise<string | undefined>> = [
      async () => (await apiV5(this.ctx).get("/events2metrics/limits/v2"))?.companyId || undefined,
      async () =>
        (await apiV5(this.ctx).post("/parsing-rules/limits/v1", { body: {} }))?.companyId ||
        undefined,
      async () => {
        const p = (await this.fetchPolicies()).find((x) => x.companyId !== undefined);
        return p?.companyId !== undefined ? String(p.companyId) : undefined;
      },
    ];
    for (const attempt of attempts) {
      const id = await attempt().catch((err) => {
        rethrowIncompleteList(err);
        return undefined;
      });
      if (id) return id;
    }
    return undefined;
  }

  /**
   * The team's name, daily quota and retention, from the (deprecated, still
   * served) team list, matched on the resolved team id. A key that may not
   * list teams, or an organization with several teams and no readable id,
   * leaves these unknown rather than guessing.
   */
  private async teamInfo(): Promise<TeamInfo> {
    const [teamId, list] = await Promise.all([
      this.resolveTeamId(),
      apiV5(this.ctx)
        .get("/aaa/teams/v2")
        .catch((err) => {
          rethrowIncompleteList(err);
          return undefined;
        }),
    ]);
    const teams = [...(list?.teams ?? []), ...(list?.defaultTeam ? [list.defaultTeam] : [])];
    const team = teamId
      ? teams.find((t) => String(t.teamId?.id ?? "") === teamId)
      : teams.length === 1
        ? teams[0]
        : undefined;
    const id = teamId ?? (team?.teamId?.id !== undefined ? String(team.teamId.id) : undefined);
    return { ...(id ? { teamId: id } : {}), ...(team ? { team } : {}) };
  }

  private async teamInstance(accountId: string, summary?: TeamSummary): Promise<ResourceInstance> {
    const info = await this.teamInfo();
    const name = info.team?.teamName || `Coralogix (${this.region.label})`;
    return instance(
      accountId,
      "team",
      TEAM_EXTERNAL_ID,
      name,
      {
        name,
        region: `${this.region.label} (${this.region.domain})`,
        teamId: info.teamId,
        dailyQuota: info.team?.dailyQuota,
        retentionDays: info.team?.retention,
        unitPrice: this.unitPrice(),
        ...(summary
          ? {
              todayUnits: round(summary.today.units),
              monthToDateUnits: round(summary.totals.units),
              monthToDateGb: round(summary.totals.gb),
              monthToDateCost: round(summary.totals.cost),
              usageMetricsExport: summary.usageMetricsExport,
            }
          : {}),
      },
      {
        teamId: info.teamId,
        ...(summary ? { [TEAM_SUMMARY_KEY]: JSON.stringify(summary) } : {}),
      },
    );
  }

  private unitPrice(): number {
    return parseUnitPrice(this.unitPriceRaw);
  }

  private async limits(): Promise<TeamLimit[]> {
    const [e2m, parsing, enrich] = await Promise.all([
      apiV5(this.ctx)
        .get("/events2metrics/limits/v2")
        .catch(() => undefined),
      apiV5(this.ctx)
        .post("/parsing-rules/limits/v1", { body: {} })
        .catch(() => undefined),
      apiV5(this.ctx)
        .get("/enrichment-rules/enrichment-rules/v1/limit")
        .catch(() => undefined),
    ]);
    const out: TeamLimit[] = [];
    const push = (name: string, used: number | undefined, limit: number | undefined) => {
      if (typeof limit === "number" && limit > 0) out.push({ name, used: used ?? 0, limit });
    };
    push("Events2Metrics metrics", e2m?.metricsLimit?.used, e2m?.metricsLimit?.limit);
    push(
      "Events2Metrics label permutations",
      e2m?.permutationsLimit?.used,
      e2m?.permutationsLimit?.limit,
    );
    push("Parsing rule groups", parsing?.usage?.groups, parsing?.limits?.groups);
    push("Parsing rules", parsing?.usage?.rules, parsing?.limits?.rules);
    push("Enrichment rules", enrich?.used, enrich?.limit);
    return out;
  }

  private async teamSummary(dailyQuota?: number): Promise<TeamSummary | undefined> {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const from = `${today.slice(0, 7)}-01`;
    let cells: UsageCell[];
    try {
      cells = await fetchUsageCells(this.ctx, { fromDate: from, toDate: today });
    } catch (err) {
      if (isPermissionError(err)) return undefined;
      throw err;
    }
    const price = this.unitPrice();
    const fold = (keyOf: (c: UsageCell) => string | undefined): UsageBreakdownRow[] => {
      const m = new Map<string, UsageBreakdownRow>();
      for (const c of cells) {
        const label = keyOf(c);
        if (!label) continue;
        const row = m.get(label) ?? { label, units: 0, gb: 0, cost: 0 };
        row.units += c.units;
        row.gb += c.gb ?? 0;
        row.cost += c.units * price;
        m.set(label, row);
      }
      return [...m.values()].sort((a, b) => b.units - a.units);
    };
    const totals = cells.reduce(
      (t, c) => ({
        units: t.units + c.units,
        gb: t.gb + (c.gb ?? 0),
        cost: t.cost + c.units * price,
      }),
      { units: 0, gb: 0, cost: 0 },
    );
    const todayCells = cells.filter((c) => c.date === today);
    const [limits, exportStatus] = await Promise.all([
      this.limits(),
      apiV4(this.ctx)
        .get("/dataplans/data-usage/v2/export-status")
        .catch(() => undefined),
    ]);
    return {
      from,
      through: today,
      unitPrice: price,
      totals,
      today: {
        units: todayCells.reduce((s, c) => s + c.units, 0),
        gb: todayCells.reduce((s, c) => s + (c.gb ?? 0), 0),
      },
      byPillar: fold((c) => PILLAR_LABELS[c.pillar]),
      byPriority: fold((c) => (c.priority ? PRIORITY_LABELS[c.priority] : undefined)),
      ...(dailyQuota !== undefined ? { dailyQuota } : {}),
      limits,
      ...(typeof exportStatus?.enabled === "boolean"
        ? { usageMetricsExport: exportStatus.enabled }
        : {}),
    };
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
        case "team": {
          const info = await this.teamInfo();
          const summary = await this.teamSummary(info.team?.dailyQuota);
          return this.teamInstance(accountId, summary);
        }
        case "alert": {
          const res = await apiV5(this.ctx).get(`/alerts/alerts/v3/${pathEncode(id)}`);
          if (res?.alertDef) return mapAlert(accountId, res.alertDef);
          break;
        }
        case "tco-policy": {
          const res = await apiV5(this.ctx).get(`/dataplans/policies/v1/${pathEncode(id)}`);
          if (res?.policy) return mapPolicy(accountId, res.policy);
          break;
        }
        case "parsing-rule-group": {
          const res = await apiV5(this.ctx).get(`/parsing-rules/rule-groups/v1/${pathEncode(id)}`);
          if (res?.ruleGroup) return mapRuleGroup(accountId, res.ruleGroup);
          break;
        }
        case "events2metrics": {
          const res = await apiV5(this.ctx).get(
            `/events2metrics/events2metrics/v2/${pathEncode(id)}`,
          );
          if (res?.e2m) return mapE2M(accountId, res.e2m);
          break;
        }
        default:
          break;
      }
      const all = await runPluginEffect(this.listResources(typeId, accountId));
      const found = all.find((r) => r.id === resourceId || r.externalId === id);
      if (!found) throw new Error(`Coralogix plugin: resource ${typeId}/${resourceId} not found`);
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
      throw new Error(
        `Coralogix plugin: cannot resolve output "${outputKey}" for type "${typeId}"`,
      );
    });
  }

  // -------------------------------------------------------------------------
  // Stats, metrics, costs and quotas
  // -------------------------------------------------------------------------

  fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<DashboardStat[]> {
    return attempt(async () => {
      const r = await runPluginEffect(this.getResource(resourceTypeId, resourceId, accountId));
      const f = r.fields;
      const num = (v: string | number | boolean | undefined, digits = 0) =>
        typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: digits }) : "—";
      switch (resourceTypeId) {
        case "team": {
          const quota = typeof f["dailyQuota"] === "number" ? f["dailyQuota"] : undefined;
          const today = typeof f["todayUnits"] === "number" ? f["todayUnits"] : undefined;
          const share = quota && today !== undefined ? today / quota : undefined;
          return [
            {
              label: "Estimated This Month",
              value:
                typeof f["monthToDateCost"] === "number" ? `$${num(f["monthToDateCost"], 2)}` : "—",
            },
            { label: "Units This Month", value: num(f["monthToDateUnits"], 1) },
            {
              label: "Quota Used Today",
              value: share !== undefined ? `${(share * 100).toFixed(0)}%` : "—",
              variant:
                share === undefined
                  ? "default"
                  : share >= 1
                    ? "status-error"
                    : share >= 0.8
                      ? "status-degraded"
                      : "status-healthy",
            },
          ];
        }
        case "alert": {
          const status = String(f["status"] ?? "");
          return [
            {
              label: "Status",
              value: f["enabled"] === false ? "Disabled" : status || "—",
              variant:
                status === "Alerting"
                  ? "status-error"
                  : status === "OK"
                    ? "status-healthy"
                    : "default",
            },
            { label: "Priority", value: String(f["priority"] ?? "—") },
          ];
        }
        case "tco-policy":
          return [
            { label: "Priority", value: String(f["priorityLabel"] ?? "—") },
            { label: "Source", value: String(f["source"] ?? "—") },
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
        case "team": {
          const info = await this.teamInfo().catch((): TeamInfo => ({}));
          return teamSeries(
            this.ctx,
            rangeOrDefault(timeRange, TEAM_METRICS_WINDOW_MS),
            info.team?.dailyQuota,
          );
        }
        case "alert": {
          const a = await runPluginEffect(this.getResource("alert", resourceId, accountId));
          return alertSeries(
            this.ctx,
            String(a.resolvedOutputs["alertVersionId"] ?? a.fields["alertVersionId"] ?? ""),
            rangeOrDefault(timeRange, ALERT_METRICS_WINDOW_MS),
          );
        }
        case "tco-policy": {
          const res = await apiV5(this.ctx).get(`/dataplans/policies/v1/${pathEncode(id)}`);
          return res?.policy ? policySeries(this.ctx, res.policy) : [];
        }
        default:
          return [];
      }
    });
  }

  fetchCostData(_accountId: string, range: CostFetchRange): PluginEffect<CostRow[]> {
    return attempt(async () => {
      return fetchCoralogixCostData(this.ctx, range, this.unitPrice());
    });
  }

  /**
   * The daily unit quota against today's units, and the configuration limits
   * Coralogix reports with their usage. Every figure is the provider's own; a
   * limit the key may not read is left out (and `quotas.partial` says the
   * list is a subset), but anything other than a permission refusal throws so
   * a transient failure never reads as quotas disappearing.
   */
  fetchQuotas(_accountId: string): PluginEffect<QuotaUsage[]> {
    return attempt(async () => {
      const out: QuotaUsage[] = [];
      let anyReadable = false;
      const soft = async <T>(load: () => Promise<T>): Promise<T | undefined> => {
        try {
          const v = await load();
          anyReadable = true;
          return v;
        } catch (err) {
          if (isPermissionError(err)) return undefined;
          throw err;
        }
      };
      const [info, e2m, parsing, enrich] = await Promise.all([
        this.teamInfo(),
        soft(() => apiV5(this.ctx).get("/events2metrics/limits/v2")),
        soft(() => apiV5(this.ctx).post("/parsing-rules/limits/v1", { body: {} })),
        soft(() => apiV5(this.ctx).get("/enrichment-rules/enrichment-rules/v1/limit")),
      ]);
      const quota = info.team?.dailyQuota;
      if (typeof quota === "number" && quota > 0) {
        const today = new Date().toISOString().slice(0, 10);
        const cells = await soft(() =>
          fetchUsageCells(this.ctx, { fromDate: today, toDate: today }),
        );
        if (cells) {
          out.push({
            id: "team/daily-units",
            service: "Data usage",
            name: "Daily unit quota",
            used: cells.reduce((s, c) => s + c.units, 0),
            limit: quota,
            unit: "units",
            adjustable: true,
            docsUrl:
              "https://coralogix.com/docs/user-guides/account-management/payment-and-billing/quota-rules/",
          });
        }
      }
      const push = (
        id: string,
        service: string,
        name: string,
        used: number | undefined,
        limit: number | undefined,
        unit: string,
      ) => {
        if (typeof limit === "number" && limit > 0) {
          out.push({ id, service, name, used: used ?? 0, limit, unit, adjustable: true });
        }
      };
      push(
        "e2m/metrics",
        "Events2Metrics",
        "Events2Metrics metrics",
        e2m?.metricsLimit?.used,
        e2m?.metricsLimit?.limit,
        "metrics",
      );
      push(
        "e2m/permutations",
        "Events2Metrics",
        "Events2Metrics label permutations",
        e2m?.permutationsLimit?.used,
        e2m?.permutationsLimit?.limit,
        "permutations",
      );
      push(
        "parsing/groups",
        "Parsing rules",
        "Parsing rule groups",
        parsing?.usage?.groups,
        parsing?.limits?.groups,
        "groups",
      );
      push(
        "parsing/rules",
        "Parsing rules",
        "Parsing rules",
        parsing?.usage?.rules,
        parsing?.limits?.rules,
        "rules",
      );
      push(
        "enrichments/rules",
        "Enrichments",
        "Enrichment rules",
        enrich?.used,
        enrich?.limit,
        "rules",
      );
      if (!anyReadable && out.length === 0) {
        throw new QuotaAccessError(
          "The Coralogix API key may not read any limits. Attach the DataUsage, Events2Metrics, ParsingRules and Enrichments presets to the key.",
          {
            label: "Coralogix API keys",
            url: "https://coralogix.com/docs/user-guides/account-management/api-keys/api-keys/",
          },
        );
      }
      return out;
    });
  }

  verifyCredentials(): PluginEffect<PreflightResult> {
    return attempt(async () => {
      return verifyCoralogixCredentials(this.ctx);
    });
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  getCreateConfig(typeId: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      if (typeId !== "enrichment") {
        throw new Error(`Coralogix plugin: cannot create "${typeId}" from Infrawrench`);
      }
      const custom = await this.fetchCustomEnrichments().catch((): CxCustomEnrichment[] => []);
      return {
        fields: [
          {
            key: "kind",
            label: "Type",
            kind: "select",
            required: true,
            defaultValue: "geo-ip",
            options: [
              {
                id: "geo-ip",
                label: "Geo IP",
                description: "Country, city and coordinates for an IP address.",
              },
              {
                id: "geo-ip-asn",
                label: "Geo IP with ASN",
                description: "Geo IP plus the network (autonomous system) the address belongs to.",
              },
              {
                id: "suspicious-ip",
                label: "Suspicious IP",
                description: "Flags addresses that appear in threat intelligence feeds.",
              },
              ...(custom.length > 0
                ? [
                    {
                      id: "custom",
                      label: "Custom lookup",
                      description: "Adds columns from a custom enrichment table you uploaded.",
                    },
                  ]
                : []),
            ],
          },
          {
            key: "customEnrichmentId",
            label: "Custom enrichment",
            kind: "select",
            required: false,
            showWhen: { fieldKey: "kind", fieldValue: "custom" },
            options: custom
              .filter((c) => c.id !== undefined)
              .map((c) => ({
                id: String(c.id),
                label: c.name ?? String(c.id),
                ...(c.fileName ? { description: c.fileName } : {}),
              })),
          },
          {
            key: "fieldName",
            label: "Log field",
            kind: "text",
            required: true,
            placeholder: "client_ip",
            description:
              "The field in your logs that holds the value to look up, for example client_ip or request.source.ip.",
          },
          {
            key: "enrichedFieldName",
            label: "Enriched field name",
            kind: "text",
            required: false,
            description:
              "Where the added data is written. Leave empty to let Coralogix name it after the log field.",
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
      if (typeId !== "enrichment") {
        throw new Error(`Coralogix plugin: cannot create "${typeId}" from Infrawrench`);
      }
      const fieldName = (fields["fieldName"] ?? "").trim();
      if (!fieldName) throw new Error("Pick the log field to enrich.");
      const kind = fields["kind"] ?? "geo-ip";
      let enrichmentType: CxEnrichment["enrichmentType"];
      switch (kind) {
        case "geo-ip":
          enrichmentType = { geoIp: { withAsn: false } };
          break;
        case "geo-ip-asn":
          enrichmentType = { geoIp: { withAsn: true } };
          break;
        case "suspicious-ip":
          enrichmentType = { suspiciousIp: {} };
          break;
        case "custom": {
          const id = Number(fields["customEnrichmentId"]);
          if (!Number.isFinite(id)) throw new Error("Pick the custom enrichment to look up.");
          enrichmentType = { customEnrichment: { id } };
          break;
        }
        default:
          throw new Error(`Unknown enrichment type "${kind}".`);
      }
      const enrichedFieldName = (fields["enrichedFieldName"] ?? "").trim();
      const res = await apiV5(this.ctx).post("/enrichment-rules/enrichment-rules/v1", {
        body: {
          requestEnrichments: [
            { fieldName, enrichmentType, ...(enrichedFieldName ? { enrichedFieldName } : {}) },
          ],
        },
      });
      const created =
        (res?.enrichments ?? []).find(
          (e) =>
            e.fieldName === fieldName &&
            JSON.stringify(e.enrichmentType) === JSON.stringify(enrichmentType),
        ) ?? res?.enrichments?.[res.enrichments.length - 1];
      if (!created) throw new Error("Coralogix plugin: enrichment create returned no rule");
      const custom = await this.fetchCustomEnrichments().catch((): CxCustomEnrichment[] => []);
      const names = new Map<number, string>();
      for (const c of custom) if (c.id !== undefined && c.name) names.set(c.id, c.name);
      return mapEnrichment(accountId, created, names);
    });
  }

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = requiredId(typeId, resourceId);
      switch (typeId) {
        case "alert": {
          const updated = await this.replaceAlert(id, (p) => {
            const name = (fields["name"] ?? "").trim();
            if (name) p.name = name;
            if ("description" in fields) p.description = fields["description"] ?? "";
            if ("priority" in fields && fields["priority"]) {
              p.priority = alertPriorityValue(fields["priority"]);
            }
          });
          return mapAlert(accountId, updated);
        }
        case "tco-policy": {
          const policy = await this.replacePolicy(id, (body) => {
            if ("name" in fields) body.name = (fields["name"] ?? "").trim() || body.name;
            if ("description" in fields) body.description = fields["description"] ?? "";
            if ("priority" in fields) {
              const p = policyPriorityValue(fields["priority"] ?? "");
              if (!p) throw new Error("Pick High, Medium, Low or Block.");
              body.priority = p;
            }
          });
          return mapPolicy(accountId, policy);
        }
        case "quota-rule": {
          const set = await this.fetchQuotaRuleSet();
          if (!set?.rules) throw new Error("Coralogix plugin: the team has no quota rule set");
          const rules = set.rules.map((r) => {
            if (r.entityType !== id) return r;
            const next = { ...r };
            if ("allocation" in fields && fields["allocation"] !== "") {
              const n = Number(fields["allocation"]);
              if (!Number.isFinite(n) || n < 0)
                throw new Error("Allocation must be a number of 0 or more.");
              if (next.allocationType !== "QUOTA_ALLOCATION_TYPE_LOCKED_UNITS" && n > 100) {
                throw new Error("A percentage allocation cannot be more than 100.");
              }
              next.allocation = n;
            }
            if ("canOverflow" in fields) next.canOverflow = fields["canOverflow"] === "true";
            if ("enabled" in fields) next.enabled = fields["enabled"] === "true";
            return next;
          });
          const res = await apiV5(this.ctx).put("/dataplan/quota-rules/v1", {
            body: { ruleSet: { ...(set.id ? { id: set.id } : {}), rules } },
          });
          const rule = (res?.ruleSet?.rules ?? rules).find((r) => r.entityType === id);
          if (!rule) throw new Error(`Coralogix plugin: quota rule "${id}" not found`);
          return mapQuotaRule(accountId, rule);
        }
        default:
          throw new Error(`Coralogix plugin: "${typeId}" cannot be edited from Infrawrench`);
      }
    });
  }

  /** Read an alert definition, let `edit` change its properties, and write it back. */
  private async replaceAlert(
    id: string,
    edit: (p: NonNullable<CxAlertDef["alertDefProperties"]>) => void,
  ): Promise<CxAlertDef> {
    const res = await apiV5(this.ctx).get(`/alerts/alerts/v3/${pathEncode(id)}`);
    const props = { ...(res?.alertDef?.alertDefProperties ?? {}) };
    if (!res?.alertDef) throw new Error(`Coralogix plugin: alert ${id} not found`);
    edit(props);
    const out = await apiV5(this.ctx).put("/alerts/alerts/v3", {
      body: { id, alertDefProperties: props },
    });
    return out?.alertDef ?? { ...res.alertDef, alertDefProperties: props };
  }

  /**
   * Read a TCO policy, copy the fields the update request accepts, let `edit`
   * change them, and write it back. The update replaces the whole policy, so
   * every documented field is carried over; read-only ones (order, company,
   * timestamps, override status) are not sent.
   */
  private async replacePolicy(id: string, edit: (body: PolicyUpdate) => void): Promise<CxPolicy> {
    const res = await apiV5(this.ctx).get(`/dataplans/policies/v1/${pathEncode(id)}`);
    const p = res?.policy;
    if (!p) throw new Error(`Coralogix plugin: policy ${id} not found`);
    const body: PolicyUpdate = {
      id,
      ...(p.name !== undefined ? { name: p.name } : {}),
      ...(p.description !== undefined ? { description: p.description } : {}),
      ...(p.priority !== undefined ? { priority: p.priority } : {}),
      ...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
      ...(p.applicationRule !== undefined ? { applicationRule: p.applicationRule } : {}),
      ...(p.subsystemRule !== undefined ? { subsystemRule: p.subsystemRule } : {}),
      ...(p.archiveRetention !== undefined ? { archiveRetention: p.archiveRetention } : {}),
      ...(p.logRules !== undefined ? { logRules: p.logRules } : {}),
      ...(p.spanRules !== undefined ? { spanRules: p.spanRules } : {}),
      ...(p.rumRules !== undefined ? { rumRules: p.rumRules } : {}),
      ...(p.priorityOverride !== undefined ? { priorityOverride: p.priorityOverride } : {}),
      ...(p.targets !== undefined ? { targets: p.targets } : {}),
    };
    edit(body);
    const out = await apiV5(this.ctx).put("/dataplans/policies/v1", { body });
    return out?.policy ?? { ...p, ...body };
  }

  /** Toggle a parsing rule group. The update replaces the group, rule ids excluded. */
  private async setRuleGroupEnabled(id: string, enabled: boolean): Promise<void> {
    const res = await apiV5(this.ctx).get(`/parsing-rules/rule-groups/v1/${pathEncode(id)}`);
    const g = res?.ruleGroup;
    if (!g) throw new Error(`Coralogix plugin: rule group ${id} not found`);
    const body = {
      name: g.name,
      ...(g.description !== undefined ? { description: g.description } : {}),
      ...(g.creator !== undefined ? { creator: g.creator } : {}),
      enabled,
      ...(g.hidden !== undefined ? { hidden: g.hidden } : {}),
      ...(g.order !== undefined ? { order: g.order } : {}),
      ruleMatchers: g.ruleMatchers ?? [],
      ruleSubgroups: (g.ruleSubgroups ?? []).map((s) => ({
        enabled: s.enabled,
        order: s.order,
        rules: (s.rules ?? []).map(({ id: _ruleId, ...rule }) => rule),
      })),
    };
    await apiV5(this.ctx).put(`/parsing-rules/rule-groups/v1/${pathEncode(id)}`, { body });
  }

  deleteResource(typeId: string, resourceId: string, _accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const raw = requiredId(typeId, resourceId);
      const id = pathEncode(raw);
      switch (typeId) {
        case "alert":
          await apiV5(this.ctx).delete(`/alerts/alerts/v3/${id}`);
          return;
        case "dashboard":
          await apiV5(this.ctx).delete(`/dashboards/dashboards/v1/${id}`);
          return;
        case "tco-policy":
          await apiV5(this.ctx).delete(`/dataplans/policies/v1/${id}`);
          return;
        case "parsing-rule-group":
          await apiV5(this.ctx).delete(`/parsing-rules/rule-groups/v1/${id}`);
          return;
        case "enrichment":
          await apiV5(this.ctx).delete("/enrichment-rules/enrichment-rules/v1", {
            query: { enrichment_ids: [raw] },
          });
          return;
        case "custom-enrichment":
          await apiV5(this.ctx).delete(`/enrichment-rules/custom-enrichment-rules/v1/${id}`);
          return;
        case "outgoing-webhook":
          await apiV5(this.ctx).delete(`/integrations/webhooks/v1/${id}`);
          return;
        case "events2metrics":
          await apiV5(this.ctx).delete(`/events2metrics/events2metrics/v2/${id}`);
          return;
        default:
          throw new Error(`Coralogix plugin: "${typeId}" cannot be deleted from Infrawrench`);
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
      const id = requiredId(typeId, resourceId);
      const toggle = actionId === "enable" || actionId === "disable";
      const enabled = actionId === "enable";
      if (typeId === "alert" && toggle) {
        await this.replaceAlert(id, (p) => {
          p.enabled = enabled;
        });
        return;
      }
      if (typeId === "tco-policy" && toggle) {
        await this.replacePolicy(id, (body) => {
          body.enabled = enabled;
        });
        return;
      }
      if (typeId === "parsing-rule-group" && toggle) {
        await this.setRuleGroupEnabled(id, enabled);
        return;
      }
      if (typeId === "dashboard") {
        if (actionId === "pin") {
          await apiV5(this.ctx).put(`/dashboards/pinned/v1/${pathEncode(id)}`);
          return;
        }
        if (actionId === "unpin") {
          await apiV5(this.ctx).delete(`/dashboards/pinned/v1/${pathEncode(id)}`);
          return;
        }
        if (actionId === "make-default") {
          await apiV5(this.ctx).put(`/dashboards/dashboards/v1/${pathEncode(id)}/default`, {
            body: { requestId: crypto.randomUUID() },
          });
          return;
        }
      }
      if (typeId === "outgoing-webhook" && actionId === "test") {
        const res = await apiV5(this.ctx).get(`/integrations/webhooks/v1/${pathEncode(id)}/test`);
        if (res?.failure) {
          const f = res.failure;
          throw new Error(
            `The test notification failed${f.statusCode ? ` (HTTP ${f.statusCode})` : ""}: ${f.displayMessage || f.errorMessage || "no details"}`,
          );
        }
        return;
      }
      if (
        typeId === "team" &&
        (actionId === "enable-usage-metrics" || actionId === "disable-usage-metrics")
      ) {
        await apiV4(this.ctx).post("/dataplans/data-usage/v2/export-status", {
          body: { enabled: actionId === "enable-usage-metrics" },
        });
        return;
      }
      throw new Error(`Coralogix plugin: unknown action "${actionId}" for "${typeId}"`);
    });
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderCoralogixDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderCoralogixSidebar(resource);
  }
}

/** The provider's id out of a resource id, refusing to act on one with nothing in it. */
function requiredId(typeId: string, resourceId: string): string {
  const id = externalIdOf(resourceId);
  if (!id.trim()) throw new Error(`Coralogix plugin: ${typeId} "${resourceId}" has no id`);
  return id;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
