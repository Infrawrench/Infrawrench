import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
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
import { pathEncode } from "@infrawrench/plugin-base";
import type { ChronoContext, ConfigObjects, ConfigRoutes, ConfigTypeId, Monitor } from "./api.js";
import { configRoutes, guarded, isConfigType, normalizeOrg, statusOf } from "./api.js";
import type { components } from "./api-types.gen.js";
import { instance, mapConfig, parseMatchers } from "./mappers.js";
import { verifyChronoCredentials } from "./preflight.js";
import { PROM_PATH, instantQuery, queryRange, rangeOrDefault } from "./prom.js";
import { BASE_KEY, renderChronoDetail, renderChronoSidebar } from "./render.js";

type DropMode = components["schemas"]["configv1DropRuleMode"];
type RollupMode = components["schemas"]["configv1RollupRuleMode"];
type Fields = Record<string, string>;

const OPS = ["GT", "GEQ", "LT", "LEQ", "EQ", "NEQ"];
const DROP_MODES: readonly DropMode[] = ["ENABLED", "DISABLED", "PREVIEW"];
const ROLLUP_MODES: readonly RollupMode[] = ["ENABLED", "PREVIEW"];
const isMode = <M extends string>(allowed: readonly M[], mode: string): mode is M =>
  allowed.some((m) => m === mode);
const str = (v: string | number | boolean | undefined): string =>
  v === undefined || v === null ? "" : String(v);
