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
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Narrower than this a window cannot split: its halves overlap a millisecond each way. */
const MIN_WINDOW_MS = 4;
const NEWEST_STEPS = 12;

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
 * say it was the last one.
 */
const cutShort = (rows: unknown[]) =>
  rows.length > 0 && rows.length % PAGE_SIZE === 0 && !cursorOf(rows.at(-1));

function wholeList<T>(path: string, rows: T[]): T[] {
  if (!cutShort(rows)) return rows;
  throw new ListTruncatedError({ vendor: "Render", path, items: rows.length });
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Milliseconds since the epoch, or NaN, which every comparison reads as false. */
const timeOf = (row: { createdAt?: string }) => Date.parse(row.createdAt ?? "");

const createdWindow = (after: number | undefined, before: number | undefined) => ({
  ...(after === undefined ? {} : { createdAfter: iso(after) }),
  ...(before === undefined ? {} : { createdBefore: iso(before) }),
});

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

type EnvGroupMeta = components["schemas"]["envGroupMeta"];

/**
 * `GET /env-groups` is documented with bare `envGroupMeta` rows and no cursor to send
 * back, while it takes `cursor`, `limit`, `createdAfter` and `createdBefore`. A cursor
 * that does come back is followed. A full page without one is read again by creation
 * window: a window answering a short page holds every group in it, and one answering a
 * full page splits in two, so the list is whole whatever order Render answers in.
 */
export async function listEnvGroups(api: RenderApi, query: OwnerQuery): Promise<EnvGroupMeta[]> {
  const path = "/env-groups";
  const read = (after?: number, before?: number) =>
    api.getAll(path, null, { query: { ...query, ...createdWindow(after, before) } });
  const first = await read();
  if (!cutShort(first)) return first.map(unwrapEnvGroup);

  const byId = new Map<string, EnvGroupMeta>();
  let reads = 1;
  const truncated = () => new ListTruncatedError({ vendor: "Render", path, items: byId.size });
  const split = async (after: number | undefined, before: number | undefined): Promise<void> => {
    const lo = after ?? 0;
    const hi = before ?? Date.now() + DAY_MS;
    if (hi - lo <= MIN_WINDOW_MS) throw truncated();
    const mid = Math.floor((lo + hi) / 2);
    // Each half reaches a millisecond past the middle, so a group created there lands in
    // one of them whether Render's bounds are inclusive or not.
    const halves: Array<[number | undefined, number | undefined]> = [
      [after, mid + 1],
      [mid - 1, before],
    ];
    for (const [a, b] of halves) {
      if (++reads > MAX_PAGES) throw truncated();
      const rows = await read(a, b);
      for (const group of rows.map(unwrapEnvGroup)) {
        const at = timeOf(group);
        // A group outside the window means the window was not applied, and splitting
        // further would only read the same page again.
        if ((a !== undefined && at < a) || (b !== undefined && at > b)) throw truncated();
        byId.set(group.id, group);
      }
      if (cutShort(rows)) await split(a, b);
    }
  };
  await split(undefined, undefined);
  return [...byId.values()];
}

/** For a picker, where the groups it could read are better than none. */
export const listEnvGroupChoices = async (api: RenderApi, query: OwnerQuery) =>
  (await api.getAll("/env-groups", null, { query, partial: true })).map(unwrapEnvGroup);

/**
 * The newest `count` rows of a service's history. The document states no order for
 * deploys or jobs. A first page that is short, or does not run oldest first, is kept as
 * Render sent it. One that runs oldest first holds the oldest rows, so a `createdAfter`
 * window is widened back from now until a short page holds at least `count` rows,
 * halving back toward the last short one wherever a page comes back full.
 */
async function newestRows<T extends { createdAt?: string }>(
  read: (pageSize: number, createdAfter?: string) => Promise<T[]>,
  count: number,
): Promise<T[]> {
  const first = await read(count);
  const oldest = first[0];
  const newest = first.at(-1);
  if (first.length < count || !oldest || !newest || !(timeOf(oldest) < timeOf(newest))) {
    return first;
  }
  const now = Date.now();
  let found: T[] | undefined;
  let shortSpan = 0;
  let fullSpan = Infinity;
  let span = HOUR_MS;
  for (let step = 0; step < NEWEST_STEPS; step++) {
    const after = now - span;
    const rows = await read(PAGE_SIZE, iso(after));
    // A row from before the window means the window was not applied.
    if (rows.some((r) => timeOf(r) < after)) return first;
    if (rows.length < PAGE_SIZE) {
      found = rows;
      shortSpan = span;
      if (rows.length >= count || after <= timeOf(oldest)) break;
      span = fullSpan === Infinity ? span * 8 : (span + fullSpan) / 2;
    } else {
      fullSpan = span;
      span = (shortSpan + span) / 2;
    }
  }
  if (!found) return first;
  return [...found].sort((a, b) => timeOf(b) - timeOf(a)).slice(0, count);
}

// Rolling window: the newest N. Older rows falling off is what this type means.
export const listRecentDeploys = (api: RenderApi, serviceId: string, count: number) =>
  newestRows(
    async (pageSize, createdAfter) =>
      (
        await api.getAll(`/services/${pathEncode(serviceId)}/deploys`, null, {
          ...(createdAfter ? { query: { createdAfter } } : {}),
          pageSize,
          maxPages: 1,
          partial: true,
        })
      ).map((row) => row.deploy),
    count,
  );

// Rolling window: the newest N. Older rows falling off is what this type means.
export const listRecentJobs = (api: RenderApi, serviceId: string, count: number) =>
  newestRows(
    async (pageSize, createdAfter) =>
      (
        await api.getAll(`/services/${pathEncode(serviceId)}/jobs`, null, {
          ...(createdAfter ? { query: { createdAfter } } : {}),
          pageSize,
          maxPages: 1,
          partial: true,
        })
      ).map((row) => row.job),
    count,
  );
