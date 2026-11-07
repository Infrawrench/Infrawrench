import {
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
 * out at 100.
 *
 * Rate limits (per user): 400 GETs a minute, 30 other writes a minute,
 * 30 log reads a minute, 10 deploy/suspend/resume/PATCH a minute per
 * service, 20 service creations an hour. A 429 is retried once after
 * `Ratelimit-Reset` when that is a few seconds; otherwise it surfaces.
 */

export const API_BASE = "https://api.render.com/v1";
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
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

/** The last row's cursor, when it is text. */
function nextCursor({ items }: PageAnswer): string | undefined {
  // A row that is not an object fails where it is unwrapped, so nothing more is asked for.
  if (items.some((row) => typeof row !== "object" || row === null)) return undefined;
  const last = items.at(-1);
  if (typeof last !== "object" || last === null || !("cursor" in last)) return undefined;
  return typeof last.cursor === "string" ? last.cursor : undefined;
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
    stopOnRepeatedCursor: true,
    emptyBodyEndsList: true,
  });
}

export type RenderApi = ReturnType<typeof createRenderApi>;

/** Narrows a list to one workspace. */
export interface OwnerQuery {
  ownerId?: string[];
}

type EnvGroupRow =
  components["schemas"]["envGroupMeta"] | { envGroup: components["schemas"]["envGroupMeta"] };

// Each list keeps a row with no wrapper as it is, and a few lists (environment
// groups) document no wrapper at all.

export const listOwners = async (api: RenderApi) =>
  (await api.getAll("/owners", null)).map((row) => ("owner" in row ? row.owner : row));

export const listServices = async (api: RenderApi, query: OwnerQuery) =>
  (await api.getAll("/services", null, { query })).map((row) =>
    "service" in row ? row.service : row,
  );

export const listProjects = async (api: RenderApi, query: OwnerQuery) =>
  (await api.getAll("/projects", null, { query })).map((row) =>
    "project" in row ? row.project : row,
  );

export const listEnvironments = async (api: RenderApi, projectId: string) =>
  (await api.getAll("/environments", null, { query: { projectId: [projectId] } })).map((row) =>
    "environment" in row ? row.environment : row,
  );

export const listDisks = async (api: RenderApi, query: OwnerQuery) =>
  (await api.getAll("/disks", null, { query })).map((row) => ("disk" in row ? row.disk : row));

export const listPostgres = async (
  api: RenderApi,
  query: OwnerQuery & { includeReplicas?: boolean },
) =>
  (await api.getAll("/postgres", null, { query })).map((row) =>
    "postgres" in row ? row.postgres : row,
  );

export const listKeyValues = async (api: RenderApi, query: OwnerQuery) =>
  (await api.getAll("/key-value", null, { query })).map((row) =>
    "keyValue" in row ? row.keyValue : row,
  );

export const listBlueprints = async (api: RenderApi, query: OwnerQuery) =>
  (await api.getAll("/blueprints", null, { query })).map((row) =>
    "blueprint" in row ? row.blueprint : row,
  );

export const listEnvVars = async (api: RenderApi, serviceId: string) =>
  (await api.getAll(`/services/${pathEncode(serviceId)}/env-vars`, null)).map((row) =>
    "envVar" in row ? row.envVar : row,
  );

export const listCustomDomains = async (api: RenderApi, serviceId: string) =>
  (await api.getAll(`/services/${pathEncode(serviceId)}/custom-domains`, null)).map((row) =>
    "customDomain" in row ? row.customDomain : row,
  );

export const listEnvGroups = async (api: RenderApi, query: OwnerQuery) =>
  (await api.getAll("/env-groups", null, { query })).map((row: EnvGroupRow) =>
    "envGroup" in row ? row.envGroup : row,
  );
