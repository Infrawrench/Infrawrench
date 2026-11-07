import {
  createApiClient,
  withCursorPagination,
  type ApiFailure,
  type ApiListItem,
  type ApiResponse,
  type HttpHostServices,
} from "@infrawrench/plugin-base";
import type { operations, paths } from "./api-types.gen.js";

/** An operation's response, by its `operationId`. */
export type VercelResponse<Op extends keyof operations> = ApiResponse<operations[Op]>;

export type VercelProject = (
  | ApiListItem<operations["getProjects"], "projects">
  | VercelResponse<"getProject">
  | VercelResponse<"createProject">
  | VercelResponse<"updateProject">
) & { serverlessFunctionRegion?: string | null };
export type VercelDeployment = ApiListItem<operations["getDeployments"], "deployments">;
export type VercelDeploymentDetail = VercelResponse<"getDeployment">;
export type VercelDomain = ApiListItem<operations["getDomains"], "domains">;
export type VercelDnsRecord = ApiListItem<operations["getRecords"], "records">;
export type VercelEnvVar = ApiListItem<operations["filterProjectEnvs"], "envs">;
export type VercelTeam = ApiListItem<operations["getTeams"], "teams"> & { updatedAt?: number };
export type VercelWebhook =
  | ApiListItem<operations["getWebhooks"], null>
  | VercelResponse<"getWebhook">
  | VercelResponse<"createWebhook">;
/** The build-output fields of an event; other kinds have none, and read as undefined. */
export type VercelDeploymentEvent = NonNullable<
  ApiListItem<operations["getDeploymentEvents"], null>
> & {
  created?: number;
  text?: string;
  payload?: { text?: string; date?: number };
};

/**
 * 500 pages is 50,000 rows, or 25,000 deployments at their page size. Past that a list
 * fails with a readable error rather than come back short, because the sync prunes
 * what it stops seeing. Deployments are what reach it: Vercel keeps them for months.
 * Vercel allows 1,000 list requests a minute (`now-list`), so a full walk fits in one.
 */
const PAGES = {
  sizeParam: "limit",
  pageSize: 100,
  maxPages: 500,
  next: "pagination.next",
} as const;

/** Carries the status, for the few reads where one status means "there is none". */
export class VercelApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "VercelApiError";
  }
}

export function hasStatus(error: unknown, ...statuses: number[]): boolean {
  return error instanceof VercelApiError && statuses.includes(error.status);
}

export function createVercelApi(options: {
  accessToken: string;
  teamId: string | null;
  caCert: string;
  http: HttpHostServices | undefined;
}) {
  const { accessToken, teamId, caCert, http } = options;
  const connection = {
    vendor: "Vercel",
    baseUrl: "https://api.vercel.com",
    headers: { Authorization: `Bearer ${accessToken}` },
    encodeQuery: encodeURIComponent,
    http,
    caCert,
    httpError: ({ status, target, body }: ApiFailure) =>
      new VercelApiError(status, `Vercel API error ${status} for ${target}: ${body}`),
  };
  const client = createApiClient<paths>({ ...connection, scopeQuery: { teamId } });
  return {
    /** Most lists take the previous page's `pagination.next` timestamp as `until`. */
    api: withCursorPagination(client, { ...PAGES, cursorParam: "until" }),
    /** `GET /v10/projects` answers with a continuation token and takes it as `from`. */
    projectPages: withCursorPagination(client, { ...PAGES, cursorParam: "from" }),
    /** `GET /v10/projects/{id}/env` documents no `limit`, so this one sends none. */
    envPages: withCursorPagination(client, {
      cursorParam: "until",
      next: PAGES.next,
      maxPages: PAGES.maxPages,
    }),
    /** `GET /v2/teams` is the user's teams: the document gives it no team to scope to. */
    accountPages: withCursorPagination(createApiClient<paths>(connection), {
      ...PAGES,
      cursorParam: "until",
    }),
  };
}
