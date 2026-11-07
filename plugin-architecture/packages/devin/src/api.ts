import {
  ListPageError,
  ListTruncatedError,
  createApiClient,
  pathEncode,
  requireListPage,
  type ApiClient,
  type ApiResponse,
  type HttpHostServices,
  type ParamValue,
} from "@infrawrench/plugin-base";
import type { components, operations, paths } from "./api-types.gen.js";

/**
 * Devin API v3 (https://docs.devin.ai/api-reference/overview, OpenAPI at
 * https://docs.devin.ai/v3-openapi.json, checked 2026-10).
 *
 * One host, `https://api.devin.ai`, Bearer auth with either a service user
 * credential (`cog_…`) or a personal access token. Organization endpoints live
 * under `/v3/organizations/{org_id}/…`, enterprise ones under
 * `/v3/enterprise/…`. An enterprise service user inherits the matching
 * org-level permission in every organization, so the org endpoints serve both
 * kinds of key and this plugin only ever calls those (plus the enterprise
 * organization listing, to find the orgs).
 *
 * Lists paginate with `first` (at most 200) and an opaque `after` cursor,
 * answering `{ items, end_cursor, has_next_page }`. Timestamps are Unix
 * seconds everywhere.
 */

export const API_BASE = "https://api.devin.ai";
export const APP_BASE = "https://app.devin.ai";
const PAGE_SIZE = 200;
/** 10,000 rows. */
const MAX_PAGES = 50;
/** 50,000 rows. The document states no order, so older sessions cannot be left to fall off. */
const MAX_SESSION_PAGES = 250;

export class DevinApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DevinApiError";
    this.status = status;
  }
}

export function statusOf(err: unknown): number {
  return err instanceof DevinApiError ? err.status : 0;
}

export function isPermissionError(err: unknown): boolean {
  const s = statusOf(err);
  return s === 401 || s === 403;
}

/** Query string with arrays as repeated keys (`tags=a&tags=b`), the form FastAPI reads. */
function queryString(query: Record<string, ParamValue>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const v of values)
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join("&");
}

export type DevinApi = ApiClient<paths>;

const STATUS_IN_MESSAGE = /Devin API error (\d{3})/;

/** A failure counts as the status its text names, which is how this plugin has always told them apart. */
function rethrowWithStatus(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  const status = Number(STATUS_IN_MESSAGE.exec(message)?.[1] ?? 0);
  if (status) throw new DevinApiError(status, message);
  throw err;
}

const withStatus =
  <Args extends unknown[], Result>(call: (...args: Args) => Promise<Result>) =>
  (...args: Args): Promise<Result> =>
    call(...args).catch(rethrowWithStatus);

export function createDevinApi(options: {
  token: string;
  caCert: string;
  http: HttpHostServices | undefined;
}): DevinApi {
  const { token, caCert, http } = options;
  const client = createApiClient<paths>({
    vendor: "Devin",
    baseUrl: API_BASE,
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    serializeQuery: queryString,
    httpError: ({ status, path, body }) =>
      new Error(`Devin API error ${status} for ${path}: ${body}`),
    caCert,
    http,
  });
  return Object.assign(client, {
    get: withStatus(client.get),
    put: withStatus(client.put),
    post: withStatus(client.post),
    delete: withStatus(client.delete),
    patch: withStatus(client.patch),
  });
}

interface Cursor {
  first: number;
  after?: string;
}

interface Page<T> {
  items?: readonly T[] | null;
  end_cursor?: string | null;
  has_next_page?: boolean;
}

/**
 * Follow `after` cursors to the last page, or throw: a sync prunes what a list stops
 * returning. A loop rather than `getAll`, which reads a page that says there is more
 * but gives no cursor as the end, and stops at an empty page where the pagination
 * document says to go on until `has_next_page` is false.
 */
