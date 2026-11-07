/**
 * OpenAI REST transport.
 *
 * Two credentials, two disjoint planes: a project key reaches everything under
 * `/v1` that isn't `/v1/organization/*`, and an admin key reaches only that.
 * Each plane is one client. Types come from OpenAI's published OpenAPI document
 * (`openai/openai-openapi`), through `plugingen.json`.
 */
import {
  createApiClient,
  type ApiBody,
  type ApiClient,
  type ApiResponse,
  type HttpHostServices,
} from "@infrawrench/plugin-base";
import type { components, operations, paths } from "./api-types.gen.js";

export const API_BASE = "https://api.openai.com/v1";

/**
 * The wall between the two key types is absolute: `/v1/organization/*` is
 * declared `AdminApiKeyAuth` in OpenAI's own API description and answers a
 * project key with 403, while an admin key is refused everywhere on the data
 * plane. Neither degrades, so rather than surfacing a bare 403 from six
 * different call sites, every admin request funnels through one guard that
 * names the missing credential.
 */
export const ADMIN_KEY_REQUIRED =
  'OpenAI plugin: this needs the account\'s "Admin API key". Organization projects, members, invites, ' +
  "usage and costs live under /v1/organization/* and only an admin key (sk-admin-…) can reach them; a " +
  "project key (sk-… / sk-proj-…) gets a 403. Edit this account and paste an admin key " +
  "from https://platform.openai.com/settings/organization/admin-keys.";

export type OpenAIApi = ApiClient<paths>;

export interface OpenAITransport {
  http: HttpHostServices | undefined;
  caCert: string;
  /** Thrown instead of sending anything when `key` is empty. */
  guard?: string;
}

export function createOpenAIApi(key: string, transport: OpenAITransport): OpenAIApi {
  const { http, caCert, guard } = transport;
  const headers = { Authorization: `Bearer ${key}`, Accept: "application/json" };
  return createApiClient<paths>({
    vendor: "OpenAI",
    baseUrl: API_BASE,
    headers: () => {
      if (guard !== undefined && key === "") throw new Error(guard);
      return headers;
    },
    http,
    caCert,
  });
}

type Schemas = components["schemas"];

export type OpenAIModel = Schemas["Model"];
export type FineTuningJob = Schemas["FineTuningJob"];
export type Batch = Schemas["Batch"];
export type OpenAIFile = Schemas["OpenAIFile"];
export type VectorStore = Schemas["VectorStoreObject"];
export type Container = Schemas["ContainerResource"];
export type EvalObject = Schemas["Eval"];
export type Project = Schemas["Project"];
export type ProjectUser = Schemas["ProjectUser"];
export type ProjectServiceAccount = Schemas["ProjectServiceAccount"];
export type ProjectRateLimit = Schemas["ProjectRateLimit"];
export type SpendLimit =
  Schemas["OrganizationSpendLimitResource"] | Schemas["ProjectSpendLimitResource"];
export type SpendAlert = Schemas["OrganizationSpendAlert"] | Schemas["ProjectSpendAlert"];
export type AdminApiKey = Schemas["AdminApiKey"];
export type ProjectApiKey = Schemas["ProjectApiKey"];
export type OrganizationUser = Schemas["User"];
export type Invite = Schemas["Invite"];
export type AuditLogEntry = Schemas["AuditLog"];

/** A field of whichever union members have it. */
type FieldOf<U, K extends PropertyKey> = U extends unknown
  ? K extends keyof U
    ? U[K]
    : never
  : never;

/** Every field of every union member, each optional, for reading a result by name. */
type AnyMember<U> = { [K in U extends unknown ? keyof U : never]?: FieldOf<U, K> };

/**
 * One usage or cost result. The document unions a result type per endpoint, and
 * the endpoint is what decides which counters a chart picks.
 */
export type UsageResult = AnyMember<Schemas["UsageTimeBucket"]["results"][number]>;

export type UsageBucket = Omit<Schemas["UsageTimeBucket"], "results"> & { results: UsageResult[] };

