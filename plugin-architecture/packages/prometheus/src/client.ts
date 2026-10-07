import type {
  BusinessMetricSourceOption,
  BusinessMetricSourceRange,
  BusinessMetricSourceResult,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  PreflightCapability,
  PreflightCapabilityCheck,
  PreflightResult,
  ResourceInstance,
  SidebarItemSchema,
  SqlTableMeta,
} from "@infrawrench/plugin-base";
import { decodePromptArgs, externalIdOf } from "@infrawrench/plugin-base";
import type { PromContext } from "./api.js";
import {
  amFetch,
  buildContext,
  PromApiError,
  promFetch,
  promString,
  splitId,
  statusOf,
} from "./api.js";
import { listPromMetricSourceOptions, runPromMetricSource } from "./business-metric-source.js";
import type {
  Alert,
  AmAlert,
  AmStatus,
  BuildInfo,
  RuleGroup,
  RuntimeInfo,
  Silence,
  TargetsData,
  TsdbStatus,
} from "./mappers.js";
import {
  groupId,
  mapAlert,
  mapAlertmanager,
  mapAmAlert,
  mapReceiver,
  mapRule,
  mapRuleGroup,
  mapScrapePool,
  mapServer,
  mapSilence,
  mapTarget,
  parseMatchers,
  ruleIds,
  targetId,
} from "./mappers.js";
import { instantQuery, queryRange, rangeOrDefault } from "./prom.js";
import { COMMANDS, renderPromDetail, renderPromSidebar, silenceFields } from "./render.js";

const MAX_TARGETS = 3000;

const DURATIONS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** `2h`, `3d`, `90m` from now, or an ISO time. */
export function parseEndsAt(raw: string, now = Date.now()): string {
  const t = raw.trim();
  const m = /^(\d+(?:\.\d+)?)\s*([mhdw])$/i.exec(t);
  if (m) return new Date(now + Number(m[1]) * DURATIONS[m[2]!.toLowerCase()]!).toISOString();
  const ms = Date.parse(t);
  if (!Number.isFinite(ms))
    throw new PromApiError(400, `Prometheus plugin: "${raw}" is not a time or a duration like 2h`);
  return new Date(ms).toISOString();
}

const PROBES: Array<{ capability: PreflightCapability; run: (c: PromClient) => Promise<unknown> }> =
  [
    {
      capability: {
        id: "query",
        label: "PromQL queries",
        description: "Run instant and range queries for the Query and Metrics tabs.",
        requiredPermissions: [{ id: "query", label: "Read access to /api/v1/query" }],
        essential: true,
      },
      run: (c) => c.raw("/api/v1/query", { query: "vector(1)" }),
    },
    {
      capability: {
        id: "targets",
        label: "Targets",
        description:
          "Scrape pools and target health. Thanos, Mimir and VictoriaMetrics may not offer this.",
        requiredPermissions: [{ id: "targets", label: "/api/v1/targets" }],
      },
      run: (c) => c.raw("/api/v1/targets", { state: "active" }),
    },
    {
      capability: {
        id: "rules",
        label: "Rules and alerts",
        description: "Recording and alerting rules and active alerts.",
        requiredPermissions: [{ id: "rules", label: "/api/v1/rules" }],
      },
      run: (c) => c.raw("/api/v1/rules", { exclude_alerts: true }),
    },
    {
      capability: {
        id: "status",
        label: "Server status",
        description: "Build and runtime information, TSDB statistics and the loaded configuration.",
        requiredPermissions: [{ id: "status", label: "/api/v1/status/*" }],
      },
      run: (c) => c.raw("/api/v1/status/buildinfo"),
    },
    {
      capability: {
        id: "alertmanager",
        label: "Alertmanager",
        description:
          "Silences, notified alerts and receivers. Needs an Alertmanager URL on the account.",
        requiredPermissions: [{ id: "alertmanager", label: "Alertmanager /api/v2/status" }],
      },
      run: (c) => c.am("/status"),
    },
  ];

export const PROM_PREFLIGHT = { capabilities: PROBES.map((p) => p.capability) };

