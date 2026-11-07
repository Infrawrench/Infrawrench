import {
  ListTruncatedError,
  createApiClient,
  pathEncode,
  withCursorPagination,
  type HostServices,
  type HttpHostServices,
  type PageAnswer,
} from "@infrawrench/plugin-base";
import type { components, paths } from "./api-types.gen.js";
import { RenderApiError, buildQuery, sendRequest } from "./kit.js";

/**
 * Transport for the Render public REST API (`https://api.render.com/v1`,
 * OpenAPI spec at https://api-docs.render.com, verified 2026-10). Requests are
 * typed from that document (`plugingen.json`).
 *
 * Auth is `Authorization: Bearer <api key>`. A key belongs to a user and sees
 * every workspace that user belongs to.
 *
 * Lists are arrays of `{<item>, cursor}` wrappers; the next page is
 * `?cursor=<last cursor>` and the list ends on a short page. `limit` tops
 * out at 100, and 500 pages is the 50,000 rows the host can sync.
 *
 * Rate limits (per user): 400 GETs a minute, 30 other writes a minute,
 * 30 log reads a minute, 10 deploy/suspend/resume/PATCH a minute per
 * service, 20 service creations an hour. A 429 is retried once after
 * `Ratelimit-Reset` when that is a few seconds; otherwise it surfaces.
 */

export const API_BASE = "https://api.render.com/v1";
const PAGE_SIZE = 100;
const MAX_PAGES = 500;
const MAX_RETRY_S = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The host's HTTP service or the global fetch, either way retrying a short 429 once. */
function retryingTransport(services: HostServices | undefined): HttpHostServices {
  return {
    async request(req) {
      let res = await sendRequest(services, req);
      if (res.status === 429) {
        const reset = Number(res.headers["ratelimit-reset"]);
        if (Number.isFinite(reset) && reset >= 0 && reset <= MAX_RETRY_S) {
          await sleep(reset * 1000);
          res = await sendRequest(services, req);
        }
      }
      return res;
    },
  };
}

/** A row's cursor, when it is text. */
function cursorOf(row: unknown): string | undefined {
  if (typeof row !== "object" || row === null || !("cursor" in row)) return undefined;
  return typeof row.cursor === "string" ? row.cursor : undefined;
}

function nextCursor({ items }: PageAnswer): string | undefined {
  // A row that is not an object fails where it is unwrapped, so nothing more is asked for.
  if (items.some((row) => typeof row !== "object" || row === null)) return undefined;
  return cursorOf(items.at(-1));
}

/**
 * A walk also stops on a full page whose last row has no cursor, and that page cannot
 * say it was the last one. `GET /env-groups` is documented that way: it takes `cursor`
 * and `limit`, but its rows are bare `envGroupMeta` with no cursor to send back.
 */
function wholeList<T>(path: string, rows: T[]): T[] {
  if (rows.length === 0 || rows.length % PAGE_SIZE !== 0 || cursorOf(rows.at(-1))) return rows;
  throw new ListTruncatedError({ vendor: "Render", path, items: rows.length });
}

export function createRenderApi(
  apiKey: string,
  caCert: string,
  services: HostServices | undefined,
) {
  const api = createApiClient<paths>({
    vendor: "Render",
    baseUrl: API_BASE,
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    http: retryingTransport(services),
    caCert,
    contentType: "with-body",
    emptyBodyIsUndefined: true,
    serializeQuery: buildQuery,
    httpError: ({ status, method, path, body }) => new RenderApiError(status, method, path, body),
  });
  return withCursorPagination(api, {
    cursorParam: "cursor",
    sizeParam: "limit",
    pageSize: PAGE_SIZE,
    maxPages: MAX_PAGES,
    next: nextCursor,
    stopOnShortPage: true,
  });
}

export type RenderApi = ReturnType<typeof createRenderApi>;

/** Narrows a list to one workspace. */
export interface OwnerQuery {
  ownerId?: string[];
}

