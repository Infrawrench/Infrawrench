import {
  createApiClient,
  type ApiBody,
  type ApiClient,
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

export type NetlifyApi = ApiClient<paths>;

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
}): NetlifyApi {
  const { accessToken, caCert, http } = options;
  return createApiClient<paths>({
    vendor: "Netlify",
    baseUrl: "https://api.netlify.com/api/v1",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    ...(http ? { http, ...(caCert ? { caCert } : {}) } : {}),
  });
}
