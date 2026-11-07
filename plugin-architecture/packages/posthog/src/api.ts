import {
  createApiClient,
  pathEncode,
  restRequest,
  withCursorPagination,
  type ApiBody,
  type ApiClient,
  type ApiResponse,
  type HttpHostServices,
  type NextPage,
  type NoSlashString,
} from "@infrawrench/plugin-base";
import type { components, operations, paths } from "./api-types.gen.js";

/**
 * PostHog's private (management) API, verified against the OpenAPI schema
 * served at `https://us.posthog.com/api/schema/` (2026-10): personal API key
 * as `Authorization: Bearer phx_…`, every list a DRF page
 * (`{count, next, previous, results}` with `limit`/`offset`) but actions, which
 * answer `{count, results}` for the same parameters, project objects
 * under `/api/projects/{project_id}/…`, organization objects under
 * `/api/organizations/{organization_id}/…`.
 */
export const CLOUD_HOSTS: Record<string, string> = {
  us: "https://us.posthog.com",
  eu: "https://eu.posthog.com",
};

/** The document gives `limit` no maximum, so this stays the size the plugin has always asked for. */
const PAGE = 200;
/** 50,000 rows, which is as many as the host's sync can prune against. */
const MAX_PAGES = 250;

/**
 * `next` says whether to go on, where a page has one. The actions route has only
 * `count`, and a page with neither carries on until an empty one. Either way the
 * next page starts after the last row read, since a page can be shorter than asked.
 */
const nextOffset: NextPage = ({ body, items, cursor }) => {
  const page: { next?: string | null; count?: number } =
    typeof body === "object" && body !== null ? body : {};
  const offset = Number(cursor) + items.length;
  if (page.next !== undefined) return page.next ? offset : undefined;
  return page.count === undefined || offset < page.count ? offset : undefined;
};

const withOffsetPages = (client: ApiClient<paths>) =>
  withCursorPagination(client, {
    cursorParam: "offset",
    firstCursor: 0,
    sizeParam: "limit",
    pageSize: PAGE,
    maxPages: MAX_PAGES,
    next: nextOffset,
  });

export type PostHogApi = ReturnType<typeof withOffsetPages>;

interface PostHogConnection {
  baseUrl: string;
  /** `us`, `eu` or `self-hosted`; resources carry it as their `region`. */
  region: string;
  apiKey: string;
  caCert?: string;
  http?: HttpHostServices;
}

export interface PostHogContext extends PostHogConnection {
  api: PostHogApi;
}

export class PostHogApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PostHogApiError";
    this.status = status;
  }
}

/** Region picker value plus optional self-hosted URL → API base. */
export function resolveHost(region: string, host: string): { baseUrl: string; region: string } {
  const custom = host.trim().replace(/\/+$/, "");
  if (custom) {
    const url = /^https?:\/\//i.test(custom) ? custom : `https://${custom}`;
    let hostname = "";
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch {
      hostname = "";
    }
    // Cloud app and ingest hostnames all mean the cloud API host of that region.
    if (/^(us|app|us\.i)\.posthog\.com$/.test(hostname))
      return { baseUrl: CLOUD_HOSTS["us"]!, region: "us" };
    if (/^eu(\.i)?\.posthog\.com$/.test(hostname))
      return { baseUrl: CLOUD_HOSTS["eu"]!, region: "eu" };
    return { baseUrl: url, region: "self-hosted" };
  }
  const r = region.trim().toLowerCase();
  return CLOUD_HOSTS[r]
    ? { baseUrl: CLOUD_HOSTS[r]!, region: r }
    : { baseUrl: CLOUD_HOSTS["us"]!, region: "us" };
}

/** DRF errors are `{ type, code, detail, attr }`. */
function apiError(status: number, path: string, body: string): PostHogApiError {
  try {
    const parsed: { detail?: string; attr?: string } = JSON.parse(body);
    if (parsed.detail) {
      return new PostHogApiError(
        status,
        `PostHog API error ${status}: ${parsed.detail}${parsed.attr ? ` (${parsed.attr})` : ""}`,
      );
    }
  } catch {
    // keep raw
  }
  return new PostHogApiError(status, `PostHog API error ${status} for ${path}: ${body}`);
}

