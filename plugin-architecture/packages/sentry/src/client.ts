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
  ResourceInstance,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { CostSetupError, externalIdOf } from "@infrawrench/plugin-base";
import type { SentryContext } from "./api.js";
import { sentryFetch, sentryPaged, sentryRequest, statusOf } from "./api.js";
import type { CostInputs, MonitorCounts, StatsResponse } from "./cost-data.js";
import { fetchSentryCostData, fetchStats, fetchUsageSummary } from "./cost-data.js";
import type {
  ProjectStats,
  SentryClientKey,
  SentryCronMonitor,
  SentryDetector,
  SentryIssue,
  SentryOrganization,
  SentryProject,
  SentryRelease,
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

const enc = encodeURIComponent;

const ISSUE_ACTIONS: Record<string, Record<string, unknown>> = {
  resolve: { status: "resolved" },
  unresolve: { status: "unresolved" },
  archive: { status: "ignored", substatus: "archived_until_escalating" },
  "archive-forever": { status: "ignored", substatus: "archived_forever" },
};

const UPTIME_INTERVALS = new Set([60, 300, 600, 1200, 1800, 3600]);

function num(raw: string | undefined, label: string): number | undefined {
  const value = (raw ?? "").trim();
  if (!value) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Sentry plugin: "${label}" must be a non-negative number, got "${value}"`);
  }
  return n;
}

/** Crontab (`0 * * * *`) or interval (`10 minute`) into Sentry's monitor config. */
export function parseSchedule(raw: string): { schedule_type: string; schedule: unknown } {
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
  private readonly org: string;
  private readonly rates: SentryRates;
  private projectsCache: Promise<SentryProject[]> | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
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
    this.org = (credentials["organization"] ?? "").trim();
    if (!this.org) throw new Error("Sentry plugin: pick an organization");
    this.rates = parseRates(credentials);
  }

  get instance(): SentryInstance {
    return this.ctx.instance;
  }

  private get o(): string {
    return enc(this.org);
  }

  private projects(): Promise<SentryProject[]> {
    this.projectsCache ??= sentryPaged<SentryProject>(
      this.ctx,
      `/organizations/${this.o}/projects/`,
    ).catch((err: unknown) => {
      this.projectsCache = undefined;
      throw err;
    });
    return this.projectsCache;
  }

  private async projectSlugs(): Promise<Map<string, string>> {
    const projects = await this.projects().catch(() => [] as SentryProject[]);
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
      sentryPaged<SentryCronMonitor>(this.ctx, `/organizations/${this.o}/monitors/`),
      sentryPaged<SentryUptimeMonitor>(this.ctx, `/organizations/${this.o}/uptime/`).catch(
        () => [] as SentryUptimeMonitor[],
      ),
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

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    const inst = this.ctx.instance;
    switch (typeId) {
      case "organization": {
        const org = await sentryFetch<SentryOrganization>(this.ctx, `/organizations/${this.o}/`);
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
        return (await sentryPaged<SentryTeam>(this.ctx, `/organizations/${this.o}/teams/`)).map(
          (t) => mapTeam(accountId, this.org, t),
        );
      case "release":
        return (
          await sentryFetch<SentryRelease[]>(this.ctx, `/organizations/${this.o}/releases/`, {
            query: { per_page: 100 },
          })
        ).map((r) => mapRelease(accountId, r));
      case "issue":
        return (await this.topIssues()).map((i) => mapIssue(accountId, i));
      case "client-key":
        return this.listClientKeys(accountId);
      case "alert":
        return (
          await sentryPaged<SentryWorkflow>(this.ctx, `/organizations/${this.o}/workflows/`)
        ).map((w) => mapWorkflow(accountId, w));
      case "monitor": {
        const [detectors, slugs] = await Promise.all([
          sentryPaged<SentryDetector>(this.ctx, `/organizations/${this.o}/detectors/`),
          this.projectSlugs(),
        ]);
        return detectors
          .filter((d) => !DEDICATED_DETECTOR_TYPES.has(d.type ?? ""))
          .map((d) => mapDetector(accountId, d, slugs));
      }
      case "cron-monitor":
        return (
          await sentryPaged<SentryCronMonitor>(this.ctx, `/organizations/${this.o}/monitors/`)
        ).map((m) => mapCronMonitor(accountId, m));
      case "uptime-monitor":
        return (
          await sentryPaged<SentryUptimeMonitor>(this.ctx, `/organizations/${this.o}/uptime/`)
        ).map((m) => mapUptimeMonitor(accountId, m));
      default:
        throw new Error(`Sentry plugin: unknown resource type "${typeId}"`);
    }
  }

  /** The unresolved issues with the most events in the last 14 days. */
  private topIssues(projectId?: string, limit = 100) {
    return sentryRequest<SentryIssue[]>(this.ctx, `/organizations/${this.o}/issues/`, {
      query: {
        query: "is:unresolved",
        statsPeriod: "14d",
        sort: "freq",
        limit,
        ...(projectId ? { project: projectId } : {}),
      },
    }).then((r) => (Array.isArray(r.body) ? r.body : []));
  }

  private async listClientKeys(accountId: string): Promise<ResourceInstance[]> {
    const projects = await this.projects();
    const slugs = new Map(projects.map((p) => [String(p.id), p.slug]));
    try {
      const keys = await sentryPaged<SentryClientKey>(
        this.ctx,
        `/organizations/${this.o}/project-keys/`,
      );
      return keys
        .filter((k) => slugs.has(String(k.projectId)))
        .map((k) => mapClientKey(accountId, this.org, slugs.get(String(k.projectId))!, k));
    } catch (err) {
      // Older self-hosted releases lack the org-wide listing: fall back to
      // one request per project.
      if (statusOf(err) !== 404) throw err;
      const out: ResourceInstance[] = [];
      for (const p of projects) {
        const keys = await sentryPaged<SentryClientKey>(
          this.ctx,
          `/projects/${this.o}/${enc(p.slug)}/keys/`,
        );
        out.push(...keys.map((k) => mapClientKey(accountId, this.org, p.slug, k)));
      }
      return out;
    }
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
    const inst = this.ctx.instance;
    switch (typeId) {
      case "organization": {
        const org = await sentryFetch<SentryOrganization>(this.ctx, `/organizations/${this.o}/`);
        const summary = await fetchUsageSummary(
          this.ctx,
          this.costInputs(await this.projectSlugs()),
        ).catch(() => undefined);
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
        const p = await sentryFetch<SentryProject>(this.ctx, `/projects/${this.o}/${enc(id)}/`);
        const pid = String(p.id);
        const [stats, issues] = await Promise.all([
          this.stats24h([pid]).catch(() => new Map<string, ProjectStats>()),
          sentryRequest<SentryIssue[]>(this.ctx, `/organizations/${this.o}/issues/`, {
            query: {
              query: "is:unresolved",
              statsPeriod: "14d",
              sort: "freq",
              limit: 10,
              project: pid,
            },
          }).catch(() => undefined),
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
        return mapTeam(
          accountId,
          this.org,
          await sentryFetch<SentryTeam>(this.ctx, `/teams/${this.o}/${enc(id)}/`),
        );
      case "release":
        return mapRelease(
          accountId,
          await sentryFetch<SentryRelease>(
            this.ctx,
            `/organizations/${this.o}/releases/${enc(id)}/`,
          ),
        );
      case "issue":
        return mapIssue(
          accountId,
          await sentryFetch<SentryIssue>(this.ctx, `/organizations/${this.o}/issues/${enc(id)}/`),
        );
      case "client-key": {
        const { projectSlug, id: keyId } = parseScopedId(id);
        const k = await sentryFetch<SentryClientKey>(
          this.ctx,
          `/projects/${this.o}/${enc(projectSlug)}/keys/${enc(keyId)}/`,
        );
        return mapClientKey(accountId, this.org, projectSlug, k);
      }
      case "alert":
        return mapWorkflow(accountId, await this.fetchWorkflow(id));
      case "monitor":
        return mapDetector(
          accountId,
          await sentryFetch<SentryDetector>(
            this.ctx,
            `/organizations/${this.o}/detectors/${enc(id)}/`,
          ),
          await this.projectSlugs(),
        );
      case "cron-monitor":
        return mapCronMonitor(
          accountId,
          await sentryFetch<SentryCronMonitor>(
            this.ctx,
            `/organizations/${this.o}/monitors/${enc(id)}/`,
          ),
        );
      case "uptime-monitor": {
        const { projectSlug, id: monitorId } = parseScopedId(id);
        const m = await sentryFetch<SentryUptimeMonitor>(
          this.ctx,
          `/projects/${this.o}/${enc(projectSlug)}/uptime/${enc(monitorId)}/`,
        );
        return mapUptimeMonitor(accountId, { ...m, projectSlug: m.projectSlug ?? projectSlug });
      }
      default:
        throw new Error(`Sentry plugin: unknown resource type "${typeId}"`);
    }
  }

  private fetchWorkflow(id: string): Promise<SentryWorkflow> {
    return sentryFetch<SentryWorkflow>(this.ctx, `/organizations/${this.o}/workflows/${enc(id)}/`);
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
    throw new Error(`Sentry plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Stats, metrics, costs, preflight
  // -------------------------------------------------------------------------

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const r = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = r.fields;
    const show = (v: unknown, suffix = "") =>
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
              health === "error" ? "status-error" : health === "ok" ? "status-healthy" : "default",
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
      case "organization":
        return organizationSeries(
          this.ctx,
          this.org,
          rangeOrDefault(timeRange, USAGE_METRICS_WINDOW_MS),
        );
      case "project": {
        const projects = await this.projects();
        const p = projects.find((x) => x.slug === id);
        const pid =
          p?.id ??
          (await sentryFetch<SentryProject>(this.ctx, `/projects/${this.o}/${enc(id)}/`)).id;
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
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    if (this.ctx.instance.selfHosted) {
      throw new CostSetupError(
        "A self-hosted Sentry has no Sentry bill: usage is free and the cost of running it is your own infrastructure's. Usage still shows on the organization's Metrics tab.",
      );
    }
    return fetchSentryCostData(this.ctx, this.costInputs(await this.projectSlugs()), range);
  }

  async verifyCredentials(): Promise<PreflightResult> {
    return verifySentryCredentials(this.ctx, this.org);
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case "project": {
        const teams = await sentryPaged<SentryTeam>(
          this.ctx,
          `/organizations/${this.o}/teams/`,
        ).catch(() => [] as SentryTeam[]);
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

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    const name = (fields["name"] ?? "").trim();
    if (!name) throw new Error("Sentry plugin: a name is required");
    switch (typeId) {
      case "project": {
        const team = (fields["team"] ?? "").trim();
        if (!team) throw new Error("Sentry plugin: pick a team for the project");
        const p = await sentryFetch<SentryProject>(
          this.ctx,
          `/teams/${this.o}/${enc(team)}/projects/`,
          {
            method: "POST",
            body: { name, ...(fields["platform"] ? { platform: fields["platform"] } : {}) },
          },
        );
        this.projectsCache = undefined;
        return mapProject(accountId, this.ctx.instance, this.org, p);
      }
      case "team": {
        const slug = name
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, "-")
          .replace(/^-+|-+$/g, "");
        const t = await sentryFetch<SentryTeam>(this.ctx, `/organizations/${this.o}/teams/`, {
          method: "POST",
          body: { slug },
        });
        return mapTeam(accountId, this.org, t);
      }
      case "client-key": {
        const project = parentResourceId
          ? externalIdOf(parentResourceId)
          : (fields["project"] ?? "").trim();
        if (!project) throw new Error("Sentry plugin: pick a project for the key");
        const rateLimit = this.rateLimitBody(fields);
        const k = await sentryFetch<SentryClientKey>(
          this.ctx,
          `/projects/${this.o}/${enc(project)}/keys/`,
          {
            method: "POST",
            body: { name, ...(rateLimit ? { rateLimit } : {}) },
          },
        );
        return mapClientKey(accountId, this.org, project, k);
      }
      default:
        throw new Error(`Sentry plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    const has = (k: string) => k in fields;
    const text = (k: string) => (fields[k] ?? "").trim();
    switch (typeId) {
      case "project": {
        const body: Record<string, unknown> = {};
        if (has("name") && text("name")) body["name"] = text("name");
        if (has("platform")) body["platform"] = text("platform") || null;
        await sentryFetch(this.ctx, `/projects/${this.o}/${enc(id)}/`, { method: "PUT", body });
        this.projectsCache = undefined;
        break;
      }
      case "team":
        if (has("name") && text("name")) {
          await sentryFetch(this.ctx, `/teams/${this.o}/${enc(id)}/`, {
            method: "PUT",
            body: { name: text("name") },
          });
        }
        break;
      case "client-key": {
        const { projectSlug, id: keyId } = parseScopedId(id);
        const body: Record<string, unknown> = {};
        if (has("name") && text("name")) body["name"] = text("name");
        if (has("rateLimitCount") || has("rateLimitWindow")) {
          const current = await this.getResource(typeId, resourceId, accountId);
          body["rateLimit"] = this.rateLimitBody({
            rateLimitCount: has("rateLimitCount")
              ? text("rateLimitCount")
              : String(current.fields["rateLimitCount"] ?? ""),
            rateLimitWindow: has("rateLimitWindow")
              ? text("rateLimitWindow")
              : String(current.fields["rateLimitWindow"] ?? ""),
          });
        }
        await sentryFetch(this.ctx, `/projects/${this.o}/${enc(projectSlug)}/keys/${enc(keyId)}/`, {
          method: "PUT",
          body,
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
        await sentryFetch(this.ctx, `/organizations/${this.o}/workflows/${enc(id)}/`, {
          method: "PUT",
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
        const body: Record<string, unknown> = {};
        if (has("name") && text("name")) body["name"] = text("name");
        const config: Record<string, unknown> = {};
        if (has("schedule") && text("schedule"))
          Object.assign(config, parseSchedule(text("schedule")));
        if (has("timezone") && text("timezone")) config["timezone"] = text("timezone");
        if (has("checkinMargin"))
          config["checkin_margin"] = num(fields["checkinMargin"], "Check-in margin") ?? null;
        if (has("maxRuntime")) {
          const v = num(fields["maxRuntime"], "Max runtime");
          if (v !== undefined && (v < 1 || v > 40320)) {
            throw new Error("Sentry plugin: max runtime must be between 1 and 40320 minutes");
          }
          config["max_runtime"] = v ?? null;
        }
        if (Object.keys(config).length > 0) {
          if (!config["schedule"]) {
            const current = await sentryFetch<SentryCronMonitor>(
              this.ctx,
              `/organizations/${this.o}/monitors/${enc(id)}/`,
            );
            config["schedule_type"] = current.config?.schedule_type;
            config["schedule"] = current.config?.schedule;
          }
          body["config"] = config;
        }
        await sentryFetch(this.ctx, `/organizations/${this.o}/monitors/${enc(id)}/`, {
          method: "PUT",
          body,
        });
        break;
      }
      case "uptime-monitor": {
        const { projectSlug, id: monitorId } = parseScopedId(id);
        const body: Record<string, unknown> = {};
        if (has("name") && text("name")) body["name"] = text("name");
        if (has("checkUrl") && text("checkUrl")) {
          const url = text("checkUrl");
          if (!/^https?:\/\//i.test(url))
            throw new Error("Sentry plugin: the URL must start with http:// or https://");
          body["url"] = url;
        }
        if (has("intervalSeconds") && text("intervalSeconds")) {
          const v = Number(text("intervalSeconds"));
          if (!UPTIME_INTERVALS.has(v)) {
            throw new Error(
              "Sentry plugin: the interval must be 60, 300, 600, 1200, 1800 or 3600 seconds",
            );
          }
          body["intervalSeconds"] = v;
        }
        if (has("timeoutMs") && text("timeoutMs")) {
          const v = num(fields["timeoutMs"], "Timeout");
          if (v === undefined || v < 1000 || v > 60000) {
            throw new Error("Sentry plugin: the timeout must be between 1000 and 60000 ms");
          }
          body["timeoutMs"] = v;
        }
        await sentryFetch(
          this.ctx,
          `/projects/${this.o}/${enc(projectSlug)}/uptime/${enc(monitorId)}/`,
          {
            method: "PUT",
            body,
          },
        );
        break;
      }
      default:
        throw new Error(`Sentry plugin: "${typeId}" cannot be edited from Infrawrench`);
    }
    return this.getResource(typeId, resourceId, accountId);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const id = externalIdOf(resourceId);
    const del = (path: string) => sentryFetch(this.ctx, path, { method: "DELETE" });
    switch (typeId) {
      case "project":
        await del(`/projects/${this.o}/${enc(id)}/`);
        this.projectsCache = undefined;
        return;
      case "team":
        await del(`/teams/${this.o}/${enc(id)}/`);
        return;
      case "client-key": {
        const { projectSlug, id: keyId } = parseScopedId(id);
        await del(`/projects/${this.o}/${enc(projectSlug)}/keys/${enc(keyId)}/`);
        return;
      }
      case "alert":
        await del(`/organizations/${this.o}/workflows/${enc(id)}/`);
        return;
      case "monitor":
        await del(`/organizations/${this.o}/detectors/${enc(id)}/`);
        return;
      case "cron-monitor":
        await del(`/organizations/${this.o}/monitors/${enc(id)}/`);
        return;
      case "uptime-monitor": {
        const { projectSlug, id: monitorId } = parseScopedId(id);
        await del(`/projects/${this.o}/${enc(projectSlug)}/uptime/${enc(monitorId)}/`);
        return;
      }
      default:
        throw new Error(`Sentry plugin: "${typeId}" cannot be deleted from Infrawrench`);
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private async updateIssue(issueId: string, action: string): Promise<void> {
    const body = ISSUE_ACTIONS[action];
    if (!body) throw new Error(`Sentry plugin: unknown issue action "${action}"`);
    await sentryFetch(this.ctx, `/organizations/${this.o}/issues/`, {
      method: "PUT",
      query: { id: [issueId] },
      body,
    });
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const id = externalIdOf(resourceId);
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
          await sentryFetch(
            this.ctx,
            `/projects/${this.o}/${enc(projectSlug)}/keys/${enc(keyId)}/`,
            {
              method: "PUT",
              body: { isActive: actionId === "enable" },
            },
          );
          return;
        }
        break;
      case "alert":
      case "monitor":
        if (toggle) {
          await sentryFetch(
            this.ctx,
            `/organizations/${this.o}/${typeId === "alert" ? "workflows" : "detectors"}/`,
            { method: "PUT", query: { id: [id] }, body: { enabled: actionId === "enable" } },
          );
          return;
        }
        break;
      case "cron-monitor": {
        const body =
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
          await sentryFetch(this.ctx, `/organizations/${this.o}/monitors/${enc(id)}/`, {
            method: "PUT",
            body,
          });
          return;
        }
        break;
      }
      case "uptime-monitor":
        if (actionId === "pause" || actionId === "resume") {
          const { projectSlug, id: monitorId } = parseScopedId(id);
          await sentryFetch(
            this.ctx,
            `/projects/${this.o}/${enc(projectSlug)}/uptime/${enc(monitorId)}/`,
            {
              method: "PUT",
              body: { status: actionId === "pause" ? "disabled" : "active" },
            },
          );
          return;
        }
        break;
    }
    throw new Error(`Sentry plugin: unknown action "${actionId}" for "${typeId}"`);
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
