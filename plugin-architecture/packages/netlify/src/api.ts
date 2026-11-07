import {
  createApiClient,
  nextLinkHeader,
  withLinkPagination,
  withPagination,
  type ApiBody,
  type ApiFailure,
  type ApiListItem,
  type ApiResponse,
  type HttpHostServices,
} from "@infrawrench/plugin-base";
import type { operations, paths } from "./api-types.gen.js";

export type NetlifySite = ApiResponse<operations["getSite"]>;
export type NetlifySiteUpdate = ApiBody<operations["updateSite"]>;
export type NetlifyDeploy = ApiResponse<operations["getDeploy"]>;
export type NetlifyForm = ApiListItem<operations["listSiteForms"], null>;
export type NetlifyDnsZone = ApiListItem<operations["getDnsZones"], null>;
export type NetlifyDnsRecord = ApiListItem<operations["getDnsRecords"], null>;
export type NetlifyBuildHook = ApiListItem<operations["listSiteBuildHooks"], null>;
export type NetlifyEnvVar = ApiListItem<operations["getEnvVars"], null>;
export type NetlifyHook = ApiListItem<operations["listHooksBySiteId"], null>;
export type NetlifySnippet = ApiListItem<operations["listSiteSnippets"], null>;
export type NetlifySubmission = ApiListItem<operations["listFormSubmissions"], null>;
export type NetlifySniCertificate = ApiResponse<operations["showSiteTLSCertificate"]>;
export type NetlifyDbBranch = ApiListItem<operations["listSiteDatabaseBranches"], "branches">;
export type NetlifyDbSnapshot = ApiListItem<operations["listSiteDatabaseSnapshots"], "snapshots">;
export type NetlifyUser = ApiResponse<operations["getCurrentUser"]>;

export type NetlifyApi = ReturnType<typeof createNetlifyApi>;

/** Netlify's largest page is 100 rows, so a list stops at 10,000 and then throws. */
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

class NetlifyApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "NetlifyApiError";
  }
}

/**
 * For a read under a site or zone the same pass has just listed, which proves the token
 * works: 401 and 403 are this one refusing it (a guest's team, a team requiring its own
 * login) and 404 is there being none, as for a site with no database. Nothing else may
 * stand for no rows, because a sync prunes what it stops seeing.
 */
export function isRefusal(err: unknown): boolean {
  return err instanceof NetlifyApiError && [401, 403, 404].includes(err.status);
}

/**
 * The official `@netlify/api` SDK uses `module.createRequire` at import time, so it
 * cannot load in Electron's renderer; this speaks the same REST API over `fetch`.
 * The host's HTTP service is used whenever there is one: bastion routing and a custom
 * CA both need it, and without one the CA has nowhere to go.
 */
export function createNetlifyApi(options: {
  accessToken: string;
  caCert: string;
  http: HttpHostServices | undefined;
}) {
  const { accessToken, caCert, http } = options;
  const client = createApiClient<paths>({
    vendor: "Netlify",
    baseUrl: "https://api.netlify.com/api/v1",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    http,
    caCert,
    httpError: ({ status, target, body }: ApiFailure) =>
      new NetlifyApiError(status, `Netlify API error ${status} for ${target}: ${body}`),
  });
  return {
    /** Sites and a site's deploys: the document gives these `page` and `per_page`. */
    pages: withPagination(client, {
      pageParam: "page",
      sizeParam: "per_page",
      pageSize: PAGE_SIZE,
      maxPages: MAX_PAGES,
    }),
    /**
     * The other lists, whose document names no page parameter. Netlify's API guide says
     * every answer over 100 rows is paged and the next page is in `Link`, and paging by
     * number a route that ignored it would read its first page forever.
     */
    links: withLinkPagination(client, { next: nextLinkHeader(), maxPages: MAX_PAGES }),
  };
}