const headersFor = (connection: PostHogConnection) => ({
  Accept: "application/json",
  Authorization: `Bearer ${connection.apiKey}`,
});

export function createPostHogContext(connection: PostHogConnection): PostHogContext {
  return {
    ...connection,
    api: withOffsetPages(
      createApiClient<paths>({
        vendor: "PostHog",
        baseUrl: connection.baseUrl,
        headers: headersFor(connection),
        http: connection.http,
        caCert: connection.caCert,
        httpError: ({ status, path, body }) => apiError(status, path, body),
      }),
    ),
  };
}

export function statusOf(err: unknown): number {
  return err instanceof PostHogApiError ? err.status : 0;
}

/**
 * An external id with nothing after the project (`7/`) has always addressed the
 * list route, which is no operation in the document for most of these verbs. It
 * is not an id PostHog hands out, so this only keeps those requests as they were.
 */
export async function listRouteRequest<Result>(
  ctx: PostHogContext,
  method: string,
  route: string,
  projectId: string,
  options: { action?: string; body?: object } = {},
): Promise<Result> {
  const { action, body } = options;
  const path = `/api/projects/${pathEncode(projectId)}/${route}/${action ? `${action}/` : ""}`;
  const answer = await restRequest<Result>({
    vendor: "PostHog",
    url: `${ctx.baseUrl}${path}`,
    errorPath: path,
    headers: headersFor(ctx),
    init: { method, ...(body ? { body: JSON.stringify(body) } : {}) },
    httpError: (failure) => apiError(failure.status, path, failure.body),
    ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    ...(ctx.http ? { http: ctx.http } : {}),
  });
  return answer.body;
}

// ---------------------------------------------------------------------------
// The objects that live under a project
// ---------------------------------------------------------------------------

/**
 * What the mappers read. Nothing validates an answer, and a list row can be a
 * smaller schema than the object, so every field may turn out to be missing.
 * `deleted` is on most of these and is what a list filters by, whichever it is.
 */
type Loose<T> = Partial<T> & { deleted?: boolean | null };

type ListItem<Op> = ApiResponse<Op> extends { results: readonly (infer Item)[] } ? Item : never;

type RowOf<Get extends keyof operations, List extends keyof operations> = Loose<
  ApiResponse<operations[Get]> | ListItem<operations[List]>
>;

export interface ProjectObjects {
  "feature-flag": RowOf<"feature_flags_retrieve", "feature_flags_list">;
  experiment: RowOf<"experiments_retrieve", "experiments_list">;
  cohort: RowOf<"cohorts_retrieve", "cohorts_list">;
  dashboard: RowOf<"dashboards_retrieve", "dashboards_list">;
  insight: RowOf<"insights_retrieve", "insights_list">;
  action: RowOf<"actions_retrieve", "actions_list">;
  annotation: RowOf<"annotations_retrieve", "annotations_list">;
  "hog-function": RowOf<"hog_functions_retrieve", "hog_functions_list">;
  "batch-export": RowOf<"batch_exports_retrieve", "batch_exports_list">;
}

export type ProjectObjectType = keyof ProjectObjects;

interface ObjectRoutes<Row> {
  route: string;
  list(api: PostHogApi, project: NoSlashString): Promise<readonly Row[]>;
  get(api: PostHogApi, project: NoSlashString, id: NoSlashString): Promise<Row>;
}