type EnvGroupRow =
  components["schemas"]["envGroupMeta"] | { envGroup: components["schemas"]["envGroupMeta"] };

const unwrapEnvGroup = (row: EnvGroupRow) => ("envGroup" in row ? row.envGroup : row);

// Each list keeps a row with no wrapper as it is, and a few lists (environment
// groups) document no wrapper at all.

export const listOwners = async (api: RenderApi) =>
  wholeList("/owners", await api.getAll("/owners", null)).map((row) =>
    "owner" in row ? row.owner : row,
  );

export const listServices = async (api: RenderApi, query: OwnerQuery) =>
  wholeList("/services", await api.getAll("/services", null, { query })).map((row) =>
    "service" in row ? row.service : row,
  );

export const listProjects = async (api: RenderApi, query: OwnerQuery) =>
  wholeList("/projects", await api.getAll("/projects", null, { query })).map((row) =>
    "project" in row ? row.project : row,
  );

export const listEnvironments = async (api: RenderApi, projectId: string) =>
  wholeList(
    "/environments",
    await api.getAll("/environments", null, { query: { projectId: [projectId] } }),
  ).map((row) => ("environment" in row ? row.environment : row));

export const listDisks = async (api: RenderApi, query: OwnerQuery) =>
  wholeList("/disks", await api.getAll("/disks", null, { query })).map((row) =>
    "disk" in row ? row.disk : row,
  );

export const listPostgres = async (
  api: RenderApi,
  query: OwnerQuery & { includeReplicas?: boolean },
) =>
  wholeList("/postgres", await api.getAll("/postgres", null, { query })).map((row) =>
    "postgres" in row ? row.postgres : row,
  );

export const listKeyValues = async (api: RenderApi, query: OwnerQuery) =>
  wholeList("/key-value", await api.getAll("/key-value", null, { query })).map((row) =>
    "keyValue" in row ? row.keyValue : row,
  );

export const listBlueprints = async (api: RenderApi, query: OwnerQuery) =>
  wholeList("/blueprints", await api.getAll("/blueprints", null, { query })).map((row) =>
    "blueprint" in row ? row.blueprint : row,
  );

export const listEnvVars = async (api: RenderApi, serviceId: string) =>
  wholeList(
    "/services/{serviceId}/env-vars",
    await api.getAll(`/services/${pathEncode(serviceId)}/env-vars`, null),
  ).map((row) => ("envVar" in row ? row.envVar : row));

export const listCustomDomains = async (api: RenderApi, serviceId: string) =>
  wholeList(
    "/services/{serviceId}/custom-domains",
    await api.getAll(`/services/${pathEncode(serviceId)}/custom-domains`, null),
  ).map((row) => ("customDomain" in row ? row.customDomain : row));

export const listEnvGroups = async (api: RenderApi, query: OwnerQuery) =>
  wholeList("/env-groups", await api.getAll("/env-groups", null, { query })).map(unwrapEnvGroup);

/** For a picker, where the groups it could read are better than none. */
export const listEnvGroupChoices = async (api: RenderApi, query: OwnerQuery) =>
  (await api.getAll("/env-groups", null, { query, partial: true })).map(unwrapEnvGroup);

// Rolling window: the newest N. Older rows falling off is what this type means.
// The document states no order for these two, so a live read should confirm it.
export const listRecentDeploys = async (api: RenderApi, serviceId: string, count: number) =>
  (
    await api.getAll(`/services/${pathEncode(serviceId)}/deploys`, null, {
      pageSize: count,
      maxPages: 1,
      partial: true,
    })
  ).map((row) => row.deploy);

export const listRecentJobs = async (api: RenderApi, serviceId: string, count: number) =>
  (
    await api.getAll(`/services/${pathEncode(serviceId)}/jobs`, null, {
      pageSize: count,
      maxPages: 1,
      partial: true,
    })
  ).map((row) => row.job);
