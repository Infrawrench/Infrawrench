import {
  createApiClient,
  restRequest,
  withCursorPagination,
  type ApiResponse,
  type HttpHostServices,
  type NextPage,
} from "@infrawrench/plugin-base";
import type { operations, paths } from "./api-types.gen.js";

/**
 * GitLab REST API v4 (https://docs.gitlab.com/api/rest/, verified against
 * `doc/api/*.md` on gitlab-org/gitlab master, 2026-10), typed from
 * `doc/api/openapi/openapi_v3.yaml`.
 *
 * - Auth: `PRIVATE-TOKEN: <token>` works for personal, group and project
 *   access tokens alike.
 * - Offset pagination: `page` / `per_page` (max 100), with `X-Next-Page`
 *   naming the next page (empty on the last one). `X-Total` is omitted above
 *   10,000 rows, so it is only ever read as a hint.
 * - Paths that take a project or group accept the numeric id or an encoded
 *   full path.
 * - GraphQL lives at `/api/graphql` on the same host and takes the same token
 *   as a Bearer token.
 */

/** An operation's response, by its `operationId`. */
type GitLabResponse<Op extends keyof operations> = ApiResponse<operations[Op]>;
/** One row of a list operation, by its `operationId`. */
type GitLabRow<Op extends keyof operations> =
  GitLabResponse<Op> extends ReadonlyArray<infer Row> ? Row : never;

export type GlGroup = GitLabResponse<"getApiV4GroupsId">;
export type GlNamespace = GitLabResponse<"getApiV4NamespacesId">;
export type GlProject = GitLabResponse<"getApiV4ProjectsId">;
export type GlPipeline = GitLabResponse<"getApiV4ProjectsIdPipelinesPipelineId">;
export type GlJob =
  GitLabRow<"getApiV4ProjectsIdPipelinesPipelineIdJobs"> | GitLabRow<"getApiV4RunnersIdJobs">;
export type GlRunner = GitLabResponse<"getApiV4RunnersId">;
export type GlDeployment = GitLabRow<"getApiV4ProjectsIdDeployments">;
export type GlEnvironment = GitLabResponse<"getApiV4ProjectsIdEnvironmentsEnvironmentId">;
export type GlProtectedBranch = GitLabResponse<"getApiV4ProjectsIdProtectedBranchesName">;
export type GlVariable = GitLabResponse<"getApiV4ProjectsIdVariablesKey">;
export type GlSchedule = GitLabResponse<"getApiV4ProjectsIdPipelineSchedulesPipelineScheduleId">;
export type GlRegistryRepository = GitLabResponse<"getApiV4RegistryRepositoriesId">;
export type GlRegistryTag =
  GitLabResponse<"getApiV4ProjectsIdRegistryRepositoriesRepositoryIdTagsTagName">;
export type GlPackage = GitLabResponse<"getApiV4ProjectsIdPackagesPackageId">;
export type GlPackageFile = GitLabRow<"getApiV4ProjectsIdPackagesPackageIdPackageFiles">;
export type GlDeployKey = GitLabResponse<"getApiV4ProjectsIdDeployKeysKeyId">;
export type GlDeployToken = GitLabResponse<"postApiV4ProjectsIdDeployTokens">;
export type GlHook =
  GitLabResponse<"getApiV4ProjectsIdHooksHookId"> | GitLabResponse<"getApiV4GroupsIdHooksHookId">;
export type GlRelease = GitLabResponse<"getApiV4ProjectsIdReleasesTagName">;
export type GlMember = GitLabResponse<"getApiV4ProjectsIdMembersUserId">;

export const GITLAB_COM = "https://gitlab.com";

/** Everything a request needs. Split out of the client so tests and the picker can build one. */
export interface GitLabContext {
  /** Instance root, e.g. `https://gitlab.com` (no trailing slash, no `/api/v4`). */
  baseUrl: string;
  token: string;
  caCert?: string;
  http?: HttpHostServices;
}

/** Thrown for any non-2xx answer, carrying the status callers (and the poller) branch on. */
export class GitLabApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GitLabApiError";
    this.status = status;
  }
}

/** HTTP status of a failed call, or 0 for a transport error. */
export function statusOf(err: unknown): number {
  return err instanceof GitLabApiError ? err.status : 0;
}

/** True for the answers that mean "this token or role may not do that". */
export function isPermissionError(err: unknown): boolean {
  const s = statusOf(err);
  return s === 401 || s === 403;
}

/** True for "not here": a missing object, or a feature this tier or instance does not have. */
export function isAbsent(err: unknown): boolean {
  const s = statusOf(err);
  return s === 403 || s === 404;
}

/**
 * Normalise what people paste into the instance URL: blank means GitLab.com,
 * a bare host gets `https://`, and a trailing `/api/v4` or slash is dropped.
 * Anything that is not an http(s) URL is refused rather than guessed at,
 * because a token sent to the wrong host is a token sent to someone else.
 */
export function resolveBaseUrl(raw: string | undefined): string {
  let value = (raw ?? "").trim();
  if (!value) return GITLAB_COM;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `GitLab plugin: "${raw}" is not a URL. Enter https://gitlab.com or your instance's address.`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`GitLab plugin: the instance URL must start with https:// (got "${raw}")`);
  }
  if (url.username || url.password) {
    throw new Error("GitLab plugin: put the token in the token field, not in the URL");
  }
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api\/v4$/i, "");
  return `${url.protocol}//${url.host}${path}`;
}