const csv = (v: string | undefined): string[] =>
  (v ?? "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Build a monitor's series conditions from the create form. */
export function seriesConditions(fields: Fields): NonNullable<Monitor["series_conditions"]> {
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

/** A config object's read-only fields are not sent back. */
function withoutTimestamps<O extends { created_at?: string; updated_at?: string }>(o: O): O {
  const copy = { ...o };
  delete copy.created_at;
  delete copy.updated_at;
  return copy;
}

const unchanged = <O>(o: O): O => o;

/** What the edit form can change on each type, past the name and description. */
const EDITS: { [T in ConfigTypeId]: (o: ConfigObjects[T], fields: Fields) => ConfigObjects[T] } = {
  monitor(o, fields) {
    const next = { ...o };
    if (fields["query"]?.trim()) {
      if (!o.prometheus_query)
        throw new Error("Only PromQL monitors can have their query edited here.");
      next.prometheus_query = fields["query"].trim();
    }
    if (fields["intervalSecs"]) next.interval_secs = Number(fields["intervalSecs"]);
    return next;
  },
  notifier(o, fields) {
    return "skipResolved" in fields
      ? { ...o, skip_resolved: fields["skipResolved"] === "true" }
      : o;
  },
  team(o, fields) {
    return "userEmails" in fields ? { ...o, user_emails: csv(fields["userEmails"]) } : o;
  },
  slo(o, fields) {
    if (!fields["objective"]) return o;
    return {
      ...o,
      definition: { ...(o.definition ?? {}), objective: Number(fields["objective"]) },
    };
  },
  "recording-rule"(o, fields) {
    const next = { ...o };
    if (fields["expr"]?.trim()) next.prometheus_expr = fields["expr"].trim();
    if (fields["intervalSecs"]) next.interval_secs = Number(fields["intervalSecs"]);
    return next;
  },
  "muting-rule"(o, fields) {
    return "comment" in fields ? { ...o, comment: fields["comment"] ?? "" } : o;
  },
  "notification-policy": unchanged,
  collection: unchanged,
  bucket: unchanged,
  dashboard: unchanged,
  "rollup-rule": unchanged,
  "drop-rule": unchanged,
  "service-account": unchanged,
  service: unchanged,
};

/** Every type has a name, and the form sends a description for any of them. */
function editNameAndDescription<O extends { name?: string }>(o: O, fields: Fields): O {
  const name = fields["name"]?.trim();
  return {
    ...o,
    ...(name ? { name } : {}),
    ...("description" in fields ? { description: fields["description"] ?? "" } : {}),
  };
}

export class ChronosphereClient implements PluginClient {
  private readonly ctx: ChronoContext;
  private readonly routes: ConfigRoutes;

  constructor(credentials: Credentials, services?: HostServices) {
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
    this.routes = configRoutes(this.ctx);
  }

  get context(): ChronoContext {
    return this.ctx;
  }

  private configType(typeId: string): ConfigTypeId {
    if (isConfigType(typeId, this.routes)) return typeId;
    throw new Error(`Chronosphere plugin: unknown resource type "${typeId}"`);
  }

  private list<T extends ConfigTypeId>(typeId: T): Promise<ConfigObjects[T][]> {
    return guarded(this.routes[typeId].list());
  }

  private read<T extends ConfigTypeId>(typeId: T, slug: string): Promise<ConfigObjects[T]> {
    return guarded(this.routes[typeId].read(pathEncode(slug)));
  }

  private write<T extends ConfigTypeId>(
    typeId: T,
    slug: string | undefined,
    body: ConfigObjects[T],
  ): Promise<ConfigObjects[T]> {
    const route = this.routes[typeId];
    return guarded(slug ? route.update(pathEncode(slug), body) : route.create(body));
  }

  /** Read, change, write back: config updates replace the whole object. */
  private async patch<T extends ConfigTypeId>(
    typeId: T,
    slug: string,
    change: (o: ConfigObjects[T]) => ConfigObjects[T],
  ): Promise<ConfigObjects[T]> {
    const current = await this.read(typeId, slug);
    return this.write(typeId, slug, change({ ...withoutTimestamps(current), slug }));
  }

  private map<T extends ConfigTypeId>(
    accountId: string,
    typeId: T,
    o: ConfigObjects[T],
  ): ResourceInstance {
    return mapConfig(accountId, typeId, o, this.ctx.baseUrl);
  }

  private async tenant(accountId: string): Promise<ResourceInstance> {
    const count = (t: ConfigTypeId) =>
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

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      if (typeId === "tenant") return [await this.tenant(accountId)];
      try {
        const configType = this.configType(typeId);
        return (await this.list(configType))
          .filter((o) => o.slug)
          .map((o) => this.map(accountId, configType, o));
      } catch (err) {
        // A token whose account cannot read this one type lists it empty.
        if (statusOf(err) === 403) return [];
        throw err;
      }
    });
  }

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      if (typeId === "tenant") return this.tenant(accountId);
      const slug = externalIdOf(resourceId) || resourceId;
      const configType = this.configType(typeId);
      return this.map(accountId, configType, await this.read(configType, slug));
    });
  }

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      if (typeId === "tenant") {
        if (outputKey === "url") return this.ctx.baseUrl;
        if (outputKey === "promUrl") return `${this.ctx.baseUrl}${PROM_PATH}`;
      }
      const r = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      const v = r.resolvedOutputs[outputKey] ?? r.fields[outputKey];
      if (v === undefined)
        throw new Error(`Chronosphere plugin: cannot resolve "${outputKey}" for "${typeId}"`);
      return String(v);
    });
  }

  fetchMetricSeries(
    typeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      if (typeId !== "monitor" && typeId !== "recording-rule") return [];
      const r = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      const query =
        typeId === "monitor"
          ? r.fields["queryType"] === "PromQL"
            ? str(r.fields["query"])
            : ""
          : str(r.fields["expr"]);
      return query ? queryRange(this.ctx, query, rangeOrDefault(timeRange)) : [];
    });
  }

  executeQuery(
    _resourceId: string,
    _accountId: string,
    sql: string,
  ): PluginEffect<{ rows: Record<string, unknown>[]; durationMs: number }> {
    return attempt(async () => {
      const started = Date.now();
      const rows = await instantQuery(this.ctx, sql.trim());
      return { rows, durationMs: Date.now() - started };
    });
  }

  introspectResource(): PluginEffect<SqlTableMeta[]> {
    return attempt(async () => {
      return [];
    });
  }

  verifyCredentials(): PluginEffect<PreflightResult> {
    return attempt(async () => {
      return verifyChronoCredentials(this.ctx);
    });
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  private async options(typeId: ConfigTypeId): Promise<Array<{ id: string; label: string }>> {
    const list = await this.list(typeId).catch(() => []);
    return list
      .filter((o) => o.slug)
      .map((o) => ({ id: String(o.slug), label: String(o.name ?? o.slug) }));
  }

  getCreateConfig(typeId: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
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
              {
                key: "criticalValue",
                label: "Critical threshold",
                kind: "number",
                required: false,
              },
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
    });
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const name = (fields["name"] ?? "").trim();
      switch (typeId) {
        case "monitor":
          return this.map(
            accountId,
            typeId,
            await this.write(typeId, undefined, {
              name,
              ...(fields["description"]?.trim()
                ? { description: fields["description"].trim() }
                : {}),
              ...(fields["collectionSlug"] !== undefined
                ? { collection_slug: fields["collectionSlug"] }
                : {}),
              prometheus_query: (fields["query"] ?? "").trim(),
              series_conditions: seriesConditions(fields),
              ...(fields["intervalSecs"] ? { interval_secs: Number(fields["intervalSecs"]) } : {}),
              ...(fields["notificationPolicySlug"]
                ? { notification_policy_slug: fields["notificationPolicySlug"] }
                : {}),
            }),
          );
        case "collection":
        case "bucket":
          return this.map(
            accountId,
            typeId,
            await this.write(typeId, undefined, {
              name,
              ...(fields["description"]?.trim()
                ? { description: fields["description"].trim() }
                : {}),
              ...(fields["teamSlug"] ? { team_slug: fields["teamSlug"] } : {}),
              ...(fields["notificationPolicySlug"]
                ? { notification_policy_slug: fields["notificationPolicySlug"] }
                : {}),
            }),
          );
        case "team":
          return this.map(
            accountId,
            typeId,
            await this.write(typeId, undefined, {
              name,
              description: fields["description"] ?? "",
              user_emails: csv(fields["userEmails"]),
            }),
          );
        case "muting-rule":
          return this.map(
            accountId,
            typeId,
            await this.write(typeId, undefined, {
              name,
              label_matchers: parseMatchers(fields["matchers"] ?? ""),
              starts_at: new Date(fields["startsAt"] ?? "").toISOString(),
              ends_at: new Date(fields["endsAt"] ?? "").toISOString(),
              ...(fields["comment"]?.trim() ? { comment: fields["comment"].trim() } : {}),
            }),
          );
        default:
          throw new Error(`Chronosphere plugin: cannot create "${typeId}" from Infrawrench`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Update / delete / actions
  // -------------------------------------------------------------------------

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const slug = externalIdOf(resourceId) || resourceId;
      const configType = this.configType(typeId);
      return this.map(accountId, configType, await this.edit(configType, slug, fields));
    });
  }

  private edit<T extends ConfigTypeId>(typeId: T, slug: string, fields: Fields) {
    const edit: (o: ConfigObjects[T], fields: Fields) => ConfigObjects[T] = EDITS[typeId];
    return this.patch(typeId, slug, (o) => edit(editNameAndDescription(o, fields), fields));
  }

  deleteResource(typeId: string, resourceId: string): PluginEffect<void> {
    return attempt(async () => {
      if (typeId === "tenant" || typeId === "service") {
        throw new Error(`Chronosphere plugin: "${typeId}" cannot be deleted from Infrawrench`);
      }
      const route = this.routes[this.configType(typeId)];
      const slug = externalIdOf(resourceId) || resourceId;
      if (route.delete) await guarded(route.delete(pathEncode(slug)));
    });
  }

  invokeAction(typeId: string, resourceId: string, actionId: string): PluginEffect<void> {
    return attempt(async () => {
      const slug = externalIdOf(resourceId) || resourceId;
      if (typeId === "drop-rule" && actionId.startsWith("mode-")) {
        const mode = actionId.slice(5).toUpperCase();
        if (!isMode(DROP_MODES, mode))
          throw new Error(`Chronosphere plugin: ${typeId} cannot be ${mode}`);
        await this.patch(typeId, slug, (o) => ({ ...o, mode }));
        return;
      }
      if (typeId === "rollup-rule" && actionId.startsWith("mode-")) {
        const mode = actionId.slice(5).toUpperCase();
        if (!isMode(ROLLUP_MODES, mode))
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
    });
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
