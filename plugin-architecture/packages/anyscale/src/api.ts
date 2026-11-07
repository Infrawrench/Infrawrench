import {
  createApiClient,
  ListTruncatedError,
  requireListPage,
  type ApiClient,
  type HttpHostServices,
  type ParamValue,
} from "@infrawrench/plugin-base";
import type { components, paths } from "./api-types.gen.js";

/**
 * The Anyscale control plane. Every organization, whatever cloud its clusters
 * run on, is managed through this one host; the CLI and Python SDK call the
 * same `/api/v2` routes this plugin does (spec published at
 * https://console.anyscale.com/api/v2/openapi.json, verified 2026-10).
 */
export const ANYSCALE_HOST = "https://console.anyscale.com";

export type AnyscaleApi = ApiClient<paths>;

type Schemas = components["schemas"];

export type MiniUser = Schemas["MiniUser"];
// `Partial` where a row is read with something missing: `userinfo` falls back to
// nothing, a new project is built from what was submitted if it cannot be read back,
// and usage rows are taken apart field by field.
export type AsUserInfo = Partial<Schemas["UserInfo"]>;
export type AsOrganization = Partial<Schemas["Organization"]>;
export type AsProject = Partial<Schemas["Project"]>;
export type AsCloud = Schemas["DecoratedCloud"];
export type AsCluster = Schemas["DecoratedSession"];
export type AsWorkspace = Schemas["ExperimentalWorkspace"];
export type AsJob = Schemas["DecoratedProductionJob"];
export type AsService =
  Schemas["DecoratedListServiceAPIModel"] | Schemas["DecoratedProductionServiceV2APIModel"];
export type AsComputeConfig = Schemas["DecoratedComputeTemplate"];
export type AsComputeConfigBody = Schemas["DecoratedComputeTemplateConfig"];
export type AsBudget = Schemas["InstanceUsageBudget"];
export type AsSessionState = Schemas["SessionState"];
export type AsUsageByCluster = Partial<Schemas["UsageByCluster"]>;
export type AsUtilizationTimeseries = Schemas["Response_ClusterUtilizationTimeseries_"];
export type AsCreditRecord =
  Partial<Schemas["CreditRecordCreditV2"]> | Partial<Schemas["CreditRecordCommitV2"]>;
export type AsCredits = {
  [K in keyof Schemas["CreditsV2"]]?: Schemas["CreditsV2"][K] extends readonly (infer Row)[]
    ? Partial<Row>[]
    : Schemas["CreditsV2"][K];
};

/** Thrown for any non-2xx answer, carrying the status callers branch on. */
export class AnyscaleApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AnyscaleApiError";
    this.status = status;
  }
}

/** An empty value is not sent, and any other is its `String()`. */
function writeQuery(query: Record<string, ParamValue>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === "") continue;
    if (Array.isArray(v)) for (const item of v) params.append(k, String(item));
    else params.set(k, String(v));
  }
  return params.toString();
}

/**
 * The typed client. Anyscale authenticates API keys (user keys and service account
 * keys alike) as the `cli_token` cookie, which is exactly what the official CLI and
 * SDK send. Routed through the host HTTP service whenever there is one: that path
 * honours bastion egress, and it is the only path on which a `Cookie` header survives
 * (browsers forbid setting it from script).
 */
export function createAnyscaleApi(options: {
  apiKey: string;
  http?: HttpHostServices | undefined;
}): AnyscaleApi {
  return createApiClient<paths>({
    vendor: "Anyscale",
    baseUrl: ANYSCALE_HOST,
    headers: {
      Accept: "application/json",
      Cookie: `cli_token=${options.apiKey}`,
    },
    http: options.http,
    serializeQuery: writeQuery,
    httpError: ({ status, path, body }) =>
      new AnyscaleApiError(status, `Anyscale API error ${status} for ${path}: ${body}`),
  });
}

/** HTTP status of a failed call, or 0 for a transport error. */
export function statusOf(err: unknown): number {
  return err instanceof AnyscaleApiError ? err.status : 0;
}

/** True for the answers that mean "this key may not do that". */
export function isPermissionError(err: unknown): boolean {
  const status = statusOf(err);
  return status === 401 || status === 403;
}

interface ListPage<T> {
  results?: T[] | null;
  metadata?: { next_paging_token?: string | null };
}

/** The paging half of a list's query string, for the caller to send last. */
export interface PageQuery {
  count: number;
  paging_token?: string;
}

/** One list's route, for the errors, and how far to read it. */
export interface ListPlan {
  path: string;
  /** The route's page size, at the largest its document allows. */
  count: number;
  maxPages: number;
  /** Stop quietly at `maxPages`, for a read where part of the list is fine. */
  partial?: boolean;
}

/**
 * Walk a `paging_token` list to the end. Past `maxPages` it throws, because a sync
 * reads a short list as the rest having been deleted, unless the plan says `partial`.
 * Every Anyscale list route shares the `{ results, metadata.next_paging_token }`
 * envelope; GET routes take the token as a query parameter and POST search routes as
 * well. A hand loop because half of them page by POST, and an empty page with a token
 * still goes on.
 */
export async function listPages<T>(
  plan: ListPlan,
  fetchPage: (query: PageQuery) => Promise<ListPage<T>>,
): Promise<T[]> {
  const { path, count, maxPages, partial } = plan;
  const out: T[] = [];
  let token: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchPage({ count, ...(token ? { paging_token: token } : {}) });
    out.push(...requireListPage(res.results, { vendor: "Anyscale", path, key: "results" }));
    token = res.metadata?.next_paging_token ?? undefined;
    if (!token) return out;
  }
  if (partial) return out;
  throw new ListTruncatedError({ vendor: "Anyscale", path, items: out.length, maxPages });
}

/** Every cloud, or the first 10,000 when `partial`. */
export function listClouds(api: AnyscaleApi, partial = false): Promise<AsCloud[]> {
  return listPages({ path: "/api/v2/clouds/", count: 1000, maxPages: 10, partial }, (query) =>
    api.get("/api/v2/clouds/", { query }),
  );
}