async function paginate<T>(
  path: string,
  load: (cursor: Cursor) => Promise<Page<T> | undefined>,
  maxPages = MAX_PAGES,
): Promise<T[]> {
  const place = { vendor: "Devin", path };
  const out: T[] = [];
  let after: string | undefined;
  for (let n = 0; n < maxPages; n++) {
    const page = await load({ first: PAGE_SIZE, ...(after !== undefined ? { after } : {}) });
    out.push(...requireListPage(page?.items, { ...place, key: "items", page }));
    if (!page?.has_next_page) return out;
    if (!page.end_cursor) {
      throw new ListPageError({ ...place, key: "end_cursor", found: page.end_cursor, page });
    }
    after = page.end_cursor;
  }
  throw new ListTruncatedError({ ...place, items: out.length, maxPages });
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

type Schemas = components["schemas"];

/** Every kind of principal, read alike: a field another kind lacks is simply absent. */
export type DevinSelf = ApiResponse<operations["handle_get_self_v3_self_get"]> & {
  service_user_id?: string;
  service_user_name?: string;
  devin_sessions_org_id?: string | null;
};

type OrganizationResponse = Schemas["OrganizationResponse"];

/** An organization as listed, or as named by a key that cannot list them. */
export type DevinOrg = Pick<OrganizationResponse, "org_id" | "name"> &
  Partial<Pick<OrganizationResponse, "max_session_acu_limit" | "max_cycle_acu_limit">>;

export type DevinSession = Schemas["SessionResponse"];
export type DevinPlaybook = Schemas["PlaybookResponse"];
export type DevinNote = Schemas["KnowledgeNoteResponse"];
export type DevinSecret = Schemas["SecretResponse"];
export type DevinUser = Schemas["User"];
export type DevinAutomation = Schemas["AutomationResponse"];
export type ConsumptionDay = Schemas["ConsumptionByDateResponse"];
export type UsageMetrics = Schemas["UsageMetrics"];

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export function getSelf(api: DevinApi): Promise<DevinSelf> {
  return api.get("/v3/self");
}

export const listUsers = (api: DevinApi, orgId: string) => {
  const path = `/v3beta1/organizations/${pathEncode(orgId)}/members/users` as const;
  return paginate(path, (cursor) => api.get(path, { query: cursor }));
};

export const listPlaybooks = (api: DevinApi, orgId: string) => {
  const path = `/v3/organizations/${pathEncode(orgId)}/playbooks` as const;
  return paginate(path, (cursor) => api.get(path, { query: cursor }));
};

export const listNotes = (api: DevinApi, orgId: string) => {
  const path = `/v3/organizations/${pathEncode(orgId)}/knowledge/notes` as const;
  return paginate(path, (cursor) => api.get(path, { query: cursor }));
};

export const listSecrets = (api: DevinApi, orgId: string) => {
  const path = `/v3/organizations/${pathEncode(orgId)}/secrets` as const;
  return paginate(path, (cursor) => api.get(path, { query: cursor }));
};

export const listAutomations = (api: DevinApi, orgId: string) => {
  const path = `/v3/organizations/${pathEncode(orgId)}/automations` as const;
  return paginate(path, (cursor) => api.get(path, { query: cursor }));
};

export const listSessions = (
  api: DevinApi,
  orgId: string,
  filter: { updated_after?: number } = {},
) => {
  const path = `/v3/organizations/${pathEncode(orgId)}/sessions` as const;
  return paginate(
    path,
    (cursor) => api.get(path, { query: { ...filter, ...cursor } }),
    MAX_SESSION_PAGES,
  );
};

/**
 * The organizations this key works in. An org-scoped service user names its
 * org in `/v3/self`. An enterprise key (no org there) lists every org in the
 * enterprise. A personal access token tries the enterprise listing too, and
 * falls back to the org its sessions run in.
 */
export async function resolveOrgs(api: DevinApi): Promise<{ self: DevinSelf; orgs: DevinOrg[] }> {
  const self = await getSelf(api);
  if (self.org_id && self.principal_type !== "pat_user") {
    return { self, orgs: [{ org_id: self.org_id, name: self.org_id }] };
  }
  try {
    const path = "/v3/enterprise/organizations";
    const orgs = await paginate(path, (cursor) => api.get(path, { query: cursor }));
    if (orgs.length > 0) return { self, orgs };
  } catch (err) {
    if (!isPermissionError(err) && statusOf(err) !== 404) throw err;
  }
  const fallback = self.org_id ?? self.devin_sessions_org_id;
  if (fallback) return { self, orgs: [{ org_id: fallback, name: fallback }] };
  throw new Error(
    "Devin: this key is not scoped to an organization and cannot list the enterprise's organizations. Use an organization service user, or give the enterprise service user a role that can view organizations.",
  );
}

/** Unix seconds of a Devin billing-day boundary: midnight PST, 08:00 UTC, for `YYYY-MM-DD`. */
export function dayStartSeconds(date: string): number {
  return Date.parse(`${date}T08:00:00Z`) / 1000;
}

/** The billing day (`YYYY-MM-DD`) a Unix timestamp falls on, with days starting 08:00 UTC. */
export function billingDay(seconds: number): string {
  return new Date((seconds - 8 * 3600) * 1000).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** One of the daily consumption endpoints: an organization, or one person, service user or session in it. */
export type ConsumptionRead = (query: {
  time_after: number;
  time_before: number;
}) => Promise<Schemas["ConsumptionResponse"]>;

export const orgConsumption =
  (api: DevinApi, orgId: string): ConsumptionRead =>
  (query) =>
    api.get(`/v3/organizations/${pathEncode(orgId)}/consumption/daily`, { query });

export const userConsumption =
  (api: DevinApi, orgId: string, userId: string): ConsumptionRead =>
  (query) =>
    api.get(
      `/v3/organizations/${pathEncode(orgId)}/consumption/daily/users/${pathEncode(userId)}`,
      { query },
    );

export const serviceUserConsumption =
  (api: DevinApi, orgId: string, serviceUserId: string): ConsumptionRead =>
  (query) =>
    api.get(
      `/v3/organizations/${pathEncode(orgId)}/consumption/daily/service-users/${pathEncode(serviceUserId)}`,
      { query },
    );

export const sessionConsumption =
  (api: DevinApi, orgId: string, sessionId: string): ConsumptionRead =>
  (query) =>
    api.get(
      `/v3/organizations/${pathEncode(orgId)}/consumption/daily/sessions/${pathEncode(sessionId)}`,
      { query },
    );

/** Daily ACUs for `[fromDate, toDate]` (inclusive billing days) from a consumption endpoint. */
export async function fetchConsumption(
  read: ConsumptionRead,
  fromDate: string,
  toDate: string,
): Promise<ConsumptionDay[]> {
  const res = await read({
    time_after: dayStartSeconds(fromDate),
    time_before: dayStartSeconds(addDays(toDate, 1)),
  });
  const rows = requireListPage(res?.consumption_by_date, {
    vendor: "Devin",
    path: "/v3/organizations/{org_id}/consumption/daily",
    key: "consumption_by_date",
    page: res,
  });
  return rows.filter((d) => {
    const day = billingDay(d.date);
    return day >= fromDate && day <= toDate;
  });
}

/** Run `fn` over `items`, at most `limit` at a time. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}