export class PromClient implements PluginClient {
  private readonly ctx: PromContext;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    this.ctx = buildContext(credentials, services?.http);
  }

  /** @internal for probes */
  raw(path: string, query?: Record<string, string | number | boolean>): Promise<unknown> {
    return promFetch(this.ctx, path, query ? { query } : {});
  }

  /** @internal for probes */
  am(path: string): Promise<unknown> {
    return amFetch(this.ctx, path);
  }

  private soft<T>(p: Promise<T>): Promise<T | undefined> {
    return p.catch(() => undefined);
  }

  private targets(state: "active" | "any" = "active"): Promise<TargetsData> {
    return promFetch<TargetsData>(this.ctx, "/api/v1/targets", { query: { state } });
  }

  private ruleGroups(): Promise<RuleGroup[]> {
    return promFetch<{ groups?: RuleGroup[] }>(this.ctx, "/api/v1/rules").then(
      (d) => d?.groups ?? [],
    );
  }

  private async server(accountId: string): Promise<ResourceInstance> {
    const [build, runtime, tsdb, targets, groups, ams] = await Promise.all([
      this.soft(promFetch<BuildInfo>(this.ctx, "/api/v1/status/buildinfo")),
      this.soft(promFetch<RuntimeInfo>(this.ctx, "/api/v1/status/runtimeinfo")),
      this.soft(promFetch<TsdbStatus>(this.ctx, "/api/v1/status/tsdb", { query: { limit: 1 } })),
      this.soft(this.targets()),
      this.soft(this.ruleGroups()),
      this.soft(
        promFetch<{ activeAlertmanagers?: Array<{ url?: string }> }>(
          this.ctx,
          "/api/v1/alertmanagers",
        ),
      ),
    ]);
    if (!build && !runtime && !targets && !groups) {
      // Nothing answered: surface the real failure from the one endpoint everything has.
      await promFetch(this.ctx, "/api/v1/query", { query: { query: "vector(1)" } });
    }
    return mapServer(
      accountId,
      this.ctx.baseUrl,
      build,
      runtime,
      tsdb,
      targets,
      groups,
      ams?.activeAlertmanagers?.map((a) => a.url ?? "").filter(Boolean),
    );
  }

  private async alertmanager(accountId: string): Promise<ResourceInstance[]> {
    if (!this.ctx.alertmanagerUrl) return [];
    const [status, receivers, silences, alerts] = await Promise.all([
      amFetch<AmStatus>(this.ctx, "/status"),
      this.soft(amFetch<Array<{ name?: string }>>(this.ctx, "/receivers")),
      this.soft(amFetch<Silence[]>(this.ctx, "/silences")),
      this.soft(amFetch<AmAlert[]>(this.ctx, "/alerts")),
    ]);
    return [
      mapAlertmanager(accountId, this.ctx.alertmanagerUrl, status, {
        ...(receivers ? { receivers: receivers.length } : {}),
        ...(silences
          ? { silences: silences.filter((s) => s.status?.state === "active").length }
          : {}),
        ...(alerts ? { alerts: alerts.length } : {}),
      }),
    ];
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "prometheus-server":
        return [await this.server(accountId)];
      case "prometheus-scrape-pool": {
        const [data, pools] = await Promise.all([
          this.targets("any"),
          this.soft(promFetch<{ scrapePools?: string[] }>(this.ctx, "/api/v1/scrape_pools")),
        ]);
        const names = new Set<string>(pools?.scrapePools ?? []);
        for (const t of data.activeTargets ?? []) if (t.scrapePool) names.add(t.scrapePool);
        return [...names].sort().map((n) =>
          mapScrapePool(
            accountId,
            n,
            (data.activeTargets ?? []).filter((t) => t.scrapePool === n),
            (data.droppedTargets ?? []).filter((t) => t.scrapePool === n).length,
          ),
        );
      }
      case "prometheus-target":
        return ((await this.targets()).activeTargets ?? [])
          .slice(0, MAX_TARGETS)
          .map((t) => mapTarget(accountId, t));
      case "prometheus-rule-group":
        return (await this.ruleGroups()).map((g) => mapRuleGroup(accountId, g));
      case "prometheus-rule":
        return (await this.ruleGroups()).flatMap((g) => {
          const ids = ruleIds(g);
          return (g.rules ?? []).map((r, i) => mapRule(accountId, g, r, ids[i]!));
        });
      case "prometheus-alert":
        return (
          (await promFetch<{ alerts?: Alert[] }>(this.ctx, "/api/v1/alerts")).alerts ?? []
        ).map((a) => mapAlert(accountId, a));
      case "prometheus-alertmanager":
        return this.alertmanager(accountId);
      case "prometheus-silence":
        if (!this.ctx.alertmanagerUrl) return [];
        return ((await amFetch<Silence[]>(this.ctx, "/silences")) ?? []).map((s) =>
          mapSilence(accountId, s),
        );
      case "prometheus-am-alert":
        if (!this.ctx.alertmanagerUrl) return [];
        return ((await amFetch<AmAlert[]>(this.ctx, "/alerts")) ?? []).map((a) =>
          mapAmAlert(accountId, a),
        );
      case "prometheus-receiver": {
        if (!this.ctx.alertmanagerUrl) return [];
        const [receivers, alerts] = await Promise.all([
          amFetch<Array<{ name?: string }>>(this.ctx, "/receivers"),
          this.soft(amFetch<AmAlert[]>(this.ctx, "/alerts")),
        ]);
        return (receivers ?? []).map((r) =>
          mapReceiver(
            accountId,
            r.name ?? "",
            (alerts ?? []).filter((a) => (a.receivers ?? []).some((x) => x.name === r.name)).length,
          ),
        );
      }
      default:
        return [];
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    if (typeId === "prometheus-server") return this.server(accountId);
    if (typeId === "prometheus-silence") {
      return mapSilence(
        accountId,
        await amFetch<Silence>(this.ctx, `/silence/${encodeURIComponent(id)}`),
      );
    }
    if (typeId === "prometheus-target") {
      const t = ((await this.targets()).activeTargets ?? []).find((x) => targetId(x) === id);
      if (!t) throw new PromApiError(404, "Prometheus plugin: the target is no longer discovered");
      return mapTarget(accountId, t);
    }
    if (typeId === "prometheus-rule-group" || typeId === "prometheus-rule") {
      for (const g of await this.ruleGroups()) {
        if (typeId === "prometheus-rule-group" && groupId(g) === id)
          return mapRuleGroup(accountId, g);
        if (typeId === "prometheus-rule") {
          const ids = ruleIds(g);
          const i = ids.indexOf(id);
          if (i >= 0) return mapRule(accountId, g, g.rules![i]!, id);
        }
      }
      throw new PromApiError(404, "Prometheus plugin: the rule is no longer loaded");
    }
    const found = (await this.listResources(typeId, accountId)).find((r) => r.externalId === id);
    if (!found) throw new PromApiError(404, `Prometheus plugin: ${typeId} "${id}" not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "prometheus-server" && outputKey === "config")
      return this.getManifest(resourceId, accountId);
    const r = await this.getResource(typeId, resourceId, accountId);
    return String(r.resolvedOutputs[outputKey] ?? r.fields[outputKey] ?? "");
  }

  // -------------------------------------------------------------------------
  // Query, metrics, stats
  // -------------------------------------------------------------------------

  async executeQuery(
    _resourceId: string,
    _accountId: string,
    sql: string,
  ): Promise<{ rows: Record<string, unknown>[]; durationMs: number }> {
    const started = Date.now();
    const rows = await instantQuery(this.ctx, sql.trim());
    return { rows, durationMs: Date.now() - started };
  }

  /** Metric names, for the editor's autocomplete (capped). */
  async introspectResource(): Promise<SqlTableMeta[]> {
    const names = await this.soft(promFetch<string[]>(this.ctx, "/api/v1/label/__name__/values"));
    return (names ?? []).slice(0, 1000).map((name) => ({ name, columns: [] }));
  }

  async fetchDashboardStats(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    if (typeId !== "prometheus-server" && typeId !== "prometheus-scrape-pool") return [];
    const f = (await this.getResource(typeId, resourceId, accountId)).fields;
    const down = Number(f[typeId === "prometheus-server" ? "targetsDown" : "down"] ?? 0);
    const up = Number(f[typeId === "prometheus-server" ? "targetsUp" : "up"] ?? 0);
    const stats: DashboardStat[] = [
      {
        label: "Targets up",
        value: `${up}/${up + down}`,
        variant: down ? "status-degraded" : "status-healthy",
      },
    ];
    if (typeId === "prometheus-server" && f["alertsFiring"] !== undefined)
      stats.push({
        label: "Firing",
        value: String(f["alertsFiring"]),
        variant: Number(f["alertsFiring"]) ? "status-error" : "status-healthy",
      });
    return stats;
  }

  async fetchMetricSeries(
    typeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const range = rangeOrDefault(timeRange);
    const run = async (queries: Array<[string, string, string?]>) =>
      (
        await Promise.all(
          queries.map(([q, label, unit]) =>
            queryRange(this.ctx, q, range, label, unit).catch(() => []),
          ),
        )
      ).flat();
    const id = externalIdOf(resourceId);
    switch (typeId) {
      case "prometheus-server":
        return run([
          ["sum(prometheus_tsdb_head_series)", "Head series", "count"],
          ["sum(rate(prometheus_tsdb_head_samples_appended_total[5m]))", "Samples ingested", "/s"],
          ["sum(up)", "Targets up", "count"],
          ["count(up == 0)", "Targets down", "count"],
          [
            "sum(rate(prometheus_rule_evaluation_failures_total[5m]))",
            "Rule evaluation failures",
            "/s",
          ],
          ["sum(rate(prometheus_notifications_dropped_total[5m]))", "Notifications dropped", "/s"],
          ['sum(process_resident_memory_bytes{job=~"prometheus.*"})', "Memory", "bytes"],
        ]);
      case "prometheus-scrape-pool": {
        const [name] = splitId(id, 1);
        const job = `job="${promString(name!)}"`;
        return run([
          [`sum(up{${job}})`, "Up", "count"],
          [`count(up{${job}} == 0)`, "Down", "count"],
          [`sum(scrape_samples_scraped{${job}})`, "Samples per scrape", "count"],
          [`max(scrape_duration_seconds{${job}})`, "Slowest scrape", "s"],
        ]);
      }
      case "prometheus-target": {
        const r = await this.getResource(typeId, resourceId, accountId);
        const sel = `job="${promString(String(r.fields["job"] ?? ""))}",instance="${promString(String(r.fields["instance"] ?? ""))}"`;
        return run([
          [`up{${sel}}`, "Up", "bool"],
          [`scrape_duration_seconds{${sel}}`, "Scrape duration", "s"],
          [`scrape_samples_scraped{${sel}}`, "Samples scraped", "count"],
          [`scrape_series_added{${sel}}`, "Series added", "count"],
        ]);
      }
      case "prometheus-rule-group": {
        const [file, name] = splitId(id, 2);
        const sel = `rule_group="${promString(`${file};${name}`)}"`;
        return run([
          [`max(prometheus_rule_group_last_duration_seconds{${sel}})`, "Evaluation time", "s"],
          [
            `sum(increase(prometheus_rule_group_iterations_missed_total{${sel}}[5m]))`,
            "Missed evaluations",
            "count",
          ],
        ]);
      }
      case "prometheus-rule": {
        const r = await this.getResource(typeId, resourceId, accountId);
        const q = String(r.fields["query"] ?? "");
        const series: Array<[string, string, string?]> = q
          ? [[q, String(r.fields["name"] ?? "value")]]
          : [];
        if (r.fields["type"] === "alerting")
          series.push([
            `count(ALERTS{alertname="${promString(String(r.fields["name"] ?? ""))}",alertstate="firing"})`,
            "Firing alerts",
            "count",
          ]);
        return run(series);
      }
      default:
        return [];
    }
  }

  async verifyCredentials(): Promise<PreflightResult> {
    const checks = await Promise.all(
      PROBES.map(async (p): Promise<PreflightCapabilityCheck> => {
        try {
          await p.run(this);
          return { capabilityId: p.capability.id, status: "ok" };
        } catch (err) {
          const s = statusOf(err);
          if (s === 401 || s === 403)
            return {
              capabilityId: p.capability.id,
              status: "missing",
              missingPermissions: p.capability.requiredPermissions,
            };
          return {
            capabilityId: p.capability.id,
            status: "unknown",
            message: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
    const build = await this.soft(promFetch<BuildInfo>(this.ctx, "/api/v1/status/buildinfo"));
    return {
      checks,
      ...(build?.version ? { identity: `${this.ctx.baseUrl} (v${build.version})` } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Silences
  // -------------------------------------------------------------------------

  private async postSilence(body: Silence): Promise<string> {
    const res = await amFetch<{ silenceID?: string }>(this.ctx, "/silences", {
      method: "POST",
      body,
    });
    if (!res?.silenceID) throw new PromApiError(500, "Alertmanager did not return a silence id");
    return res.silenceID;
  }

  private async createSilence(fields: Record<string, string>): Promise<string> {
    const matchers = parseMatchers(fields["matchers"] ?? "");
    if (!matchers.length)
      throw new PromApiError(400, "Prometheus plugin: a silence needs at least one matcher");
    const comment = (fields["comment"] ?? "").trim();
    if (!comment) throw new PromApiError(400, "Prometheus plugin: a silence needs a comment");
    return this.postSilence({
      matchers,
      startsAt: new Date().toISOString(),
      endsAt: parseEndsAt(fields["duration"] || fields["endsAt"] || "2h"),
      createdBy: (fields["createdBy"] ?? "").trim() || "Infrawrench",
      comment,
    });
  }

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId !== "prometheus-silence")
      throw new PromApiError(400, `Prometheus plugin: cannot create "${typeId}" from Infrawrench`);
    return { fields: silenceFields("") };
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId !== "prometheus-silence")
      throw new PromApiError(400, `Prometheus plugin: cannot create "${typeId}" from Infrawrench`);
    const id = await this.createSilence(fields);
    return this.getResource(typeId, `${accountId}:${typeId}:${id}`, accountId);
  }

  /**
   * Alertmanager updates a silence by POSTing it with its id. Changing the
   * matchers of an active silence expires it and creates a new one, so the
   * returned resource can carry a new id.
   */
  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId !== "prometheus-silence")
      throw new PromApiError(
        400,
        `Prometheus plugin: "${typeId}" cannot be edited from Infrawrench`,
      );
    const id = externalIdOf(resourceId);
    const cur = await amFetch<Silence>(this.ctx, `/silence/${encodeURIComponent(id)}`);
    const has = (k: string) => k in fields;
    const next = await this.postSilence({
      id,
      matchers: has("matchers") ? parseMatchers(fields["matchers"] ?? "") : (cur.matchers ?? []),
      startsAt: cur.startsAt ?? new Date().toISOString(),
      endsAt: has("endsAt") ? parseEndsAt(fields["endsAt"] ?? "") : (cur.endsAt ?? ""),
      createdBy: has("createdBy")
        ? (fields["createdBy"] ?? "").trim() || "Infrawrench"
        : (cur.createdBy ?? ""),
      comment: has("comment") ? (fields["comment"] ?? "") : (cur.comment ?? ""),
    });
    return this.getResource(typeId, `${accountId}:${typeId}:${next}`, accountId);
  }

  async deleteResource(typeId: string, resourceId: string): Promise<void> {
    if (typeId !== "prometheus-silence")
      throw new PromApiError(
        400,
        `Prometheus plugin: "${typeId}" cannot be deleted from Infrawrench`,
      );
    await amFetch(this.ctx, `/silence/${encodeURIComponent(externalIdOf(resourceId))}`, {
      method: "DELETE",
    });
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private async lifecycle(path: string, what: string): Promise<void> {
    try {
      await promFetch(this.ctx, path, { method: "POST" });
    } catch (err) {
      const s = statusOf(err);
      if (s === 404 || s === 405 || s === 403) {
        throw new PromApiError(
          s,
          `Prometheus plugin: ${what} is turned off on this server (start Prometheus with ${
            path.startsWith("/-/") ? "--web.enable-lifecycle" : "--web.enable-admin-api"
          })`,
        );
      }
      throw err;
    }
  }

  async invokeAction(typeId: string, resourceId: string, actionId: string): Promise<void> {
    switch (`${typeId}:${actionId}`) {
      case "prometheus-server:reload":
        return this.lifecycle("/-/reload", "Reloading the configuration");
      case "prometheus-server:clean-tombstones":
        return this.lifecycle("/api/v1/admin/tsdb/clean_tombstones", "The TSDB admin API");
      case "prometheus-server:snapshot":
        return this.lifecycle("/api/v1/admin/tsdb/snapshot", "The TSDB admin API");
      case "prometheus-silence:expire":
        return this.deleteResource("prometheus-silence", resourceId);
      default:
        throw new PromApiError(
          400,
          `Prometheus plugin: unknown action "${actionId}" for "${typeId}"`,
        );
    }
  }

  async executeNoSqlCommand(
    typeId: string,
    _resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const values = decodePromptArgs(args);
    if (command === COMMANDS.createSilence) {
      return { silenceID: await this.createSilence(values) };
    }
    if (command === COMMANDS.deleteSeries && typeId === "prometheus-server") {
      const match = (values["match"] ?? "").trim();
      if (!match) throw new PromApiError(400, "Prometheus plugin: enter a series selector");
      const query: Record<string, string | string[]> = { "match[]": [match] };
      // RFC 3339 or Unix seconds, passed through as Prometheus reads them.
      if ((values["start"] ?? "").trim()) query["start"] = values["start"]!.trim();
      if ((values["end"] ?? "").trim()) query["end"] = values["end"]!.trim();
      try {
        await promFetch(this.ctx, "/api/v1/admin/tsdb/delete_series", { method: "POST", query });
      } catch (err) {
        if ([403, 404, 405].includes(statusOf(err)))
          throw new PromApiError(
            statusOf(err),
            "Prometheus plugin: the TSDB admin API is turned off (--web.enable-admin-api)",
          );
        throw err;
      }
      return { ok: true };
    }
    throw new PromApiError(400, `Prometheus plugin: unknown command "${command}"`);
  }

  /** The server's TSDB cardinality report and flags, as text. */
  async describeResource(typeId: string, resourceId: string, accountId: string): Promise<string> {
    if (typeId !== "prometheus-server") {
      const r = await this.getResource(typeId, resourceId, accountId);
      return Object.entries(r.fields)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join("\n");
    }
    const [tsdb, flags] = await Promise.all([
      this.soft(promFetch<TsdbStatus>(this.ctx, "/api/v1/status/tsdb", { query: { limit: 15 } })),
      this.soft(promFetch<Record<string, string>>(this.ctx, "/api/v1/status/flags")),
    ]);
    const lines: string[] = [];
    const table = (title: string, rows: Array<{ name?: string; value?: number }> | undefined) => {
      if (!rows?.length) return;
      lines.push(title);
      for (const r of rows) lines.push(`  ${String(r.value ?? 0).padStart(10)}  ${r.name ?? ""}`);
      lines.push("");
    };
    if (tsdb?.headStats) {
      lines.push(
        `Head: ${tsdb.headStats.numSeries ?? 0} series, ${tsdb.headStats.chunkCount ?? 0} chunks`,
        "",
      );
    }
    table("Series by metric name", tsdb?.seriesCountByMetricName);
    table("Values by label name", tsdb?.labelValueCountByLabelName);
    table("Series by label pair", tsdb?.seriesCountByLabelValuePair);
    table("Memory by label name (bytes)", tsdb?.memoryInBytesByLabelName);
    if (flags) {
      lines.push("Flags");
      for (const [k, v] of Object.entries(flags).sort(([a], [b]) => (a < b ? -1 : 1)))
        lines.push(`  --${k}=${v}`);
    }
    return lines.join("\n") || "This server does not report TSDB statistics or flags.";
  }

  /** Read-only YAML: the server config, a scrape pool's config, or the Alertmanager config. */
  async getManifest(resourceId: string, _accountId: string): Promise<string> {
    const [, typeId] = resourceId.split(":");
    const id = externalIdOf(resourceId);
    if (typeId === "prometheus-scrape-pool") {
      const [pool] = splitId(id, 1);
      const d = await promFetch<{ yaml?: string }>(this.ctx, "/api/v1/scrape_pools/config", {
        query: { scrapePool: pool! },
      });
      return d?.yaml ?? "";
    }
    if (typeId === "prometheus-alertmanager") {
      return (await amFetch<AmStatus>(this.ctx, "/status"))?.config?.original ?? "";
    }
    return (await promFetch<{ yaml?: string }>(this.ctx, "/api/v1/status/config"))?.yaml ?? "";
  }

  // -------------------------------------------------------------------------
  // Business metric source
  // -------------------------------------------------------------------------

  async listBusinessMetricSourceOptions(
    _accountId: string,
    fieldKey: string,
    params: Record<string, string>,
  ): Promise<BusinessMetricSourceOption[]> {
    return listPromMetricSourceOptions(this.ctx, fieldKey, params);
  }

  async runBusinessMetricSource(
    _accountId: string,
    params: Record<string, string>,
    range: BusinessMetricSourceRange,
  ): Promise<BusinessMetricSourceResult> {
    return runPromMetricSource(this.ctx, params, range);
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderPromDetail(resource, this.ctx.baseUrl, this.ctx.alertmanagerUrl);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderPromSidebar(resource);
  }
}
