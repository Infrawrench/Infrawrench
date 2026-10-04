import type {
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  ResourceInstance,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { CostSetupError, externalIdOf } from "@infrawrench/plugin-base";
import type { NewRelicAccount, NewRelicContext } from "./api.js";
import { listAccounts, nerdgraph, nrqlString, statusOf } from "./api.js";
import { fetchNewRelicCostData, fetchUsageSummary } from "./cost-data.js";
import type { NrCondition, NrEntity, NrPolicy } from "./mappers.js";
import {
  CONDITION_FIELDS,
  ENTITY_FIELDS,
  ENTITY_QUERIES,
  mapAccount,
  mapCondition,
  mapEntity,
  mapPolicy,
  parseScopedId,
} from "./mappers.js";
import {
  DEFAULT_METRICS_WINDOW_MS,
  USAGE_METRICS_WINDOW_MS,
  apmSeries,
  browserSeries,
  conditionSeries,
  hostSeries,
  rangeOrDefault,
  syntheticSeries,
  usageSeries,
} from "./metrics.js";
import type { NewRelicRates } from "./rates.js";
import { parseRates } from "./rates.js";
import type { NewRelicRegion } from "./regions.js";
import { resolveRegion } from "./regions.js";
import { USAGE_SUMMARY_KEY, renderNewRelicDetail, renderNewRelicSidebar } from "./render.js";

const MAX_ENTITY_PAGES = 50;
const MAX_ALERT_PAGES = 50;
/** Alert listing is per account; beyond this many accounts it stops (and says so in docs). */
const MAX_ALERT_ACCOUNTS = 100;
const ACCOUNT_CONCURRENCY = 5;

/**
 * Synthetic monitor update mutations, one per monitor type (NerdGraph has
 * no type-agnostic update). Keys are the entity outline's `monitorType`.
 */
const MONITOR_UPDATE: Record<string, { mutation: string; input: string }> = {
  SIMPLE: {
    mutation: "syntheticsUpdateSimpleMonitor",
    input: "SyntheticsUpdateSimpleMonitorInput",
  },
  BROWSER: {
    mutation: "syntheticsUpdateSimpleBrowserMonitor",
    input: "SyntheticsUpdateSimpleBrowserMonitorInput",
  },
  SCRIPT_API: {
    mutation: "syntheticsUpdateScriptApiMonitor",
    input: "SyntheticsUpdateScriptApiMonitorInput",
  },
  SCRIPT_BROWSER: {
    mutation: "syntheticsUpdateScriptBrowserMonitor",
    input: "SyntheticsUpdateScriptBrowserMonitorInput",
  },
  STEP_MONITOR: {
    mutation: "syntheticsUpdateStepMonitor",
    input: "SyntheticsUpdateStepMonitorInput",
  },
  BROKEN_LINKS: {
    mutation: "syntheticsUpdateBrokenLinksMonitor",
    input: "SyntheticsUpdateBrokenLinksMonitorInput",
  },
  CERT_CHECK: {
    mutation: "syntheticsUpdateCertCheckMonitor",
    input: "SyntheticsUpdateCertCheckMonitorInput",
  },
};

/** NRQL condition update mutations, one per condition type. */
const CONDITION_UPDATE: Record<string, { mutation: string; input: string }> = {
  STATIC: {
    mutation: "alertsNrqlConditionStaticUpdate",
    input: "AlertsNrqlConditionUpdateStaticInput",
  },
  BASELINE: {
    mutation: "alertsNrqlConditionBaselineUpdate",
    input: "AlertsNrqlConditionUpdateBaselineInput",
  },
  OUTLIER: {
    mutation: "alertsNrqlConditionOutlierUpdate",
    input: "AlertsNrqlConditionUpdateOutlierInput",
  },
};

const INCIDENT_PREFERENCES = ["PER_POLICY", "PER_CONDITION", "PER_CONDITION_AND_TARGET"];

/** Run `fn` over `items`, at most `limit` at a time. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export class NewRelicClient implements PluginClient {
  private readonly ctx: NewRelicContext;
  private readonly usageAccountId: number | undefined;
  private readonly rates: NewRelicRates;
  private accountsCache: Promise<NewRelicAccount[]> | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    if (!apiKey) throw new Error("New Relic plugin: missing apiKey credential");
    const caCert = credentials["caCert"] ?? "";
    this.ctx = {
      apiKey,
      region: resolveRegion(credentials["region"]),
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
    const rawAccount = (credentials["accountId"] ?? "").trim();
    const parsed = Number(rawAccount);
    if (rawAccount && !Number.isInteger(parsed)) {
      throw new Error(`New Relic plugin: account "${rawAccount}" is not a numeric account ID`);
    }
    this.usageAccountId = rawAccount ? parsed : undefined;
    this.rates = parseRates(credentials);
  }

  get region(): NewRelicRegion {
    return this.ctx.region;
  }

  private accounts(): Promise<NewRelicAccount[]> {
    this.accountsCache ??= listAccounts(this.ctx).catch((err: unknown) => {
      this.accountsCache = undefined;
      throw err;
    });
    return this.accountsCache;
  }

  private async accountById(id: number): Promise<NewRelicAccount> {
    const found = (await this.accounts().catch(() => [] as NewRelicAccount[])).find(
      (a) => a.id === id,
    );
    return found ?? { id, name: String(id) };
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    if (typeId === "account") {
      return (await this.accounts()).map((a) =>
        mapAccount(accountId, this.region, a, this.usageAccountId),
      );
    }
    if (typeId === "alert-policy") return this.listPolicies(accountId);
    if (typeId === "alert-condition") return this.listConditions(accountId);
    const query = ENTITY_QUERIES[typeId];
    if (!query) throw new Error(`New Relic plugin: unknown resource type "${typeId}"`);
    return (await this.searchEntities(query)).map((e) =>
      mapEntity(accountId, typeId, this.region, e),
    );
  }

  private async searchEntities(query: string): Promise<NrEntity[]> {
    const out: NrEntity[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_ENTITY_PAGES; page++) {
      const data: {
        actor?: {
          entitySearch?: {
            results?: { nextCursor?: string | null; entities?: NrEntity[] | null } | null;
          } | null;
        };
      } = await nerdgraph(
        this.ctx,
        `query($query: String!, $cursor: String) {
  actor { entitySearch(query: $query) { results(cursor: $cursor) { nextCursor entities { ${ENTITY_FIELDS} } } } }
}`,
        { query, cursor },
        { allowPartial: true },
      );
      const results = data.actor?.entitySearch?.results;
      out.push(...(results?.entities ?? []));
      cursor = results?.nextCursor ?? null;
      if (!cursor) break;
    }
    return out;
  }

  private async entityByGuid(guid: string): Promise<NrEntity | undefined> {
    const found = await this.searchEntities(`id = ${nrqlString(guid)}`);
    return found.find((e) => e.guid === guid) ?? found[0];
  }

  private alertAccounts(): Promise<NewRelicAccount[]> {
    return this.accounts().then((all) => all.slice(0, MAX_ALERT_ACCOUNTS));
  }

  private async policiesIn(account: NewRelicAccount): Promise<NrPolicy[]> {
    const out: NrPolicy[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_ALERT_PAGES; page++) {
      const data: {
        actor?: {
          account?: {
            alerts?: {
              policiesSearch?: { nextCursor?: string | null; policies?: NrPolicy[] | null } | null;
            } | null;
          } | null;
        };
      } = await nerdgraph(
        this.ctx,
        `query($accountId: Int!, $cursor: String) {
  actor { account(id: $accountId) { alerts { policiesSearch(cursor: $cursor) { nextCursor policies { id name incidentPreference accountId } } } } }
}`,
        { accountId: account.id, cursor },
      );
      const res = data.actor?.account?.alerts?.policiesSearch;
      out.push(...(res?.policies ?? []));
      cursor = res?.nextCursor ?? null;
      if (!cursor) break;
    }
    return out;
  }

  private async conditionsIn(account: NewRelicAccount): Promise<NrCondition[]> {
    const out: NrCondition[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_ALERT_PAGES; page++) {
      const data: {
        actor?: {
          account?: {
            alerts?: {
              nrqlConditionsSearch?: {
                nextCursor?: string | null;
                nrqlConditions?: NrCondition[] | null;
              } | null;
            } | null;
          } | null;
        };
      } = await nerdgraph(
        this.ctx,
        `query($accountId: Int!, $cursor: String) {
  actor { account(id: $accountId) { alerts { nrqlConditionsSearch(cursor: $cursor) { nextCursor nrqlConditions { ${CONDITION_FIELDS} } } } } }
}`,
        { accountId: account.id, cursor },
      );
      const res = data.actor?.account?.alerts?.nrqlConditionsSearch;
      out.push(...(res?.nrqlConditions ?? []));
      cursor = res?.nextCursor ?? null;
      if (!cursor) break;
    }
    return out;
  }

  /**
   * A permission error in one account (the key's user has no alerts access
   * there) lists that account empty; anything else fails the listing.
   */
  private async perAccount<T>(
    load: (a: NewRelicAccount) => Promise<T[]>,
  ): Promise<Array<[NewRelicAccount, T[]]>> {
    const accounts = await this.alertAccounts();
    return mapLimit(accounts, ACCOUNT_CONCURRENCY, async (a): Promise<[NewRelicAccount, T[]]> => {
      try {
        return [a, await load(a)];
      } catch (err) {
        if (statusOf(err) === 403) return [a, []];
        throw err;
      }
    });
  }

  private async listPolicies(accountId: string): Promise<ResourceInstance[]> {
    const all = await this.perAccount((a) => this.policiesIn(a));
    return all.flatMap(([a, policies]) => policies.map((p) => mapPolicy(accountId, a, p)));
  }

  private async listConditions(accountId: string): Promise<ResourceInstance[]> {
    const all = await this.perAccount(async (a) => {
      const [conditions, policies] = await Promise.all([this.conditionsIn(a), this.policiesIn(a)]);
      const names = new Map(policies.map((p) => [String(p.id), p.name ?? String(p.id)]));
      return conditions.map((c) => ({ c, names }));
    });
    return all.flatMap(([a, rows]) =>
      rows.map(({ c, names }) => mapCondition(accountId, a, c, names)),
    );
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
      case "account": {
        const nrId = Number(id);
        const account = await this.accountById(nrId);
        if (nrId !== this.usageAccountId) {
          return mapAccount(accountId, this.region, account, this.usageAccountId);
        }
        const summary = await fetchUsageSummary(this.ctx, nrId, this.rates).catch(() => undefined);
        const r = mapAccount(
          accountId,
          this.region,
          account,
          this.usageAccountId,
          summary?.totalCost,
        );
        return summary
          ? {
              ...r,
              resolvedOutputs: {
                ...r.resolvedOutputs,
                [USAGE_SUMMARY_KEY]: JSON.stringify(summary),
              },
            }
          : r;
      }
      case "alert-policy": {
        const { nrAccountId, id: policyId } = parseScopedId(id);
        const data = await nerdgraph<{
          actor?: { account?: { alerts?: { policy?: NrPolicy | null } | null } | null };
        }>(
          this.ctx,
          `query($accountId: Int!, $id: ID!) { actor { account(id: $accountId) { alerts { policy(id: $id) { id name incidentPreference accountId } } } } }`,
          { accountId: nrAccountId, id: policyId },
        );
        const p = data.actor?.account?.alerts?.policy;
        if (!p) throw new Error(`New Relic plugin: alert policy ${policyId} not found`);
        return mapPolicy(accountId, await this.accountById(nrAccountId), p);
      }
      case "alert-condition": {
        const { nrAccountId, id: conditionId } = parseScopedId(id);
        const c = await this.fetchCondition(nrAccountId, conditionId);
        const account = await this.accountById(nrAccountId);
        const names = new Map<string, string>();
        if (c.policyId !== undefined) {
          const policies = await this.policiesIn(account).catch(() => [] as NrPolicy[]);
          for (const p of policies) names.set(String(p.id), p.name ?? String(p.id));
        }
        return mapCondition(accountId, account, c, names);
      }
      default: {
        if (!ENTITY_QUERIES[typeId]) break;
        const e = await this.entityByGuid(id);
        if (!e) throw new Error(`New Relic plugin: entity ${id} not found`);
        return mapEntity(accountId, typeId, this.region, e);
      }
    }
    throw new Error(`New Relic plugin: unknown resource type "${typeId}"`);
  }

  private async fetchCondition(nrAccountId: number, conditionId: string): Promise<NrCondition> {
    const data = await nerdgraph<{
      actor?: { account?: { alerts?: { nrqlCondition?: NrCondition | null } | null } | null };
    }>(
      this.ctx,
      `query($accountId: Int!, $id: ID!) { actor { account(id: $accountId) { alerts { nrqlCondition(id: $id) { ${CONDITION_FIELDS} } } } } }`,
      { accountId: nrAccountId, id: conditionId },
    );
    const c = data.actor?.account?.alerts?.nrqlCondition;
    if (!c) throw new Error(`New Relic plugin: alert condition ${conditionId} not found`);
    return c;
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
    throw new Error(`New Relic plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
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
    const show = (v: unknown, suffix = "") => (v === undefined ? "—" : `${String(v)}${suffix}`);
    const severity = String(f["alertSeverity"] ?? "");
    const severityStat: DashboardStat = {
      label: "Alerts",
      value: severity ? severity.replace(/_/g, " ").toLowerCase() : "—",
      variant:
        severity === "CRITICAL"
          ? "status-error"
          : severity === "WARNING"
            ? "status-degraded"
            : severity === "NOT_ALERTING"
              ? "status-healthy"
              : "default",
    };
    switch (resourceTypeId) {
      case "account":
        return [
          {
            label: "Estimated month to date",
            value:
              typeof f["monthToDate"] === "number"
                ? `$${f["monthToDate"].toLocaleString("en-US", { maximumFractionDigits: 0 })}`
                : "—",
          },
        ];
      case "apm-application":
        return [
          severityStat,
          { label: "Apdex", value: show(f["apdex"]) },
          { label: "Response time", value: show(f["responseTimeMs"], " ms") },
          { label: "Error rate", value: show(f["errorRate"], "%") },
        ];
      case "browser-application":
        return [
          severityStat,
          { label: "Page load", value: show(f["pageLoadTime"], " s") },
          { label: "JS errors", value: show(f["jsErrorRate"], "%") },
        ];
      case "host":
        return [
          severityStat,
          { label: "CPU", value: show(f["cpuPercent"], "%") },
          { label: "Memory", value: show(f["memoryPercent"], "%") },
        ];
      case "synthetic-monitor":
        return [
          severityStat,
          { label: "Status", value: show(f["status"]) },
          { label: "Success rate", value: show(f["successRate"], "%") },
        ];
      case "alert-condition":
        return [{ label: "Enabled", value: f["enabled"] === true ? "Yes" : "No" }];
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
    const range = rangeOrDefault(timeRange, DEFAULT_METRICS_WINDOW_MS);
    switch (resourceTypeId) {
      case "account": {
        const nrId = Number(id);
        return usageSeries(this.ctx, nrId, rangeOrDefault(timeRange, USAGE_METRICS_WINDOW_MS));
      }
      case "apm-application":
      case "browser-application":
      case "host":
      case "synthetic-monitor": {
        const r = await this.getResource(resourceTypeId, resourceId, accountId);
        const nrAccountId = Number(r.fields["nrAccountId"]);
        if (!Number.isInteger(nrAccountId)) return [];
        if (resourceTypeId === "apm-application")
          return apmSeries(this.ctx, nrAccountId, id, range);
        if (resourceTypeId === "browser-application") {
          return browserSeries(this.ctx, nrAccountId, id, range);
        }
        if (resourceTypeId === "host") return hostSeries(this.ctx, nrAccountId, id, range);
        const monitorId = String(r.fields["monitorId"] ?? "");
        return monitorId ? syntheticSeries(this.ctx, nrAccountId, monitorId, range) : [];
      }
      case "alert-condition": {
        const { nrAccountId, id: conditionId } = parseScopedId(id);
        const c = await this.fetchCondition(nrAccountId, conditionId);
        const dataAccount = c.nrql?.dataAccountId ?? nrAccountId;
        return conditionSeries(this.ctx, dataAccount, c.nrql?.query ?? "", range);
      }
      default:
        return [];
    }
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    if (this.usageAccountId === undefined) {
      throw new CostSetupError(
        "Pick a usage account under Edit credentials: New Relic records usage in the organization's parent (or reporting) account, and cost is read from there.",
      );
    }
    return fetchNewRelicCostData(this.ctx, this.usageAccountId, this.rates, range);
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId !== "alert-policy") {
      throw new Error(`New Relic plugin: cannot create "${typeId}" from Infrawrench`);
    }
    const accounts = await this.accounts().catch(() => [] as NewRelicAccount[]);
    const fallback = this.usageAccountId ?? accounts[0]?.id;
    return {
      fields: [
        {
          key: "nrAccountId",
          label: "Account",
          kind: "select",
          required: true,
          description: "The New Relic account the policy belongs to.",
          ...(fallback !== undefined ? { defaultValue: String(fallback) } : {}),
          options: accounts.map((a) => ({
            id: String(a.id),
            label: a.name,
            description: String(a.id),
          })),
        },
        {
          key: "name",
          label: "Name",
          kind: "text",
          required: true,
          placeholder: "Production services",
        },
        {
          key: "incidentPreference",
          label: "Incident preference",
          kind: "select",
          required: true,
          defaultValue: "PER_CONDITION",
          description: "How violations of this policy's conditions are grouped into incidents.",
          options: [
            { id: "PER_POLICY", label: "One incident per policy" },
            { id: "PER_CONDITION", label: "One incident per condition" },
            { id: "PER_CONDITION_AND_TARGET", label: "One incident per condition and entity" },
          ],
        },
      ],
    };
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId !== "alert-policy") {
      throw new Error(`New Relic plugin: cannot create "${typeId}" from Infrawrench`);
    }
    const nrAccountId = Number(fields["nrAccountId"] ?? this.usageAccountId);
    if (!Number.isInteger(nrAccountId)) throw new Error("New Relic plugin: pick an account");
    const name = (fields["name"] ?? "").trim();
    if (!name) throw new Error("New Relic plugin: a policy needs a name");
    const preference = INCIDENT_PREFERENCES.includes(fields["incidentPreference"] ?? "")
      ? fields["incidentPreference"]
      : "PER_CONDITION";
    const data = await nerdgraph<{ alertsPolicyCreate?: NrPolicy | null }>(
      this.ctx,
      `mutation($accountId: Int!, $policy: AlertsPolicyInput!) { alertsPolicyCreate(accountId: $accountId, policy: $policy) { id name incidentPreference accountId } }`,
      { accountId: nrAccountId, policy: { name, incidentPreference: preference } },
    );
    if (!data.alertsPolicyCreate)
      throw new Error("New Relic plugin: policy create returned nothing");
    return mapPolicy(accountId, await this.accountById(nrAccountId), data.alertsPolicyCreate);
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    if (typeId === "alert-policy") {
      const { nrAccountId, id: policyId } = parseScopedId(id);
      const policy: Record<string, string> = {};
      if ("name" in fields && fields["name"]?.trim()) policy["name"] = fields["name"].trim();
      if (
        "incidentPreference" in fields &&
        INCIDENT_PREFERENCES.includes(fields["incidentPreference"] ?? "")
      ) {
        policy["incidentPreference"] = fields["incidentPreference"]!;
      }
      const data = await nerdgraph<{ alertsPolicyUpdate?: NrPolicy | null }>(
        this.ctx,
        `mutation($accountId: Int!, $id: ID!, $policy: AlertsPolicyUpdateInput!) { alertsPolicyUpdate(accountId: $accountId, id: $id, policy: $policy) { id name incidentPreference accountId } }`,
        { accountId: nrAccountId, id: policyId, policy },
      );
      if (!data.alertsPolicyUpdate)
        throw new Error("New Relic plugin: policy update returned nothing");
      return mapPolicy(accountId, await this.accountById(nrAccountId), data.alertsPolicyUpdate);
    }
    if (typeId === "alert-condition") {
      const condition: Record<string, unknown> = {};
      if ("name" in fields && fields["name"]?.trim()) condition["name"] = fields["name"].trim();
      if ("description" in fields) condition["description"] = fields["description"] ?? "";
      if ("runbookUrl" in fields) condition["runbookUrl"] = fields["runbookUrl"] ?? "";
      await this.updateCondition(id, condition);
      return this.getResource(typeId, resourceId, accountId);
    }
    if (typeId === "synthetic-monitor") {
      const monitor: Record<string, unknown> = {};
      if ("name" in fields && fields["name"]?.trim()) monitor["name"] = fields["name"].trim();
      if ("period" in fields && fields["period"]) monitor["period"] = fields["period"];
      await this.updateMonitor(resourceId, accountId, monitor);
      return this.getResource(typeId, resourceId, accountId);
    }
    throw new Error(`New Relic plugin: "${typeId}" cannot be edited from Infrawrench`);
  }

  private async updateCondition(
    externalId: string,
    condition: Record<string, unknown>,
  ): Promise<void> {
    const { nrAccountId, id } = parseScopedId(externalId);
    const current = await this.fetchCondition(nrAccountId, id);
    const op = CONDITION_UPDATE[current.type ?? ""];
    if (!op) {
      throw new Error(
        `New Relic plugin: conditions of type "${current.type ?? "unknown"}" cannot be edited`,
      );
    }
    await nerdgraph(
      this.ctx,
      `mutation($accountId: Int!, $id: ID!, $condition: ${op.input}!) { ${op.mutation}(accountId: $accountId, id: $id, condition: $condition) { id } }`,
      { accountId: nrAccountId, id, condition },
    );
  }

  private async updateMonitor(
    resourceId: string,
    accountId: string,
    monitor: Record<string, unknown>,
  ): Promise<void> {
    const guid = externalIdOf(resourceId);
    const r = await this.getResource("synthetic-monitor", resourceId, accountId);
    const type = String(r.fields["monitorType"] ?? "");
    const op = MONITOR_UPDATE[type];
    if (!op) throw new Error(`New Relic plugin: monitors of type "${type}" cannot be edited`);
    const data = await nerdgraph<
      Record<string, { errors?: Array<{ description?: string }> | null } | null>
    >(
      this.ctx,
      `mutation($guid: EntityGuid!, $monitor: ${op.input}!) { ${op.mutation}(guid: $guid, monitor: $monitor) { errors { description type } } }`,
      { guid, monitor },
    );
    const errors = data[op.mutation]?.errors ?? [];
    if (errors.length > 0) {
      throw new Error(
        `New Relic: ${errors.map((e) => e.description ?? "update failed").join("; ")}`,
      );
    }
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const id = externalIdOf(resourceId);
    switch (typeId) {
      case "alert-policy": {
        const { nrAccountId, id: policyId } = parseScopedId(id);
        await nerdgraph(
          this.ctx,
          `mutation($accountId: Int!, $id: ID!) { alertsPolicyDelete(accountId: $accountId, id: $id) { id } }`,
          { accountId: nrAccountId, id: policyId },
        );
        return;
      }
      case "alert-condition": {
        const { nrAccountId, id: conditionId } = parseScopedId(id);
        await nerdgraph(
          this.ctx,
          `mutation($accountId: Int!, $id: ID!) { alertsConditionDelete(accountId: $accountId, id: $id) { id } }`,
          { accountId: nrAccountId, id: conditionId },
        );
        return;
      }
      case "synthetic-monitor":
        await nerdgraph(
          this.ctx,
          `mutation($guid: EntityGuid!) { syntheticsDeleteMonitor(guid: $guid) { deletedGuid } }`,
          { guid: id },
        );
        return;
      case "dashboard": {
        const data = await nerdgraph<{
          dashboardDelete?: { status?: string; errors?: Array<{ description?: string }> | null };
        }>(
          this.ctx,
          `mutation($guid: EntityGuid!) { dashboardDelete(guid: $guid) { status errors { description type } } }`,
          { guid: id },
        );
        const errors = data.dashboardDelete?.errors ?? [];
        if (errors.length > 0) {
          throw new Error(
            `New Relic: ${errors.map((e) => e.description ?? "delete failed").join("; ")}`,
          );
        }
        return;
      }
      case "workload":
        await nerdgraph(
          this.ctx,
          `mutation($guid: EntityGuid!) { workloadDelete(guid: $guid) { guid } }`,
          {
            guid: id,
          },
        );
        return;
      default:
        throw new Error(`New Relic plugin: "${typeId}" cannot be deleted from Infrawrench`);
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): Promise<void> {
    const id = externalIdOf(resourceId);
    if (typeId === "alert-condition" && (actionId === "enable" || actionId === "disable")) {
      await this.updateCondition(id, { enabled: actionId === "enable" });
      return;
    }
    if (typeId === "synthetic-monitor" && (actionId === "enable" || actionId === "disable")) {
      await this.updateMonitor(resourceId, accountId, {
        status: actionId === "enable" ? "ENABLED" : "DISABLED",
      });
      return;
    }
    throw new Error(`New Relic plugin: unknown action "${actionId}" for "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderNewRelicDetail(resource, this.region, this.rates);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderNewRelicSidebar(resource);
  }
}
