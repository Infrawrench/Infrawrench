import {
  createApiClient,
  withCursorPagination,
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

export function createVercelApi(options: {
  accessToken: string;
  teamId: string | null;
  caCert: string;
  http: HttpHostServices | undefined;
}) {
  const { accessToken, teamId, caCert, http } = options;
  const client = createApiClient<paths>({
    vendor: "Vercel",
    baseUrl: "https://api.vercel.com",
    headers: { Authorization: `Bearer ${accessToken}` },
    scopeQuery: { teamId },
    encodeQuery: encodeURIComponent,
    http,
    caCert,
  });
  return {
    /** Most lists take the previous page's `pagination.next` timestamp as `until`. */
    api: withCursorPagination(client, { ...PAGES, cursorParam: "until" }),
    /** `GET /v10/projects` answers with a continuation token and takes it as `from`. */
    projectPages: withCursorPagination(client, { ...PAGES, cursorParam: "from" }),
  };
}
