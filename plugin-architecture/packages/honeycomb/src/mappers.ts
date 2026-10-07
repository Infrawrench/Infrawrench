import type { ResourceInstance } from "@infrawrench/plugin-base";
import { ALL_DATASETS } from "./resource-types.js";
import type {
  HnyApiKeyAttrs,
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
  HnyNotificationRecipient,
  HnyQueryAnnotation,
  HnyQuerySpec,
  HnyRecipient,
  HnySignal,
  HnySlo,
  HnyTag,
  HnyTrigger,
} from "./types.js";

export const PLUGIN_ID = "honeycomb";

export function resourceIdFor(accountId: string, typeId: string, externalId: string): string {
  return `${accountId}:${typeId}:${externalId}`;
}

type Fields = Record<string, string | number | boolean>;

/** Drop undefined/null so `fields` only carries what the API returned. */
function clean(fields: Record<string, string | number | boolean | null | undefined>): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, string | number | boolean | null | undefined>,
  extra: { parentResourceId?: string; resolvedOutputs?: Record<string, string> } = {},
): ResourceInstance {
  const now = new Date().toISOString();
  return {
    id: resourceIdFor(accountId, typeId, externalId),
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields: clean(fields),
    resolvedOutputs: extra.resolvedOutputs ?? {},
    secretStates: [],
    externalId,
    ...(extra.parentResourceId ? { parentResourceId: extra.parentResourceId } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

/** Where an environment-scoped object lives, carried into every mapper. */
export interface EnvScope {
  slug: string;
  region: string;
  /** Team slug, for building UI links. */
  team?: string;
  uiUrl?: string;
}

/** The `dataset` field value: blank for environment-wide objects. */
export function datasetField(dataset: string): string {
  return dataset === ALL_DATASETS ? "" : dataset;
}

/** Split `env/dataset/id` (or `env/id`) external ids. */
export function splitExternalId(externalId: string): string[] {
  return externalId.split("/");
}

export function tagsText(tags: HnyTag[] | undefined): string {
  return (tags ?? [])
    .filter((t) => t.key)
    .map((t) => `${t.key}:${t.value ?? ""}`)
    .join(", ");
}

/** Parse `key:value, key2:value2` back into Honeycomb tags. */
export function parseTags(text: string): HnyTag[] {
  return text
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => {
      const i = t.indexOf(":");
      return i > 0
        ? { key: t.slice(0, i).trim(), value: t.slice(i + 1).trim() }
        : { key: t, value: "" };
    });
}

function recipientLabel(r: HnyNotificationRecipient): string {
  return r.target ? `${r.type ?? "recipient"}: ${r.target}` : (r.type ?? r.id ?? "");
}

function epochToIso(seconds: number | undefined | null): string | undefined {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}

function teamUrl(env: EnvScope, path = ""): string | undefined {
  if (!env.uiUrl || !env.team) return undefined;
  return `${env.uiUrl}/${encodeURIComponent(env.team)}/environments/${encodeURIComponent(env.slug)}${path}`;
}

/** One-line rendering of a query spec, for display only. */
export function describeQuery(q: HnyQuerySpec | undefined): string {
  if (!q) return "";
  const calcs = (q.calculations ?? [])
    .map((c) => (c.column ? `${c.op ?? "COUNT"}(${c.column})` : (c.op ?? "COUNT")))
    .join(", ");
  const filters = (q.filters ?? [])
    .map((f) => {
      const value =
        f.value === undefined || f.value === null
          ? ""
          : ` ${Array.isArray(f.value) ? f.value.join(",") : String(f.value)}`;
      return `${f.column ?? ""} ${f.op ?? ""}${value}`.trim();
    })
    .join(` ${q.filter_combination ?? "AND"} `);
  const parts = [calcs || "COUNT"];
  if (filters) parts.push(`WHERE ${filters}`);
  if (q.breakdowns?.length) parts.push(`GROUP BY ${q.breakdowns.join(", ")}`);
  if (q.time_range) parts.push(`over ${Math.round(q.time_range / 60)}m`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------

export function mapEnvironment(
  accountId: string,
  env: {
    slug: string;
    id?: string;
    attrs?: HnyEnvironmentAttrs;
    name?: string;
    team?: string;
    region: string;
    uiUrl?: string;
    connected: boolean;
  },
): ResourceInstance {
  const a = env.attrs ?? {};
  const url = teamUrl({
    slug: env.slug,
    region: env.region,
    ...(env.team ? { team: env.team } : {}),
    ...(env.uiUrl ? { uiUrl: env.uiUrl } : {}),
  });
  return instance(
    accountId,
    "environment",
    env.slug,
    a.name ?? env.name ?? env.slug,
    {
      name: a.name ?? env.name ?? env.slug,
      description: a.description,
      color: a.color,
      deleteProtected: a.settings?.delete_protected,
      slug: env.slug,
      environmentId: env.id,
      connected: env.connected,
      team: env.team,
      region: env.region,
    },
    {
      resolvedOutputs: {
        slug: env.slug,
        ...(env.id ? { environmentId: env.id } : {}),
        ...(url ? { url } : {}),
      },
    },
  );
}

/** Dataset definition keys, as fields on the dataset (`def_<key>`). */
export const DEFINITION_KEYS = [
  "trace_id",
  "span_id",
  "parent_id",
  "name",
  "service_name",
  "duration_ms",
  "error",
  "status",
  "route",
  "user",
  "span_kind",
  "annotation_type",
  "link_trace_id",
  "link_span_id",
  "log_message",
  "log_severity",
] as const;

export function mapDataset(
  accountId: string,
  env: EnvScope,
  d: HnyDataset,
  definitions?: HnyDatasetDefinitions,
): ResourceInstance {
  const slug = d.slug ?? d.name ?? "";
  const defs: Record<string, string> = {};
  for (const key of DEFINITION_KEYS) {
    const name = definitions?.[key]?.name;
    if (name) defs[`def_${key}`] = name;
  }
  const url = teamUrl(env, `/datasets/${encodeURIComponent(slug)}`);
  return instance(
    accountId,
    "dataset",
    `${env.slug}/${slug}`,
    d.name ?? slug,
    {
      name: d.name ?? slug,
      description: d.description ?? "",
      expandJsonDepth: d.expand_json_depth,
      deleteProtected: d.settings?.delete_protected,
      ...defs,
      slug,
      datasetType: d.dataset_type ?? "events",
      columnCount: d.regular_columns_count ?? undefined,
      lastWrittenAt: d.last_written_at ?? undefined,
      createdAt: d.created_at,
      environment: env.slug,
      region: env.region,
    },
    {
      parentResourceId: resourceIdFor(accountId, "environment", env.slug),
      resolvedOutputs: { slug, ...(url ? { url } : {}) },
    },
  );
}

export function mapColumn(
  accountId: string,
  env: EnvScope,
  dataset: string,
  c: HnyColumn,
): ResourceInstance {
  return instance(
    accountId,
    "column",
    `${env.slug}/${dataset}/${c.id ?? c.key_name ?? ""}`,
    c.key_name ?? c.id ?? "",
    {
      keyName: c.key_name,
      type: c.type,
      description: c.description ?? "",
      hidden: c.hidden ?? false,
      lastWrittenAt: c.last_written,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      dataset,
      environment: env.slug,
    },
    {
      parentResourceId: resourceIdFor(accountId, "dataset", `${env.slug}/${dataset}`),
      resolvedOutputs: c.key_name ? { keyName: c.key_name } : {},
    },
  );
}

export function mapDerivedColumn(
  accountId: string,
  env: EnvScope,
  dataset: string,
  c: HnyDerivedColumn,
): ResourceInstance {
  return instance(
    accountId,
    "derived-column",
    `${env.slug}/${dataset}/${c.id ?? ""}`,
    c.alias ?? c.id ?? "",
    {
      alias: c.alias,
      expression: c.expression,
      description: c.description ?? "",
      dataset: datasetField(dataset),
      environment: env.slug,
    },
    {
      parentResourceId: resourceIdFor(accountId, "environment", env.slug),
      resolvedOutputs: c.alias ? { alias: c.alias } : {},
    },
  );
}

export function mapTrigger(
  accountId: string,
  env: EnvScope,
  dataset: string,
  t: HnyTrigger,
): ResourceInstance {
  const recipients = t.recipients ?? [];
  return instance(
    accountId,
    "trigger",
    `${env.slug}/${dataset}/${t.id ?? ""}`,
    t.name ?? t.id ?? "",
    {
      name: t.name,
      description: t.description ?? "",
      thresholdOp: t.threshold?.op,
      thresholdValue: t.threshold?.value,
      exceededLimit: t.threshold?.exceeded_limit,
      frequency: t.frequency,
      alertType: t.alert_type,
      disabled: t.disabled ?? false,
      triggered: t.triggered ?? false,
      query: describeQuery(t.query),
      queryId: t.query_id ?? t.query?.id,
      recipients: recipients.map(recipientLabel).join(", "),
      recipientIds: recipients
        .map((r) => r.id)
        .filter(Boolean)
        .join(", "),
      tags: tagsText(t.tags),
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      dataset: datasetField(t.dataset_slug ?? dataset),
      environment: env.slug,
      region: env.region,
    },
    {
      parentResourceId: resourceIdFor(accountId, "environment", env.slug),
      resolvedOutputs: t.id ? { triggerId: t.id } : {},
    },
  );
}

/** The dataset path an SLO's routes take: its one dataset, or `__all__`. */
export function sloDatasetPath(s: HnySlo, fallback: string): string {
  const slugs = s.dataset_slugs ?? [];
  if (slugs.length === 1 && slugs[0]) return slugs[0];
  if (slugs.length > 1) return ALL_DATASETS;
  return fallback;
}

export function mapSlo(
  accountId: string,
  env: EnvScope,
  dataset: string,
  s: HnySlo,
): ResourceInstance {
  const path = sloDatasetPath(s, dataset);
  return instance(
    accountId,
    "slo",
    `${env.slug}/${path}/${s.id ?? ""}`,
    s.name ?? s.id ?? "",
    {
      name: s.name,
      description: s.description ?? "",
      targetPercent:
        typeof s.target_per_million === "number" ? s.target_per_million / 10_000 : undefined,
      timePeriodDays: s.time_period_days,
      sli: s.sli?.alias,
      datasets: (s.dataset_slugs ?? []).join(", "),
      status: s.status,
      compliance: s.compliance,
      budgetRemaining: s.budget_remaining,
      tags: tagsText(s.tags),
      createdAt: s.created_at,
      dataset: datasetField(path),
      environment: env.slug,
      region: env.region,
    },
    {
      parentResourceId: resourceIdFor(accountId, "environment", env.slug),
      resolvedOutputs: s.id ? { sloId: s.id } : {},
    },
  );
}

export function mapBurnAlert(
  accountId: string,
  env: EnvScope,
  dataset: string,
  sloId: string,
  b: HnyBurnAlert,
): ResourceInstance {
  const recipients = b.recipients ?? [];
  const kind = b.alert_type === "budget_rate" ? "Budget rate" : "Exhaustion time";
  const detail =
    b.alert_type === "budget_rate"
      ? `${(b.budget_rate_decrease_threshold_per_million ?? 0) / 10_000}% in ${b.budget_rate_window_minutes ?? "?"}m`
      : `${b.exhaustion_minutes ?? "?"}m to exhaustion`;
  return instance(
    accountId,
    "burn-alert",
    `${env.slug}/${dataset}/${b.id ?? ""}`,
    `${kind}: ${detail}`,
    {
      alertType: b.alert_type,
      exhaustionMinutes: b.exhaustion_minutes,
      budgetRateWindowMinutes: b.budget_rate_window_minutes,
      budgetRateDecreasePercent:
        typeof b.budget_rate_decrease_threshold_per_million === "number"
          ? b.budget_rate_decrease_threshold_per_million / 10_000
          : undefined,
      description: b.description ?? "",
      triggered: b.triggered ?? false,
      recipients: recipients.map(recipientLabel).join(", "),
      recipientIds: recipients
        .map((r) => r.id)
        .filter(Boolean)
        .join(", "),
      sloId: b.slo?.id ?? sloId,
      createdAt: b.created_at,
      dataset: datasetField(dataset),
      environment: env.slug,
    },
    {
      parentResourceId: resourceIdFor(accountId, "slo", `${env.slug}/${dataset}/${sloId}`),
      resolvedOutputs: b.id ? { burnAlertId: b.id } : {},
    },
  );
}

export function mapBoard(accountId: string, env: EnvScope, b: HnyBoard): ResourceInstance {
  const url = b.links?.board_url;
  return instance(
    accountId,
    "board",
    `${env.slug}/${b.id ?? ""}`,
    b.name ?? b.id ?? "",
    {
      name: b.name,
      description: b.description ?? "",
      type: b.type,
      panelCount: b.panels?.length ?? 0,
      tags: tagsText(b.tags),
      url,
      environment: env.slug,
    },
    {
      parentResourceId: resourceIdFor(accountId, "environment", env.slug),
      resolvedOutputs: { ...(b.id ? { boardId: b.id } : {}), ...(url ? { url } : {}) },
    },
  );
}

export function filtersText(
  filters:
    Array<{ column?: string | null; operation?: string; op?: string; value?: unknown }> | undefined,
): string {
  return (filters ?? [])
    .map((f) => {
      const op = f.operation ?? f.op ?? "";
      const value =
        f.value === undefined || f.value === null
          ? ""
          : ` ${Array.isArray(f.value) ? f.value.join(",") : String(f.value)}`;
      return `${f.column ?? ""} ${op}${value}`.trim();
    })
    .join("; ");
}

export function mapBoardView(
  accountId: string,
  env: EnvScope,
  boardId: string,
  v: HnyBoardView,
): ResourceInstance {
  return instance(
    accountId,
    "board-view",
    `${env.slug}/${boardId}/${v.id ?? ""}`,
    v.name ?? v.id ?? "",
    { name: v.name, filters: filtersText(v.filters), boardId, environment: env.slug },
    {
      parentResourceId: resourceIdFor(accountId, "board", `${env.slug}/${boardId}`),
      resolvedOutputs: v.id ? { viewId: v.id } : {},
    },
  );
}

export function mapMarker(
  accountId: string,
  env: EnvScope,
  dataset: string,
  m: HnyMarker,
): ResourceInstance {
  const start = epochToIso(m.start_time);
  const label = m.message || m.type || "Marker";
  return instance(
    accountId,
    "marker",
    `${env.slug}/${dataset}/${m.id ?? ""}`,
    start ? `${label} (${start.slice(0, 16).replace("T", " ")})` : label,
    {
      message: m.message ?? "",
      type: m.type ?? "",
      url: m.url ?? "",
      startTime: start,
      endTime: epochToIso(m.end_time),
      color: m.color,
      dataset: datasetField(dataset),
      environment: env.slug,
    },
    {
      parentResourceId: resourceIdFor(accountId, "environment", env.slug),
      resolvedOutputs: m.id ? { markerId: m.id } : {},
    },
  );
}

export function mapMarkerSetting(
  accountId: string,
  env: EnvScope,
  dataset: string,
  m: HnyMarkerSetting,
): ResourceInstance {
  return instance(
    accountId,
    "marker-setting",
    `${env.slug}/${dataset}/${m.id ?? ""}`,
    `${m.type ?? "marker"} (${datasetField(dataset) || "all datasets"})`,
    { type: m.type, color: m.color, dataset: datasetField(dataset), environment: env.slug },
    { parentResourceId: resourceIdFor(accountId, "environment", env.slug) },
  );
}

export function mapSavedQuery(
  accountId: string,
  env: EnvScope,
  dataset: string,
  a: HnyQueryAnnotation,
  spec?: HnyQuerySpec,
): ResourceInstance {
  return instance(
    accountId,
    "saved-query",
    `${env.slug}/${dataset}/${a.id ?? ""}`,
    a.name ?? a.id ?? "",
    {
      name: a.name,
      description: a.description ?? "",
      query: spec ? describeQuery(spec) : undefined,
      queryId: a.query_id,
      source: a.source,
      createdAt: a.created_at,
      dataset: datasetField(dataset),
      environment: env.slug,
    },
    {
      parentResourceId: resourceIdFor(accountId, "environment", env.slug),
      resolvedOutputs: a.query_id ? { queryId: a.query_id } : {},
    },
  );
}

/** The human-facing target of a recipient, whatever its type. */
export function recipientTarget(r: HnyRecipient): string {
  const d = r.details ?? {};
  return d.email_address ?? d.slack_channel ?? d.pagerduty_integration_name ?? d.webhook_name ?? "";
}

export function mapRecipient(
  accountId: string,
  r: HnyRecipient,
  triggerCount?: number,
): ResourceInstance {
  const target = recipientTarget(r);
  return instance(
    accountId,
    "recipient",
    r.id ?? "",
    target ? `${target} (${r.type ?? "recipient"})` : (r.id ?? ""),
    {
      type: r.type,
      target,
      url: r.details?.webhook_url ?? "",
      triggerCount,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    },
    { resolvedOutputs: r.id ? { recipientId: r.id } : {} },
  );
}

export function mapSignal(accountId: string, env: EnvScope, s: HnySignal): ResourceInstance {
  const watches = s.measured_signal === "presence" ? "Presence" : "Error rate";
  return instance(
    accountId,
    "signal",
    `${env.slug}/${s.id ?? ""}`,
    `${s.service_name ?? "service"}: ${watches}`,
    {
      serviceName: s.service_name,
      measuredSignal: s.measured_signal,
      sensitivity: s.sensitivity ?? undefined,
      enabled: s.enabled ?? false,
      status: s.status,
      currentlyAnomalous: s.currently_anomalous ?? false,
      lastAnomalyAt: epochToIso(s.last_anomaly_started_at),
      dataset: s.dataset_slug,
      environment: env.slug,
    },
    { parentResourceId: resourceIdFor(accountId, "environment", env.slug) },
  );
}

/** Permission names as Honeycomb's UI words them. */
const PERMISSION_LABELS: Record<string, string> = {
  send_events: "Send events",
  create_datasets: "Create datasets",
  manage_markers: "Manage markers",
  manage_triggers: "Manage triggers",
  manage_boards: "Manage public boards",
  manage_privateBoards: "Manage private boards",
  run_queries: "Run queries",
  manage_columns: "Manage queries and columns",
  manage_slos: "Manage SLOs",
  manage_recipients: "Manage recipients",
  manage_signals: "Manage signals",
  read_service_maps: "Read service maps",
  visible_team_members: "Visible to team members",
};

export function permissionsText(p: Record<string, boolean | undefined> | undefined): string {
  return Object.entries(p ?? {})
    .filter(([, v]) => v === true)
    .map(([k]) => PERMISSION_LABELS[k] ?? k)
    .join(", ");
}

export function mapApiKey(
  accountId: string,
  k: { id: string; attributes?: HnyApiKeyAttrs; environmentId?: string },
  envSlugById: Map<string, string>,
): ResourceInstance {
  const a = k.attributes ?? {};
  const envSlug = k.environmentId ? envSlugById.get(k.environmentId) : undefined;
  return instance(
    accountId,
    "api-key",
    k.id,
    a.name ?? k.id,
    {
      name: a.name,
      keyType: a.key_type,
      disabled: a.disabled ?? false,
      permissions: permissionsText(a.permissions),
      environmentId: k.environmentId,
      environment: envSlug,
      createdAt: a.timestamps?.created,
      updatedAt: a.timestamps?.updated,
    },
    { resolvedOutputs: { keyId: k.id } },
  );
}
