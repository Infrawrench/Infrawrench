import {
  createApiClient,
  ListPageError,
  ListTruncatedError,
  requireListPage,
  type ApiBody,
  type ApiClient,
  type ApiClientOptions,
  type ApiListItem,
  type ApiResponse,
  type HttpHostServices,
} from "@infrawrench/plugin-base";
import type {
  operations as deploymentOperations,
  paths as deploymentPaths,
} from "./api-types.deployment.gen.js";
import type {
  operations as managementOperations,
  paths as managementPaths,
} from "./api-types.management.gen.js";

/**
 * Convex has two HTTP APIs, both verified against their OpenAPI documents
 * (2026-10), which `plugingen.json` generates the types from:
 *
 * - The **Management API** at `https://api.convex.dev/v1`
 *   (`/v1/openapi.json`): teams, projects, deployments, deploy keys, custom
 *   domains, members, invites, custom roles, access tokens, default
 *   environment variables. `Authorization: Bearer <token>`.
 * - The **Deployment API** on every deployment at `{deploymentUrl}/api/v1`
 *   (`@convex-dev/platform/deployment-openapi.json` in convex-backend):
 *   environment variables, pause/unpause, log streams, usage limits, current
 *   usage, canonical URLs, audit log. `Authorization: Convex <token>`, where
 *   a team access token works as well as a deploy key.
 *
 * Writes on both are `POST /…/verb_noun` RPC-style calls rather than REST
 * verbs, except `PATCH /projects/{id}` and `PATCH /deployments/{name}`.
 */
export const CONVEX_API = "https://api.convex.dev/v1";

export type ManagementApi = ApiClient<managementPaths>;
export type DeploymentApi = ApiClient<deploymentPaths>;

/** A Management API operation's response, by its `operationId`. */
type ManagementResponse<Op extends keyof managementOperations> = ApiResponse<
  managementOperations[Op]
>;
/** A Deployment API operation's response, by its `operationId`. */
type DeploymentResponse<Op extends keyof deploymentOperations> = ApiResponse<
  deploymentOperations[Op]
>;

export type UpdateDeploymentBody = ApiBody<managementOperations["update deployment"]>;
export type UpdateProjectBody = ApiBody<managementOperations["update project"]>;
export type UpdateLogStreamBody = ApiBody<deploymentOperations["update_log_stream"]>;
export type CreateLogStreamBody = ApiBody<deploymentOperations["create_log_stream"]>;
export type UsageLimitBody = ApiBody<deploymentOperations["create_usage_limit"]>;

export interface ConvexContext {
  token: string;
  http?: HttpHostServices;
  caCert?: string;
  /** Overridable for tests; production always uses {@link CONVEX_API}. */
  baseUrl?: string;
}

/** Thrown for any non-2xx answer, carrying the status the poller classifies on. */
export class ConvexApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, message: string, code = "") {
    super(message);
    this.name = "ConvexApiError";
    this.status = status;
    this.code = code;
  }
}

export function statusOf(err: unknown): number {
  return err instanceof ConvexApiError ? err.status : 0;
}

/** Convex errors are `{code, message}`. */
export function toError(status: number, label: string, raw: string): ConvexApiError {
  let code = "";
  let message = "";
  try {
    const parsed: { code?: string; message?: string } = JSON.parse(raw);
    code = typeof parsed.code === "string" ? parsed.code : "";
    message = typeof parsed.message === "string" ? parsed.message : "";
  } catch {
    message = raw.slice(0, 300);
  }
  if (status === 401) {
    return new ConvexApiError(
      401,
      "Convex API error 401: the access token was rejected. Create a new team access token under Team Settings > Access Tokens and update the account.",
      code,
    );
  }
  return new ConvexApiError(
    status,
    `Convex API error ${status} for ${label}${code ? ` (${code})` : ""}${message ? `: ${message}` : ""}`,
    code,
  );
}

/** A 2xx that is not JSON reaches the caller as its text, rather than failing on the parse. */
function jsonOrText(text: string): string {
  try {
    JSON.parse(text);
    return text;
  } catch {
    return JSON.stringify(text);
  }
}

/** The host service when there is one, otherwise `fetch`, which has no way to use a custom CA. */
function transport(ctx: ConvexContext): HttpHostServices {
  return {
    async request(req) {
      const res = ctx.http
        ? await ctx.http.request(req)
        : await fetch(req.url, {
            method: req.method,
            headers: req.headers,
            ...(typeof req.body === "string" ? { body: req.body } : {}),
          }).then(async (answer) => ({
            status: answer.status,
            headers: {},
            body: await answer.text(),
          }));
      return res.body && res.status >= 200 && res.status < 300
        ? { ...res, body: jsonOrText(res.body) }
        : res;
    },
  };
}

function shared(ctx: ConvexContext): Omit<ApiClientOptions, "baseUrl" | "headers"> {
  return {
    vendor: "Convex",
    http: transport(ctx),
    caCert: ctx.caCert,
    contentType: "with-body",
    httpError: ({ status, path, body }) => toError(status, path, body),
  };
}

