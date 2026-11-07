import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { ApiBody, ApiResponse, NoSlashString, PluginEffect } from "@infrawrench/plugin-base";
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
import { QuotaAccessError, externalIdOf, pathEncode } from "@infrawrench/plugin-base";
import type { ChecklyApi } from "./api.js";
import { ckEntries, ckPaged, createChecklyApi, statusOf } from "./api.js";
import type { operations } from "./api-types.gen.js";
import type { Check, CheckStatus } from "./mappers.js";
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

type Json = string | number | boolean | null | undefined | Json[] | { [key: string]: Json };
/** What a read-back object is sent back as: the server's own shape, so nothing here checks it. */
type RoundTrip = Record<string, Json>;

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
    const parsed: Json = JSON.parse(raw || "[]");
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // comma-separated fallback
  }
  return csv(raw);
}

/** The fields this plugin changes on a check it read back. */
type CheckEdit = ApiBody<operations["putV1ChecksId"]>;
type GroupEdit = ApiBody<operations["putV1CheckgroupsId"]>;

/** Update route per check type; Playwright suites and agentic checks have none of their own. */
const UPDATE_CHECK = new Map<
  string,
  (api: ChecklyApi, id: NoSlashString, body: RoundTrip) => Promise<Check>
>([
  ["API", (api, id, body) => api.put(`/v1/checks/api/${id}`, { body })],
  ["BROWSER", (api, id, body) => api.put(`/v1/checks/browser/${id}`, { body })],
  ["DNS", (api, id, body) => api.put(`/v1/checks/dns/${id}`, { body })],
  ["GRPC", (api, id, body) => api.put(`/v1/checks/grpc/${id}`, { body })],
  ["HEARTBEAT", (api, id, body) => api.put(`/v1/checks/heartbeat/${id}`, { body })],
  ["ICMP", (api, id, body) => api.put(`/v1/checks/icmp/${id}`, { body })],
  ["MULTI_STEP", (api, id, body) => api.put(`/v1/checks/multistep/${id}`, { body })],
  ["SSL", (api, id, body) => api.put(`/v1/checks/ssl/${id}`, { body })],
  ["TCP", (api, id, body) => api.put(`/v1/checks/tcp/${id}`, { body })],
  ["TRACEROUTE", (api, id, body) => api.put(`/v1/checks/traceroute/${id}`, { body })],
  ["URL", (api, id, body) => api.put(`/v1/checks/url/${id}`, { body })],
]);

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

/**
 * Every setting of `PublicStatusPageV3Mutation`. Checkly documents that PUT as "a full
 * replacement: omitted optional fields are reset", so an edit sends them all back.
 */
const STATUS_PAGE_WRITABLE = [
  "name",
  "url",
  "description",
  "customDomain",
  "themeColors",
  "logo",
  "logoDark",
  "redirectTo",
  "favicon",
  "defaultTheme",
  "privacyPolicyLink",
  "termsOfServiceLink",
  "supportLink",
  "footerText",
  "googleAnalyticsTag",
  "allowIndexing",
  "isPrivate",
] as const;

/**
 * `DashboardUpdate` gives most of these a default and does not say whether an omitted
 * one is left alone, so an edit sends them all back. Not `keys`: their `rawKey` is
 * required in that schema and only comes back from a write, as Checkly's own Terraform
 * provider notes, and it never sends them either.
 */
const DASHBOARD_WRITABLE = [
  "customUrl",
  "customDomain",
  "logo",
  "favicon",
  "link",
  "header",
  "description",
  "width",
  "refreshRate",
  "paginate",
  "paginationRate",
  "sortByStatus",
  "checksPerPage",
  "useTagsAndOperator",
  "hideTags",
  "enableIncidents",
  "expandChecks",
  "tags",
  "showHeader",
  "showCheckRunLinks",
  "showGroupNames",
  "customCSS",
  "isPrivate",
  "showP95",
  "showP99",
] as const;

export function writable(obj: object, keys: Set<string>): RoundTrip {
  return Object.fromEntries(Object.entries(obj).filter(([k, v]) => keys.has(k) && v !== undefined));
}

