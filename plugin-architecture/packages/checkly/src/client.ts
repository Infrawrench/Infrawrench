import type {
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  PreflightResult,
  QuotaUsage,
  ResourceInstance,
  SecretHostServices,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { QuotaAccessError, externalIdOf } from "@infrawrench/plugin-base";
import type { ChecklyContext } from "./api.js";
import { ckFetch, ckPaged, statusOf } from "./api.js";
import type { CheckStatus, Obj } from "./mappers.js";
import {
  mapChannel,
  mapCheck,
  mapDashboard,
  mapGroup,
  mapPrivateLocation,
  mapStatusPage,
  mapVariable,
  mapWindow,
  resourceIdFor,
} from "./mappers.js";
import {
  DEFAULT_METRICS_WINDOW_MS,
  checkAnalytics,
  checkResultSeries,
  privateLocationSeries,
  rangeOrDefault,
} from "./metrics.js";
import { verifyChecklyCredentials } from "./preflight.js";
import { ANALYTICS_KEY, renderChecklyDetail, renderChecklySidebar } from "./render.js";

const AGENT_KEY_FIELD = "agentKey";
const opt = (id: string, label = id) => ({ id, label });

function trimmed(fields: Record<string, string>, key: string): string {
  return (fields[key] ?? "").trim();
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function csv(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function pickList(raw: string | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || "[]") as unknown;
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // comma-separated fallback
  }
  return csv(raw);
}

/** Update route per check type; Playwright suites and agentic checks have none of their own. */
export const UPDATE_PATH: Record<string, string> = {
  API: "api",
  BROWSER: "browser",
  DNS: "dns",
  GRPC: "grpc",
  HEARTBEAT: "heartbeat",
  ICMP: "icmp",
  MULTI_STEP: "multistep",
  SSL: "ssl",
  TCP: "tcp",
  TRACEROUTE: "traceroute",
  URL: "url",
};

/**
 * Keys the per-type `PUT /v1/checks/{type}/{id}` bodies accept (the union
 * across types in Checkly's OpenAPI document). A check read back is filtered
 * to these before being sent, so read-only fields (`id`, timestamps,
 * `projectBindings`, the deprecated `alertChannels`) never go back.
 */
export const CHECK_WRITABLE = new Set([
  "activated",
  "aiAutoRepairEnabled",
  "alertChannelSubscriptions",
  "alertSettings",
  "checkType",
  "description",
  "doubleCheck",
  "frequency",
  "groupId",
  "groupOrder",
  "intent",
  "locations",
  "muted",
  "name",
  "runParallel",
  "runtimeId",
  "shouldFail",
  "tags",
  "triggerIncident",
  "useGlobalAlertSettings",
  "degradedResponseTime",
  "frequencyOffset",
  "localSetupScript",
  "localTearDownScript",
  "maxResponseTime",
  "privateLocations",
  "request",
  "retryStrategy",
  "setupSnippetId",
  "tearDownSnippetId",
  "dependencies",
  "environmentVariables",
  "script",
  "scriptPath",
  "sslCheckDomain",
  "heartbeat",
  "degradedPacketLossThreshold",
  "maxPacketLossThreshold",
]);

export const GROUP_WRITABLE = new Set([
  "activated",
  "alertChannelSubscriptions",
  "alertSettings",
  "apiCheckDefaults",
  "browserCheckDefaults",
  "concurrency",
  "doubleCheck",
  "environmentVariables",
  "localSetupScript",
  "localTearDownScript",
  "locations",
  "muted",
  "name",
  "privateLocations",
  "retryStrategy",
  "runParallel",
  "runtimeId",
  "setupSnippetId",
  "tags",
  "tearDownSnippetId",
  "useGlobalAlertSettings",
]);

export function writable(obj: Obj, keys: Set<string>): Obj {
  return Object.fromEntries(Object.entries(obj).filter(([k, v]) => keys.has(k) && v !== undefined));
}

/** The alert channel `config` for a new channel of a type. */
export function channelConfig(type: string, fields: Record<string, string>): Obj {
  const target = trimmed(fields, "target");
  const name = trimmed(fields, "name");
  const secret = trimmed(fields, "secret");
  switch (type) {
    case "EMAIL":
      return { address: target };
    case "SLACK":
      return { url: target, ...(name ? { channel: name } : {}) };
    case "WEBHOOK":
      return { name: name || target, url: target, method: "POST", webhookType: "WEBHOOK" };
    case "SMS":
    case "CALL":
      return { number: target, name: name || target };
    case "PAGERDUTY":
      return { serviceKey: secret, ...(name ? { serviceName: name } : {}) };
    case "OPSGENIE":
      return {
        name: name || "Opsgenie",
        apiKey: secret,
        region: trimmed(fields, "region") || "US",
        priority: "P3",
      };
    default:
      throw new Error(`Unsupported alert channel type "${type}"`);
  }
}

export class ChecklyClient implements PluginClient {
  private readonly ctx: ChecklyContext;
  private readonly secrets: SecretHostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    const accountId = (credentials["accountId"] ?? "").trim();
    if (!apiKey) throw new Error("Checkly plugin: missing apiKey credential");
    if (!accountId) throw new Error("Checkly plugin: missing accountId credential");
    const caCert = credentials["caCert"] ?? "";
    this.ctx = {
      apiKey,
      accountId,
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
    this.secrets = services?.secrets;
  }

  /** A 403 means the key's role cannot see that area: list it empty. */
  private async scoped(load: () => Promise<ResourceInstance[]>): Promise<ResourceInstance[]> {
    try {
      return await load();
    } catch (err) {
      if (statusOf(err) === 403) return [];
      throw err;
    }
  }

  private async statuses(): Promise<Map<string, CheckStatus>> {
    const list = await ckFetch<CheckStatus[]>(this.ctx, "/v1/check-statuses").catch(
      () => [] as CheckStatus[],
    );
    return new Map((list ?? []).filter((s) => s.checkId).map((s) => [s.checkId as string, s]));
  }

  // -------------------------------------------------------------------------
  // Listing and reads
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    return this.scoped(async () => {
      switch (typeId) {
        case "check": {
          const [checks, statuses] = await Promise.all([
            ckPaged<Obj>(this.ctx, "/v1/checks"),
            this.statuses(),
          ]);
          return checks.map((c) => mapCheck(accountId, c, statuses.get(String(c["id"]))));
        }
        case "check-group": {
          const [groups, checks] = await Promise.all([
            ckPaged<Obj>(this.ctx, "/v1/check-groups"),
            ckPaged<Obj>(this.ctx, "/v1/checks").catch(() => [] as Obj[]),
          ]);
          const counts = new Map<string, number>();
          for (const c of checks) {
            if (c["groupId"] !== undefined && c["groupId"] !== null) {
              const g = String(c["groupId"]);
              counts.set(g, (counts.get(g) ?? 0) + 1);
            }
          }
          return groups.map((g) => mapGroup(accountId, g, counts.get(String(g["id"])) ?? 0));
        }
        case "alert-channel":
          return (await ckPaged<Obj>(this.ctx, "/v1/alert-channels")).map((c) =>
            mapChannel(accountId, c),
          );
        case "maintenance-window":
          return (await ckPaged<Obj>(this.ctx, "/v1/maintenance-windows")).map((w) =>
            mapWindow(accountId, w),
          );
        case "private-location":
          return ((await ckFetch<Obj[]>(this.ctx, "/v1/private-locations")) ?? []).map((p) =>
            mapPrivateLocation(accountId, p),
          );
        case "dashboard":
          return (await ckPaged<Obj>(this.ctx, "/v1/dashboards")).map((d) =>
            mapDashboard(accountId, d),
          );
        case "status-page": {
          const out: Obj[] = [];
          let nextId: string | undefined;
          for (let i = 0; i < 20; i++) {
            const res = await ckFetch<{ entries?: Obj[]; nextId?: string | null }>(
              this.ctx,
              "/v3/status-pages",
              {
                query: { limit: 100, ...(nextId ? { nextId } : {}) },
              },
            );
            out.push(...(res.entries ?? []));
            nextId = res.nextId ?? undefined;
            if (!nextId) break;
          }
          return out.map((p) => mapStatusPage(accountId, p));
        }
        case "variable":
          return (await ckPaged<Obj>(this.ctx, "/v1/variables")).map((v) =>
            mapVariable(accountId, v),
          );
        default:
          throw new Error(`Checkly plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  private async rawCheck(id: string): Promise<Obj> {
    return ckFetch<Obj>(this.ctx, `/v1/checks/${encodeURIComponent(id)}`);
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = encodeURIComponent(externalIdOf(resourceId));
    switch (typeId) {
      case "check": {
        const [c, statuses] = await Promise.all([
          this.rawCheck(externalIdOf(resourceId)),
          this.statuses(),
        ]);
        return mapCheck(accountId, c, statuses.get(String(c["id"])));
      }
      case "check-group": {
        const [g, checks] = await Promise.all([
          ckFetch<Obj>(this.ctx, `/v1/check-groups/${id}`),
          ckFetch<Obj[]>(this.ctx, `/v1/check-groups/${id}/checks`, {
            query: { limit: 100 },
          }).catch(() => [] as Obj[]),
        ]);
        return mapGroup(accountId, g, (checks ?? []).length);
      }
      case "alert-channel":
        return mapChannel(accountId, await ckFetch<Obj>(this.ctx, `/v1/alert-channels/${id}`));
      case "maintenance-window":
        return mapWindow(accountId, await ckFetch<Obj>(this.ctx, `/v1/maintenance-windows/${id}`));
      case "private-location":
        return mapPrivateLocation(
          accountId,
          await ckFetch<Obj>(this.ctx, `/v1/private-locations/${id}`),
        );
      case "dashboard":
        return mapDashboard(accountId, await ckFetch<Obj>(this.ctx, `/v1/dashboards/${id}`));
      case "status-page":
        return mapStatusPage(accountId, await ckFetch<Obj>(this.ctx, `/v3/status-pages/${id}`));
      case "variable":
        return mapVariable(accountId, await ckFetch<Obj>(this.ctx, `/v1/variables/${id}`));
      default:
        throw new Error(`Checkly plugin: unknown resource type "${typeId}"`);
    }
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "private-location" && outputKey === AGENT_KEY_FIELD) {
      const stored = this.secrets
        ? await this.secrets.getPlaintext(resourceId, AGENT_KEY_FIELD).catch(() => null)
        : null;
      if (stored) return stored;
      throw new Error(
        "Use Generate agent key on the private location first: Checkly shows a key only when it is created.",
      );
    }
    const r = await this.getResource(typeId, resourceId, accountId);
    const value = r.resolvedOutputs[outputKey] ?? r.fields[outputKey];
    if (value === undefined)
      throw new Error(`Checkly plugin: cannot resolve output "${outputKey}" for "${typeId}"`);
    return String(value);
  }

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    if (resource.resourceTypeId !== "check" || !resource.externalId) return resource;
    const analytics = await checkAnalytics(
      this.ctx,
      resource.externalId,
      String(resource.fields["checkType"] ?? ""),
    );
    return {
      ...resource,
      resolvedOutputs: { ...resource.resolvedOutputs, [ANALYTICS_KEY]: JSON.stringify(analytics) },
    };
  }

  // -------------------------------------------------------------------------
  // Metrics, stats, quotas
  // -------------------------------------------------------------------------

  async fetchMetricSeries(
    typeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const id = externalIdOf(resourceId);
    const range = rangeOrDefault(timeRange, DEFAULT_METRICS_WINDOW_MS);
    if (typeId === "check") return checkResultSeries(this.ctx, id, range);
    if (typeId === "private-location") return privateLocationSeries(this.ctx, id, range);
    return [];
  }

  async fetchDashboardStats(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const r = await this.getResource(typeId, resourceId, accountId);
    if (typeId === "check") {
      const status = String(r.fields["status"] ?? "");
      return [
        {
          label: "Status",
          value: status || "—",
          variant:
            status === "Passing"
              ? "status-healthy"
              : status === "Degraded"
                ? "status-degraded"
                : status
                  ? "status-error"
                  : "default",
        },
        {
          label: "Every",
          value: r.fields["frequency"] !== undefined ? `${String(r.fields["frequency"])} min` : "—",
        },
      ];
    }
    if (typeId === "private-location")
      return [{ label: "Agents", value: String(r.fields["agentCount"] ?? 0) }];
    return [];
  }

  /**
   * Credit consumption against the current usage term's budget, for accounts
   * on a credit package (`GET /v2/usage/terms` + `/v2/usage/summary`). Both
   * numbers come from Checkly; accounts on a limits plan report nothing.
   */
  async fetchQuotas(): Promise<QuotaUsage[]> {
    const today = new Date().toISOString().slice(0, 10);
    let terms: Array<{
      id?: string;
      name?: string;
      creditBudget?: number;
      usageStartDate?: string;
      contractEndDate?: string;
      packageModel?: string;
    }>;
    try {
      terms =
        (
          await ckFetch<{ data?: typeof terms }>(this.ctx, "/v2/usage/terms", {
            query: { from: today, to: today },
          })
        ).data ?? [];
    } catch (err) {
      const status = statusOf(err);
      if (status === 401 || status === 403)
        throw new QuotaAccessError(
          "The Checkly API key cannot read usage terms (an Owner or Admin role can).",
        );
      throw err;
    }
    const out: QuotaUsage[] = [];
    for (const term of terms) {
      if (!term.id || term.packageModel !== "credits" || !(Number(term.creditBudget) > 0)) continue;
      const summary = await ckFetch<{ totals?: { creditsUsed?: number | null } }>(
        this.ctx,
        "/v2/usage/summary",
        {
          query: {
            usageTermsIds: [term.id],
            ...(term.usageStartDate ? { from: term.usageStartDate.slice(0, 10) } : {}),
            to: today,
          },
        },
      );
      const used = summary.totals?.creditsUsed;
      if (typeof used !== "number") continue;
      out.push({
        id: `credits/${term.id}`,
        service: "usage",
        name: `Credits used (${term.name ?? "current term"})`,
        limit: Number(term.creditBudget),
        used,
        unit: "credits",
      });
    }
    return out;
  }

  async verifyCredentials(): Promise<PreflightResult> {
    return verifyChecklyCredentials(this.ctx);
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  private async locationOptions() {
    const locs = await ckFetch<Array<{ region?: string; name?: string }>>(
      this.ctx,
      "/v1/locations",
    ).catch(() => []);
    return (locs ?? [])
      .filter((l) => l.region)
      .map((l) => ({
        id: l.region as string,
        label: `${l.name ?? l.region} (${l.region})`,
        category: "Locations",
      }));
  }

  private async groupOptions() {
    const groups = await ckPaged<Obj>(this.ctx, "/v1/check-groups").catch(() => [] as Obj[]);
    return [
      opt("", "None"),
      ...groups.map((g) => opt(String(g["id"]), String(g["name"] ?? g["id"]))),
    ];
  }

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case "check":
        return {
          fields: [
            {
              key: "checkType",
              label: "Type",
              kind: "select",
              required: true,
              defaultValue: "URL",
              options: [
                opt("URL", "URL monitor"),
                opt("API", "API check"),
                opt("TCP", "TCP monitor"),
                opt("ICMP", "Ping (ICMP) monitor"),
                opt("DNS", "DNS monitor"),
                opt("HEARTBEAT", "Heartbeat monitor"),
              ],
              description:
                "Browser, multistep and Playwright checks need a script: create them with the Checkly CLI or in Checkly.",
            },
            { key: "name", label: "Name", kind: "text", required: true },
            {
              key: "url",
              label: "URL",
              kind: "text",
              required: false,
              placeholder: "https://example.com/health",
              showWhen: { fieldKey: "checkType", fieldValues: ["URL", "API"] },
            },
            {
              key: "method",
              label: "Method",
              kind: "select",
              required: false,
              defaultValue: "GET",
              options: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].map((m) => opt(m)),
              showWhen: { fieldKey: "checkType", fieldValue: "API" },
            },
            {
              key: "expectedStatus",
              label: "Expected status code",
              kind: "number",
              required: false,
              defaultValue: "200",
              showWhen: { fieldKey: "checkType", fieldValue: "API" },
            },
            {
              key: "hostname",
              label: "Host",
              kind: "text",
              required: false,
              placeholder: "db.example.com",
              showWhen: { fieldKey: "checkType", fieldValues: ["TCP", "ICMP", "DNS"] },
            },
            {
              key: "port",
              label: "Port",
              kind: "number",
              required: false,
              showWhen: { fieldKey: "checkType", fieldValue: "TCP" },
            },
            {
              key: "recordType",
              label: "Record type",
              kind: "select",
              required: false,
              defaultValue: "A",
              options: ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SOA", "HTTPS"].map((r) => opt(r)),
              showWhen: { fieldKey: "checkType", fieldValue: "DNS" },
            },
            {
              key: "period",
              label: "Expect a ping every (minutes)",
              kind: "number",
              required: false,
              defaultValue: "60",
              showWhen: { fieldKey: "checkType", fieldValue: "HEARTBEAT" },
            },
            {
              key: "grace",
              label: "Grace (minutes)",
              kind: "number",
              required: false,
              defaultValue: "10",
              showWhen: { fieldKey: "checkType", fieldValue: "HEARTBEAT" },
            },
            {
              key: "frequency",
              label: "Run every (minutes)",
              kind: "select",
              required: false,
              defaultValue: "10",
              options: [
                "1",
                "2",
                "5",
                "10",
                "15",
                "30",
                "60",
                "120",
                "180",
                "360",
                "720",
                "1440",
              ].map((f) => opt(f)),
              showWhen: { fieldKey: "checkType", fieldValuesNot: ["HEARTBEAT"] },
            },
            {
              key: "locations",
              label: "Locations",
              kind: "policy-picker",
              required: false,
              policies: await this.locationOptions(),
              showWhen: { fieldKey: "checkType", fieldValuesNot: ["HEARTBEAT"] },
            },
            {
              key: "groupId",
              label: "Group",
              kind: "select",
              required: false,
              defaultValue: "",
              options: await this.groupOptions(),
            },
            {
              key: "tags",
              label: "Tags",
              kind: "text",
              required: false,
              placeholder: "production, api",
            },
          ],
        };
      case "check-group":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            {
              key: "locations",
              label: "Locations",
              kind: "policy-picker",
              required: false,
              policies: await this.locationOptions(),
            },
            { key: "tags", label: "Tags", kind: "text", required: false },
            {
              key: "concurrency",
              label: "Concurrency",
              kind: "number",
              required: false,
              defaultValue: "3",
            },
          ],
        };
      case "alert-channel":
        return {
          fields: [
            {
              key: "type",
              label: "Type",
              kind: "select",
              required: true,
              defaultValue: "EMAIL",
              options: [
                opt("EMAIL", "Email"),
                opt("SLACK", "Slack (incoming webhook)"),
                opt("WEBHOOK", "Webhook"),
                opt("SMS", "SMS"),
                opt("CALL", "Phone call"),
                opt("PAGERDUTY", "PagerDuty"),
                opt("OPSGENIE", "Opsgenie"),
              ],
            },
            {
              key: "target",
              label: "Address, URL or number",
              kind: "text",
              required: false,
              showWhen: {
                fieldKey: "type",
                fieldValues: ["EMAIL", "SLACK", "WEBHOOK", "SMS", "CALL"],
              },
            },
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: false,
              description: "Webhook, SMS, call and Opsgenie name, or a Slack channel.",
            },
            {
              key: "secret",
              label: "Integration key or API key",
              kind: "text",
              required: false,
              showWhen: { fieldKey: "type", fieldValues: ["PAGERDUTY", "OPSGENIE"] },
            },
            {
              key: "region",
              label: "Opsgenie region",
              kind: "select",
              required: false,
              defaultValue: "US",
              options: [opt("US"), opt("EU")],
              showWhen: { fieldKey: "type", fieldValue: "OPSGENIE" },
            },
            {
              key: "subscribeAll",
              label: "Subscribe",
              kind: "select",
              required: false,
              defaultValue: "new",
              options: [opt("new", "New checks from now on"), opt("none", "Nothing yet")],
            },
          ],
        };
      case "maintenance-window":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            { key: "startsAt", label: "Starts", kind: "datetime", required: true },
            { key: "endsAt", label: "Ends", kind: "datetime", required: true },
            {
              key: "tags",
              label: "Tags",
              kind: "text",
              required: false,
              description: "Checks and groups with these tags pause during the window.",
            },
            {
              key: "repeatUnit",
              label: "Repeat",
              kind: "select",
              required: false,
              defaultValue: "",
              options: [
                opt("", "Does not repeat"),
                opt("DAY", "Daily"),
                opt("WEEK", "Weekly"),
                opt("MONTH", "Monthly"),
              ],
            },
          ],
        };
      case "private-location":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            {
              key: "slugName",
              label: "Slug",
              kind: "text",
              required: true,
              placeholder: "office-network",
              description: "Lowercase letters, numbers and dashes; used in check configuration.",
            },
          ],
        };
      case "dashboard":
        return {
          fields: [
            { key: "header", label: "Header", kind: "text", required: true },
            {
              key: "customUrl",
              label: "Subdomain",
              kind: "text",
              required: true,
              description: "<subdomain>.checklyhq.com; must be unique across Checkly.",
            },
            {
              key: "tags",
              label: "Tags",
              kind: "text",
              required: false,
              description: "Only checks with these tags are shown.",
            },
          ],
        };
      case "variable":
        return {
          fields: [
            { key: "key", label: "Key", kind: "text", required: true, placeholder: "API_TOKEN" },
            { key: "value", label: "Value", kind: "text", required: true },
            {
              key: "secret",
              label: "Secret",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: [opt("false", "No"), opt("true", "Yes: never shown again")],
            },
          ],
        };
      default:
        throw new Error(`Checkly plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const post = <T>(path: string, body: unknown, query?: Record<string, string | boolean>) =>
      ckFetch<T>(this.ctx, path, {
        method: "POST",
        body: JSON.stringify(body),
        ...(query ? { query } : {}),
      });
    switch (typeId) {
      case "check": {
        const type = trimmed(fields, "checkType") || "URL";
        const locations = pickList(fields["locations"]);
        const groupId = num(fields["groupId"]);
        const common: Obj = {
          name: trimmed(fields, "name"),
          activated: true,
          tags: csv(fields["tags"]),
          ...(groupId !== undefined ? { groupId } : {}),
        };
        const sched: Obj = {
          frequency: num(fields["frequency"]) ?? 10,
          ...(locations.length ? { locations } : {}),
        };
        let path: string;
        let body: Obj;
        switch (type) {
          case "URL":
            path = "/v1/checks/url";
            body = { ...common, ...sched, request: { url: trimmed(fields, "url"), method: "GET" } };
            break;
          case "API":
            path = "/v1/checks/api";
            body = {
              ...common,
              ...sched,
              request: {
                url: trimmed(fields, "url"),
                method: trimmed(fields, "method") || "GET",
                assertions: [
                  {
                    source: "STATUS_CODE",
                    property: "",
                    comparison: "EQUALS",
                    target: String(num(fields["expectedStatus"]) ?? 200),
                    regex: null,
                  },
                ],
              },
            };
            break;
          case "TCP":
            path = "/v1/checks/tcp";
            body = {
              ...common,
              ...sched,
              request: { hostname: trimmed(fields, "hostname"), port: num(fields["port"]) ?? 443 },
            };
            break;
          case "ICMP":
            path = "/v1/checks/icmp";
            body = { ...common, ...sched, request: { hostname: trimmed(fields, "hostname") } };
            break;
          case "DNS":
            path = "/v1/checks/dns";
            body = {
              ...common,
              ...sched,
              request: {
                query: trimmed(fields, "hostname"),
                recordType: trimmed(fields, "recordType") || "A",
              },
            };
            break;
          case "HEARTBEAT":
            path = "/v1/checks/heartbeat";
            body = {
              ...common,
              heartbeat: {
                period: num(fields["period"]) ?? 60,
                periodUnit: "minutes",
                grace: num(fields["grace"]) ?? 10,
                graceUnit: "minutes",
              },
            };
            break;
          default:
            throw new Error(`Checkly plugin: cannot create ${type} checks from Infrawrench`);
        }
        return mapCheck(accountId, await post<Obj>(path, body, { autoAssignAlerts: true }));
      }
      case "check-group": {
        const locations = pickList(fields["locations"]);
        return mapGroup(
          accountId,
          await post<Obj>("/v1/check-groups", {
            name: trimmed(fields, "name"),
            activated: true,
            tags: csv(fields["tags"]),
            locations: locations.length ? locations : ["us-east-1", "eu-west-1"],
            concurrency: num(fields["concurrency"]) ?? 3,
          }),
          0,
        );
      }
      case "alert-channel": {
        const type = trimmed(fields, "type") || "EMAIL";
        return mapChannel(
          accountId,
          await post<Obj>("/v1/alert-channels", {
            type,
            config: channelConfig(type, fields),
            sendFailure: true,
            sendRecovery: true,
            sendDegraded: false,
            autoSubscribe: fields["subscribeAll"] !== "none",
          }),
        );
      }
      case "maintenance-window": {
        const repeat = trimmed(fields, "repeatUnit");
        return mapWindow(
          accountId,
          await post<Obj>("/v1/maintenance-windows", {
            name: trimmed(fields, "name"),
            startsAt: trimmed(fields, "startsAt"),
            endsAt: trimmed(fields, "endsAt"),
            tags: csv(fields["tags"]),
            repeatUnit: repeat || "DAY",
            ...(repeat
              ? { repeatInterval: 1 }
              : { repeatEndsAt: trimmed(fields, "endsAt").slice(0, 10) }),
          }),
        );
      }
      case "private-location":
        return mapPrivateLocation(
          accountId,
          await post<Obj>("/v1/private-locations", {
            name: trimmed(fields, "name"),
            slugName: trimmed(fields, "slugName"),
          }),
        );
      case "dashboard":
        return mapDashboard(
          accountId,
          await post<Obj>("/v1/dashboards", {
            header: trimmed(fields, "header"),
            customUrl: trimmed(fields, "customUrl"),
            tags: csv(fields["tags"]),
          }),
        );
      case "variable":
        return mapVariable(
          accountId,
          await post<Obj>("/v1/variables", {
            key: trimmed(fields, "key"),
            value: fields["value"] ?? "",
            secret: fields["secret"] === "true",
          }),
        );
      default:
        throw new Error(`Checkly plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  /** GET the check, apply `change`, PUT it back on its type's route. */
  private async updateCheck(id: string, change: (c: Obj) => void): Promise<Obj> {
    const current = await this.rawCheck(id);
    const route = UPDATE_PATH[String(current["checkType"] ?? "")];
    if (!route) {
      // Playwright suites and agentic checks: only the deprecated generic route, with just the change.
      const delta: Obj = {};
      change(delta);
      return ckFetch<Obj>(this.ctx, `/v1/checks/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(delta),
      });
    }
    const body = writable(current, CHECK_WRITABLE);
    change(body);
    return ckFetch<Obj>(this.ctx, `/v1/checks/${route}/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  private async updateGroup(id: string, change: (g: Obj) => void): Promise<Obj> {
    const path = `/v1/check-groups/${encodeURIComponent(id)}`;
    const body = writable(await ckFetch<Obj>(this.ctx, path), GROUP_WRITABLE);
    change(body);
    return ckFetch<Obj>(this.ctx, path, { method: "PUT", body: JSON.stringify(body) });
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    const put = (path: string, body: Obj) =>
      ckFetch<Obj>(this.ctx, path, { method: "PUT", body: JSON.stringify(body) });
    switch (typeId) {
      case "check":
        await this.updateCheck(id, (c) => {
          if ("name" in fields) c["name"] = fields["name"];
          if ("description" in fields) c["description"] = fields["description"];
          if ("frequency" in fields && fields["frequency"] !== "")
            c["frequency"] = Number(fields["frequency"]);
          if ("tags" in fields) c["tags"] = csv(fields["tags"]);
          if ("degradedResponseTime" in fields)
            c["degradedResponseTime"] = num(fields["degradedResponseTime"]);
          if ("maxResponseTime" in fields) c["maxResponseTime"] = num(fields["maxResponseTime"]);
        });
        break;
      case "check-group":
        await this.updateGroup(id, (g) => {
          if ("name" in fields) g["name"] = fields["name"];
          if ("tags" in fields) g["tags"] = csv(fields["tags"]);
          if ("concurrency" in fields) g["concurrency"] = num(fields["concurrency"]);
        });
        break;
      case "alert-channel": {
        const path = `/v1/alert-channels/${encodeURIComponent(id)}`;
        const current = await ckFetch<Obj>(this.ctx, path);
        const body: Obj = { type: current["type"], config: current["config"] };
        for (const k of [
          "sendFailure",
          "sendRecovery",
          "sendDegraded",
          "sslExpiry",
          "autoSubscribe",
        ]) {
          body[k] = k in fields ? fields[k] === "true" : current[k];
        }
        body["sslExpiryThreshold"] =
          "sslExpiryThreshold" in fields
            ? num(fields["sslExpiryThreshold"])
            : current["sslExpiryThreshold"];
        await put(path, body);
        break;
      }
      case "maintenance-window": {
        const path = `/v1/maintenance-windows/${encodeURIComponent(id)}`;
        const c = await ckFetch<Obj>(this.ctx, path);
        const keep = [
          "name",
          "tags",
          "startsAt",
          "endsAt",
          "repeatInterval",
          "repeatUnit",
          "repeatEndsAt",
          "timezone",
          "pauseAllChecks",
          "silenceAlertsTags",
          "silenceAllAlerts",
          "description",
          "statusPageVisibility",
        ];
        const body = Object.fromEntries(
          keep.filter((k) => c[k] !== undefined && c[k] !== null).map((k) => [k, c[k]]),
        );
        if ("name" in fields) body["name"] = fields["name"];
        if ("tags" in fields) body["tags"] = csv(fields["tags"]);
        if ("description" in fields) body["description"] = fields["description"];
        await put(path, body);
        break;
      }
      case "private-location": {
        const path = `/v1/private-locations/${encodeURIComponent(id)}`;
        const c = await ckFetch<Obj>(this.ctx, path);
        await put(path, {
          name: "name" in fields ? fields["name"] : c["name"],
          ...("proxyUrl" in fields
            ? { proxyUrl: fields["proxyUrl"] }
            : c["proxyUrl"]
              ? { proxyUrl: c["proxyUrl"] }
              : {}),
          ...(c["icon"] ? { icon: c["icon"] } : {}),
        });
        break;
      }
      case "dashboard": {
        const body: Obj = {};
        if ("header" in fields) body["header"] = fields["header"];
        if ("description" in fields) body["description"] = fields["description"];
        if ("customUrl" in fields) body["customUrl"] = fields["customUrl"];
        if ("customDomain" in fields) body["customDomain"] = fields["customDomain"];
        if ("tags" in fields) body["tags"] = csv(fields["tags"]);
        if ("refreshRate" in fields) body["refreshRate"] = num(fields["refreshRate"]);
        const path = `/v1/dashboards/${encodeURIComponent(id)}`;
        const c = await ckFetch<Obj>(this.ctx, path);
        await put(path, {
          header: c["header"],
          customUrl: c["customUrl"],
          tags: c["tags"],
          ...body,
        });
        break;
      }
      case "status-page": {
        const path = `/v3/status-pages/${encodeURIComponent(id)}`;
        const c = await ckFetch<Obj>(this.ctx, path);
        await put(path, {
          name: "name" in fields ? fields["name"] : c["name"],
          url: c["url"],
          ...("description" in fields
            ? { description: fields["description"] }
            : c["description"]
              ? { description: c["description"] }
              : {}),
        });
        break;
      }
      case "variable": {
        const path = `/v1/variables/${encodeURIComponent(id)}`;
        const c = await ckFetch<Obj>(this.ctx, path);
        const value = fields["value"];
        if (c["secret"] === true && !value)
          throw new Error("Secret variables are write-only: enter the new value to change it.");
        await put(path, {
          key: id,
          value: value || c["value"],
          locked: "locked" in fields ? fields["locked"] === "true" : c["locked"],
          ...(c["secret"] === true ? { secret: true } : {}),
        });
        break;
      }
      default:
        throw new Error(`Checkly plugin: "${typeId}" cannot be edited from Infrawrench`);
    }
    return this.getResource(typeId, resourceId, accountId);
  }

  async deleteResource(typeId: string, resourceId: string): Promise<void> {
    const id = encodeURIComponent(externalIdOf(resourceId));
    const paths: Record<string, string> = {
      check: `/v1/checks/${id}`,
      "check-group": `/v1/check-groups/${id}`,
      "alert-channel": `/v1/alert-channels/${id}`,
      "maintenance-window": `/v1/maintenance-windows/${id}`,
      "private-location": `/v1/private-locations/${id}`,
      dashboard: `/v1/dashboards/${id}`,
      "status-page": `/v3/status-pages/${id}`,
      variable: `/v1/variables/${id}`,
    };
    const path = paths[typeId];
    if (!path) throw new Error(`Checkly plugin: "${typeId}" cannot be deleted from Infrawrench`);
    await ckFetch<unknown>(this.ctx, path, { method: "DELETE" });
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private async trigger(checkIds: string[]): Promise<void> {
    if (checkIds.length === 0) throw new Error("Nothing to run.");
    await ckFetch<unknown>(this.ctx, "/v2/check-sessions/trigger", {
      method: "POST",
      body: JSON.stringify({ target: { checkId: checkIds } }),
    });
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): Promise<void> {
    const id = externalIdOf(resourceId);
    const flags: Record<string, [string, boolean]> = {
      activate: ["activated", true],
      deactivate: ["activated", false],
      mute: ["muted", true],
      unmute: ["muted", false],
    };
    const flag = flags[actionId];
    if (typeId === "check") {
      if (flag) {
        await this.updateCheck(id, (c) => {
          c[flag[0]] = flag[1];
        });
        return;
      }
      if (actionId === "run") return this.trigger([id]);
    }
    if (typeId === "check-group") {
      if (flag) {
        await this.updateGroup(id, (g) => {
          g[flag[0]] = flag[1];
        });
        return;
      }
      if (actionId === "run") {
        const checks = await ckFetch<Obj[]>(
          this.ctx,
          `/v1/check-groups/${encodeURIComponent(id)}/checks`,
          { query: { limit: 100 } },
        );
        return this.trigger((checks ?? []).map((c) => String(c["id"])).filter(Boolean));
      }
    }
    if (typeId === "private-location" && actionId === "generate-key") {
      const key = await ckFetch<{ rawKey?: string }>(
        this.ctx,
        `/v1/private-locations/${encodeURIComponent(id)}/keys`,
        { method: "POST", body: "{}" },
      );
      if (!key.rawKey) throw new Error("Checkly did not return the new key.");
      if (!this.secrets?.setPlaintext)
        throw new Error(
          "This Infrawrench host cannot store the key. Update the app and try again.",
        );
      await this.secrets.setPlaintext(
        resourceIdFor(accountId, "private-location", id),
        AGENT_KEY_FIELD,
        key.rawKey,
      );
      return;
    }
    throw new Error(`Checkly plugin: unknown action "${actionId}" for "${typeId}"`);
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderChecklyDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderChecklySidebar(resource);
  }
}
