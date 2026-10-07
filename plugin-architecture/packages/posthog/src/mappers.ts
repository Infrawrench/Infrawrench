import type { ResourceInstance } from "@infrawrench/plugin-base";

export const PLUGIN_ID = "posthog";

type FieldValue = string | number | boolean | undefined | null;
// PostHog objects are wide and mostly optional; mappers read them loosely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Obj = Record<string, any>;

export const LEVELS: Record<number, string> = { 1: "member", 8: "admin", 15: "owner" };
export const LEVEL_IDS: Record<string, number> = { member: 1, admin: 8, owner: 15 };

export function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, FieldValue>,
  outputs: Record<string, string | undefined> = {},
  parent?: { typeId: string; id: string },
): ResourceInstance {
  const now = new Date().toISOString();
  const clean: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && v !== "") clean[k] = v;
  }
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(outputs)) if (v) resolved[k] = v;
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields: clean,
    resolvedOutputs: resolved,
    secretStates: [],
    externalId,
    ...(parent ? { parentResourceId: `${accountId}:${parent.typeId}:${parent.id}` } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

const tags = (t: unknown): string | undefined =>
  Array.isArray(t) && t.length ? t.map(String).join(", ") : undefined;

/** `<projectId>/<id>` → `[projectId, id]`. */
export function splitScoped(externalId: string): [string, string] {
  const i = externalId.indexOf("/");
  return i < 0 ? ["", externalId] : [externalId.slice(0, i), externalId.slice(i + 1)];
}

/** The first release condition's rollout, which is what "rollout %" means for a simple flag. */
export function rolloutOf(filters: Obj | undefined): number | undefined {
  const g = (filters?.groups as Obj[] | undefined)?.[0];
  const r = g?.rollout_percentage;
  return typeof r === "number" ? r : g && r === null ? 100 : undefined;
}

export function mapProjectObject(
  accountId: string,
  typeId: string,
  projectId: string,
  x: Obj,
  ctx: { baseUrl: string; region: string },
): ResourceInstance {
  const id = String(x.id ?? "");
  const ext = `${projectId}/${id}`;
  const common = { projectId, region: ctx.region, createdAt: x.created_at as string | undefined };
  const parent = { typeId: "project", id: projectId };
  const app = `${ctx.baseUrl}/project/${projectId}`;
  switch (typeId) {
    case "feature-flag": {
      const filters = (x.filters ?? {}) as Obj;
      const variants = ((filters.multivariate?.variants as Obj[]) ?? []).map(
        (v) => `${v.key} ${v.rollout_percentage}%`,
      );
      return instance(
        accountId,
        typeId,
        ext,
        String(x.key ?? id),
        {
          name: x.name,
          active: x.active === true,
          rolloutPercentage: rolloutOf(filters),
          tags: tags(x.tags),
          key: x.key,
          variants: variants.join(", "),
          conditionCount: (filters.groups ?? []).length,
          status: x.status,
          lastCalledAt: x.last_called_at,
          filtersJson: JSON.stringify(filters),
          ...common,
        },
        { key: x.key },
        parent,
      );
    }
    case "experiment":
      return instance(
        accountId,
        typeId,
        ext,
        String(x.name ?? id),
        {
          name: x.name,
          description: x.description,
          status: x.status ?? (x.end_date ? "stopped" : x.start_date ? "running" : "draft"),
          featureFlagKey: x.feature_flag_key ?? x.feature_flag?.key,
          type: x.type,
          startDate: x.start_date,
          endDate: x.end_date,
          conclusion: x.conclusion,
          archived: x.archived === true,
          ...common,
        },
        {},
        parent,
      );
    case "cohort":
      return instance(
        accountId,
        typeId,
        ext,
        String(x.name ?? id),
        {
          name: x.name,
          description: x.description,
          count: x.count,
          isStatic: x.is_static === true,
          isCalculating: x.is_calculating === true,
          lastCalculation: x.last_calculation,
          filtersJson: x.filters ? JSON.stringify(x.filters) : undefined,
          ...common,
        },
        {},
        parent,
      );
    case "dashboard":
      return instance(
        accountId,
        typeId,
        ext,
        String(x.name ?? id),
        {
          name: x.name,
          description: x.description,
          pinned: x.pinned === true,
          tags: tags(x.tags),
          lastAccessedAt: x.last_accessed_at,
          ...common,
        },
        { url: `${app}/dashboard/${id}` },
        parent,
      );
    case "insight": {
      const dashboards = ((x.dashboards as unknown[]) ?? []).map((d) =>
        String(typeof d === "object" && d ? (d as Obj).id : d),
      );
      return instance(
        accountId,
        typeId,
        ext,
        String(x.name || x.derived_name || x.short_id || id),
        {
          name: x.name,
          description: x.description,
          kind: x.query?.source?.kind ?? x.query?.kind,
          shortId: x.short_id,
          dashboards: dashboards.join(", "),
          dashboardRefs: dashboards.map((d) => `${projectId}/${d}`).join(", "),
          lastRefresh: x.last_refresh,
          ...common,
        },
        { url: x.short_id ? `${app}/insights/${x.short_id}` : undefined },
        parent,
      );
    }
    case "action":
      return instance(
        accountId,
        typeId,
        ext,
        String(x.name ?? id),
        {
          name: x.name,
          description: x.description,
          stepCount: (x.steps ?? []).length,
          postToSlack: x.post_to_slack === true,
          stepsJson: x.steps ? JSON.stringify(x.steps) : undefined,
          ...common,
        },
        {},
        parent,
      );
    case "annotation":
      return instance(
        accountId,
        typeId,
        ext,
        String(x.content ?? id).slice(0, 80),
        {
          content: x.content,
          dateMarker: x.date_marker,
          scope: x.scope,
          creationType: x.creation_type,
          ...common,
        },
        {},
        parent,
      );
    case "hog-function":
      return instance(
        accountId,
        typeId,
        ext,
        String(x.name ?? id),
        {
          name: x.name,
          type: x.type,
          enabled: x.enabled === true,
          template: x.template?.name ?? x.template?.id,
          state: x.status?.state !== undefined ? String(x.status.state) : undefined,
          description: x.description,
          ...common,
        },
        {},
        parent,
      );
    case "batch-export": {
      const last = (x.latest_runs as Obj[] | undefined)?.[0];
      return instance(
        accountId,
        typeId,
        ext,
        String(x.name ?? id),
        {
          name: x.name,
          destination: x.destination?.type,
          model: x.model,
          interval: x.interval,
          paused: x.paused === true,
          lastRunStatus: last?.status,
          lastRunAt: last?.created_at ?? last?.data_interval_end,
          ...common,
        },
        {},
        parent,
      );
    }
    default:
      return instance(accountId, typeId, ext, String(x.name ?? id), { ...common }, {}, parent);
  }
}

export function mapProject(
  accountId: string,
  p: Obj,
  ctx: { baseUrl: string; region: string },
): ResourceInstance {
  const id = String(p.id ?? "");
  return instance(
    accountId,
    "project",
    id,
    String(p.name ?? id),
    {
      name: p.name,
      timezone: p.timezone,
      ingestedEvent: p.ingested_event === true,
      isDemo: p.is_demo === true,
      projectId: id,
      region: ctx.region,
    },
    { projectApiKey: p.api_token, apiHost: ctx.baseUrl, projectId: id },
  );
}

export function mapMember(accountId: string, m: Obj): ResourceInstance {
  const user = (m.user ?? {}) as Obj;
  const id = String(user.uuid ?? m.id ?? "");
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  return instance(accountId, "member", id, name || String(user.email ?? id), {
    level: LEVELS[Number(m.level)] ?? String(m.level ?? ""),
    email: user.email,
    name,
    twoFactor: m.is_2fa_enabled === true,
    lastLogin: m.last_login,
    joinedAt: m.joined_at,
  });
}
