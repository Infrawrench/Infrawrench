import type {
  CreateFieldConfig,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  PreflightResult,
  ResourceInstance,
  SecretHostServices,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import type { HoneycombContext, JsonApiResource } from "./api.js";
import { ds, mapPooled, statusOf, v1, v2, v2Paged } from "./api.js";
import type { EnvScope } from "./mappers.js";
import {
  DEFINITION_KEYS,
  mapApiKey,
  mapBoard,
  mapBoardView,
  mapBurnAlert,
  mapColumn,
  mapDataset,
  mapDerivedColumn,
  mapEnvironment,
  mapMarker,
  mapMarkerSetting,
  mapRecipient,
  mapSavedQuery,
  mapSignal,
  mapSlo,
  mapTrigger,
  parseTags,
  recipientTarget,
  resourceIdFor,
  sloDatasetPath,
} from "./mappers.js";
import {
  DEFAULT_METRICS_WINDOW_MS,
  SLO_METRICS_WINDOW_MS,
  datasetSeries,
  environmentSeries,
  rangeOrDefault,
  sloSeries,
  storedQuerySeries,
} from "./metrics.js";
import { verifyHoneycombCredentials } from "./preflight.js";
import type { HoneycombRegion } from "./regions.js";
import { resolveRegion } from "./regions.js";
import { RECIPIENT_TRIGGERS_KEY, renderHoneycombDetail, renderHoneycombSidebar } from "./render.js";
import { ALL_DATASETS } from "./resource-types.js";
import type {
  HnyApiKeyAttrs,
  HnyAuth,
  HnyAuthV2,
  HnyBoard,
  HnyBoardView,
  HnyBurnAlert,
  HnyColumn,
  HnyDataset,
  HnyDatasetDefinitions,
  HnyDerivedColumn,
  HnyEnvironmentAttrs,
  HnyMarker,
  HnyMarkerSetting,
  HnyQueryAnnotation,
  HnyQuerySpec,
  HnyRecipient,
  HnySignal,
  HnySlo,
  HnyTrigger,
} from "./types.js";

/** Stored per environment resource: its configuration key. */
const CONFIG_KEY_FIELD = "configurationKey";
/** Stored per API key resource: the secret, when Infrawrench created it. */
const API_KEY_SECRET_FIELD = "key";
const CACHE_TTL_MS = 60_000;
/** Markers are events, not configuration: keep the most recent per dataset. */
const MAX_MARKERS_PER_DATASET = 100;
const POOL = 4;

/** Everything an environment-scoped call needs. */
interface EnvAccess extends EnvScope {
  id?: string;
  name: string;
  attrs?: HnyEnvironmentAttrs;
  key: string | null;
}

/** Permissions a connection key is minted with by Connect environment. */
const CONNECT_PERMISSIONS = {
  manage_columns: true,
  run_queries: true,
  manage_triggers: true,
  manage_slos: true,
  manage_boards: true,
  manage_markers: true,
  manage_recipients: true,
  manage_signals: true,
  create_datasets: true,
};

const API_KEY_PERMISSIONS: Array<{ id: string; label: string; ingest?: boolean }> = [
  { id: "create_datasets", label: "Create datasets", ingest: true },
  { id: "send_events", label: "Send events" },
  { id: "manage_columns", label: "Manage queries and columns" },
  { id: "run_queries", label: "Run queries" },
  { id: "manage_triggers", label: "Manage triggers" },
  { id: "manage_slos", label: "Manage SLOs" },
  { id: "manage_boards", label: "Manage public boards" },
  { id: "manage_privateBoards", label: "Manage private boards" },
  { id: "manage_markers", label: "Manage markers" },
  { id: "manage_recipients", label: "Manage recipients" },
  { id: "manage_signals", label: "Manage signals" },
  { id: "read_service_maps", label: "Read service maps (Enterprise)" },
  { id: "visible_team_members", label: "Visible to team members" },
];

const CALC_OPS = [
  "COUNT",
  "CONCURRENCY",
  "SUM",
  "AVG",
  "COUNT_DISTINCT",
  "MAX",
  "MIN",
  "P50",
  "P90",
  "P95",
  "P99",
  "P999",
  "RATE_AVG",
  "RATE_SUM",
  "RATE_MAX",
];

const FILTER_OPS = [
  "=",
  "!=",
  ">",
  ">=",
  "<",
  "<=",
  "starts-with",
  "does-not-start-with",
  "ends-with",
  "does-not-end-with",
  "exists",
  "does-not-exist",
  "contains",
  "does-not-contain",
  "in",
  "not-in",
];

const opt = (id: string, label = id) => ({ id, label });

function trimmed(fields: Record<string, string>, key: string): string {
  return (fields[key] ?? "").trim();
}

function numberOr(value: string | undefined, fallback?: number): number | undefined {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function boolField(value: string | undefined): boolean {
  return value === "true" || value === "yes" || value === "1";
}

/** Typed filter value: numbers and booleans as JSON, lists for in/not-in. */
export function filterValue(op: string, raw: string): unknown {
  if (op === "exists" || op === "does-not-exist") return undefined;
  const parse = (v: string): unknown => {
    const t = v.trim();
    if (t === "true") return true;
    if (t === "false") return false;
    if (t !== "" && Number.isFinite(Number(t))) return Number(t);
    return t;
  };
  if (op === "in" || op === "not-in") return raw.split(",").map(parse);
  return parse(raw);
}

/** Build a one-calculation query spec from the simple builder fields. */
export function builderSpec(
  fields: Record<string, string>,
  opts: { forTrigger: boolean },
): HnyQuerySpec {
  const json = trimmed(fields, "queryJson");
  if (json) {
    try {
      return JSON.parse(json) as HnyQuerySpec;
    } catch {
      throw new Error("Query JSON is not valid JSON.");
    }
  }
  const op = trimmed(fields, "calcOp") || "COUNT";
  const column = trimmed(fields, "calcColumn");
  if (op !== "COUNT" && op !== "CONCURRENCY" && !column) {
    throw new Error(`${op} needs a column to calculate over.`);
  }
  const spec: HnyQuerySpec = {
    calculations: [{ op, ...(column && op !== "COUNT" && op !== "CONCURRENCY" ? { column } : {}) }],
    time_range: numberOr(fields["timeRange"], opts.forTrigger ? 900 : 7200) as number,
  };
  const filterColumn = trimmed(fields, "filterColumn");
  if (filterColumn) {
    const fop = trimmed(fields, "filterOp") || "=";
    const value = filterValue(fop, fields["filterValue"] ?? "");
    spec.filters = [{ column: filterColumn, op: fop, ...(value !== undefined ? { value } : {}) }];
  }
  const breakdown = trimmed(fields, "breakdown");
  if (breakdown && !opts.forTrigger) spec.breakdowns = [breakdown];
  return spec;
}

export class HoneycombClient implements PluginClient {
  private readonly ctx: HoneycombContext;
  private readonly configurationKey: string | undefined;
  private readonly secrets: SecretHostServices | undefined;
  private envCache: { at: number; value: Promise<EnvAccess[]>; accountId: string } | undefined;
  private readonly datasetCache = new Map<string, { at: number; value: Promise<HnyDataset[]> }>();
  private authCache: Promise<HnyAuth> | undefined;
  private teamCache: Promise<string> | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const region: HoneycombRegion = resolveRegion(credentials["region"]);
    const configurationKey = (credentials["configurationKey"] ?? "").trim();
    let keyId = (credentials["managementKeyId"] ?? "").trim();
    let keySecret = (credentials["managementKeySecret"] ?? "").trim();
    // Accept the joined `id:secret` form pasted into either field.
    if (keyId.includes(":") && !keySecret)
      [keyId, keySecret] = keyId.split(":", 2) as [string, string];
    if (keySecret.includes(":") && !keyId)
      [keyId, keySecret] = keySecret.split(":", 2) as [string, string];
    if ((keyId && !keySecret) || (!keyId && keySecret)) {
      throw new Error("Honeycomb plugin: a management key needs both its ID and its secret");
    }
    if (!configurationKey && !(keyId && keySecret)) {
      throw new Error(
        "Honeycomb plugin: add a configuration key, a management key (ID and secret), or both",
      );
    }
    const caCert = credentials["caCert"] ?? "";
    this.ctx = {
      region,
      ...(keyId && keySecret ? { managementToken: `${keyId}:${keySecret}` } : {}),
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
    this.configurationKey = configurationKey || undefined;
    this.secrets = services?.secrets;
  }

  // -------------------------------------------------------------------------
  // Shared lookups
  // -------------------------------------------------------------------------

  private accountAuth(): Promise<HnyAuth> {
    if (!this.configurationKey) return Promise.reject(new Error("no configuration key"));
    this.authCache ??= v1<HnyAuth>(this.ctx, this.configurationKey, "/1/auth");
    return this.authCache;
  }

  /** The team slug every `/2/teams/{team}` route needs. */
  private teamSlug(): Promise<string> {
    this.teamCache ??= (async () => {
      if (this.ctx.managementToken) {
        const auth = await v2<HnyAuthV2>(this.ctx, "/2/auth");
        const teamId = auth.data?.relationships?.team?.data?.id;
        const team = (auth.included ?? []).find(
          (i) => i.type === "teams" && (!teamId || i.id === teamId),
        );
        if (team?.attributes?.slug) return team.attributes.slug;
      }
      const auth = await this.accountAuth();
      if (auth.team?.slug) return auth.team.slug;
      throw new Error("Honeycomb plugin: could not determine the team");
    })();
    return this.teamCache;
  }

  private async storedSecret(resourceId: string, field: string): Promise<string | null> {
    if (!this.secrets) return null;
    const value = await this.secrets.getPlaintext(resourceId, field).catch(() => null);
    return value && value.trim() ? value.trim() : null;
  }

  private async storeSecret(resourceId: string, field: string, value: string): Promise<void> {
    if (!this.secrets?.setPlaintext) {
      throw new Error("This Infrawrench host cannot store keys. Update the app and try again.");
    }
    await this.secrets.setPlaintext(resourceId, field, value);
  }

  private environments(accountId: string): Promise<EnvAccess[]> {
    const cached = this.envCache;
    if (cached && cached.accountId === accountId && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.value;
    }
    const value = this.loadEnvironments(accountId);
    this.envCache = { at: Date.now(), value, accountId };
    value.catch(() => {
      if (this.envCache?.value === value) this.envCache = undefined;
    });
    return value;
  }

  private async loadEnvironments(accountId: string): Promise<EnvAccess[]> {
    const accountAuth = this.configurationKey
      ? await this.accountAuth().catch(() => undefined)
      : undefined;
    const accountEnvSlug = accountAuth ? accountAuth.environment?.slug || "classic" : undefined;
    const team = await this.teamSlug().catch(() => undefined);
    const base = {
      region: this.ctx.region.id,
      uiUrl: this.ctx.region.uiUrl,
      ...(team ? { team } : {}),
    };
    const out: EnvAccess[] = [];
    if (this.ctx.managementToken && team) {
      const envs = await v2Paged<HnyEnvironmentAttrs>(
        this.ctx,
        `/2/teams/${encodeURIComponent(team)}/environments`,
      );
      for (const e of envs) {
        const slug = e.attributes?.slug ?? e.id;
        const stored = await this.storedSecret(
          resourceIdFor(accountId, "environment", slug),
          CONFIG_KEY_FIELD,
        );
        out.push({
          ...base,
          slug,
          id: e.id,
          name: e.attributes?.name ?? slug,
          ...(e.attributes ? { attrs: e.attributes } : {}),
          key: stored ?? (slug === accountEnvSlug ? (this.configurationKey ?? null) : null),
        });
      }
    }
    if (accountEnvSlug && !out.some((e) => e.slug === accountEnvSlug)) {
      const stored = await this.storedSecret(
        resourceIdFor(accountId, "environment", accountEnvSlug),
        CONFIG_KEY_FIELD,
      );
      out.push({
        ...base,
        slug: accountEnvSlug,
        name:
          accountAuth?.environment?.name || `${accountAuth?.team?.name ?? "Honeycomb"} (Classic)`,
        key: stored ?? this.configurationKey ?? null,
      });
    }
    return out;
  }

  private async env(accountId: string, slug: string): Promise<EnvAccess> {
    const found = (await this.environments(accountId)).find((e) => e.slug === slug);
    if (!found) throw new Error(`Honeycomb plugin: environment "${slug}" not found`);
    return found;
  }

  private requireKey(env: EnvAccess): string {
    if (!env.key) {
      throw new Error(
        `Environment ${env.name} is not connected. Open it and use Connect environment, or edit it and paste a configuration key.`,
      );
    }
    return env.key;
  }

  private async keyFor(
    accountId: string,
    envSlug: string,
  ): Promise<{ env: EnvAccess; key: string }> {
    const env = await this.env(accountId, envSlug);
    return { env, key: this.requireKey(env) };
  }

  private datasets(env: EnvAccess): Promise<HnyDataset[]> {
    const cached = this.datasetCache.get(env.slug);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
    const value = v1<HnyDataset[]>(this.ctx, this.requireKey(env), "/1/datasets").then(
      (d) => d ?? [],
    );
    this.datasetCache.set(env.slug, { at: Date.now(), value });
    value.catch(() => this.datasetCache.delete(env.slug));
    return value;
  }

  /**
   * Run a lister over every connected environment. A refused or vanished
   * environment key lists that environment empty rather than failing the
   * others; a 403 means the key lacks that one permission.
   */
  private async perEnv(
    accountId: string,
    load: (env: EnvAccess, key: string) => Promise<ResourceInstance[]>,
  ): Promise<ResourceInstance[]> {
    const envs = (await this.environments(accountId)).filter((e) => e.key);
    const results = await mapPooled(envs, POOL, async (env) => {
      try {
        return await load(env, env.key as string);
      } catch (err) {
        const status = statusOf(err);
        if (status === 401 || status === 403 || status === 404) return [];
        throw err;
      }
    });
    return results.flat();
  }

  /** Run a lister over every dataset (and optionally `__all__`) of every connected environment. */
  private perDataset(
    accountId: string,
    includeAll: boolean,
    load: (env: EnvAccess, key: string, dataset: string) => Promise<ResourceInstance[]>,
  ): Promise<ResourceInstance[]> {
    return this.perEnv(accountId, async (env, key) => {
      const slugs = (await this.datasets(env)).map((d) => d.slug ?? "").filter(Boolean);
      if (includeAll) slugs.push(ALL_DATASETS);
      const results = await mapPooled(slugs, POOL, async (dataset) => {
        try {
          return await load(env, key, dataset);
        } catch (err) {
          const status = statusOf(err);
          // `__all__` is not offered for every route on every plan.
          if (status === 403 || status === 404 || (dataset === ALL_DATASETS && status === 400)) {
            return [];
          }
          throw err;
        }
      });
      // `__all__` may echo dataset-scoped objects back; keep the first (the
      // dataset-scoped) copy of each provider id.
      const seen = new Set<string>();
      return results.flat().filter((r) => {
        const providerId = (r.externalId ?? r.id).split("/").pop() ?? r.id;
        if (seen.has(providerId)) return false;
        seen.add(providerId);
        return true;
      });
    });
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "environment":
        return (await this.environments(accountId)).map((e) => this.mapEnv(accountId, e));
      case "dataset":
        return this.perEnv(accountId, async (env, key) => {
          const sets = await this.datasets(env);
          return mapPooled(sets, POOL, async (d) => {
            const defs = await v1<HnyDatasetDefinitions>(
              this.ctx,
              key,
              `/1/dataset_definitions/${ds(d.slug ?? "")}`,
            ).catch(() => undefined);
            return mapDataset(accountId, env, d, defs);
          });
        });
      case "column":
        return this.perDataset(accountId, false, async (env, key, dataset) =>
          (await v1<HnyColumn[]>(this.ctx, key, `/1/columns/${ds(dataset)}`)).map((c) =>
            mapColumn(accountId, env, dataset, c),
          ),
        );
      case "derived-column":
        return this.perDataset(accountId, true, async (env, key, dataset) =>
          (await v1<HnyDerivedColumn[]>(this.ctx, key, `/1/derived_columns/${ds(dataset)}`)).map(
            (c) => mapDerivedColumn(accountId, env, dataset, c),
          ),
        );
      case "trigger":
        return this.perDataset(accountId, true, async (env, key, dataset) =>
          (await v1<HnyTrigger[]>(this.ctx, key, `/1/triggers/${ds(dataset)}`)).map((t) =>
            mapTrigger(accountId, env, dataset, t),
          ),
        );
      case "slo":
        return this.perDataset(accountId, true, async (env, key, dataset) =>
          (await v1<HnySlo[]>(this.ctx, key, `/1/slos/${ds(dataset)}`)).map((s) =>
            mapSlo(accountId, env, dataset, s),
          ),
        );
      case "burn-alert":
        return this.listBurnAlerts(accountId);
      case "board":
        return this.perEnv(accountId, async (env, key) =>
          (await v1<HnyBoard[]>(this.ctx, key, "/1/boards")).map((b) =>
            mapBoard(accountId, env, b),
          ),
        );
      case "board-view":
        return this.perEnv(accountId, async (env, key) => {
          const boards = await v1<HnyBoard[]>(this.ctx, key, "/1/boards");
          const views = await mapPooled(boards, POOL, async (b) =>
            b.id
              ? (
                  await v1<HnyBoardView[]>(
                    this.ctx,
                    key,
                    `/1/boards/${encodeURIComponent(b.id)}/views`,
                  ).catch(() => [] as HnyBoardView[])
                ).map((v) => mapBoardView(accountId, env, b.id as string, v))
              : [],
          );
          return views.flat();
        });
      case "marker":
        return this.perDataset(accountId, true, async (env, key, dataset) => {
          const markers = await v1<HnyMarker[]>(this.ctx, key, `/1/markers/${ds(dataset)}`);
          return [...(markers ?? [])]
            .sort((a, b) => (b.start_time ?? 0) - (a.start_time ?? 0))
            .slice(0, MAX_MARKERS_PER_DATASET)
            .map((m) => mapMarker(accountId, env, dataset, m));
        });
      case "marker-setting":
        return this.perDataset(accountId, true, async (env, key, dataset) =>
          (await v1<HnyMarkerSetting[]>(this.ctx, key, `/1/marker_settings/${ds(dataset)}`)).map(
            (m) => mapMarkerSetting(accountId, env, dataset, m),
          ),
        );
      case "saved-query":
        return this.perDataset(accountId, true, async (env, key, dataset) =>
          (
            await v1<HnyQueryAnnotation[]>(this.ctx, key, `/1/query_annotations/${ds(dataset)}`)
          ).map((a) => mapSavedQuery(accountId, env, dataset, a)),
        );
      case "recipient":
        return this.listRecipients(accountId);
      case "signal":
        return this.perEnv(accountId, async (env, key) =>
          (await this.fetchSignals(key)).map((s) => mapSignal(accountId, env, s)),
        );
      case "api-key":
        return this.listApiKeys(accountId);
      default:
        throw new Error(`Honeycomb plugin: unknown resource type "${typeId}"`);
    }
  }

  private mapEnv(accountId: string, e: EnvAccess): ResourceInstance {
    return mapEnvironment(accountId, {
      slug: e.slug,
      ...(e.id ? { id: e.id } : {}),
      ...(e.attrs ? { attrs: e.attrs } : {}),
      name: e.name,
      ...(e.team ? { team: e.team } : {}),
      region: e.region,
      ...(e.uiUrl ? { uiUrl: e.uiUrl } : {}),
      connected: Boolean(e.key),
    });
  }

  private async listBurnAlerts(accountId: string): Promise<ResourceInstance[]> {
    const slos = await this.listResources("slo", accountId);
    const out = await mapPooled(slos, POOL, async (slo) => {
      const [envSlug, dataset, sloId] = (slo.externalId ?? "").split("/");
      if (!envSlug || !dataset || !sloId) return [];
      try {
        const { env, key } = await this.keyFor(accountId, envSlug);
        const alerts = await v1<HnyBurnAlert[]>(this.ctx, key, `/1/burn_alerts/${ds(dataset)}`, {
          query: { slo_id: sloId },
        });
        return (alerts ?? []).map((b) => mapBurnAlert(accountId, env, dataset, sloId, b));
      } catch (err) {
        const status = statusOf(err);
        if (status === 401 || status === 403 || status === 404) return [];
        throw err;
      }
    });
    return out.flat();
  }

  /** Recipients are team-wide: read them through the first connected environment. */
  private async recipientKey(accountId: string): Promise<string> {
    const env = (await this.environments(accountId)).find((e) => e.key);
    if (!env?.key) {
      throw new Error(
        "Connect an environment first: recipients are read with a configuration key.",
      );
    }
    return env.key;
  }

  private async listRecipients(accountId: string): Promise<ResourceInstance[]> {
    const envs = (await this.environments(accountId)).filter((e) => e.key);
    for (const env of envs) {
      try {
        const list = await v1<HnyRecipient[]>(this.ctx, env.key as string, "/1/recipients");
        return (list ?? []).map((r) => mapRecipient(accountId, r));
      } catch (err) {
        const status = statusOf(err);
        if (status === 401 || status === 403 || status === 404) continue;
        throw err;
      }
    }
    return [];
  }

  private async fetchSignals(key: string): Promise<HnySignal[]> {
    const out: HnySignal[] = [];
    let after: string | undefined;
    for (let page = 0; page < 50; page++) {
      const res = await v1<{ signals?: HnySignal[]; links?: { next?: string | null } }>(
        this.ctx,
        key,
        "/1/signals",
        { query: { "page[size]": 100, ...(after ? { "page[after]": after } : {}) } },
      );
      out.push(...(res.signals ?? []));
      const next = res.links?.next;
      if (!next) break;
      const cursor = /page%5Bafter%5D=([^&]+)|page\[after\]=([^&]+)/.exec(next);
      after = decodeURIComponent(cursor?.[1] ?? cursor?.[2] ?? "");
      if (!after) break;
    }
    return out;
  }

  private async listApiKeys(accountId: string): Promise<ResourceInstance[]> {
    if (!this.ctx.managementToken) return [];
    const team = await this.teamSlug();
    const [keys, envs] = await Promise.all([
      v2Paged<HnyApiKeyAttrs>(this.ctx, `/2/teams/${encodeURIComponent(team)}/api-keys`),
      this.environments(accountId),
    ]);
    const slugById = new Map(envs.filter((e) => e.id).map((e) => [e.id as string, e.slug]));
    return keys.map((k) => mapApiKey(accountId, this.keyRef(k), slugById));
  }

  private keyRef(k: JsonApiResource<HnyApiKeyAttrs>) {
    const envId = k.relationships?.["environment"]?.data?.id;
    return {
      id: k.id,
      ...(k.attributes ? { attributes: k.attributes } : {}),
      ...(envId ? { environmentId: envId } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Single reads
  // -------------------------------------------------------------------------

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const ext = externalIdOf(resourceId);
    const [a = "", b = "", c = ""] = ext.split("/");
    switch (typeId) {
      case "environment":
        return this.mapEnv(accountId, await this.env(accountId, ext));
      case "dataset": {
        const { env, key } = await this.keyFor(accountId, a);
        const [d, defs] = await Promise.all([
          v1<HnyDataset>(this.ctx, key, `/1/datasets/${ds(b)}`),
          v1<HnyDatasetDefinitions>(this.ctx, key, `/1/dataset_definitions/${ds(b)}`).catch(
            () => undefined,
          ),
        ]);
        return mapDataset(accountId, env, d, defs);
      }
      case "column": {
        const { env, key } = await this.keyFor(accountId, a);
        const col = await v1<HnyColumn>(
          this.ctx,
          key,
          `/1/columns/${ds(b)}/${encodeURIComponent(c)}`,
        );
        return mapColumn(accountId, env, b, col);
      }
      case "derived-column": {
        const { env, key } = await this.keyFor(accountId, a);
        const col = await v1<HnyDerivedColumn>(
          this.ctx,
          key,
          `/1/derived_columns/${ds(b)}/${encodeURIComponent(c)}`,
        );
        return mapDerivedColumn(accountId, env, b, col);
      }
      case "trigger": {
        const { env, key } = await this.keyFor(accountId, a);
        const t = await v1<HnyTrigger>(
          this.ctx,
          key,
          `/1/triggers/${ds(b)}/${encodeURIComponent(c)}`,
        );
        return mapTrigger(accountId, env, b, t);
      }
      case "slo": {
        const { env, key } = await this.keyFor(accountId, a);
        const path = `/1/slos/${ds(b)}/${encodeURIComponent(c)}`;
        // `detailed` (compliance, budget, burn rate) is Enterprise-only.
        const s = await v1<HnySlo>(this.ctx, key, path, { query: { detailed: true } }).catch(
          (err) => {
            if (statusOf(err) === 404) throw err;
            return v1<HnySlo>(this.ctx, key, path);
          },
        );
        return mapSlo(accountId, env, b, s);
      }
      case "burn-alert": {
        const { env, key } = await this.keyFor(accountId, a);
        const alert = await v1<HnyBurnAlert>(
          this.ctx,
          key,
          `/1/burn_alerts/${ds(b)}/${encodeURIComponent(c)}`,
        );
        return mapBurnAlert(accountId, env, b, alert.slo?.id ?? "", alert);
      }
      case "board": {
        const { env, key } = await this.keyFor(accountId, a);
        return mapBoard(
          accountId,
          env,
          await v1<HnyBoard>(this.ctx, key, `/1/boards/${encodeURIComponent(b)}`),
        );
      }
      case "board-view": {
        const { env, key } = await this.keyFor(accountId, a);
        const view = await v1<HnyBoardView>(
          this.ctx,
          key,
          `/1/boards/${encodeURIComponent(b)}/views/${encodeURIComponent(c)}`,
        );
        return mapBoardView(accountId, env, b, view);
      }
      case "saved-query": {
        const { env, key } = await this.keyFor(accountId, a);
        const ann = await v1<HnyQueryAnnotation>(
          this.ctx,
          key,
          `/1/query_annotations/${ds(b)}/${encodeURIComponent(c)}`,
        );
        const spec = ann.query_id
          ? await v1<HnyQuerySpec>(
              this.ctx,
              key,
              `/1/queries/${ds(b)}/${encodeURIComponent(ann.query_id)}`,
            ).catch(() => undefined)
          : undefined;
        return mapSavedQuery(accountId, env, b, ann, spec);
      }
      case "recipient": {
        const r = await v1<HnyRecipient>(
          this.ctx,
          await this.recipientKey(accountId),
          `/1/recipients/${encodeURIComponent(ext)}`,
        );
        return mapRecipient(accountId, r);
      }
      case "signal": {
        const { env, key } = await this.keyFor(accountId, a);
        const s = await v1<HnySignal>(this.ctx, key, `/1/signals/${encodeURIComponent(b)}`);
        return mapSignal(accountId, env, s);
      }
      case "api-key": {
        const team = await this.teamSlug();
        const res = await v2<{ data?: JsonApiResource<HnyApiKeyAttrs> }>(
          this.ctx,
          `/2/teams/${encodeURIComponent(team)}/api-keys/${encodeURIComponent(ext)}`,
        );
        if (!res.data) break;
        const envs = await this.environments(accountId);
        const slugById = new Map(envs.filter((e) => e.id).map((e) => [e.id as string, e.slug]));
        return mapApiKey(accountId, this.keyRef(res.data), slugById);
      }
      default:
        break;
    }
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId || r.externalId === ext);
    if (!found) throw new Error(`Honeycomb plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "api-key" && outputKey === "key") {
      const secret = await this.storedSecret(resourceId, API_KEY_SECRET_FIELD);
      if (secret) return secret;
      throw new Error(
        "Honeycomb shows a key's secret only once, when it is created. Only keys created from Infrawrench have it stored.",
      );
    }
    const resource = await this.getResource(typeId, resourceId, accountId);
    const resolved = resource.resolvedOutputs[outputKey];
    if (resolved !== undefined) return resolved;
    const field = resource.fields[outputKey];
    if (field !== undefined) return String(field);
    throw new Error(`Honeycomb plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    if (resource.resourceTypeId !== "recipient" || !resource.externalId) return resource;
    const triggers = await v1<HnyTrigger[]>(
      this.ctx,
      await this.recipientKey(resource.accountId),
      `/1/recipients/${encodeURIComponent(resource.externalId)}/triggers`,
    );
    const rows = (triggers ?? []).map((t) => ({
      name: t.name ?? t.id,
      dataset: t.dataset_slug ?? "",
    }));
    return {
      ...resource,
      fields: { ...resource.fields, triggerCount: rows.length },
      resolvedOutputs: {
        ...resource.resolvedOutputs,
        [RECIPIENT_TRIGGERS_KEY]: JSON.stringify(rows),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Stats and metrics
  // -------------------------------------------------------------------------

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const r = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = r.fields;
    switch (resourceTypeId) {
      case "trigger":
        return [
          {
            label: "State",
            value:
              f["disabled"] === true ? "Disabled" : f["triggered"] === true ? "Triggered" : "OK",
            variant:
              f["disabled"] === true
                ? "default"
                : f["triggered"] === true
                  ? "status-error"
                  : "status-healthy",
          },
          {
            label: "Threshold",
            value:
              `${String(f["thresholdOp"] ?? "")} ${String(f["thresholdValue"] ?? "")}`.trim() ||
              "—",
          },
        ];
      case "slo":
        return [
          {
            label: "Target",
            value: f["targetPercent"] !== undefined ? `${String(f["targetPercent"])}%` : "—",
          },
          {
            label: "Budget left",
            value: f["budgetRemaining"] !== undefined ? `${String(f["budgetRemaining"])}%` : "—",
          },
        ];
      case "dataset":
        return [
          { label: "Columns", value: String(f["columnCount"] ?? "—") },
          {
            label: "Last event",
            value: String(f["lastWrittenAt"] ?? "—")
              .slice(0, 16)
              .replace("T", " "),
          },
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
    const ext = externalIdOf(resourceId);
    const [a = "", b = "", c = ""] = ext.split("/");
    switch (resourceTypeId) {
      case "environment": {
        const { key } = await this.keyFor(accountId, ext);
        return environmentSeries(
          this.ctx,
          key,
          rangeOrDefault(timeRange, DEFAULT_METRICS_WINDOW_MS),
        );
      }
      case "dataset": {
        const { key } = await this.keyFor(accountId, a);
        const defs = await v1<HnyDatasetDefinitions>(
          this.ctx,
          key,
          `/1/dataset_definitions/${ds(b)}`,
        ).catch(() => ({}) as HnyDatasetDefinitions);
        const duration = defs["duration_ms"]?.name;
        const error = defs["error"]?.name;
        return datasetSeries(
          this.ctx,
          key,
          b,
          { ...(duration ? { duration } : {}), ...(error ? { error } : {}) },
          rangeOrDefault(timeRange, DEFAULT_METRICS_WINDOW_MS),
        );
      }
      case "trigger": {
        const { key } = await this.keyFor(accountId, a);
        const t = await v1<HnyTrigger>(
          this.ctx,
          key,
          `/1/triggers/${ds(b)}/${encodeURIComponent(c)}`,
        );
        const queryId = t.query_id ?? t.query?.id;
        if (!queryId) return [];
        return storedQuerySeries(
          this.ctx,
          key,
          b,
          queryId,
          rangeOrDefault(timeRange, DEFAULT_METRICS_WINDOW_MS),
          t.threshold ?? undefined,
        );
      }
      case "saved-query": {
        const { key } = await this.keyFor(accountId, a);
        const ann = await v1<HnyQueryAnnotation>(
          this.ctx,
          key,
          `/1/query_annotations/${ds(b)}/${encodeURIComponent(c)}`,
        );
        if (!ann.query_id) return [];
        return storedQuerySeries(
          this.ctx,
          key,
          b,
          ann.query_id,
          rangeOrDefault(timeRange, DEFAULT_METRICS_WINDOW_MS),
        );
      }
      case "slo": {
        const { key } = await this.keyFor(accountId, a);
        return sloSeries(this.ctx, key, b, c, rangeOrDefault(timeRange, SLO_METRICS_WINDOW_MS));
      }
      default:
        return [];
    }
  }

  async verifyCredentials(): Promise<PreflightResult> {
    return verifyHoneycombCredentials(this.ctx, this.configurationKey);
  }

  // -------------------------------------------------------------------------
  // Create forms
  // -------------------------------------------------------------------------

  private async connectedEnvOptions(accountId = "", onlyEnv?: string) {
    const envs = await this.environments(accountId).catch(() => [] as EnvAccess[]);
    return envs
      .filter((e) => e.key && (!onlyEnv || e.slug === onlyEnv))
      .map((e) => opt(e.slug, e.name));
  }

  /** `env/dataset` choices across connected environments, optionally with `env/__all__`. */
  private async targetOptions(includeAll: boolean, accountId = "", onlyEnv?: string) {
    const envs = (await this.environments(accountId).catch(() => [] as EnvAccess[])).filter(
      (e) => e.key && (!onlyEnv || e.slug === onlyEnv),
    );
    const groups = await mapPooled(envs, POOL, async (env) => {
      const sets = await this.datasets(env).catch(() => [] as HnyDataset[]);
      return [
        ...(includeAll
          ? [
              {
                id: `${env.slug}/${ALL_DATASETS}`,
                label: `${env.name}: all datasets (environment-wide)`,
              },
            ]
          : []),
        ...sets
          .filter((d) => d.slug)
          .map((d) => ({ id: `${env.slug}/${d.slug}`, label: `${env.name}: ${d.name ?? d.slug}` })),
      ];
    });
    return groups.flat();
  }

  private async recipientOptions(accountId = "") {
    try {
      const list = await v1<HnyRecipient[]>(
        this.ctx,
        await this.recipientKey(accountId),
        "/1/recipients",
      );
      return (list ?? [])
        .filter((r) => r.id)
        .map((r) => ({
          id: r.id as string,
          label: `${recipientTarget(r) || r.id} (${r.type ?? ""})`,
        }));
    } catch {
      return [];
    }
  }

  private queryBuilderFields(forTrigger: boolean): CreateFieldConfig[] {
    return [
      {
        key: "calcOp",
        label: "Calculate",
        kind: "select",
        required: true,
        defaultValue: "COUNT",
        options: CALC_OPS.map((o) => opt(o)),
      },
      {
        key: "calcColumn",
        label: "Of column",
        kind: "text",
        required: false,
        placeholder: "duration_ms",
        description: "The column to calculate over. Not needed for COUNT and CONCURRENCY.",
      },
      {
        key: "filterColumn",
        label: "Where column",
        kind: "text",
        required: false,
        placeholder: "http.status_code",
        description: "Optional filter: only events where this column matches.",
      },
      {
        key: "filterOp",
        label: "Matches",
        kind: "select",
        required: false,
        defaultValue: "=",
        options: FILTER_OPS.map((o) => opt(o)),
      },
      {
        key: "filterValue",
        label: "Value",
        kind: "text",
        required: false,
        placeholder: "500",
        description: "Comma-separated for in and not-in.",
      },
      ...(forTrigger
        ? []
        : [
            {
              key: "breakdown",
              label: "Group by column",
              kind: "text" as const,
              required: false,
              placeholder: "service.name",
            },
          ]),
      {
        key: "timeRange",
        label: "Time range",
        kind: "select",
        required: true,
        defaultValue: forTrigger ? "900" : "7200",
        options: [
          opt("300", "5 minutes"),
          opt("900", "15 minutes"),
          opt("1800", "30 minutes"),
          opt("3600", "1 hour"),
          opt("7200", "2 hours"),
          opt("21600", "6 hours"),
          opt("86400", "1 day"),
          ...(forTrigger ? [] : [opt("604800", "7 days")]),
        ],
      },
      {
        key: "queryJson",
        label: "Query JSON (advanced)",
        kind: "text",
        multiline: true,
        required: false,
        description:
          "Optional: a full Honeycomb query specification, copied from a query's JSON view. Replaces the fields above.",
      },
    ];
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    // Creating from a parent's page is the only way the form learns the
    // account, and so the only way it can reach environments connected with
    // a stored key; from the sidebar it sees the account key's environment.
    const accountId = parentResourceId?.split(":")[0] ?? "";
    const parentEnv =
      parentResourceId?.split(":")[1] === "environment"
        ? externalIdOf(parentResourceId)
        : undefined;
    switch (typeId) {
      case "environment":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "staging" },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "color",
              label: "Color",
              kind: "select",
              required: false,
              defaultValue: "",
              options: [
                opt("", "Random"),
                ...[
                  "blue",
                  "green",
                  "gold",
                  "red",
                  "purple",
                  "lightBlue",
                  "lightGreen",
                  "lightGold",
                  "lightRed",
                  "lightPurple",
                ].map((c) => opt(c)),
              ],
            },
            {
              key: "connect",
              label: "Connect it",
              kind: "select",
              required: false,
              defaultValue: "true",
              options: [
                opt("true", "Yes, create a configuration key for Infrawrench"),
                opt("false", "No"),
              ],
            },
          ],
        };
      case "dataset":
        return {
          fields: [
            ...(parentResourceId
              ? []
              : [
                  {
                    key: "environment",
                    label: "Environment",
                    kind: "select" as const,
                    required: true,
                    options: await this.connectedEnvOptions(accountId),
                  },
                ]),
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "checkout-service",
            },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "expandJsonDepth",
              label: "JSON unpacking depth",
              kind: "number",
              required: false,
              defaultValue: "0",
              minValue: 0,
              maxValue: 10,
            },
          ],
        };
      case "column":
        return {
          fields: [
            ...(parentResourceId
              ? []
              : [
                  {
                    key: "target",
                    label: "Dataset",
                    kind: "select" as const,
                    required: true,
                    options: await this.targetOptions(false, accountId, parentEnv),
                  },
                ]),
            {
              key: "keyName",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "user.plan",
            },
            {
              key: "type",
              label: "Type",
              kind: "select",
              required: true,
              defaultValue: "string",
              options: ["string", "integer", "float", "boolean", "histogram"].map((t) => opt(t)),
            },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "hidden",
              label: "Hidden",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: [opt("false", "No"), opt("true", "Yes")],
            },
          ],
        };
      case "derived-column":
        return {
          fields: [
            {
              key: "target",
              label: "Dataset",
              kind: "select",
              required: true,
              options: await this.targetOptions(true, accountId, parentEnv),
            },
            { key: "alias", label: "Alias", kind: "text", required: true, placeholder: "is_error" },
            {
              key: "expression",
              label: "Expression",
              kind: "text",
              multiline: true,
              required: true,
              placeholder: "IF(GTE($http.status_code, 500), 1, 0)",
              description: "A derived column formula. See Honeycomb's derived column reference.",
            },
            { key: "description", label: "Description", kind: "text", required: false },
          ],
        };
      case "trigger":
        return {
          fields: [
            {
              key: "target",
              label: "Dataset",
              kind: "select",
              required: true,
              options: await this.targetOptions(true, accountId, parentEnv),
            },
            { key: "name", label: "Name", kind: "text", required: true },
            { key: "description", label: "Description", kind: "text", required: false },
            ...this.queryBuilderFields(true),
            {
              key: "thresholdOp",
              label: "Alert when the result is",
              kind: "select",
              required: true,
              defaultValue: ">",
              options: [">", ">=", "<", "<="].map((o) => opt(o)),
            },
            { key: "thresholdValue", label: "Threshold", kind: "number", required: true },
            {
              key: "frequency",
              label: "Check every",
              kind: "select",
              required: true,
              defaultValue: "900",
              options: [
                opt("60", "1 minute"),
                opt("300", "5 minutes"),
                opt("900", "15 minutes"),
                opt("1800", "30 minutes"),
                opt("3600", "1 hour"),
                opt("21600", "6 hours"),
                opt("86400", "1 day"),
              ],
            },
            {
              key: "alertType",
              label: "Notify",
              kind: "select",
              required: false,
              defaultValue: "on_change",
              options: [
                opt("on_change", "When it fires and when it resolves"),
                opt("on_true", "On every evaluation over the threshold"),
                opt("on_group_change", "Per group, when a group fires or resolves"),
              ],
            },
            {
              key: "recipientId",
              label: "Recipient",
              kind: "select",
              required: false,
              defaultValue: "",
              options: [opt("", "None"), ...(await this.recipientOptions(accountId))],
            },
          ],
        };
      case "slo": {
        const derived = await this.listResources("derived-column", accountId).catch(
          () => [] as ResourceInstance[],
        );
        return {
          fields: [
            {
              key: "sli",
              label: "SLI derived column",
              kind: "select",
              required: true,
              description:
                "A derived column that is true (or 1) for good events. Environment-wide ones need datasets below.",
              options: derived
                .filter((d) => !parentEnv || d.fields["environment"] === parentEnv)
                .map((d) =>
                  opt(
                    d.externalId ?? d.id,
                    `${String(d.fields["environment"] ?? "")}: ${String(d.fields["alias"] ?? d.displayName)} (${String(d.fields["dataset"] || "all datasets")})`,
                  ),
                ),
            },
            { key: "name", label: "Name", kind: "text", required: true },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "targetPercent",
              label: "Target (%)",
              kind: "number",
              required: true,
              defaultValue: "99.9",
              minValue: 0,
              maxValue: 100,
              stepValue: 0.01,
            },
            {
              key: "timePeriodDays",
              label: "Window (days)",
              kind: "number",
              required: true,
              defaultValue: "30",
              minValue: 1,
              maxValue: 90,
            },
            {
              key: "datasets",
              label: "Datasets",
              kind: "text",
              required: false,
              placeholder: "frontend, backend",
              description:
                "Only for environment-wide SLIs: comma-separated dataset slugs to evaluate the SLO on.",
            },
          ],
        };
      }
      case "burn-alert":
        return {
          fields: [
            ...(parentResourceId
              ? []
              : [
                  {
                    key: "slo",
                    label: "SLO",
                    kind: "select" as const,
                    required: true,
                    options: (
                      await this.listResources("slo", accountId).catch(
                        () => [] as ResourceInstance[],
                      )
                    ).map((s) => opt(s.externalId ?? s.id, s.displayName)),
                  },
                ]),
            {
              key: "alertType",
              label: "Kind",
              kind: "select",
              required: true,
              defaultValue: "exhaustion_time",
              options: [
                opt("exhaustion_time", "Budget will run out within a time"),
                opt("budget_rate", "Budget drops faster than a rate"),
              ],
            },
            {
              key: "exhaustionMinutes",
              label: "Exhaustion time (minutes)",
              kind: "number",
              required: false,
              defaultValue: "240",
              showWhen: { fieldKey: "alertType", fieldValue: "exhaustion_time" },
            },
            {
              key: "budgetRateWindowMinutes",
              label: "Window (minutes)",
              kind: "number",
              required: false,
              defaultValue: "60",
              showWhen: { fieldKey: "alertType", fieldValue: "budget_rate" },
            },
            {
              key: "budgetRateDecreasePercent",
              label: "Budget decrease (%)",
              kind: "number",
              required: false,
              defaultValue: "1",
              stepValue: 0.0001,
              showWhen: { fieldKey: "alertType", fieldValue: "budget_rate" },
            },
            {
              key: "recipientId",
              label: "Recipient",
              kind: "select",
              required: true,
              options: await this.recipientOptions(accountId),
            },
            { key: "description", label: "Description", kind: "text", required: false },
          ],
        };
      case "board":
        return {
          fields: [
            ...(parentEnv
              ? []
              : [
                  {
                    key: "environment",
                    label: "Environment",
                    kind: "select" as const,
                    required: true,
                    options: await this.connectedEnvOptions(accountId),
                  },
                ]),
            { key: "name", label: "Name", kind: "text", required: true },
            { key: "description", label: "Description", kind: "text", required: false },
          ],
        };
      case "board-view":
        return {
          fields: [
            ...(parentResourceId
              ? []
              : [
                  {
                    key: "board",
                    label: "Board",
                    kind: "select" as const,
                    required: true,
                    options: (
                      await this.listResources("board", accountId).catch(
                        () => [] as ResourceInstance[],
                      )
                    ).map((b) => opt(b.externalId ?? b.id, b.displayName)),
                  },
                ]),
            { key: "name", label: "Name", kind: "text", required: true },
            {
              key: "filterColumn",
              label: "Filter column",
              kind: "text",
              required: true,
              placeholder: "service.name",
            },
            {
              key: "filterOp",
              label: "Matches",
              kind: "select",
              required: true,
              defaultValue: "=",
              options: FILTER_OPS.map((o) => opt(o)),
            },
            { key: "filterValue", label: "Value", kind: "text", required: false },
          ],
        };
      case "marker":
        return {
          fields: [
            {
              key: "target",
              label: "Dataset",
              kind: "select",
              required: true,
              options: await this.targetOptions(true, accountId, parentEnv),
            },
            {
              key: "message",
              label: "Message",
              kind: "text",
              required: true,
              placeholder: "Deploy v1.42",
            },
            { key: "type", label: "Type", kind: "text", required: false, placeholder: "deploy" },
            { key: "url", label: "Link", kind: "text", required: false },
            {
              key: "startTime",
              label: "Start",
              kind: "datetime",
              required: false,
              description: "Leave empty for now.",
            },
            {
              key: "endTime",
              label: "End",
              kind: "datetime",
              required: false,
              description: "Optional: makes the marker a span rather than a point.",
            },
          ],
        };
      case "marker-setting":
        return {
          fields: [
            {
              key: "target",
              label: "Dataset",
              kind: "select",
              required: true,
              options: await this.targetOptions(true, accountId, parentEnv),
            },
            {
              key: "type",
              label: "Marker type",
              kind: "text",
              required: true,
              placeholder: "deploy",
            },
            { key: "color", label: "Color", kind: "text", required: true, placeholder: "#F96E10" },
          ],
        };
      case "saved-query":
        return {
          fields: [
            {
              key: "target",
              label: "Dataset",
              kind: "select",
              required: true,
              options: await this.targetOptions(true, accountId, parentEnv),
            },
            { key: "name", label: "Name", kind: "text", required: true },
            { key: "description", label: "Description", kind: "text", required: false },
            ...this.queryBuilderFields(false),
          ],
        };
      case "recipient":
        return {
          fields: [
            {
              key: "type",
              label: "Type",
              kind: "select",
              required: true,
              defaultValue: "email",
              options: [
                opt("email", "Email"),
                opt("slack", "Slack channel"),
                opt("pagerduty", "PagerDuty"),
                opt("webhook", "Webhook"),
                opt("msteams_workflow", "Microsoft Teams workflow"),
              ],
            },
            {
              key: "target",
              label: "Address, channel or name",
              kind: "text",
              required: true,
              description:
                "Email: the address. Slack: #channel or @user (the Slack app must be installed in Honeycomb). PagerDuty, webhook and Teams: a name for the recipient.",
            },
            {
              key: "url",
              label: "URL",
              kind: "text",
              required: false,
              showWhen: { fieldKey: "type", fieldValues: ["webhook", "msteams_workflow"] },
            },
            {
              key: "secret",
              label: "Integration key or secret",
              kind: "text",
              required: false,
              showWhen: { fieldKey: "type", fieldValues: ["pagerduty", "webhook"] },
              description:
                "PagerDuty: the Events API v2 integration key. Webhook: an optional shared secret.",
            },
          ],
        };
      case "api-key": {
        const envs = await this.environments(accountId).catch(() => [] as EnvAccess[]);
        return {
          fields: [
            {
              key: "environment",
              label: "Environment",
              kind: "select",
              required: true,
              options: envs.filter((e) => e.id).map((e) => opt(e.id as string, e.name)),
            },
            { key: "name", label: "Name", kind: "text", required: true },
            {
              key: "keyType",
              label: "Type",
              kind: "select",
              required: true,
              defaultValue: "ingest",
              options: [
                opt("ingest", "Ingest (send telemetry)"),
                opt("configuration", "Configuration (manage the environment)"),
              ],
            },
            {
              key: "permissions",
              label: "Permissions",
              kind: "policy-picker",
              required: false,
              description: "Ingest keys only honour Create datasets.",
              policies: API_KEY_PERMISSIONS.map((p) => ({
                id: p.id,
                label: p.label,
                category: p.ingest ? "Ingest and configuration" : "Configuration keys",
              })),
            },
          ],
        };
      }
      default:
        throw new Error(`Honeycomb plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  private async target(
    accountId: string,
    fields: Record<string, string>,
    parentResourceId: string | undefined,
  ): Promise<{ env: EnvAccess; key: string; dataset: string }> {
    const raw =
      trimmed(fields, "target") || (parentResourceId ? externalIdOf(parentResourceId) : "");
    const [envSlug = "", dataset = ""] = raw.split("/");
    if (!envSlug || !dataset) throw new Error("Pick a dataset.");
    const { env, key } = await this.keyFor(accountId, envSlug);
    return { env, key, dataset };
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    switch (typeId) {
      case "environment":
        return this.createEnvironment(accountId, fields);
      case "dataset": {
        const envSlug =
          trimmed(fields, "environment") ||
          (parentResourceId ? externalIdOf(parentResourceId) : "");
        const { env, key } = await this.keyFor(accountId, envSlug);
        const depth = numberOr(fields["expandJsonDepth"]);
        const d = await v1<HnyDataset>(this.ctx, key, "/1/datasets", {
          method: "POST",
          body: JSON.stringify({
            name: trimmed(fields, "name"),
            ...(fields["description"] ? { description: fields["description"] } : {}),
            ...(depth !== undefined ? { expand_json_depth: depth } : {}),
          }),
        });
        this.datasetCache.delete(env.slug);
        return mapDataset(accountId, env, d);
      }
      case "column": {
        const { env, key, dataset } = await this.target(accountId, fields, parentResourceId);
        const c = await v1<HnyColumn>(this.ctx, key, `/1/columns/${ds(dataset)}`, {
          method: "POST",
          body: JSON.stringify({
            key_name: trimmed(fields, "keyName"),
            type: trimmed(fields, "type") || "string",
            ...(fields["description"] ? { description: fields["description"] } : {}),
            hidden: boolField(fields["hidden"]),
          }),
        });
        return mapColumn(accountId, env, dataset, c);
      }
      case "derived-column": {
        const { env, key, dataset } = await this.target(accountId, fields, undefined);
        const c = await v1<HnyDerivedColumn>(this.ctx, key, `/1/derived_columns/${ds(dataset)}`, {
          method: "POST",
          body: JSON.stringify({
            alias: trimmed(fields, "alias"),
            expression: trimmed(fields, "expression"),
            ...(fields["description"] ? { description: fields["description"] } : {}),
          }),
        });
        return mapDerivedColumn(accountId, env, dataset, c);
      }
      case "trigger": {
        const { env, key, dataset } = await this.target(accountId, fields, undefined);
        const recipientId = trimmed(fields, "recipientId");
        const t = await v1<HnyTrigger>(this.ctx, key, `/1/triggers/${ds(dataset)}`, {
          method: "POST",
          body: JSON.stringify({
            name: trimmed(fields, "name"),
            ...(fields["description"] ? { description: fields["description"] } : {}),
            query: builderSpec(fields, { forTrigger: true }),
            threshold: {
              op: trimmed(fields, "thresholdOp") || ">",
              value: numberOr(fields["thresholdValue"], 0),
            },
            frequency: numberOr(fields["frequency"], 900),
            alert_type: trimmed(fields, "alertType") || "on_change",
            disabled: false,
            ...(recipientId ? { recipients: [{ id: recipientId }] } : {}),
          }),
        });
        return mapTrigger(accountId, env, dataset, t);
      }
      case "slo":
        return this.createSlo(accountId, fields);
      case "burn-alert": {
        const sloExt =
          trimmed(fields, "slo") || (parentResourceId ? externalIdOf(parentResourceId) : "");
        const [envSlug = "", dataset = "", sloId = ""] = sloExt.split("/");
        if (!sloId) throw new Error("Pick an SLO.");
        const { env, key } = await this.keyFor(accountId, envSlug);
        const recipientId = trimmed(fields, "recipientId");
        if (!recipientId)
          throw new Error("Pick a recipient: Honeycomb requires one per burn alert.");
        const kind = trimmed(fields, "alertType") || "exhaustion_time";
        const body: Record<string, unknown> = {
          alert_type: kind,
          slo: { id: sloId },
          recipients: [{ id: recipientId }],
          ...(fields["description"] ? { description: fields["description"] } : {}),
        };
        if (kind === "budget_rate") {
          body["budget_rate_window_minutes"] = numberOr(fields["budgetRateWindowMinutes"], 60);
          body["budget_rate_decrease_threshold_per_million"] = Math.round(
            (numberOr(fields["budgetRateDecreasePercent"], 1) as number) * 10_000,
          );
        } else {
          body["exhaustion_minutes"] = numberOr(fields["exhaustionMinutes"], 240);
        }
        const b = await v1<HnyBurnAlert>(this.ctx, key, `/1/burn_alerts/${ds(dataset)}`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        return mapBurnAlert(accountId, env, dataset, sloId, b);
      }
      case "board": {
        const envSlug =
          trimmed(fields, "environment") ||
          (parentResourceId ? externalIdOf(parentResourceId) : "");
        const { env, key } = await this.keyFor(accountId, envSlug);
        const b = await v1<HnyBoard>(this.ctx, key, "/1/boards", {
          method: "POST",
          body: JSON.stringify({
            name: trimmed(fields, "name"),
            ...(fields["description"] ? { description: fields["description"] } : {}),
            type: "flexible",
            layout_generation: "auto",
            panels: [],
            tags: [],
          }),
        });
        return mapBoard(accountId, env, b);
      }
      case "board-view": {
        const boardExt =
          trimmed(fields, "board") || (parentResourceId ? externalIdOf(parentResourceId) : "");
        const [envSlug = "", boardId = ""] = boardExt.split("/");
        const { env, key } = await this.keyFor(accountId, envSlug);
        const op = trimmed(fields, "filterOp") || "=";
        const value = filterValue(op, fields["filterValue"] ?? "");
        const v = await v1<HnyBoardView>(
          this.ctx,
          key,
          `/1/boards/${encodeURIComponent(boardId)}/views`,
          {
            method: "POST",
            body: JSON.stringify({
              name: trimmed(fields, "name"),
              filters: [
                {
                  column: trimmed(fields, "filterColumn"),
                  operation: op,
                  ...(value !== undefined ? { value } : {}),
                },
              ],
            }),
          },
        );
        return mapBoardView(accountId, env, boardId, v);
      }
      case "marker": {
        const { env, key, dataset } = await this.target(accountId, fields, undefined);
        const start = trimmed(fields, "startTime");
        const end = trimmed(fields, "endTime");
        const m = await v1<HnyMarker>(this.ctx, key, `/1/markers/${ds(dataset)}`, {
          method: "POST",
          body: JSON.stringify({
            message: trimmed(fields, "message"),
            ...(fields["type"] ? { type: trimmed(fields, "type") } : {}),
            ...(fields["url"] ? { url: trimmed(fields, "url") } : {}),
            ...(start ? { start_time: Math.floor(Date.parse(start) / 1000) } : {}),
            ...(end ? { end_time: Math.floor(Date.parse(end) / 1000) } : {}),
          }),
        });
        return mapMarker(accountId, env, dataset, m);
      }
      case "marker-setting": {
        const { env, key, dataset } = await this.target(accountId, fields, undefined);
        const m = await v1<HnyMarkerSetting>(this.ctx, key, `/1/marker_settings/${ds(dataset)}`, {
          method: "POST",
          body: JSON.stringify({ type: trimmed(fields, "type"), color: trimmed(fields, "color") }),
        });
        return mapMarkerSetting(accountId, env, dataset, m);
      }
      case "saved-query": {
        const { env, key, dataset } = await this.target(accountId, fields, undefined);
        const spec = builderSpec(fields, { forTrigger: false });
        const query = await v1<HnyQuerySpec>(this.ctx, key, `/1/queries/${ds(dataset)}`, {
          method: "POST",
          body: JSON.stringify(spec),
        });
        const ann = await v1<HnyQueryAnnotation>(
          this.ctx,
          key,
          `/1/query_annotations/${ds(dataset)}`,
          {
            method: "POST",
            body: JSON.stringify({
              name: trimmed(fields, "name"),
              ...(fields["description"] ? { description: fields["description"] } : {}),
              query_id: query.id,
            }),
          },
        );
        return mapSavedQuery(accountId, env, dataset, ann, query);
      }
      case "recipient": {
        const r = await v1<HnyRecipient>(
          this.ctx,
          await this.recipientKey(accountId),
          "/1/recipients",
          {
            method: "POST",
            body: JSON.stringify(recipientBody(trimmed(fields, "type"), fields)),
          },
        );
        return mapRecipient(accountId, r);
      }
      case "api-key":
        return this.createApiKey(accountId, fields);
      default:
        throw new Error(`Honeycomb plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  private async createEnvironment(accountId: string, fields: Record<string, string>) {
    const team = await this.teamSlug();
    const color = trimmed(fields, "color");
    const res = await v2<{ data?: JsonApiResource<HnyEnvironmentAttrs> }>(
      this.ctx,
      `/2/teams/${encodeURIComponent(team)}/environments`,
      {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "environments",
            attributes: {
              name: trimmed(fields, "name"),
              ...(fields["description"] ? { description: fields["description"] } : {}),
              ...(color ? { color } : {}),
            },
          },
        }),
      },
    );
    const created = res.data;
    if (!created) throw new Error("Honeycomb returned no environment");
    this.envCache = undefined;
    const slug = created.attributes?.slug ?? created.id;
    let connected = false;
    if (fields["connect"] !== "false") {
      await this.connectEnvironment(accountId, slug, created.id).catch(() => undefined);
      connected = true;
    }
    return mapEnvironment(accountId, {
      slug,
      id: created.id,
      ...(created.attributes ? { attrs: created.attributes } : {}),
      team,
      region: this.ctx.region.id,
      uiUrl: this.ctx.region.uiUrl,
      connected,
    });
  }

  private async createSlo(accountId: string, fields: Record<string, string>) {
    const [envSlug = "", sliDataset = "", sliId = ""] = trimmed(fields, "sli").split("/");
    const { env, key } = await this.keyFor(accountId, envSlug);
    const sli = await v1<HnyDerivedColumn>(
      this.ctx,
      key,
      `/1/derived_columns/${ds(sliDataset)}/${encodeURIComponent(sliId)}`,
    );
    const datasets = trimmed(fields, "datasets")
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);
    const path = sliDataset === ALL_DATASETS ? ALL_DATASETS : sliDataset;
    if (path === ALL_DATASETS && datasets.length === 0) {
      throw new Error("An environment-wide SLI needs the datasets to evaluate the SLO on.");
    }
    const s = await v1<HnySlo>(this.ctx, key, `/1/slos/${ds(path)}`, {
      method: "POST",
      body: JSON.stringify({
        name: trimmed(fields, "name"),
        description: fields["description"] ?? "",
        sli: { alias: sli.alias },
        time_period_days: numberOr(fields["timePeriodDays"], 30),
        target_per_million: Math.round(
          (numberOr(fields["targetPercent"], 99.9) as number) * 10_000,
        ),
        ...(path === ALL_DATASETS ? { dataset_slugs: datasets } : {}),
      }),
    });
    return mapSlo(accountId, env, path, s);
  }

  private async createApiKey(accountId: string, fields: Record<string, string>) {
    const team = await this.teamSlug();
    const keyType = trimmed(fields, "keyType") || "ingest";
    let picked: string[] = [];
    try {
      picked = JSON.parse(fields["permissions"] || "[]") as string[];
    } catch {
      picked = [];
    }
    const permissions = Object.fromEntries(
      picked
        .filter((p) => keyType === "configuration" || p === "create_datasets")
        .map((p) => [p, true]),
    );
    const res = await v2<{ data?: JsonApiResource<HnyApiKeyAttrs> }>(
      this.ctx,
      `/2/teams/${encodeURIComponent(team)}/api-keys`,
      {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "api-keys",
            attributes: { key_type: keyType, name: trimmed(fields, "name"), permissions },
            relationships: {
              environment: { data: { id: trimmed(fields, "environment"), type: "environments" } },
            },
          },
        }),
      },
    );
    if (!res.data) throw new Error("Honeycomb returned no key");
    const secret = res.data.attributes?.secret;
    const resourceId = resourceIdFor(accountId, "api-key", res.data.id);
    if (secret) {
      // Ingest keys are used as id + secret; configuration keys as the secret alone.
      const usable = keyType === "ingest" ? `${res.data.id}${secret}` : secret;
      await this.storeSecret(resourceId, API_KEY_SECRET_FIELD, usable).catch(() => undefined);
    }
    const envs = await this.environments(accountId);
    const slugById = new Map(envs.filter((e) => e.id).map((e) => [e.id as string, e.slug]));
    return mapApiKey(accountId, this.keyRef(res.data), slugById);
  }

  /** Mint a configuration key for an environment and store it against the environment. */
  private async connectEnvironment(accountId: string, slug: string, envId: string): Promise<void> {
    const team = await this.teamSlug();
    const res = await v2<{ data?: JsonApiResource<HnyApiKeyAttrs> }>(
      this.ctx,
      `/2/teams/${encodeURIComponent(team)}/api-keys`,
      {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "api-keys",
            attributes: {
              key_type: "configuration",
              name: "Infrawrench",
              permissions: CONNECT_PERMISSIONS,
            },
            relationships: { environment: { data: { id: envId, type: "environments" } } },
          },
        }),
      },
    );
    const secret = res.data?.attributes?.secret;
    if (!secret) throw new Error("Honeycomb did not return the new key's secret");
    await this.storeSecret(resourceIdFor(accountId, "environment", slug), CONFIG_KEY_FIELD, secret);
    this.envCache = undefined;
    this.datasetCache.delete(slug);
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const ext = externalIdOf(resourceId);
    const [a = "", b = "", c = ""] = ext.split("/");
    switch (typeId) {
      case "environment": {
        if (fields[CONFIG_KEY_FIELD]?.trim()) {
          const key = fields[CONFIG_KEY_FIELD].trim();
          const auth = await v1<HnyAuth>(this.ctx, key, "/1/auth");
          if (auth.type === "ingest")
            throw new Error("That is an ingest key. Paste a configuration key.");
          await this.storeSecret(resourceId, CONFIG_KEY_FIELD, key);
          this.envCache = undefined;
        }
        const attrs: Record<string, unknown> = {};
        if ("name" in fields) attrs["name"] = fields["name"];
        if ("description" in fields) attrs["description"] = fields["description"];
        if ("color" in fields && fields["color"]) attrs["color"] = fields["color"];
        if ("deleteProtected" in fields) {
          attrs["settings"] = { delete_protected: boolField(fields["deleteProtected"]) };
        }
        if (Object.keys(attrs).length > 0) {
          const env = await this.env(accountId, ext);
          if (!env.id)
            throw new Error("Editing an environment needs a management key on the account.");
          const team = await this.teamSlug();
          await v2(
            this.ctx,
            `/2/teams/${encodeURIComponent(team)}/environments/${encodeURIComponent(env.id)}`,
            {
              method: "PATCH",
              body: JSON.stringify({
                data: { id: env.id, type: "environments", attributes: attrs },
              }),
            },
          );
          this.envCache = undefined;
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "dataset": {
        const { key } = await this.keyFor(accountId, a);
        const settingsChanged = ["description", "expandJsonDepth", "deleteProtected"].some(
          (k) => k in fields,
        );
        if (settingsChanged) {
          const current = await v1<HnyDataset>(this.ctx, key, `/1/datasets/${ds(b)}`);
          await v1(this.ctx, key, `/1/datasets/${ds(b)}`, {
            method: "PUT",
            body: JSON.stringify({
              description:
                "description" in fields ? fields["description"] : (current.description ?? ""),
              expand_json_depth:
                "expandJsonDepth" in fields
                  ? (numberOr(fields["expandJsonDepth"], 0) as number)
                  : (current.expand_json_depth ?? 0),
              settings: {
                delete_protected:
                  "deleteProtected" in fields
                    ? boolField(fields["deleteProtected"])
                    : (current.settings?.delete_protected ?? false),
              },
            }),
          });
        }
        const defs: Record<string, { name: string }> = {};
        for (const k of DEFINITION_KEYS) {
          if (`def_${k}` in fields) defs[k] = { name: (fields[`def_${k}`] ?? "").trim() };
        }
        if (Object.keys(defs).length > 0) {
          await v1(this.ctx, key, `/1/dataset_definitions/${ds(b)}`, {
            method: "PATCH",
            body: JSON.stringify(defs),
          });
        }
        this.datasetCache.delete(a);
        return this.getResource(typeId, resourceId, accountId);
      }
      case "column": {
        const { env, key } = await this.keyFor(accountId, a);
        const current = await v1<HnyColumn>(
          this.ctx,
          key,
          `/1/columns/${ds(b)}/${encodeURIComponent(c)}`,
        );
        const updated = await v1<HnyColumn>(
          this.ctx,
          key,
          `/1/columns/${ds(b)}/${encodeURIComponent(c)}`,
          {
            method: "PUT",
            body: JSON.stringify({
              key_name: current.key_name,
              type: fields["type"] || current.type,
              description:
                "description" in fields ? fields["description"] : (current.description ?? ""),
              hidden: "hidden" in fields ? boolField(fields["hidden"]) : (current.hidden ?? false),
            }),
          },
        );
        return mapColumn(accountId, env, b, updated);
      }
      case "derived-column": {
        const { env, key } = await this.keyFor(accountId, a);
        const path = `/1/derived_columns/${ds(b)}/${encodeURIComponent(c)}`;
        const current = await v1<HnyDerivedColumn>(this.ctx, key, path);
        const updated = await v1<HnyDerivedColumn>(this.ctx, key, path, {
          method: "PUT",
          body: JSON.stringify({
            alias: current.alias,
            expression: "expression" in fields ? fields["expression"] : current.expression,
            description:
              "description" in fields ? fields["description"] : (current.description ?? ""),
          }),
        });
        return mapDerivedColumn(accountId, env, b, updated);
      }
      case "trigger":
        return this.updateTrigger(accountId, a, b, c, (t) => {
          if ("name" in fields) t.name = fields["name"] ?? "";
          if ("description" in fields) t.description = fields["description"] ?? "";
          if ("thresholdOp" in fields || "thresholdValue" in fields || "exceededLimit" in fields) {
            const limit = numberOr(fields["exceededLimit"], t.threshold?.exceeded_limit);
            t.threshold = {
              op: fields["thresholdOp"] || t.threshold?.op || ">",
              value: numberOr(fields["thresholdValue"], t.threshold?.value ?? 0) as number,
              ...(limit !== undefined ? { exceeded_limit: limit } : {}),
            };
          }
          if ("frequency" in fields) {
            const freq = numberOr(fields["frequency"], t.frequency);
            if (freq !== undefined) t.frequency = freq;
          }
          if ("alertType" in fields && fields["alertType"]) t.alert_type = fields["alertType"];
        });
      case "slo": {
        const { env, key } = await this.keyFor(accountId, a);
        const path = `/1/slos/${ds(b)}/${encodeURIComponent(c)}`;
        const current = await v1<HnySlo>(this.ctx, key, path);
        const updated = await v1<HnySlo>(this.ctx, key, path, {
          method: "PUT",
          body: JSON.stringify({
            name: "name" in fields ? fields["name"] : current.name,
            description:
              "description" in fields ? fields["description"] : (current.description ?? ""),
            sli: current.sli,
            time_period_days:
              "timePeriodDays" in fields
                ? numberOr(fields["timePeriodDays"], current.time_period_days)
                : current.time_period_days,
            target_per_million:
              "targetPercent" in fields
                ? Math.round((numberOr(fields["targetPercent"], 0) as number) * 10_000)
                : current.target_per_million,
            tags: current.tags ?? [],
            ...(b === ALL_DATASETS ? { dataset_slugs: current.dataset_slugs ?? [] } : {}),
          }),
        });
        return mapSlo(accountId, env, sloDatasetPath(updated, b), updated);
      }
      case "burn-alert": {
        const { env, key } = await this.keyFor(accountId, a);
        const path = `/1/burn_alerts/${ds(b)}/${encodeURIComponent(c)}`;
        const current = await v1<HnyBurnAlert>(this.ctx, key, path);
        const body: Record<string, unknown> = {
          alert_type: current.alert_type,
          slo: current.slo,
          description:
            "description" in fields ? fields["description"] : (current.description ?? ""),
          recipients: (current.recipients ?? []).map((r) => ({ id: r.id })),
        };
        if (current.alert_type === "budget_rate") {
          body["budget_rate_window_minutes"] = numberOr(
            fields["budgetRateWindowMinutes"],
            current.budget_rate_window_minutes,
          );
          body["budget_rate_decrease_threshold_per_million"] =
            "budgetRateDecreasePercent" in fields
              ? Math.round((numberOr(fields["budgetRateDecreasePercent"], 0) as number) * 10_000)
              : current.budget_rate_decrease_threshold_per_million;
        } else {
          body["exhaustion_minutes"] = numberOr(
            fields["exhaustionMinutes"],
            current.exhaustion_minutes,
          );
        }
        const updated = await v1<HnyBurnAlert>(this.ctx, key, path, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        return mapBurnAlert(accountId, env, b, current.slo?.id ?? "", updated);
      }
      case "board": {
        const { env, key } = await this.keyFor(accountId, a);
        const path = `/1/boards/${encodeURIComponent(b)}`;
        const current = await v1<HnyBoard>(this.ctx, key, path);
        const { id: _id, links: _links, ...rest } = current;
        const updated = await v1<HnyBoard>(this.ctx, key, path, {
          method: "PUT",
          body: JSON.stringify({
            ...rest,
            ...("name" in fields ? { name: fields["name"] } : {}),
            ...("description" in fields ? { description: fields["description"] } : {}),
            tags: current.tags ?? [],
          }),
        });
        return mapBoard(accountId, env, updated);
      }
      case "board-view": {
        const { env, key } = await this.keyFor(accountId, a);
        const path = `/1/boards/${encodeURIComponent(b)}/views/${encodeURIComponent(c)}`;
        const current = await v1<HnyBoardView>(this.ctx, key, path);
        const updated = await v1<HnyBoardView>(this.ctx, key, path, {
          method: "PUT",
          body: JSON.stringify({
            name: fields["name"] ?? current.name,
            filters: current.filters ?? [],
          }),
        });
        return mapBoardView(accountId, env, b, updated);
      }
      case "marker": {
        const { env, key } = await this.keyFor(accountId, a);
        const list = await v1<HnyMarker[]>(this.ctx, key, `/1/markers/${ds(b)}`);
        const current = (list ?? []).find((m) => m.id === c);
        if (!current) throw new Error("Marker not found");
        const updated = await v1<HnyMarker>(
          this.ctx,
          key,
          `/1/markers/${ds(b)}/${encodeURIComponent(c)}`,
          {
            method: "PUT",
            body: JSON.stringify({
              ...(current.start_time ? { start_time: current.start_time } : {}),
              ...(current.end_time ? { end_time: current.end_time } : {}),
              message: "message" in fields ? fields["message"] : current.message,
              type: "type" in fields ? fields["type"] : current.type,
              url: "url" in fields ? fields["url"] : current.url,
            }),
          },
        );
        return mapMarker(accountId, env, b, updated);
      }
      case "marker-setting": {
        const { env, key } = await this.keyFor(accountId, a);
        const list = await v1<HnyMarkerSetting[]>(this.ctx, key, `/1/marker_settings/${ds(b)}`);
        const current = (list ?? []).find((m) => m.id === c);
        const updated = await v1<HnyMarkerSetting>(
          this.ctx,
          key,
          `/1/marker_settings/${ds(b)}/${encodeURIComponent(c)}`,
          {
            method: "PUT",
            body: JSON.stringify({ type: current?.type, color: fields["color"] ?? current?.color }),
          },
        );
        return mapMarkerSetting(accountId, env, b, updated);
      }
      case "saved-query": {
        const { env, key } = await this.keyFor(accountId, a);
        const path = `/1/query_annotations/${ds(b)}/${encodeURIComponent(c)}`;
        const current = await v1<HnyQueryAnnotation>(this.ctx, key, path);
        const updated = await v1<HnyQueryAnnotation>(this.ctx, key, path, {
          method: "PUT",
          body: JSON.stringify({
            name: "name" in fields ? fields["name"] : current.name,
            description:
              "description" in fields ? fields["description"] : (current.description ?? ""),
            query_id: current.query_id,
          }),
        });
        return mapSavedQuery(accountId, env, b, updated);
      }
      case "recipient": {
        const key = await this.recipientKey(accountId);
        const path = `/1/recipients/${encodeURIComponent(ext)}`;
        const current = await v1<HnyRecipient>(this.ctx, key, path);
        const merged: Record<string, string> = {
          target: "target" in fields ? (fields["target"] ?? "") : recipientTarget(current),
          url: "url" in fields ? (fields["url"] ?? "") : (current.details?.webhook_url ?? ""),
          secret: fields["secret"] ?? "",
        };
        const body = recipientBody(current.type ?? "", merged, current);
        const updated = await v1<HnyRecipient>(this.ctx, key, path, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        return mapRecipient(accountId, updated);
      }
      case "signal": {
        const { env, key } = await this.keyFor(accountId, a);
        const updated = await v1<HnySignal>(this.ctx, key, `/1/signals/${encodeURIComponent(b)}`, {
          method: "PUT",
          body: JSON.stringify({ sensitivity: fields["sensitivity"] || "medium" }),
        });
        return mapSignal(accountId, env, updated);
      }
      case "api-key":
        return this.patchApiKey(accountId, ext, {
          ...("name" in fields ? { name: fields["name"] } : {}),
        });
      default:
        throw new Error(`Honeycomb plugin: "${typeId}" cannot be edited from Infrawrench`);
    }
  }

  private async updateTrigger(
    accountId: string,
    envSlug: string,
    dataset: string,
    id: string,
    mutate: (t: HnyTrigger) => void,
  ): Promise<ResourceInstance> {
    const { env, key } = await this.keyFor(accountId, envSlug);
    const path = `/1/triggers/${ds(dataset)}/${encodeURIComponent(id)}`;
    const current = await v1<HnyTrigger>(this.ctx, key, path);
    mutate(current);
    const updated = await v1<HnyTrigger>(this.ctx, key, path, {
      method: "PUT",
      body: JSON.stringify(triggerBody(current)),
    });
    return mapTrigger(accountId, env, dataset, updated);
  }

  private async patchApiKey(accountId: string, id: string, attrs: Record<string, unknown>) {
    const team = await this.teamSlug();
    await v2(this.ctx, `/2/teams/${encodeURIComponent(team)}/api-keys/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ data: { id, type: "api-keys", attributes: attrs } }),
    });
    return this.getResource("api-key", resourceIdFor(accountId, "api-key", id), accountId);
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  async deleteResource(typeId: string, resourceId: string, accountId: string): Promise<void> {
    const ext = externalIdOf(resourceId);
    const [a = "", b = "", c = ""] = ext.split("/");
    const del = async (path: string) => {
      const { key } = await this.keyFor(accountId, a);
      await v1(this.ctx, key, path, { method: "DELETE" });
    };
    switch (typeId) {
      case "environment": {
        const env = await this.env(accountId, ext);
        if (!env.id)
          throw new Error("Deleting an environment needs a management key on the account.");
        const team = await this.teamSlug();
        await v2(
          this.ctx,
          `/2/teams/${encodeURIComponent(team)}/environments/${encodeURIComponent(env.id)}`,
          {
            method: "DELETE",
          },
        );
        this.envCache = undefined;
        return;
      }
      case "dataset":
        await del(`/1/datasets/${ds(b)}`);
        this.datasetCache.delete(a);
        return;
      case "column":
        return del(`/1/columns/${ds(b)}/${encodeURIComponent(c)}`);
      case "derived-column":
        return del(`/1/derived_columns/${ds(b)}/${encodeURIComponent(c)}`);
      case "trigger":
        return del(`/1/triggers/${ds(b)}/${encodeURIComponent(c)}`);
      case "slo":
        return del(`/1/slos/${ds(b)}/${encodeURIComponent(c)}`);
      case "burn-alert":
        return del(`/1/burn_alerts/${ds(b)}/${encodeURIComponent(c)}`);
      case "board":
        return del(`/1/boards/${encodeURIComponent(b)}`);
      case "board-view":
        return del(`/1/boards/${encodeURIComponent(b)}/views/${encodeURIComponent(c)}`);
      case "marker":
        return del(`/1/markers/${ds(b)}/${encodeURIComponent(c)}`);
      case "marker-setting":
        return del(`/1/marker_settings/${ds(b)}/${encodeURIComponent(c)}`);
      case "saved-query":
        return del(`/1/query_annotations/${ds(b)}/${encodeURIComponent(c)}`);
      case "recipient":
        await v1(
          this.ctx,
          await this.recipientKey(accountId),
          `/1/recipients/${encodeURIComponent(ext)}`,
          {
            method: "DELETE",
          },
        );
        return;
      case "api-key": {
        const team = await this.teamSlug();
        await v2(
          this.ctx,
          `/2/teams/${encodeURIComponent(team)}/api-keys/${encodeURIComponent(ext)}`,
          {
            method: "DELETE",
          },
        );
        return;
      }
      default:
        throw new Error(`Honeycomb plugin: "${typeId}" cannot be deleted from Infrawrench`);
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
    const ext = externalIdOf(resourceId);
    const [a = "", b = "", c = ""] = ext.split("/");
    if (typeId === "environment" && actionId === "connect") {
      const env = await this.env(accountId, ext);
      if (!env.id)
        throw new Error("Connect environment needs a management key with api-keys:write.");
      await this.connectEnvironment(accountId, env.slug, env.id);
      return;
    }
    if (typeId === "trigger" && (actionId === "enable" || actionId === "disable")) {
      await this.updateTrigger(accountId, a, b, c, (t) => {
        t.disabled = actionId === "disable";
      });
      return;
    }
    if (typeId === "signal" && (actionId === "enable" || actionId === "disable")) {
      const { key } = await this.keyFor(accountId, a);
      await v1(this.ctx, key, `/1/signals/${encodeURIComponent(b)}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: actionId === "enable" }),
      });
      return;
    }
    if (typeId === "api-key" && (actionId === "enable" || actionId === "disable")) {
      await this.patchApiKey(accountId, ext, { disabled: actionId === "disable" });
      return;
    }
    throw new Error(`Honeycomb plugin: unknown action "${actionId}" for "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderHoneycombDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderHoneycombSidebar(resource);
  }
}

/**
 * The PUT body for a trigger: everything read back except the read-only
 * fields. When the trigger references a stored query, only `query_id` goes
 * back (sending both is rejected), as the official Go client does.
 */
export function triggerBody(t: HnyTrigger): Record<string, unknown> {
  const {
    id: _id,
    dataset_slug: _ds,
    triggered: _tr,
    created_at: _c,
    updated_at: _u,
    query,
    query_id,
    recipients,
    ...rest
  } = t;
  return {
    ...rest,
    ...(query_id ? { query_id } : query ? { query: stripQueryId(query) } : {}),
    recipients: (recipients ?? []).map((r) => ({
      id: r.id,
      ...(r.details ? { details: r.details } : {}),
    })),
    tags: t.tags ?? [],
  };
}

function stripQueryId(q: HnyQuerySpec): HnyQuerySpec {
  const { id: _id, ...rest } = q;
  return rest;
}

/** Create/update body for a recipient of the given type. */
export function recipientBody(
  type: string,
  fields: Record<string, string>,
  current?: HnyRecipient,
): Record<string, unknown> {
  const target = (fields["target"] ?? "").trim();
  const url = (fields["url"] ?? "").trim();
  const secret = (fields["secret"] ?? "").trim();
  switch (type) {
    case "email":
      return { type, details: { email_address: target } };
    case "slack":
      return { type, details: { slack_channel: target } };
    case "pagerduty": {
      const integrationKey = secret || current?.details?.pagerduty_integration_key || "";
      if (!integrationKey) throw new Error("PagerDuty recipients need an integration key.");
      return {
        type,
        details: { pagerduty_integration_name: target, pagerduty_integration_key: integrationKey },
      };
    }
    case "webhook":
      return {
        type,
        details: {
          webhook_name: target,
          webhook_url: url,
          ...(secret ? { webhook_secret: secret } : {}),
          ...(current?.details?.webhook_headers
            ? { webhook_headers: current.details.webhook_headers }
            : {}),
          ...(current?.details?.webhook_payloads
            ? { webhook_payloads: current.details.webhook_payloads }
            : {}),
        },
      };
    case "msteams":
    case "msteams_workflow":
      return { type, details: { webhook_name: target, webhook_url: url } };
    default:
      throw new Error(`Unsupported recipient type "${type}"`);
  }
}

export { parseTags };