/** The Management API. */
export function managementApi(ctx: ConvexContext): ManagementApi {
  return createApiClient<managementPaths>({
    ...shared(ctx),
    baseUrl: ctx.baseUrl ?? CONVEX_API,
    headers: { Authorization: `Bearer ${ctx.token}`, Accept: "application/json" },
  });
}

/** The Deployment API, on one deployment's own URL. */
export function deploymentApi(ctx: ConvexContext, deploymentUrl: string): DeploymentApi {
  return createApiClient<deploymentPaths>({
    ...shared(ctx),
    baseUrl: `${deploymentUrl.replace(/\/+$/, "")}/api/v1`,
    headers: { Authorization: `Convex ${ctx.token}`, Accept: "application/json" },
  });
}

/** What {@link paged} adds to each request. */
export interface Paging {
  limit: number;
  cursor?: string;
}

interface Page<T> {
  items?: readonly T[] | null;
  pagination?: { hasMore?: boolean; nextCursor?: string | null } | null;
}

/** 50,000 rows at the document's largest page of 100: the most the host can prune. */
const MAX_PAGES = 500;

/**
 * Drain a `{items, pagination: {hasMore, nextCursor}}` listing, asking for each
 * page through `fetchPage`, which puts `paging` in the query:
 *
 *   paged("/teams/{team_id}/projects", (query) => api.get(`/teams/${team}/projects`, { query }));
 *
 * A loop rather than `withCursorPagination`, whose typed `getAll` does not take
 * `list_members` and `list_pending_invites`: their documented answers have no
 * `pagination`. Throws on a page with no list and at the cap, since a sync prunes
 * whatever a list leaves out.
 */
export async function paged<T>(
  route: string,
  fetchPage: (paging: Paging) => Promise<Page<T> | undefined>,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    // `String`: a cursor that is not the string the document promises still goes as text.
    const res = await fetchPage({ limit: 100, ...(cursor ? { cursor: String(cursor) } : {}) });
    out.push(...rowsOf(res?.items, route, "items", res));
    cursor = res?.pagination?.nextCursor ?? undefined;
    if (!res?.pagination?.hasMore || !cursor) return out;
  }
  throw new ListTruncatedError({
    vendor: "Convex",
    path: route,
    items: out.length,
    maxPages: MAX_PAGES,
  });
}

/** The rows of a list read in one request; `key` is null where the answer is the array. */
export function rowsOf<T>(
  list: readonly T[] | null | undefined,
  route: string,
  key: string | null,
  page?: unknown,
): T[] {
  return requireListPage(list, { vendor: "Convex", path: route, key, page });
}

/** A deployment's variables, a map rather than a list, held to the same standard. */
export function environmentVariablesOf(
  res: { environmentVariables?: Record<string, string> | null } | undefined,
): Record<string, string> {
  const vars = res?.environmentVariables;
  if (vars === null) return {};
  if (typeof vars !== "object" || Array.isArray(vars)) {
    throw new ListPageError({
      vendor: "Convex",
      path: "/list_environment_variables",
      key: "environmentVariables",
      found: vars,
      page: res,
    });
  }
  return vars;
}

// ---- wire shapes ---------------------------------------------------------------

type RawDeployment = ManagementResponse<"platform_get_deployment">;
type CloudDeployment = Extract<RawDeployment, { kind: "cloud" }>;

/**
 * Either kind of deployment. A local one has none of the cloud fields, which is
 * how the mappers read it, so they can take both without asking which it is.
 */
export type CvDeployment =
  | CloudDeployment
  | (Extract<RawDeployment, { kind: "local" }> &
      Partial<
        Pick<
          CloudDeployment,
          | "lastDeployTime"
          | "region"
          | "isDefault"
          | "reference"
          | "dashboardEditConfirmation"
          | "deploymentUrl"
          | "expiresAt"
          | "class"
          | "sendLogsToClient"
        >
      >);

export type CvProject = ManagementResponse<"get project by id">;
export type CvDeployKey = ApiListItem<managementOperations["list deploy keys"], null>;
export type CvCustomDomain = ApiListItem<managementOperations["list custom domains"], "domains">;
export type CvUsageLimit = ApiListItem<deploymentOperations["list_usage_limits"], "usageLimits">;
export type CvUsage = DeploymentResponse<"get_current_usage">;

/** A log stream of any type, with the fields only some types have readable on all of them. */
export type CvLogStream = DeploymentResponse<"get_log_stream"> & {
  url?: string;
  hmacSecret?: string;
  format?: string;
  service?: string | null;
  datasetName?: string;
  siteLocation?: string;
  bucket?: string;
  prefix?: string | null;
  host?: string | null;
  topics?: string[] | null;
};

/** What creating a log stream answers; only a webhook has a secret. */
export type CvCreatedLogStream = DeploymentResponse<"create_log_stream"> & { hmacSecret?: string };