/** `keys` of `obj` that hold a value, in the order of `keys`. */
function present<T extends object>(obj: T, keys: readonly (keyof T)[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) {
    const value = obj[k];
    if (value !== undefined && value !== null) out[k] = value;
  }
  return out;
}

/** The alert channel `config` for a new channel of a type. */
export function channelConfig(
  type: string,
  fields: Record<string, string>,
): ApiBody<operations["postV1Alertchannels"]>["config"] {
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
  private readonly api: ChecklyApi;
  private readonly secrets: SecretHostServices | undefined;

  constructor(credentials: Credentials, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    const accountId = (credentials["accountId"] ?? "").trim();
    if (!apiKey) throw new Error("Checkly plugin: missing apiKey credential");
    if (!accountId) throw new Error("Checkly plugin: missing accountId credential");
    const caCert = credentials["caCert"] ?? "";
    this.api = createChecklyApi({
      apiKey,
      accountId,
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    });
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
    const list = await this.api.get("/v1/check-statuses").catch((): CheckStatus[] => []);
    return new Map(
      (list ?? [])
        .filter((s): s is CheckStatus & { checkId: string } => Boolean(s.checkId))
        .map((s): [string, CheckStatus] => [s.checkId, s]),
    );
  }

  // -------------------------------------------------------------------------
  // Listing and reads
  // -------------------------------------------------------------------------

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      return this.scoped(async () => {
        switch (typeId) {
          case "check": {
            const [checks, statuses] = await Promise.all([this.checks(), this.statuses()]);
            return checks.map((c) => mapCheck(accountId, c, statuses.get(String(c.id))));
          }
          case "check-group": {
            const [groups, checks] = await Promise.all([
              this.groups(),
              this.checks().catch(() => []),
            ]);
            const counts = new Map<string, number>();
            for (const c of checks) {
              if (c.groupId !== undefined && c.groupId !== null) {
                const g = String(c.groupId);
                counts.set(g, (counts.get(g) ?? 0) + 1);
              }
            }
            return groups.map((g) => mapGroup(accountId, g, counts.get(String(g.id)) ?? 0));
          }
          case "alert-channel":
            return (await ckPaged((query) => this.api.get("/v1/alert-channels", { query }))).map(
              (c) => mapChannel(accountId, c),
            );
          case "maintenance-window":
            return (
              await ckPaged((query) => this.api.get("/v1/maintenance-windows", { query }))
            ).map((w) => mapWindow(accountId, w));
          case "private-location":
            return ((await this.api.get("/v1/private-locations")) ?? []).map((p) =>
              mapPrivateLocation(accountId, p),
            );
          case "dashboard":
            return (await ckPaged((query) => this.api.get("/v1/dashboards", { query }))).map((d) =>
              mapDashboard(accountId, d),
            );
          case "status-page": {
            const out = await ckEntries(
              (cursor) => this.api.get("/v3/status-pages", { query: { limit: 100, ...cursor } }),
              20,
            );
            return out.map((p) => mapStatusPage(accountId, p));
          }
          case "variable":
            return (await ckPaged((query) => this.api.get("/v1/variables", { query }))).map((v) =>
              mapVariable(accountId, v),
            );
          default:
            throw new Error(`Checkly plugin: unknown resource type "${typeId}"`);
        }
      });
    });
  }

  private checks(): Promise<Check[]> {
    return ckPaged((query) => this.api.get("/v1/checks", { query }));
  }

  private groups() {
    return ckPaged((query) => this.api.get("/v1/check-groups", { query }));
  }

  private rawCheck(id: string) {
    return this.api.get(`/v1/checks/${pathEncode(id)}`);
  }

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = pathEncode(externalIdOf(resourceId));
      switch (typeId) {
        case "check": {
          const [c, statuses] = await Promise.all([
            this.rawCheck(externalIdOf(resourceId)),
            this.statuses(),
          ]);
          return mapCheck(accountId, c, statuses.get(String(c.id)));
        }
        case "check-group": {
          const [g, checks] = await Promise.all([
            this.api.get(`/v1/check-groups/${id}`),
            this.api
              .get(`/v1/check-groups/${id}/checks`, { query: { limit: 100 } })
              .catch(() => []),
          ]);
          return mapGroup(accountId, g, (checks ?? []).length);
        }
        case "alert-channel":
          return mapChannel(accountId, await this.api.get(`/v1/alert-channels/${id}`));
        case "maintenance-window":
          return mapWindow(accountId, await this.api.get(`/v1/maintenance-windows/${id}`));
        case "private-location":
          return mapPrivateLocation(accountId, await this.api.get(`/v1/private-locations/${id}`));
        case "dashboard":
          return mapDashboard(accountId, await this.api.get(`/v1/dashboards/${id}`));
        case "status-page":
          return mapStatusPage(accountId, await this.api.get(`/v3/status-pages/${id}`));
        case "variable":
          return mapVariable(accountId, await this.api.get(`/v1/variables/${id}`));
        default:
          throw new Error(`Checkly plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      if (typeId === "private-location" && outputKey === AGENT_KEY_FIELD) {
        const stored = this.secrets
          ? await this.secrets.getPlaintext(resourceId, AGENT_KEY_FIELD).catch(() => null)
          : null;
        if (stored) return stored;
        throw new Error(
          "Use Generate agent key on the private location first: Checkly shows a key only when it is created.",
        );
      }
      const r = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      const value = r.resolvedOutputs[outputKey] ?? r.fields[outputKey];
      if (value === undefined)
        throw new Error(`Checkly plugin: cannot resolve output "${outputKey}" for "${typeId}"`);
      return String(value);
    });
  }

  enrichDetail(resource: ResourceInstance): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      if (resource.resourceTypeId !== "check" || !resource.externalId) return resource;
      const analytics = await checkAnalytics(
        this.api,
        resource.externalId,
        String(resource.fields["checkType"] ?? ""),
      );
      return {
        ...resource,
        resolvedOutputs: {
          ...resource.resolvedOutputs,
          [ANALYTICS_KEY]: JSON.stringify(analytics),
        },
      };
    });
  }

  // -------------------------------------------------------------------------
  // Metrics, stats, quotas
  // -------------------------------------------------------------------------

  fetchMetricSeries(
    typeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      const range = rangeOrDefault(timeRange, DEFAULT_METRICS_WINDOW_MS);
      if (typeId === "check") return checkResultSeries(this.api, id, range);
      if (typeId === "private-location") return privateLocationSeries(this.api, id, range);
      return [];
    });
  }

  fetchDashboardStats(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<DashboardStat[]> {
    return attempt(async () => {
      const r = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
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
            value:
              r.fields["frequency"] !== undefined ? `${String(r.fields["frequency"])} min` : "—",
          },
        ];
      }
      if (typeId === "private-location")
        return [{ label: "Agents", value: String(r.fields["agentCount"] ?? 0) }];
      return [];
    });
  }

  /**
   * Credit consumption against the current usage term's budget, for accounts
   * on a credit package (`GET /v2/usage/terms` + `/v2/usage/summary`). Both
   * numbers come from Checkly; accounts on a limits plan report nothing.
   */
  fetchQuotas(): PluginEffect<QuotaUsage[]> {
    return attempt(async () => {
      const today = new Date().toISOString().slice(0, 10);
      let terms: ApiResponse<operations["getV2UsageTerms"]>["data"];
      try {
        terms =
          (await this.api.get("/v2/usage/terms", { query: { from: today, to: today } })).data ?? [];
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
        if (!term.id || term.packageModel !== "credits" || !(Number(term.creditBudget) > 0))
          continue;
        const summary = await this.api.get("/v2/usage/summary", {
          query: {
            usageTermsIds: [term.id],
            ...(term.usageStartDate ? { from: term.usageStartDate.slice(0, 10) } : {}),
            to: today,
          },
        });
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
    });
  }

  verifyCredentials(): PluginEffect<PreflightResult> {
    return attempt(async () => {
      return verifyChecklyCredentials(this.api);
    });
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  private async locationOptions() {
    const locs = await this.api.get("/v1/locations").catch(() => []);
    return (locs ?? [])
      .filter((l) => l.region)
      .map((l) => ({
        id: l.region,
        label: `${l.name ?? l.region} (${l.region})`,
        category: "Locations",
      }));
  }

  private async groupOptions() {
    const groups = await this.groups().catch(() => []);
    return [opt("", "None"), ...groups.map((g) => opt(String(g.id), String(g.name ?? g.id)))];
  }

  getCreateConfig(typeId: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
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
                options: ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SOA", "HTTPS"].map((r) =>
                  opt(r),
                ),
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
    });
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      switch (typeId) {
        case "check":
          return mapCheck(accountId, await this.createCheck(fields));
        case "check-group": {
          const locations = pickList(fields["locations"]);
          return mapGroup(
            accountId,
            await this.api.post("/v1/check-groups", {
              body: {
                name: trimmed(fields, "name"),
                activated: true,
                tags: csv(fields["tags"]),
                locations: locations.length ? locations : ["us-east-1", "eu-west-1"],
                concurrency: num(fields["concurrency"]) ?? 3,
              },
            }),
            0,
          );
        }
        case "alert-channel": {
          const type = trimmed(fields, "type") || "EMAIL";
          return mapChannel(
            accountId,
            await this.api.post("/v1/alert-channels", {
              body: {
                type,
                config: channelConfig(type, fields),
                sendFailure: true,
                sendRecovery: true,
                sendDegraded: false,
                autoSubscribe: fields["subscribeAll"] !== "none",
              },
            }),
          );
        }
        case "maintenance-window": {
          const repeat = trimmed(fields, "repeatUnit");
          return mapWindow(
            accountId,
            await this.api.post("/v1/maintenance-windows", {
              body: {
                name: trimmed(fields, "name"),
                startsAt: trimmed(fields, "startsAt"),
                endsAt: trimmed(fields, "endsAt"),
                tags: csv(fields["tags"]),
                repeatUnit: repeat || "DAY",
                ...(repeat
                  ? { repeatInterval: 1 }
                  : { repeatEndsAt: trimmed(fields, "endsAt").slice(0, 10) }),
              },
            }),
          );
        }
        case "private-location":
          return mapPrivateLocation(
            accountId,
            await this.api.post("/v1/private-locations", {
              body: {
                name: trimmed(fields, "name"),
                slugName: trimmed(fields, "slugName"),
              },
            }),
          );
        case "dashboard":
          return mapDashboard(
            accountId,
            await this.api.post("/v1/dashboards", {
              body: {
                header: trimmed(fields, "header"),
                customUrl: trimmed(fields, "customUrl"),
                tags: csv(fields["tags"]),
              },
            }),
          );
        case "variable":
          return mapVariable(
            accountId,
            await this.api.post("/v1/variables", {
              body: {
                key: trimmed(fields, "key"),
                value: fields["value"] ?? "",
                secret: fields["secret"] === "true",
              },
            }),
          );
        default:
          throw new Error(`Checkly plugin: cannot create "${typeId}" from Infrawrench`);
      }
    });
  }

  private createCheck(fields: Record<string, string>): Promise<Check> {
    const type = trimmed(fields, "checkType") || "URL";
    const locations = pickList(fields["locations"]);
    const groupId = num(fields["groupId"]);
    const common = {
      name: trimmed(fields, "name"),
      activated: true,
      tags: csv(fields["tags"]),
      ...(groupId !== undefined ? { groupId } : {}),
    };
    const sched = {
      frequency: num(fields["frequency"]) ?? 10,
      ...(locations.length ? { locations } : {}),
    };
    const query = { autoAssignAlerts: true };
    switch (type) {
      case "URL":
        return this.api.post("/v1/checks/url", {
          query,
          body: {
            ...common,
            ...sched,
            request: { url: trimmed(fields, "url"), method: "GET" },
          },
        });
      case "API":
        return this.api.post("/v1/checks/api", {
          query,
          body: {
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
          },
        });
      case "TCP":
        return this.api.post("/v1/checks/tcp", {
          query,
          body: {
            ...common,
            ...sched,
            request: {
              hostname: trimmed(fields, "hostname"),
              port: num(fields["port"]) ?? 443,
            },
          },
        });
      case "ICMP":
        return this.api.post("/v1/checks/icmp", {
          query,
          body: { ...common, ...sched, request: { hostname: trimmed(fields, "hostname") } },
        });
      case "DNS":
        return this.api.post("/v1/checks/dns", {
          query,
          body: {
            ...common,
            ...sched,
            request: {
              query: trimmed(fields, "hostname"),
              recordType: trimmed(fields, "recordType") || "A",
            },
          },
        });
      case "HEARTBEAT":
        return this.api.post("/v1/checks/heartbeat", {
          query,
          body: {
            ...common,
            heartbeat: {
              period: num(fields["period"]) ?? 60,
              periodUnit: "minutes",
              grace: num(fields["grace"]) ?? 10,
              graceUnit: "minutes",
            },
          },
        });
      default:
        throw new Error(`Checkly plugin: cannot create ${type} checks from Infrawrench`);
    }
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  /** GET the check, apply `change`, PUT it back on its type's route. */
  private async updateCheck(id: string, change: (c: CheckEdit) => void): Promise<Check> {
    const current = await this.rawCheck(id);
    const put = UPDATE_CHECK.get(String(current.checkType ?? ""));
    if (!put) {
      // Playwright suites and agentic checks: only the deprecated generic route, with just the change.
      const delta: CheckEdit = {};
      change(delta);
      return this.api.put(`/v1/checks/${pathEncode(id)}`, { body: delta });
    }
    const body = writable(current, CHECK_WRITABLE);
    change(body);
    return put(this.api, pathEncode(id), body);
  }

  private async updateGroup(id: string, change: (g: GroupEdit) => void) {
    const groupId = pathEncode(id);
    const body = writable(await this.api.get(`/v1/check-groups/${groupId}`), GROUP_WRITABLE);
    change(body);
    return this.api.put(`/v1/check-groups/${groupId}`, { body });
  }

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      const encoded = pathEncode(id);
      switch (typeId) {
        case "check":
          await this.updateCheck(id, (c) => {
            if ("name" in fields) c.name = fields["name"];
            if ("description" in fields) c.description = fields["description"];
            if ("frequency" in fields && fields["frequency"] !== "")
              c.frequency = Number(fields["frequency"]);
            if ("tags" in fields) c.tags = csv(fields["tags"]);
            if ("degradedResponseTime" in fields)
              c.degradedResponseTime = num(fields["degradedResponseTime"]);
            if ("maxResponseTime" in fields) c.maxResponseTime = num(fields["maxResponseTime"]);
          });
          break;
        case "check-group":
          await this.updateGroup(id, (g) => {
            if ("name" in fields) g.name = fields["name"];
            if ("tags" in fields) g.tags = csv(fields["tags"]);
            if ("concurrency" in fields) g.concurrency = num(fields["concurrency"]);
          });
          break;
        case "alert-channel": {
          const current = await this.api.get(`/v1/alert-channels/${encoded}`);
          const flag = (
            k: "sendFailure" | "sendRecovery" | "sendDegraded" | "sslExpiry" | "autoSubscribe",
          ) => (k in fields ? fields[k] === "true" : current[k]);
          await this.api.put(`/v1/alert-channels/${encoded}`, {
            body: {
              type: current.type,
              config: current.config,
              sendFailure: flag("sendFailure"),
              sendRecovery: flag("sendRecovery"),
              sendDegraded: flag("sendDegraded"),
              sslExpiry: flag("sslExpiry"),
              autoSubscribe: flag("autoSubscribe"),
              sslExpiryThreshold:
                "sslExpiryThreshold" in fields
                  ? num(fields["sslExpiryThreshold"])
                  : current.sslExpiryThreshold,
            },
          });
          break;
        }
        case "maintenance-window": {
          const c = await this.api.get(`/v1/maintenance-windows/${encoded}`);
          const body = present(c, [
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
          ]);
          if ("name" in fields) body.name = fields["name"];
          if ("tags" in fields) body.tags = csv(fields["tags"]);
          if ("description" in fields) body.description = fields["description"];
          await this.api.put(`/v1/maintenance-windows/${encoded}`, { body });
          break;
        }
        case "private-location": {
          const c = await this.api.get(`/v1/private-locations/${encoded}`);
          await this.api.put(`/v1/private-locations/${encoded}`, {
            body: {
              name: "name" in fields ? fields["name"] : c.name,
              ...("proxyUrl" in fields
                ? { proxyUrl: fields["proxyUrl"] }
                : c.proxyUrl
                  ? { proxyUrl: c.proxyUrl }
                  : {}),
              ...(c.icon ? { icon: c.icon } : {}),
            },
          });
          break;
        }
        case "dashboard": {
          const body: ApiBody<operations["putV1DashboardsDashboardid"]> = {};
          if ("header" in fields) body.header = fields["header"];
          if ("description" in fields) body.description = fields["description"];
          if ("customUrl" in fields) body.customUrl = fields["customUrl"];
          if ("customDomain" in fields) body.customDomain = fields["customDomain"];
          if ("tags" in fields) body.tags = csv(fields["tags"]);
          if ("refreshRate" in fields) body.refreshRate = num(fields["refreshRate"]);
          const c = await this.api.get(`/v1/dashboards/${encoded}`);
          await this.api.put(`/v1/dashboards/${encoded}`, {
            body: { ...present(c, DASHBOARD_WRITABLE), ...body },
          });
          break;
        }
        case "status-page": {
          const c = await this.api.get(`/v3/status-pages/${encoded}`);
          await this.api.put(`/v3/status-pages/${encoded}`, {
            body: {
              ...present(c, STATUS_PAGE_WRITABLE),
              name: "name" in fields ? fields["name"] : c.name,
              url: c.url,
              ...("description" in fields ? { description: fields["description"] } : {}),
            },
          });
          break;
        }
        case "variable": {
          const c = await this.api.get(`/v1/variables/${encoded}`);
          const value = fields["value"];
          if (c.secret === true && !value)
            throw new Error("Secret variables are write-only: enter the new value to change it.");
          await this.api.put(`/v1/variables/${encoded}`, {
            body: {
              key: id,
              value: value || c.value,
              locked: "locked" in fields ? fields["locked"] === "true" : c.locked,
              ...(c.secret === true ? { secret: true } : {}),
            },
          });
          break;
        }
        default:
          throw new Error(`Checkly plugin: "${typeId}" cannot be edited from Infrawrench`);
      }
      return runPluginEffect(this.getResource(typeId, resourceId, accountId));
    });
  }

  deleteResource(typeId: string, resourceId: string): PluginEffect<void> {
    return attempt(async () => {
      const id = pathEncode(externalIdOf(resourceId));
      switch (typeId) {
        case "check":
          await this.api.delete(`/v1/checks/${id}`);
          return;
        case "check-group":
          await this.api.delete(`/v1/check-groups/${id}`);
          return;
        case "alert-channel":
          await this.api.delete(`/v1/alert-channels/${id}`);
          return;
        case "maintenance-window":
          await this.api.delete(`/v1/maintenance-windows/${id}`);
          return;
        case "private-location":
          await this.api.delete(`/v1/private-locations/${id}`);
          return;
        case "dashboard":
          await this.api.delete(`/v1/dashboards/${id}`);
          return;
        case "status-page":
          await this.api.delete(`/v3/status-pages/${id}`);
          return;
        case "variable":
          await this.api.delete(`/v1/variables/${id}`);
          return;
        default:
          throw new Error(`Checkly plugin: "${typeId}" cannot be deleted from Infrawrench`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private async trigger(checkIds: string[]): Promise<void> {
    if (checkIds.length === 0) throw new Error("Nothing to run.");
    await this.api.post("/v2/check-sessions/trigger", {
      body: { target: { checkId: checkIds } },
    });
  }

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      const flags: Record<string, ["activated" | "muted", boolean]> = {
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
          const checks = await this.api.get(`/v1/check-groups/${pathEncode(id)}/checks`, {
            query: { limit: 100 },
          });
          return this.trigger((checks ?? []).map((c) => String(c.id)).filter(Boolean));
        }
      }
      if (typeId === "private-location" && actionId === "generate-key") {
        const key = await this.api.post(`/v1/private-locations/${pathEncode(id)}/keys`, {
          body: {},
        });
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
    });
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderChecklyDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderChecklySidebar(resource);
  }
}
