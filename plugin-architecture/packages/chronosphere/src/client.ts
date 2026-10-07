import type {
  CreateResourceConfig,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  PreflightResult,
  ResourceInstance,
  SidebarItemSchema,
  SqlTableMeta,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import type { ChronoContext } from "./api.js";
import { chronoFetch, listConfig, normalizeOrg, statusOf } from "./api.js";
import type { Obj } from "./mappers.js";
import { instance, mapConfig, parseMatchers } from "./mappers.js";
import { verifyChronoCredentials } from "./preflight.js";
import { PROM_PATH, instantQuery, queryRange, rangeOrDefault } from "./prom.js";
import { BASE_KEY, renderChronoDetail, renderChronoSidebar } from "./render.js";
import { CONFIG } from "./resource-types.js";

const OPS = ["GT", "GEQ", "LT", "LEQ", "EQ", "NEQ"];
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const csv = (v: string | undefined): string[] =>
  (v ?? "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Build a monitor's series conditions from the create form. */
export function seriesConditions(fields: Record<string, string>): Obj {
  const sustain = Number(fields["sustainSecs"] || 0);
  const level = (sev: "warn" | "critical") => {
    const raw = fields[`${sev}Value`];
    if (raw === undefined || raw.trim() === "") return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`The ${sev} threshold must be a number.`);
    return {
      conditions: [
        { op: fields["op"] || "GT", value, ...(sustain ? { sustain_secs: sustain } : {}) },
      ],
    };
  };
  const warn = level("warn");
  const critical = level("critical");
  if (!warn && !critical) throw new Error("Set a warn or a critical threshold.");
  return { defaults: { ...(warn ? { warn } : {}), ...(critical ? { critical } : {}) } };
}

export class ChronosphereClient implements PluginClient {
  private readonly ctx: ChronoContext;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const org = normalizeOrg(credentials["org"] ?? "");
    const token = (credentials["apiToken"] ?? "").trim();
    if (!org) throw new Error("Chronosphere plugin: missing org credential");
    if (!token) throw new Error("Chronosphere plugin: missing apiToken credential");
    const caCert = credentials["caCert"] ?? "";
    this.ctx = {
      org,
      baseUrl: `https://${org}.chronosphere.io`,
      token,
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
  }

  get context(): ChronoContext {
    return this.ctx;
  }

  private cfg(typeId: string) {
    const c = CONFIG[typeId];
    if (!c) throw new Error(`Chronosphere plugin: unknown resource type "${typeId}"`);
    return c;
  }

  private list(typeId: string): Promise<Obj[]> {
    const c = this.cfg(typeId);
    return listConfig<Obj>(this.ctx, c.plural, c.listKey);
  }

  private async read(typeId: string, slug: string): Promise<Obj> {
    const c = this.cfg(typeId);
    const res = await chronoFetch<Obj>(
      this.ctx,
      `/api/v1/config/${c.plural}/${encodeURIComponent(slug)}`,
    );
    return (res?.[c.singular] as Obj) ?? {};
  }

  private async write(typeId: string, slug: string | undefined, body: Obj): Promise<Obj> {
    const c = this.cfg(typeId);
    const path = slug
      ? `/api/v1/config/${c.plural}/${encodeURIComponent(slug)}`
      : `/api/v1/config/${c.plural}`;
    const res = await chronoFetch<Obj>(this.ctx, path, {
      method: slug ? "PUT" : "POST",
      body: JSON.stringify({ [c.singular]: body }),
    });
    return (res?.[c.singular] as Obj) ?? body;
  }

  /** Read, change, write back: config updates replace the whole object. */
  private async patch(typeId: string, slug: string, change: (o: Obj) => Obj): Promise<Obj> {
    const current = await this.read(typeId, slug);
    const { created_at: _c, updated_at: _u, ...rest } = current;
    return this.write(typeId, slug, change({ ...rest, slug }));
  }

  private map(accountId: string, typeId: string, o: Obj): ResourceInstance {
    return mapConfig(accountId, typeId, o, this.ctx.baseUrl);
  }

  private async tenant(accountId: string): Promise<ResourceInstance> {
    const count = (t: string) =>
      this.list(t)
        .then((l) => l.length)
        .catch(() => undefined);
    const [monitorCount, collectionCount, dashboardCount, sloCount] = await Promise.all([
      count("monitor"),
      count("collection"),
      count("dashboard"),
      count("slo"),
    ]);
    return instance(
      accountId,
      "tenant",
      this.ctx.org,
      this.ctx.org,
      {
        org: this.ctx.org,
        url: this.ctx.baseUrl,
        monitorCount,
        collectionCount,
        dashboardCount,
        sloCount,
      },
      { url: this.ctx.baseUrl, promUrl: `${this.ctx.baseUrl}${PROM_PATH}` },
    );
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    if (typeId === "tenant") return [await this.tenant(accountId)];
    try {
      return (await this.list(typeId))
        .filter((o) => o.slug)
        .map((o) => this.map(accountId, typeId, o));
    } catch (err) {
      // A token whose account cannot read this one type lists it empty.
      if (statusOf(err) === 403) return [];
      throw err;
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    if (typeId === "tenant") return this.tenant(accountId);
    const slug = externalIdOf(resourceId) || resourceId;
    return this.map(accountId, typeId, await this.read(typeId, slug));
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "tenant") {
      if (outputKey === "url") return this.ctx.baseUrl;
      if (outputKey === "promUrl") return `${this.ctx.baseUrl}${PROM_PATH}`;
    }
    const r = await this.getResource(typeId, resourceId, accountId);
    const v = r.resolvedOutputs[outputKey] ?? r.fields[outputKey];
    if (v === undefined)
      throw new Error(`Chronosphere plugin: cannot resolve "${outputKey}" for "${typeId}"`);
    return String(v);
  }

  async fetchMetricSeries(
    typeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    if (typeId !== "monitor" && typeId !== "recording-rule") return [];
    const r = await this.getResource(typeId, resourceId, accountId);
    const query =
      typeId === "monitor"
        ? r.fields["queryType"] === "PromQL"
          ? str(r.fields["query"])
          : ""
        : str(r.fields["expr"]);
    return query ? queryRange(this.ctx, query, rangeOrDefault(timeRange)) : [];
  }

  async executeQuery(
    _resourceId: string,
    _accountId: string,
    sql: string,
  ): Promise<{ rows: Record<string, unknown>[]; durationMs: number }> {
    const started = Date.now();
    const rows = await instantQuery(this.ctx, sql.trim());
    return { rows, durationMs: Date.now() - started };
  }

  async introspectResource(): Promise<SqlTableMeta[]> {
    return [];
  }

  async verifyCredentials(): Promise<PreflightResult> {
    return verifyChronoCredentials(this.ctx);
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  private async options(typeId: string): Promise<Array<{ id: string; label: string }>> {
    const list = await this.list(typeId).catch(() => [] as Obj[]);
    return list
      .filter((o) => o.slug)
      .map((o) => ({ id: String(o.slug), label: String(o.name ?? o.slug) }));
  }

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case "monitor": {
        const [collections, policies] = await Promise.all([
          this.options("collection"),
          this.options("notification-policy"),
        ]);
        return {
          fields: [
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "High error rate",
            },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "collectionSlug",
              label: "Collection",
              kind: "select",
              required: true,
              options: collections,
              ...(collections[0] ? { defaultValue: collections[0].id } : {}),
            },
            {
              key: "query",
              label: "PromQL query",
              kind: "code",
              required: true,
              defaultValue: 'sum by (service) (rate(http_requests_total{code=~"5.."}[5m]))',
            },
            {
              key: "op",
              label: "Fire when the value is",
              kind: "select",
              required: true,
              defaultValue: "GT",
              options: OPS.map((op) => ({
                id: op,
                label:
                  {
                    GT: "Above",
                    GEQ: "At or above",
                    LT: "Below",
                    LEQ: "At or below",
                    EQ: "Equal to",
                    NEQ: "Not equal to",
                  }[op] ?? op,
              })),
            },
            { key: "warnValue", label: "Warn threshold", kind: "number", required: false },
            { key: "criticalValue", label: "Critical threshold", kind: "number", required: false },
            {
              key: "sustainSecs",
              label: "For (seconds)",
              kind: "number",
              required: false,
              defaultValue: "300",
              minValue: 0,
            },
            {
              key: "intervalSecs",
              label: "Evaluate every (seconds)",
              kind: "number",
              required: false,
              defaultValue: "60",
              minValue: 15,
            },
            {
              key: "notificationPolicySlug",
              label: "Notification policy",
              kind: "select",
              required: false,
              description: "Leave empty to use the collection's default policy.",
              options: [{ id: "", label: "Collection default" }, ...policies],
            },
          ],
        };
      }
      case "collection":
      case "bucket": {
        const [teams, policies] = await Promise.all([
          this.options("team"),
          this.options("notification-policy"),
        ]);
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "teamSlug",
              label: "Team",
              kind: "select",
              required: false,
              options: [{ id: "", label: "None" }, ...teams],
            },
            {
              key: "notificationPolicySlug",
              label: "Default notification policy",
              kind: "select",
              required: false,
              options: [{ id: "", label: "None" }, ...policies],
            },
          ],
        };
      }
      case "team":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "userEmails",
              label: "Members",
              kind: "string-list",
              required: false,
              description: "Email addresses of the team's members.",
            },
          ],
        };
      case "muting-rule":
        return {
          fields: [
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "Deploy window",
            },
            {
              key: "matchers",
              label: "Match alerts with labels",
              kind: "text",
              required: true,
              multiline: true,
              placeholder: "service=checkout, env!=dev",
              description:
                "One per line or comma-separated: label=value, label!=value, label=~regex or label!~regex.",
            },
            { key: "startsAt", label: "Starts", kind: "datetime", required: true },
            { key: "endsAt", label: "Ends", kind: "datetime", required: true },
            { key: "comment", label: "Comment", kind: "text", required: false },
          ],
        };
      default:
        throw new Error(`Chronosphere plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const name = (fields["name"] ?? "").trim();
    let body: Obj;
    switch (typeId) {
      case "monitor":
        body = {
          name,
          ...(fields["description"]?.trim() ? { description: fields["description"].trim() } : {}),
          collection_slug: fields["collectionSlug"],
          prometheus_query: (fields["query"] ?? "").trim(),
          series_conditions: seriesConditions(fields),
          ...(fields["intervalSecs"] ? { interval_secs: Number(fields["intervalSecs"]) } : {}),
          ...(fields["notificationPolicySlug"]
            ? { notification_policy_slug: fields["notificationPolicySlug"] }
            : {}),
        };
        break;
      case "collection":
      case "bucket":
        body = {
          name,
          ...(fields["description"]?.trim() ? { description: fields["description"].trim() } : {}),
          ...(fields["teamSlug"] ? { team_slug: fields["teamSlug"] } : {}),
          ...(fields["notificationPolicySlug"]
            ? { notification_policy_slug: fields["notificationPolicySlug"] }
            : {}),
        };
        break;
      case "team":
        body = {
          name,
          description: fields["description"] ?? "",
          user_emails: csv(fields["userEmails"]),
        };
        break;
      case "muting-rule":
        body = {
          name,
          label_matchers: parseMatchers(fields["matchers"] ?? ""),
          starts_at: new Date(fields["startsAt"] ?? "").toISOString(),
          ends_at: new Date(fields["endsAt"] ?? "").toISOString(),
          ...(fields["comment"]?.trim() ? { comment: fields["comment"].trim() } : {}),
        };
        break;
      default:
        throw new Error(`Chronosphere plugin: cannot create "${typeId}" from Infrawrench`);
    }
    return this.map(accountId, typeId, await this.write(typeId, undefined, body));
  }

  // -------------------------------------------------------------------------
  // Update / delete / actions
  // -------------------------------------------------------------------------

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const slug = externalIdOf(resourceId) || resourceId;
    const has = (k: string) => k in fields;
    const updated = await this.patch(typeId, slug, (o) => {
      const next = { ...o };
      if (fields["name"]?.trim()) next.name = fields["name"].trim();
      if (has("description")) next.description = fields["description"] ?? "";
      switch (typeId) {
        case "monitor":
          if (fields["query"]?.trim()) {
            if (!o.prometheus_query)
              throw new Error("Only PromQL monitors can have their query edited here.");
            next.prometheus_query = fields["query"].trim();
          }
          if (fields["intervalSecs"]) next.interval_secs = Number(fields["intervalSecs"]);
          break;
        case "notifier":
          if (has("skipResolved")) next.skip_resolved = fields["skipResolved"] === "true";
          break;
        case "team":
          if (has("userEmails")) next.user_emails = csv(fields["userEmails"]);
          break;
        case "slo":
          if (fields["objective"])
            next.definition = { ...(o.definition ?? {}), objective: Number(fields["objective"]) };
          break;
        case "recording-rule":
          if (fields["expr"]?.trim()) next.prometheus_expr = fields["expr"].trim();
          if (fields["intervalSecs"]) next.interval_secs = Number(fields["intervalSecs"]);
          break;
        case "muting-rule":
          if (has("comment")) next.comment = fields["comment"] ?? "";
          break;
      }
      return next;
    });
    return this.map(accountId, typeId, updated);
  }

  async deleteResource(typeId: string, resourceId: string): Promise<void> {
    if (typeId === "tenant" || typeId === "service") {
      throw new Error(`Chronosphere plugin: "${typeId}" cannot be deleted from Infrawrench`);
    }
    const c = this.cfg(typeId);
    const slug = externalIdOf(resourceId) || resourceId;
    await chronoFetch(this.ctx, `/api/v1/config/${c.plural}/${encodeURIComponent(slug)}`, {
      method: "DELETE",
    });
  }

  async invokeAction(typeId: string, resourceId: string, actionId: string): Promise<void> {
    const slug = externalIdOf(resourceId) || resourceId;
    if ((typeId === "drop-rule" || typeId === "rollup-rule") && actionId.startsWith("mode-")) {
      const mode = actionId.slice(5).toUpperCase();
      const allowed =
        typeId === "drop-rule" ? ["ENABLED", "DISABLED", "PREVIEW"] : ["ENABLED", "PREVIEW"];
      if (!allowed.includes(mode))
        throw new Error(`Chronosphere plugin: ${typeId} cannot be ${mode}`);
      await this.patch(typeId, slug, (o) => ({ ...o, mode }));
      return;
    }
    if (typeId === "muting-rule" && actionId === "end") {
      // starts_at cannot change and must be sent back as it was.
      await this.patch(typeId, slug, (o) => ({ ...o, ends_at: new Date().toISOString() }));
      return;
    }
    throw new Error(`Chronosphere plugin: unknown action "${actionId}" for "${typeId}"`);
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderChronoDetail({
      ...resource,
      resolvedOutputs: { ...resource.resolvedOutputs, [BASE_KEY]: this.ctx.baseUrl },
    });
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderChronoSidebar(resource);
  }
}
