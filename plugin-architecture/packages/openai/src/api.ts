/**
 * OpenAI REST transport.
 *
 * Two credentials, two disjoint planes: a project key reaches everything under
 * `/v1` that isn't `/v1/organization/*`, and an admin key reaches only that.
 * Each plane is one client. Types come from OpenAI's published OpenAPI document
 * (`openai/openai-openapi`), through `plugingen.json`.
 */
import {
  ListTruncatedError,
  createApiClient,
  withCursorPagination,
  type ApiBody,
  type ApiResponse,
  type CursorApiClient,
  type HttpHostServices,
  type NextPage,
  type PageAnswer,
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

const VENDOR = "OpenAI";

/** The largest `limit` the routes document, on those that document one. */
const PAGE_SIZE = 100;
/** 50,000 rows, the most an inventory list goes up to. */
const MAX_PAGES = 500;

/** `/files` documents a `limit` of up to 10,000, so the same 50,000 rows take far fewer requests. */
export const FILE_PAGES = { pageSize: 10_000, maxPages: 5 };

/**
 * One bucket a page over the manifest's `maxHistoryDays`, the slowest a cost read of
 * the full history could go. Costs are not resource rows, so 50,000 is not their limit.
 */
const MAX_BUCKET_PAGES = 400;

/** What a usage chart reads: part of a long window is fine there. */
export const CHART_PAGES = { maxPages: 10, partial: true };

function fieldOf(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * `has_more` said there is more and nothing says how to reach it. Ending here would
 * read the rest as deleted.
 */
function noWayOn(items: readonly unknown[]): never {
  throw new ListTruncatedError({ vendor: VENDOR, path: "this list", items: items.length });
}

/**
 * Only some answers hand back an explicit `last_id`: the admin endpoints (projects,
 * users, invites, project API keys) and vector stores, containers and evals do, while
 * fine-tuning jobs do not and the cursor is read off the last element. Preferring
 * `last_id` and falling back to the element covers both.
 */
function nextAfter({ body, items }: PageAnswer): string {
  return (
    text(fieldOf(body, "last_id")) ?? text(fieldOf(items[items.length - 1], "id")) ?? noWayOn(items)
  );
}

function nextUsagePage({ body, items }: PageAnswer): string {
  return text(fieldOf(body, "next_page")) ?? noWayOn(items);
}

export interface OpenAITransport {
  http: HttpHostServices | undefined;
  caCert: string;
  /** Thrown instead of sending anything when `key` is empty. */
  guard?: string;
}

export type OpenAIApi = CursorApiClient<
  paths,
  { cursorParam: "after"; sizeParam: "limit"; next: NextPage; hasMore: "has_more" }
> & {
  buckets: CursorApiClient<
    paths,
    { cursorParam: "page"; sizeParam: never; next: NextPage; hasMore: "has_more" }
  >;
};

export function createOpenAIApi(key: string, transport: OpenAITransport): OpenAIApi {
  const { http, caCert, guard } = transport;
  const headers = { Authorization: `Bearer ${key}`, Accept: "application/json" };
  const api = createApiClient<paths>({
    vendor: VENDOR,
    baseUrl: API_BASE,
    headers: () => {
      if (guard !== undefined && key === "") throw new Error(guard);
      return headers;
    },
    http,
    caCert,
  });
  return {
    ...withCursorPagination(api, {
      cursorParam: "after",
      sizeParam: "limit",
      pageSize: PAGE_SIZE,
      maxPages: MAX_PAGES,
      next: nextAfter,
      hasMore: "has_more",
      // Every list document requires `has_more`, so that is what ends a list.
      continueOnEmptyPage: true,
    }),
    /**
     * Usage and costs don't use the `after` cursor at all: they page with an opaque
     * `page` token echoed back as `next_page`. `UsageResponse` requires `has_more`, and
     * an empty page that sets it still has more to come.
     */
    buckets: withCursorPagination(api, {
      cursorParam: "page",
      maxPages: MAX_BUCKET_PAGES,
      next: nextUsagePage,
      hasMore: "has_more",
      continueOnEmptyPage: true,
    }),
  };
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