/** What an error body can hold; GitLab uses all of these. */
interface ErrorBody {
  message?: string | Array<string | number> | Record<string, string | string[]> | null;
  error?: string;
  error_description?: string;
}

/** GitLab errors are `{"message": "..."}` (string, array or field map) or `{"error": "..."}`. */
export function errorDetail(body: string): string {
  try {
    const parsed: ErrorBody = JSON.parse(body);
    const m = parsed.message;
    if (typeof m === "string") return m;
    if (Array.isArray(m)) return m.map(String).join("; ");
    if (m && typeof m === "object") {
      return Object.entries(m)
        .map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(", ") : String(v)}`)
        .join("; ");
    }
    if (typeof parsed.error_description === "string") return parsed.error_description;
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // Not JSON: fall through to the raw body.
  }
  return body.slice(0, 500);
}

const PAGES = {
  cursorParam: "page",
  firstCursor: 1,
  sizeParam: "per_page",
  pageSize: 100,
} as const;

const followingPage = (cursor: string | undefined) => String(Number(cursor) + 1);

/**
 * `X-Next-Page` where GitLab sends it. A proxy can strip or mangle the header, so
 * without a page number a full page means there may be another. It is only ever a
 * number that goes back as `page`, on the instance's own host, so nothing in it can
 * send the token elsewhere. An empty page defers to the header.
 */
const nextPage: NextPage = ({ headers, items, cursor, pageSize }) => {
  const next = headers["x-next-page"];
  if (next === "") return null;
  const page = Number(next);
  if (Number.isFinite(page) && next !== undefined) return String(page);
  return items.length < (pageSize ?? PAGES.pageSize) ? null : followingPage(cursor);
};

function client(ctx: GitLabContext) {
  return createApiClient<paths>({
    vendor: "GitLab",
    baseUrl: `${ctx.baseUrl}/api/v4`,
    headers: { "PRIVATE-TOKEN": ctx.token, Accept: "application/json" },
    contentType: "with-body",
    emptyBodyIsUndefined: true,
    httpError: ({ status, method, path, body }) =>
      new GitLabApiError(
        status,
        `GitLab API error ${status} for ${method} ${path}: ${errorDetail(body)}`,
      ),
    // Bastion egress and a custom CA are only honoured through the host's service.
    ...(ctx.http ? { http: ctx.http } : {}),
    ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
  });
}

/**
 * The REST API, with `getAll` for offset lists. 100 pages of 100 costs nothing until
 * a list really is that long, and past it the list fails rather than come back short,
 * because the sync prunes what it stops seeing. A bounded read says `partial: true`.
 */
export function gitlabApi(ctx: GitLabContext) {
  return withCursorPagination(client(ctx), {
    ...PAGES,
    next: nextPage,
    maxPages: 100,
    continueOnEmptyPage: true,
  });
}

/**
 * A walk for a metric reader that stops by itself: pages count up rather than follow
 * the header, an empty page ends it, and running out of pages only thins a chart.
 */
export function gitlabJobPages(ctx: GitLabContext, maxPages: number) {
  return withCursorPagination(client(ctx), {
    ...PAGES,
    next: ({ headers, items, cursor }) =>
      headers["x-next-page"] === "" || items.length < PAGES.pageSize ? null : followingPage(cursor),
    maxPages,
    partial: true,
  });
}

/** Like {@link gitlabApi}, with a cap of the reader's own. */
export function gitlabCompleteLists(ctx: GitLabContext, maxPages: number) {
  return withCursorPagination(client(ctx), {
    ...PAGES,
    next: nextPage,
    maxPages,
    continueOnEmptyPage: true,
  });
}

/**
 * Deployments of one environment. A blank name is not sent, so the filter goes
 * away rather than match nothing.
 */
export function environmentFilter(name: string | undefined) {
  return name === "" || name === undefined ? {} : { environment: String(name) };
}

/** The row count a list's first page reports. GitLab omits it above 10,000 rows: not a count, not zero. */
export function totalOf({ headers }: { headers: Record<string, string> }): number | undefined {
  const total = headers["x-total"];
  if (total === undefined || total === "") return undefined;
  const n = Number(total);
  return Number.isFinite(n) ? n : undefined;
}

/** POST a GraphQL query (Bearer auth). Field errors are returned, not thrown. */
export async function glGraphql<T>(
  ctx: GitLabContext,
  query: string,
  variables: object = {},
): Promise<{ data?: T; errors?: Array<{ message?: string }> }> {
  const { body } = await restRequest<string>({
    vendor: "GitLab",
    url: `${ctx.baseUrl}/api/graphql`,
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    contentType: "with-body",
    responseAs: "text",
    init: { method: "POST", body: JSON.stringify({ query, variables }) },
    httpError: ({ status, body: text }) =>
      new GitLabApiError(
        status,
        `GitLab API error ${status} for POST /api/graphql: ${errorDetail(text)}`,
      ),
    ...(ctx.http ? { http: ctx.http } : {}),
    ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
  });
  return JSON.parse(body);
}

/** Split `head/rest` at the first slash: composite external ids. */
export function splitScoped(id: string): { scope: string; rest: string } {
  const i = id.indexOf("/");
  if (i < 0) return { scope: id, rest: "" };
  return { scope: id.slice(0, i), rest: id.slice(i + 1) };
}