export type UsageEndpointName = keyof {
  [P in keyof paths as P extends `/organization/usage/${infer Name}` ? Name : never]: unknown;
};

/** The usage filters: one per request, and the endpoint table says which it takes. */
export type UsageFilterQuery = Partial<
  Record<"models" | "project_ids" | "user_ids" | "api_key_ids" | "vector_store_ids", string[]>
>;

export type CostQuery = NonNullable<operations["usage-costs"]["parameters"]["query"]>;
export type AuditLogPage = ApiResponse<operations["list-audit-logs"]>;
export type AuditLogQuery = NonNullable<operations["list-audit-logs"]["parameters"]["query"]>;

export type RateLimitBody = ApiBody<operations["update-project-rate-limits"]>;
export type ServiceAccountBody = ApiBody<operations["update-project-service-account"]>;
export type SpendAlertBody = ApiBody<operations["create-organization-spend-alert"]>;
export type SpeechBody = ApiBody<operations["createSpeech"]>;

/** Which member answers depends on the `response_format` the model was asked for. */
export type TranscriptionAnswer = AnyMember<ApiResponse<operations["createTranscription"]>>;

/** One page's paging parameters, in the order they go on the wire. */
export interface PageQuery {
  limit: number;
  after?: string;
}

/** What a list page says, read the same way whichever route answered it. */
export interface ListPage<T> {
  data?: readonly T[];
  has_more?: boolean;
  last_id?: string | null;
}

/**
 * OpenAI paginates in four different dialects. The three list-shaped ones
 * relevant here all take an `after` cursor, but only some responses hand back
 * an explicit `last_id`: the admin endpoints (projects, users, invites, project
 * API keys) and vector stores / containers / evals do, while fine-tuning jobs,
 * batches and files do not and require the cursor to be read off the last
 * element. Preferring `last_id` and falling back to `data[-1].id` covers both
 * without silently truncating a long list.
 */
function nextCursor<T extends { id: string }>(
  page: ListPage<T>,
  batch: readonly T[],
): string | undefined {
  if (typeof page.last_id === "string" && page.last_id !== "") return page.last_id;
  const last = batch[batch.length - 1];
  return last?.id;
}

/**
 * Walk an `after` / `limit` list. A loop over the call rather than
 * `withCursorPagination`, because `getAll` reads a list that is not an array as
 * empty and here it throws, which keeps the host from pruning everything a sync
 * stopped seeing.
 */
export async function listPages<T extends { id: string }>(
  getPage: (paging: PageQuery) => Promise<ListPage<T>>,
  opts: { pageSize?: number; maxPages?: number } = {},
): Promise<T[]> {
  const pageSize = opts.pageSize ?? 100;
  const maxPages = opts.maxPages ?? 20;
  const out: T[] = [];
  let after: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    // Not validated at runtime, so a cursor that is not text still goes as text.
    const body = await getPage({
      limit: pageSize,
      ...(after ? { after: String(after) } : {}),
    });
    const batch = body.data ?? [];
    out.push(...batch);
    if (!body.has_more || batch.length === 0) break;
    const cursor = nextCursor(body, batch);
    if (!cursor) break;
    after = cursor;
  }

  return out;
}

/**
 * Usage and cost endpoints don't use the `after` cursor at all: they page with
 * an opaque `page` token echoed back as `next_page`. An empty page with more to
 * come is followed, which `getAll` would stop at.
 */
export async function listUsagePages(
  getPage: (paging: { page?: string }) => Promise<ApiResponse<operations["usage-costs"]>>,
  maxPages = 10,
): Promise<UsageBucket[]> {
  const out: UsageBucket[] = [];
  let page: string | undefined;

  for (let i = 0; i < maxPages; i++) {
    const body = await getPage(page ? { page: String(page) } : {});
    out.push(...(body.data ?? []));
    if (!body.has_more || !body.next_page) break;
    page = body.next_page;
  }

  return out;
}
