import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type {
  ApiBody,
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  NoSlashString,
  PluginClient,
  PluginEffect,
  PreflightResult,
  ResourceInstance,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import {
  CostSetupError,
  externalIdOf,
  pathEncode,
  requireListPage,
} from "@infrawrench/plugin-base";
import type { SentryApi, SentryContext } from "./api.js";
import { isPermissionError, sentryApi, statusOf } from "./api.js";
import type { operations } from "./api-types.gen.js";
import type { CostInputs, MonitorCounts, StatsResponse } from "./cost-data.js";
import { fetchSentryCostData, fetchStats, fetchUsageSummary } from "./cost-data.js";
import type {
  ProjectStats,
  SentryProject,
  SentryTeam,
  SentryUptimeMonitor,
  SentryWorkflow,
} from "./mappers.js";
import {
  DEDICATED_DETECTOR_TYPES,
  mapClientKey,
  mapCronMonitor,
  mapDetector,
  mapIssue,
  mapOrganization,
  mapProject,
  mapRelease,
  mapTeam,
  mapUptimeMonitor,
  mapWorkflow,
  orgUrl,
  parseScopedId,
} from "./mappers.js";
import {
  DEFAULT_METRICS_WINDOW_MS,
  USAGE_METRICS_WINDOW_MS,
  cronSeries,
  issueSeries,
  organizationSeries,
  projectSeries,
  rangeOrDefault,
  uptimeSeries,
} from "./metrics.js";
import { verifySentryCredentials } from "./preflight.js";
import type { SentryRates } from "./rates.js";
import { parseRates } from "./rates.js";
import type { SentryInstance } from "./regions.js";
import { resolveInstance } from "./regions.js";
import type { TopIssue } from "./render.js";
import {
  TOP_ISSUES_KEY,
  USAGE_SUMMARY_KEY,
  renderSentryDetail,
  renderSentrySidebar,
} from "./render.js";

/** Common platform ids for the create-project picker (Sentry's own identifiers). */
export const PLATFORMS: Array<{ id: string; label: string }> = [
  { id: "javascript", label: "Browser JavaScript" },
  { id: "javascript-react", label: "React" },
  { id: "javascript-nextjs", label: "Next.js" },
  { id: "javascript-vue", label: "Vue" },
  { id: "javascript-angular", label: "Angular" },
  { id: "node", label: "Node.js" },
  { id: "node-express", label: "Express" },
  { id: "python", label: "Python" },
  { id: "python-django", label: "Django" },
  { id: "python-flask", label: "Flask" },
  { id: "python-fastapi", label: "FastAPI" },
  { id: "go", label: "Go" },
  { id: "java", label: "Java" },
  { id: "java-spring-boot", label: "Spring Boot" },
  { id: "ruby", label: "Ruby" },
  { id: "ruby-rails", label: "Rails" },
  { id: "php", label: "PHP" },
  { id: "php-laravel", label: "Laravel" },
  { id: "dotnet", label: ".NET" },
  { id: "dotnet-aspnetcore", label: "ASP.NET Core" },
  { id: "rust", label: "Rust" },
  { id: "elixir", label: "Elixir" },
  { id: "android", label: "Android" },
  { id: "apple-ios", label: "iOS" },
  { id: "flutter", label: "Flutter" },
  { id: "react-native", label: "React Native" },
  { id: "other", label: "Other" },
];

/**
 * Organization tokens (`sntrys_`) are CI tokens with a fixed `org:ci` scope:
 * they can upload source maps and create releases and nothing this plugin
 * reads. Say so up front rather than failing every listing with a 403.
 */
export function assertUsableToken(token: string): void {
  if (token.startsWith("sntrys_")) {
    throw new Error(
      "Sentry plugin: this is an organization token (sntrys_), which only covers CI uploads. Use an internal integration token (sntryi_) or a personal token (sntryu_) instead.",
    );
  }
}

const enc = pathEncode;

const ISSUE_ACTIONS: Record<string, ApiBody<operations["updateOrganizationIssues"]>> = {
  resolve: { status: "resolved" },
  unresolve: { status: "unresolved" },
  archive: { status: "ignored", substatus: "archived_until_escalating" },
  "archive-forever": { status: "ignored", substatus: "archived_forever" },
};

const UPTIME_INTERVALS = new Set([60, 300, 600, 1200, 1800, 3600]);

/** `max_runtime`'s maximum in the document: 7 days. 40320 is `checkin_margin`'s. */
const MAX_RUNTIME_MINUTES = 10_080;

function num(raw: string | undefined, label: string): number | undefined {
  const value = (raw ?? "").trim();
  if (!value) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Sentry plugin: "${label}" must be a non-negative number, got "${value}"`);
  }
  return n;
}

/**
 * A resource's id for a write. A blank one would send the write to another route,
 * or to a bulk route with nothing limiting which rows it touches.
 */
function writeId(resourceId: string): string {
  const id = externalIdOf(resourceId);
  if (!id) throw new Error(`Sentry plugin: malformed id "${resourceId}"`);
  return id;
}

/** Crontab (`0 * * * *`) or interval (`10 minute`) into Sentry's monitor config. */
export function parseSchedule(
  raw: string,
):
  | { schedule_type: "interval"; schedule: [number, string] }
  | { schedule_type: "crontab"; schedule: string } {
  const value = raw.trim();
  const interval = /^(\d+)\s*(minute|hour|day|week|month|year)s?$/i.exec(value);
  if (interval) {
    return {
      schedule_type: "interval",
      schedule: [Number(interval[1]), interval[2]!.toLowerCase()],
    };
  }
  if (value.split(/\s+/).length === 5 || value.startsWith("@")) {
    return { schedule_type: "crontab", schedule: value };
  }
  throw new Error(
    `Sentry plugin: "${value}" is not a crontab (five fields, e.g. 0 * * * *) or an interval (e.g. 10 minute)`,
  );
}

export class SentryClient implements PluginClient {
  private readonly ctx: SentryContext;
  private readonly api: SentryApi;
  private readonly org: string;
  private readonly rates: SentryRates;
  private projectsCache: Promise<SentryProject[]> | undefined;

  constructor(credentials: Credentials, services?: HostServices) {
    const token = (credentials["authToken"] ?? "").trim();
    if (!token) throw new Error("Sentry plugin: missing authToken credential");
    assertUsableToken(token);
    const caCert = credentials["caCert"] ?? "";
    this.ctx = {
      token,
      instance: resolveInstance(credentials["region"], credentials["baseUrl"]),
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
    this.api = sentryApi(this.ctx);
    this.org = (credentials["organization"] ?? "").trim();
    if (!this.org) throw new Error("Sentry plugin: pick an organization");
    this.rates = parseRates(credentials);
  }

  get instance(): SentryInstance {
    return this.ctx.instance;
  }

  private get o(): NoSlashString {
    return enc(this.org);
  }

  private projects(): Promise<SentryProject[]> {
    this.projectsCache ??= this.api
      .getAll(`/organizations/${this.o}/projects/`, null)
      .catch((err: unknown) => {
        this.projectsCache = undefined;
        throw err;
      });
    return this.projectsCache;
  }

  private async projectSlugs(): Promise<Map<string, string>> {
    const projects = await this.projects().catch((err: unknown): SentryProject[] => {
      // A token that may not read projects still gets ids. Any other failure is not "none".
      if (isPermissionError(err)) return [];
      throw err;
    });
    return new Map(projects.map((p) => [String(p.id), p.slug]));
  }

  private costInputs(slugs: Map<string, string>): CostInputs {
    return {
      org: this.org,
      rates: this.rates,
      projectSlugs: slugs,
      monitors: () => this.monitorCounts(),
    };
  }

  private async monitorCounts(): Promise<MonitorCounts> {
    const [crons, uptime] = await Promise.all([
      this.api.getAll(`/organizations/${this.o}/monitors/`, null),
      this.api
        .getAll(`/organizations/${this.o}/uptime/`, null)
        .catch((): SentryUptimeMonitor[] => []),
    ]);
    return {
      cron: crons.filter((m) => m.status !== "disabled").length,
      uptime: uptime.filter((m) => m.status !== "disabled").length,
    };
  }

  /** Accepted and dropped events per project over the last 24 hours, by project id. */
  private async stats24h(projectIds?: string[]): Promise<Map<string, ProjectStats>> {
    const end = new Date();
    const start = new Date(end.getTime() - 24 * 3600_000);
    const res: StatsResponse = await fetchStats(this.ctx, this.org, {
      groupBy: ["project", "outcome"],
      category: ["error", "transaction", "span", "replay"],
      outcome: ["accepted", "filtered", "rate_limited"],
      start: start.toISOString().replace(/\.\d{3}Z$/, "Z"),
      end: end.toISOString().replace(/\.\d{3}Z$/, "Z"),
      interval: "1h",
      ...(projectIds ? { project: projectIds } : {}),
    });
    const out = new Map<string, ProjectStats>();
    for (const g of res.groups ?? []) {
      const id = String(g.by["project"] ?? "");
      const qty = g.totals["sum(quantity)"] ?? 0;
      const s = out.get(id) ?? { accepted24h: 0, dropped24h: 0 };
      if (g.by["outcome"] === "accepted") s.accepted24h = (s.accepted24h ?? 0) + qty;
      else s.dropped24h = (s.dropped24h ?? 0) + qty;
      out.set(id, s);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      const inst = this.ctx.instance;
      switch (typeId) {
        case "organization": {
          const org = await this.api.get(`/organizations/${this.o}/`);
          return [mapOrganization(accountId, inst, org)];
        }
        case "project": {
          this.projectsCache = undefined;
          const [projects, stats] = await Promise.all([
            this.projects(),
            this.stats24h().catch(() => new Map<string, ProjectStats>()),
          ]);
          return projects.map((p) =>
            mapProject(accountId, inst, this.org, p, stats.get(String(p.id)) ?? {}),
          );
        }
        case "team":
          return (await this.api.getAll(`/organizations/${this.o}/teams/`, null)).map((t) =>
            mapTeam(accountId, this.org, t),
          );
        case "release":
          // Rolling window: the newest 100. Older rows falling off is what this type means.
          return (
            await this.api.getAll(`/organizations/${this.o}/releases/`, null, {
              maxPages: 1,
              partial: true,
            })
          ).map((r) => mapRelease(accountId, r));
        case "issue":
          return (await this.topIssues()).map((i) => mapIssue(accountId, i));
        case "client-key":
          return this.listClientKeys(accountId);
        case "alert":
          return (await this.api.getAll(`/organizations/${this.o}/workflows/`, null)).map((w) =>
            mapWorkflow(accountId, w),
          );
        case "monitor": {
          const [detectors, slugs] = await Promise.all([
            this.api.getAll(`/organizations/${this.o}/detectors/`, null),
            this.projectSlugs(),
          ]);
          return detectors
            .filter((d) => !DEDICATED_DETECTOR_TYPES.has(d.type ?? ""))
            .map((d) => mapDetector(accountId, d, slugs));
        }
        case "cron-monitor":
          return (await this.api.getAll(`/organizations/${this.o}/monitors/`, null)).map((m) =>
            mapCronMonitor(accountId, m),
          );
        case "uptime-monitor":
          return (await this.api.getAll(`/organizations/${this.o}/uptime/`, null)).map((m) =>
            mapUptimeMonitor(accountId, m),
          );
        default:
          throw new Error(`Sentry plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  /**
   * The unresolved issues with the most events in the last 14 days. Ranked, so this
   * is one page by design, at the 100 `limit` allows: the type says it lists those.
   */
  private async topIssues() {
    const { body } = await this.api.getResponse(`/organizations/${this.o}/issues/`, {
      query: { query: "is:unresolved", statsPeriod: "14d", sort: "freq", limit: 100 },
    });
    return requireListPage(body, {
      vendor: "Sentry",
      path: `/organizations/${this.o}/issues/`,
      key: null,
    });
  }

  private async listClientKeys(accountId: string): Promise<ResourceInstance[]> {
    const projects = await this.projects();
    const slugs = new Map(projects.map((p) => [String(p.id), p.slug]));
    try {
      const keys = await this.api.getAll(`/organizations/${this.o}/project-keys/`, null);
      return keys
        .filter((k) => slugs.has(String(k.projectId)))
        .map((k) => mapClientKey(accountId, this.org, slugs.get(String(k.projectId))!, k));
    } catch (err) {
      // Older self-hosted releases lack the org-wide listing: fall back to
      // one request per project.
      if (statusOf(err) !== 404) throw err;
      const out: ResourceInstance[] = [];
      for (const p of projects) {
        const keys = await this.api.getAll(`/projects/${this.o}/${enc(p.slug)}/keys/`, null);
        out.push(...keys.map((k) => mapClientKey(accountId, this.org, p.slug, k)));
      }
      return out;
    }
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
      const inst = this.ctx.instance;
      switch (typeId) {
        case "organization": {
          const org = await this.api.get(`/organizations/${this.o}/`);
          const summary = await this.projectSlugs()
            .then((slugs) => fetchUsageSummary(this.ctx, this.costInputs(slugs)))
            .catch(() => undefined);
          const r = mapOrganization(
            accountId,
            inst,
            org,
            inst.selfHosted ? undefined : summary?.totalCost,
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
        case "project": {
          const p = await this.api.get(`/projects/${this.o}/${enc(id)}/`);
          const pid = String(p.id);
          const [stats, issues] = await Promise.all([
            this.stats24h([pid]).catch(() => new Map<string, ProjectStats>()),
            this.api
              .getResponse(`/organizations/${this.o}/issues/`, {
                query: {
                  query: "is:unresolved",
                  statsPeriod: "14d",
                  sort: "freq",
                  limit: 10,
                  ...(pid ? { project: [pid] } : {}),
                },
              })
              .catch(() => undefined),
          ]);
          const list = issues && Array.isArray(issues.body) ? issues.body : undefined;
          const hits = Number(issues?.headers["x-hits"]);
          const unresolved = list
            ? Number.isFinite(hits) && issues?.headers["x-hits"] !== undefined
              ? hits
              : list.length
            : undefined;
          const r = mapProject(accountId, inst, this.org, p, {
            ...(stats.get(pid) ?? {}),
            ...(unresolved !== undefined ? { unresolved } : {}),
          });
          if (!list) return r;
          const top: TopIssue[] = list.map((i) => ({
            id: i.id,
            shortId: i.shortId ?? i.id,
            title: i.title ?? "",
            level: i.level ?? "",
            count: Number(i.count ?? 0),
            userCount: i.userCount ?? 0,
            lastSeen: i.lastSeen ?? "",
          }));
          return {
            ...r,
            resolvedOutputs: { ...r.resolvedOutputs, [TOP_ISSUES_KEY]: JSON.stringify(top) },
          };
        }
        case "team":
          return mapTeam(accountId, this.org, await this.api.get(`/teams/${this.o}/${enc(id)}/`));
        case "release":
          return mapRelease(
            accountId,
            await this.api.get(`/organizations/${this.o}/releases/${enc(id)}/`),
          );
        case "issue":
          return mapIssue(
            accountId,
            await this.api.get(`/organizations/${this.o}/issues/${enc(id)}/`),
          );
        case "client-key": {
          const { projectSlug, id: keyId } = parseScopedId(id);
          const k = await this.api.get(
            `/projects/${this.o}/${enc(projectSlug)}/keys/${enc(keyId)}/`,
          );
          return mapClientKey(accountId, this.org, projectSlug, k);
        }
        case "alert":
          return mapWorkflow(accountId, await this.fetchWorkflow(id));
        case "monitor":
          return mapDetector(
            accountId,
            await this.api.get(`/organizations/${this.o}/detectors/${enc(id)}/`),
            await this.projectSlugs(),
          );
        case "cron-monitor":
          return mapCronMonitor(
            accountId,
            await this.api.get(`/organizations/${this.o}/monitors/${enc(id)}/`),
          );
        case "uptime-monitor": {
          const { projectSlug, id: monitorId } = parseScopedId(id);
          const m = await this.api.get(
            `/projects/${this.o}/${enc(projectSlug)}/uptime/${enc(monitorId)}/`,
          );
          return mapUptimeMonitor(accountId, { ...m, projectSlug: m.projectSlug ?? projectSlug });
        }
        default:
          throw new Error(`Sentry plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  private fetchWorkflow(id: string): Promise<SentryWorkflow> {
    return this.api.get(`/organizations/${this.o}/workflows/${enc(id)}/`);
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
      throw new Error(`Sentry plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
    });
  }

  // -------------------------------------------------------------------------
  // Stats, metrics, costs, preflight
  // -------------------------------------------------------------------------

  fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<DashboardStat[]> {
    return attempt(async () => {
      const r = await runPluginEffect(this.getResource(resourceTypeId, resourceId, accountId));
      const f = r.fields;
      const show = (v: string | number | boolean | undefined, suffix = "") =>
        v === undefined
          ? "—"
          : `${typeof v === "number" ? v.toLocaleString("en-US") : String(v)}${suffix}`;
      switch (resourceTypeId) {
        case "organization":
          return [
            {
              label: "Estimated month to date",
              value:
                typeof f["monthToDate"] === "number"
                  ? `$${f["monthToDate"].toLocaleString("en-US", { maximumFractionDigits: 0 })}`
                  : "—",
            },
          ];
        case "project": {
          const n = f["unresolvedIssues"];
          return [
            {
              label: "Unresolved issues",
              value: show(n),
              variant:
                typeof n === "number" ? (n > 0 ? "status-degraded" : "status-healthy") : "default",
            },
            { label: "Events (24h)", value: show(f["events24h"]) },
            { label: "Dropped (24h)", value: show(f["dropped24h"]) },
          ];
        }
        case "cron-monitor": {
          const health = String(f["health"] ?? "");
          return [
            {
              label: "Status",
              value: f["status"] === "disabled" ? "paused" : health || "—",
              variant:
                health === "error"
                  ? "status-error"
                  : health === "ok"
                    ? "status-healthy"
                    : "default",
            },
            { label: "Last check-in", value: show(f["lastCheckIn"]) },
          ];
        }
        case "uptime-monitor": {
          const up = String(f["uptimeStatus"] ?? "");
          return [
            {
              label: "Uptime",
              value: f["status"] === "disabled" ? "paused" : up || "—",
              variant: up === "down" ? "status-error" : up === "up" ? "status-healthy" : "default",
            },
            { label: "Interval", value: show(f["intervalSeconds"], " s") },
          ];
        }
        case "issue":
          return [
            { label: "Events", value: show(f["count"]) },
            { label: "Users", value: show(f["userCount"]) },
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
      const range = rangeOrDefault(timeRange, DEFAULT_METRICS_WINDOW_MS);
      switch (resourceTypeId) {
        case "organization":
          return organizationSeries(
            this.ctx,
            this.org,
            rangeOrDefault(timeRange, USAGE_METRICS_WINDOW_MS),
          );
        case "project": {
          const projects = await this.projects();
          const p = projects.find((x) => x.slug === id);
          const pid = p?.id ?? (await this.api.get(`/projects/${this.o}/${enc(id)}/`)).id;
          return projectSeries(this.ctx, this.org, String(pid), range);
        }
        case "issue":
          return issueSeries(this.ctx, this.org, id, range);
        case "cron-monitor":
          return cronSeries(this.ctx, this.org, id, range);
        case "uptime-monitor":
          return uptimeSeries(this.ctx, this.org, parseScopedId(id).id, range);
        default:
          return [];
      }
    });
  }

  fetchCostData(_accountId: string, range: CostFetchRange): PluginEffect<CostRow[]> {
    return attempt(async () => {
      if (this.ctx.instance.selfHosted) {
        throw new CostSetupError(
          "A self-hosted Sentry has no Sentry bill: usage is free and the cost of running it is your own infrastructure's. Usage still shows on the organization's Metrics tab.",
        );
      }
      return fetchSentryCostData(this.ctx, this.costInputs(await this.projectSlugs()), range);
    });
  }

  verifyCredentials(): PluginEffect<PreflightResult> {
    return attempt(async () => {
      return verifySentryCredentials(this.ctx, this.org);
    });
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  getCreateConfig(typeId: string, parentResourceId?: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      switch (typeId) {
        case "project": {
          const teams = await this.api
            .getAll(`/organizations/${this.o}/teams/`, null)
            .catch((): SentryTeam[] => []);
          return {
            fields: [
              {
                key: "name",
                label: "Name",
                kind: "text",
                required: true,
                placeholder: "checkout-api",
              },
              {
                key: "team",
                label: "Team",
                kind: "select",
                required: true,
                description: "The team that owns the project.",
                ...(teams[0] ? { defaultValue: teams[0].slug } : {}),
                options: teams.map((t) => ({
                  id: t.slug,
                  label: t.name ?? t.slug,
                  description: t.slug,
                })),
              },
              {
                key: "platform",
                label: "Platform",
                kind: "select",
                required: false,
                description:
                  "What the project is written in; Sentry uses it for setup guides and grouping.",
                defaultValue: "other",
                options: PLATFORMS,
              },
            ],
          };
        }
        case "team":
          return {
            fields: [
              {
                key: "name",
                label: "Name",
                kind: "text",
                required: true,
                placeholder: "backend",
                description:
                  "Lowercase letters, numbers, hyphens and underscores; used as the team's slug.",
              },
            ],
          };
        case "client-key": {
          const projects = parentResourceId ? [] : await this.projects().catch(() => []);
          return {
            fields: [
              ...(parentResourceId
                ? []
                : [
                    {
                      key: "project",
                      label: "Project",
                      kind: "select" as const,
                      required: true,
                      ...(projects[0] ? { defaultValue: projects[0].slug } : {}),
                      options: projects.map((p) => ({ id: p.slug, label: p.name ?? p.slug })),
                    },
                  ]),
              { key: "name", label: "Name", kind: "text", required: true, placeholder: "Frontend" },
              {
                key: "rateLimitCount",
                label: "Rate limit (events)",
                kind: "number",
                required: false,
                description: "Optional: events accepted per window through this key.",
              },
              {
                key: "rateLimitWindow",
                label: "Rate limit window (seconds)",
                kind: "number",
                required: false,
                description: "Optional: length of the window, e.g. 60 or 3600.",
              },
            ],
          };
        }
        default:
          throw new Error(`Sentry plugin: cannot create "${typeId}" from Infrawrench`);
      }
    });
  }

  private rateLimitBody(fields: Record<string, string>): { count: number; window: number } | null {
    const count = num(fields["rateLimitCount"], "Rate limit");
    const window = num(fields["rateLimitWindow"], "Rate limit window");
    if (count === undefined && window === undefined) return null;
    if (count === undefined || window === undefined) {
      throw new Error("Sentry plugin: a rate limit needs both a count and a window");
    }
    return { count, window };
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const name = (fields["name"] ?? "").trim();
      if (!name) throw new Error("Sentry plugin: a name is required");
      switch (typeId) {
        case "project": {
          const team = (fields["team"] ?? "").trim();
          if (!team) throw new Error("Sentry plugin: pick a team for the project");
          const p = await this.api.post(`/teams/${this.o}/${enc(team)}/projects/`, {
            body: { name, ...(fields["platform"] ? { platform: fields["platform"] } : {}) },
          });
          this.projectsCache = undefined;
          return mapProject(accountId, this.ctx.instance, this.org, p);
        }
        case "team": {
          const slug = name
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, "-")
            .replace(/^-+|-+$/g, "");
          const t = await this.api.post(`/organizations/${this.o}/teams/`, { body: { slug } });
          return mapTeam(accountId, this.org, t);
        }
        case "client-key": {
          const project = parentResourceId
            ? externalIdOf(parentResourceId)
            : (fields["project"] ?? "").trim();
          if (!project) throw new Error("Sentry plugin: pick a project for the key");
          const rateLimit = this.rateLimitBody(fields);
          const k = await this.api.post(`/projects/${this.o}/${enc(project)}/keys/`, {
            body: { name, ...(rateLimit ? { rateLimit } : {}) },
          });
          return mapClientKey(accountId, this.org, project, k);
        }
        default:
          throw new Error(`Sentry plugin: cannot create "${typeId}" from Infrawrench`);
      }
    });
  }

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = writeId(resourceId);
      const has = (k: string) => k in fields;
      const text = (k: string) => (fields[k] ?? "").trim();
      const named = () => (has("name") && text("name") ? text("name") : undefined);
      switch (typeId) {
        case "project": {
          // An undefined field is not sent, so these bodies hold what was edited.
          await this.api.put(`/projects/${this.o}/${enc(id)}/`, {
            body: {
              name: named(),
              platform: has("platform") ? text("platform") || null : undefined,
            },
          });
          this.projectsCache = undefined;
          break;
        }
        case "team":
          if (has("name") && text("name")) {
            await this.api.put(`/teams/${this.o}/${enc(id)}/`, { body: { name: text("name") } });
          }
          break;
        case "client-key": {
          const { projectSlug, id: keyId } = parseScopedId(id);
          let rateLimit: { count: number; window: number } | null | undefined;
          if (has("rateLimitCount") || has("rateLimitWindow")) {
            const current = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
            rateLimit = this.rateLimitBody({
              rateLimitCount: has("rateLimitCount")
                ? text("rateLimitCount")
                : String(current.fields["rateLimitCount"] ?? ""),
              rateLimitWindow: has("rateLimitWindow")
                ? text("rateLimitWindow")
                : String(current.fields["rateLimitWindow"] ?? ""),
            });
          }
          await this.api.put(`/projects/${this.o}/${enc(projectSlug)}/keys/${enc(keyId)}/`, {
            body: { name: named(), rateLimit },
          });
          break;
        }
        case "alert": {
          // The update takes the whole alert (name is required), so send the
          // current one back with only the edited values replaced.
          const current = await this.fetchWorkflow(id);
          const frequency = has("frequency")
            ? num(fields["frequency"], "Action interval")
            : undefined;
          await this.api.put(`/organizations/${this.o}/workflows/${enc(id)}/`, {
            body: {
              id: current.id,
              name: has("name") && text("name") ? text("name") : current.name,
              enabled: current.enabled ?? true,
              environment: current.environment ?? null,
              config: {
                ...(current.config ?? {}),
                ...(frequency !== undefined ? { frequency } : {}),
              },
              triggers: current.triggers,
              actionFilters: current.actionFilters ?? [],
              detectorIds: current.detectorIds ?? [],
              owner: current.owner ?? null,
            },
          });
          break;
        }
        case "cron-monitor": {
          const schedule =
            has("schedule") && text("schedule") ? parseSchedule(text("schedule")) : undefined;
          const timezone = has("timezone") && text("timezone") ? text("timezone") : undefined;
          const margin = has("checkinMargin")
            ? (num(fields["checkinMargin"], "Check-in margin") ?? null)
            : undefined;
          let maxRuntime: number | null | undefined;
          if (has("maxRuntime")) {
            const v = num(fields["maxRuntime"], "Max runtime");
            if (v !== undefined && (v < 1 || v > MAX_RUNTIME_MINUTES)) {
              throw new Error(
                `Sentry plugin: max runtime must be between 1 and ${MAX_RUNTIME_MINUTES} minutes`,
              );
            }
            maxRuntime = v ?? null;
          }
          const tuning = {
            ...(timezone !== undefined ? { timezone } : {}),
            ...(margin !== undefined ? { checkin_margin: margin } : {}),
            ...(maxRuntime !== undefined ? { max_runtime: maxRuntime } : {}),
          };
          let config: ApiBody<operations["updateOrganizationMonitor"]>["config"];
          if (schedule) {
            config = { ...schedule, ...tuning };
          } else if (Object.keys(tuning).length > 0) {
            const current = await this.api.get(`/organizations/${this.o}/monitors/${enc(id)}/`);
            config = {
              ...tuning,
              schedule_type: current.config?.schedule_type,
              schedule: current.config?.schedule,
            };
          }
          await this.api.put(`/organizations/${this.o}/monitors/${enc(id)}/`, {
            body: { name: named(), config },
          });
          break;
        }
        case "uptime-monitor": {
          const { projectSlug, id: monitorId } = parseScopedId(id);
          let url: string | undefined;
          if (has("checkUrl") && text("checkUrl")) {
            url = text("checkUrl");
            if (!/^https?:\/\//i.test(url))
              throw new Error("Sentry plugin: the URL must start with http:// or https://");
          }
          let intervalSeconds: number | undefined;
          if (has("intervalSeconds") && text("intervalSeconds")) {
            intervalSeconds = Number(text("intervalSeconds"));
            if (!UPTIME_INTERVALS.has(intervalSeconds)) {
              throw new Error(
                "Sentry plugin: the interval must be 60, 300, 600, 1200, 1800 or 3600 seconds",
              );
            }
          }
          let timeoutMs: number | undefined;
          if (has("timeoutMs") && text("timeoutMs")) {
            timeoutMs = num(fields["timeoutMs"], "Timeout");
            if (timeoutMs === undefined || timeoutMs < 1000 || timeoutMs > 60000) {
              throw new Error("Sentry plugin: the timeout must be between 1000 and 60000 ms");
            }
          }
          await this.api.put(`/projects/${this.o}/${enc(projectSlug)}/uptime/${enc(monitorId)}/`, {
            body: { name: named(), url, intervalSeconds, timeoutMs },
          });
          break;
        }
        default:
          throw new Error(`Sentry plugin: "${typeId}" cannot be edited from Infrawrench`);
      }
      return runPluginEffect(this.getResource(typeId, resourceId, accountId));
    });
  }

  deleteResource(typeId: string, resourceId: string, _accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const id = writeId(resourceId);
      switch (typeId) {
        case "project":
          await this.api.delete(`/projects/${this.o}/${enc(id)}/`);
          this.projectsCache = undefined;
          return;
        case "team":
          await this.api.delete(`/teams/${this.o}/${enc(id)}/`);
          return;
        case "client-key": {
          const { projectSlug, id: keyId } = parseScopedId(id);
          await this.api.delete(`/projects/${this.o}/${enc(projectSlug)}/keys/${enc(keyId)}/`);
          return;
        }
        case "alert":
          await this.api.delete(`/organizations/${this.o}/workflows/${enc(id)}/`);
          return;
        case "monitor":
          await this.api.delete(`/organizations/${this.o}/detectors/${enc(id)}/`);
          return;
        case "cron-monitor":
          await this.api.delete(`/organizations/${this.o}/monitors/${enc(id)}/`);
          return;
        case "uptime-monitor": {
          const { projectSlug, id: monitorId } = parseScopedId(id);
          await this.api.delete(
            `/projects/${this.o}/${enc(projectSlug)}/uptime/${enc(monitorId)}/`,
          );
          return;
        }
        default:
          throw new Error(`Sentry plugin: "${typeId}" cannot be deleted from Infrawrench`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private async updateIssue(issueId: string, action: string): Promise<void> {
    const body = ISSUE_ACTIONS[action];
    if (!body) throw new Error(`Sentry plugin: unknown issue action "${action}"`);
    await this.api.put(`/organizations/${this.o}/issues/`, { query: { id: [issueId] }, body });
  }

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      const id = writeId(resourceId);
      const toggle = actionId === "enable" || actionId === "disable";
      switch (typeId) {
        case "issue":
          return this.updateIssue(id, actionId);
        case "project": {
          const m = /^(resolve|archive)-issue:(\d+)$/.exec(actionId);
          if (m) return this.updateIssue(m[2]!, m[1]!);
          break;
        }
        case "client-key":
          if (toggle) {
            const { projectSlug, id: keyId } = parseScopedId(id);
            await this.api.put(`/projects/${this.o}/${enc(projectSlug)}/keys/${enc(keyId)}/`, {
              body: { isActive: actionId === "enable" },
            });
            return;
          }
          break;
        case "alert":
          if (toggle) {
            await this.api.put(`/organizations/${this.o}/workflows/`, {
              query: { id: [id] },
              body: { enabled: actionId === "enable" },
            });
            return;
          }
          break;
        case "monitor":
          if (toggle) {
            await this.api.put(`/organizations/${this.o}/detectors/`, {
              query: { id: [id] },
              body: { enabled: actionId === "enable" },
            });
            return;
          }
          break;
        case "cron-monitor": {
          const body: ApiBody<operations["updateOrganizationMonitor"]> | undefined =
            actionId === "pause"
              ? { status: "disabled" }
              : actionId === "resume"
                ? { status: "active" }
                : actionId === "mute"
                  ? { isMuted: true }
                  : actionId === "unmute"
                    ? { isMuted: false }
                    : undefined;
          if (body) {
            await this.api.put(`/organizations/${this.o}/monitors/${enc(id)}/`, { body });
            return;
          }
          break;
        }
        case "uptime-monitor":
          if (actionId === "pause" || actionId === "resume") {
            const { projectSlug, id: monitorId } = parseScopedId(id);
            await this.api.put(
              `/projects/${this.o}/${enc(projectSlug)}/uptime/${enc(monitorId)}/`,
              {
                body: { status: actionId === "pause" ? "disabled" : "active" },
              },
            );
            return;
          }
          break;
      }
      throw new Error(`Sentry plugin: unknown action "${actionId}" for "${typeId}"`);
    });
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderSentryDetail(resource, this.rates, {
      alerts: orgUrl(this.ctx.instance, this.org, "monitors/alerts/"),
      monitors: orgUrl(this.ctx.instance, this.org, "monitors/"),
    });
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderSentrySidebar(resource);
  }
}