export const OBJECTS: { [T in ProjectObjectType]: ObjectRoutes<ProjectObjects[T]> } = {
  "feature-flag": {
    route: "feature_flags",
    list: (api, p) => api.getAll(`/api/projects/${p}/feature_flags/`, "results"),
    get: (api, p, id) => api.get(`/api/projects/${p}/feature_flags/${id}/`),
  },
  experiment: {
    route: "experiments",
    list: (api, p) => api.getAll(`/api/projects/${p}/experiments/`, "results"),
    get: (api, p, id) => api.get(`/api/projects/${p}/experiments/${id}/`),
  },
  cohort: {
    route: "cohorts",
    list: (api, p) => api.getAll(`/api/projects/${p}/cohorts/`, "results"),
    get: (api, p, id) => api.get(`/api/projects/${p}/cohorts/${id}/`),
  },
  dashboard: {
    route: "dashboards",
    list: (api, p) => api.getAll(`/api/projects/${p}/dashboards/`, "results"),
    get: (api, p, id) => api.get(`/api/projects/${p}/dashboards/${id}/`),
  },
  insight: {
    route: "insights",
    list: (api, p) => api.getAll(`/api/projects/${p}/insights/`, "results"),
    get: (api, p, id) => api.get(`/api/projects/${p}/insights/${id}/`),
  },
  action: {
    route: "actions",
    list: (api, p) => api.getAll(`/api/projects/${p}/actions/`, "results"),
    get: (api, p, id) => api.get(`/api/projects/${p}/actions/${id}/`),
  },
  annotation: {
    route: "annotations",
    list: (api, p) => api.getAll(`/api/projects/${p}/annotations/`, "results"),
    get: (api, p, id) => api.get(`/api/projects/${p}/annotations/${id}/`),
  },
  "hog-function": {
    route: "hog_functions",
    list: (api, p) => api.getAll(`/api/projects/${p}/hog_functions/`, "results"),
    get: (api, p, id) => api.get(`/api/projects/${p}/hog_functions/${id}/`),
  },
  "batch-export": {
    route: "batch_exports",
    list: (api, p) => api.getAll(`/api/projects/${p}/batch_exports/`, "results"),
    get: (api, p, id) => api.get(`/api/projects/${p}/batch_exports/${id}/`),
  },
};

export function isProjectObjectType(typeId: string): typeId is ProjectObjectType {
  return Object.hasOwn(OBJECTS, typeId);
}

/** Batch exports are the one type with a real DELETE; everything else is soft deleted by PATCH. */
export interface ObjectPatches {
  "feature-flag": ApiBody<operations["feature_flags_partial_update"]>;
  experiment: ApiBody<operations["experiments_partial_update"]>;
  cohort: ApiBody<operations["cohorts_partial_update"]>;
  dashboard: ApiBody<operations["dashboards_partial_update"]>;
  insight: ApiBody<operations["insights_partial_update"]>;
  action: ApiBody<operations["actions_partial_update"]>;
  annotation: ApiBody<operations["annotations_partial_update"]>;
  "hog-function": ApiBody<operations["hog_functions_partial_update"]>;
}

export type SoftDeletedType = keyof ObjectPatches;

export const PATCHES: {
  [T in SoftDeletedType]: (
    api: PostHogApi,
    project: NoSlashString,
    id: NoSlashString,
    body: ObjectPatches[T],
  ) => Promise<object | undefined>;
} = {
  "feature-flag": (api, p, id, body) =>
    api.patch(`/api/projects/${p}/feature_flags/${id}/`, { body }),
  experiment: (api, p, id, body) => api.patch(`/api/projects/${p}/experiments/${id}/`, { body }),
  cohort: (api, p, id, body) => api.patch(`/api/projects/${p}/cohorts/${id}/`, { body }),
  dashboard: (api, p, id, body) => api.patch(`/api/projects/${p}/dashboards/${id}/`, { body }),
  insight: (api, p, id, body) => api.patch(`/api/projects/${p}/insights/${id}/`, { body }),
  action: (api, p, id, body) => api.patch(`/api/projects/${p}/actions/${id}/`, { body }),
  annotation: (api, p, id, body) => api.patch(`/api/projects/${p}/annotations/${id}/`, { body }),
  "hog-function": (api, p, id, body) =>
    api.patch(`/api/projects/${p}/hog_functions/${id}/`, { body }),
};

export type FlagFilters = components["schemas"]["FeatureFlagFiltersSchema"];
export type ProjectRow = Partial<
  | ApiResponse<operations["organizations_projects_retrieve"]>
  | ListItem<operations["organizations_projects_list"]>
>;
export type MemberRow = Partial<ListItem<operations["members_list"]>>;
export type SpendPoint = ListItem<operations["billing_spend_retrieve"]>;
export type SpendQuery = NonNullable<operations["billing_spend_retrieve"]["parameters"]["query"]>;
