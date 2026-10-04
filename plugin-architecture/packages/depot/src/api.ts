/**
 * Depot API transport and wire shapes.
 *
 * Depot's public API is a set of Connect RPC services served from
 * `https://api.depot.dev` (verified against the generated client in
 * `github.com/depot/sdk-node`, `src/gen/depot/**`, October 2026, and
 * https://depot.dev/docs/api/overview). Connect speaks plain HTTP + JSON for
 * unary calls: `POST {base}/{package}.{Service}/{Method}` with a JSON body
 * and `Content-Type: application/json`. Auth is an organization token sent
 * as `Authorization: Bearer …`.
 *
 * The JSON is the canonical proto3 mapping, which decides three things the
 * shapes below encode:
 * - field names are lowerCamelCase (`project_id` → `projectId`);
 * - `google.protobuf.Timestamp` is an RFC 3339 string;
 * - fields holding their default value (0, "", false, empty list) are
 *   omitted, so every field is optional on the way in and readers default.
 * Enums are their full value names (`STATUS_SUCCESS`, `HARDWARE_4X4`).
 */

import { jsonRestFetch, type HttpHostServices } from "@infrawrench/plugin-base";

export const DEPOT_API_BASE = "https://api.depot.dev";
const VENDOR = "Depot";

/* -------------------------------------------------------------------------- */
/* Wire shapes                                                                 */
/* -------------------------------------------------------------------------- */

/** `depot.core.v1.CachePolicy`. `keep_bytes` is deprecated and ignored. */
export interface WireCachePolicy {
  keepGb?: number;
  keepDays?: number;
}

/** `depot.core.v1.Project`. */
export interface WireProject {
  projectId?: string;
  organizationId?: string;
  name?: string;
  regionId?: string;
  createdAt?: string;
  cachePolicy?: WireCachePolicy;
  hardware?: string;
}

/** `depot.core.v1.Build`. Status is `STATUS_RUNNING | _FAILED | _SUCCESS | _ERROR | _CANCELED`. */
export interface WireBuild {
  buildId?: string;
  status?: string;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  buildDurationSeconds?: number;
  savedDurationSeconds?: number;
  cachedSteps?: number;
  totalSteps?: number;
}

/** `depot.core.v1.ListTokensResponse.Token`: metadata only, the secret is never readable. */
export interface WireToken {
  tokenId?: string;
  description?: string;
}

/** `depot.core.v1.TrustPolicy`: one OIDC trust relationship, a oneof over four CI providers. */
export interface WireTrustPolicy {
  trustPolicyId?: string;
  github?: { repositoryOwner?: string; repository?: string };
  circleci?: { organizationUuid?: string; projectUuid?: string };
  buildkite?: { organizationSlug?: string; pipelineSlug?: string };
  gitlab?: { namespaceId?: string; projectId?: string };
}

/** `depot.build.v1.Image`. `sizeBytes` is a uint64, which proto3 JSON encodes as a string. */
export interface WireImage {
  tag?: string;
  digest?: string;
  pushedAt?: string;
  sizeBytes?: string | number;
}

/** `depot.core.v1.ProjectUsage`. */
export interface WireProjectUsage {
  projectId?: string;
  buildCount?: number;
  buildDurationSeconds?: number;
  layerCacheSizeGb?: number;
}

/** `depot.core.v1.ContainerBuildUsage`: one row per project, keyed by name only. */
export interface WireContainerBuildUsage {
  projectName?: string;
  buildCount?: number;
  minutesSaved?: number;
  minutesBilled?: number;
}

/** `depot.core.v1.GithubActionsJobUsageDetail`. */
export interface WireActionsJobDetail {
  workflow?: string;
  runner?: string;
  jobCount?: number;
  minutesElapsed?: number;
  minutesBilled?: number;
}

/** `depot.core.v1.GithubActionsJobsUsage`: one row per repository. */
export interface WireActionsUsage {
  repo?: string;
  total?: { jobCount?: number; minutesElapsed?: number; minutesBilled?: number };
  jobs?: WireActionsJobDetail[];
}

/** `depot.core.v1.StorageUsage`. */
export interface WireStorageUsage {
  storageType?: string;
  totalGb?: number;
}

/** `depot.core.v1.AgentSandboxUsage`. */
export interface WireSandboxUsage {
  agentType?: string;
  sandboxesCount?: number;
  minutesElapsed?: number;
  minutesBilled?: number;
}

/** `depot.core.v1.GetUsageResponse`. */
export interface WireUsage {
  periodStart?: string;
  periodEnd?: string;
  containerBuild?: WireContainerBuildUsage[];
  githubActionsJobs?: WireActionsUsage[];
  storage?: WireStorageUsage[];
  agentSandbox?: WireSandboxUsage[];
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                   */
/* -------------------------------------------------------------------------- */

export interface DepotTransport {
  token: string;
  http?: HttpHostServices | undefined;
  caCert?: string | undefined;
}

/**
 * One unary Connect call. Errors come back as a non-2xx status with a JSON
 * body `{code, message}`; `jsonRestFetch` folds both into the thrown message,
 * which is what the host shows.
 */
export async function connectCall<T>(
  transport: DepotTransport,
  method: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const result = await jsonRestFetch<T>({
    vendor: VENDOR,
    url: `${DEPOT_API_BASE}/${method}`,
    errorPath: method,
    headers: {
      Authorization: `Bearer ${transport.token}`,
      Accept: "application/json",
      "Connect-Protocol-Version": "1",
    },
    init: { method: "POST", body: JSON.stringify(body) },
    ...(transport.http ? { http: transport.http } : {}),
    ...(transport.http && transport.caCert ? { caCert: transport.caCert } : {}),
  });
  return (result ?? {}) as T;
}

/** Fully-qualified method names, so a typo is a compile error rather than a 404. */
export const RPC = {
  listProjects: "depot.core.v1.ProjectService/ListProjects",
  getProject: "depot.core.v1.ProjectService/GetProject",
  createProject: "depot.core.v1.ProjectService/CreateProject",
  updateProject: "depot.core.v1.ProjectService/UpdateProject",
  deleteProject: "depot.core.v1.ProjectService/DeleteProject",
  resetProject: "depot.core.v1.ProjectService/ResetProject",
  listTrustPolicies: "depot.core.v1.ProjectService/ListTrustPolicies",
  addTrustPolicy: "depot.core.v1.ProjectService/AddTrustPolicy",
  removeTrustPolicy: "depot.core.v1.ProjectService/RemoveTrustPolicy",
  listTokens: "depot.core.v1.ProjectService/ListTokens",
  createToken: "depot.core.v1.ProjectService/CreateToken",
  updateToken: "depot.core.v1.ProjectService/UpdateToken",
  deleteToken: "depot.core.v1.ProjectService/DeleteToken",
  listBuilds: "depot.core.v1.BuildService/ListBuilds",
  getBuild: "depot.core.v1.BuildService/GetBuild",
  listImages: "depot.build.v1.RegistryService/ListImages",
  deleteImage: "depot.build.v1.RegistryService/DeleteImage",
  listProjectUsage: "depot.core.v1.UsageService/ListProjectUsage",
  getUsage: "depot.core.v1.UsageService/GetUsage",
} as const;

/** Most pages any one listing walks, so a huge org cannot stall a sync pass. */
const MAX_PAGES = 20;

/**
 * Walk a `page_token` / `next_page_token` listing. Depot returns an empty
 * (or absent) token on the last page.
 */
export async function listAllPages<TItem, TResponse extends { nextPageToken?: string }>(
  transport: DepotTransport,
  method: string,
  body: Record<string, unknown>,
  pick: (response: TResponse) => TItem[] | undefined,
  options: { pageSize?: number; maxPages?: number; stop?: (items: TItem[]) => boolean } = {},
): Promise<TItem[]> {
  const out: TItem[] = [];
  let pageToken: string | undefined;
  const maxPages = options.maxPages ?? MAX_PAGES;
  for (let page = 0; page < maxPages; page++) {
    const response = await connectCall<TResponse>(transport, method, {
      ...body,
      ...(options.pageSize ? { pageSize: options.pageSize } : {}),
      ...(pageToken ? { pageToken } : {}),
    });
    const items = pick(response) ?? [];
    out.push(...items);
    if (options.stop?.(items)) break;
    pageToken = response.nextPageToken || undefined;
    if (!pageToken || items.length === 0) break;
  }
  return out;
}

/** `Promise.all` over `items` with at most `limit` calls in flight. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Usage for `[startMs, endMs)`, via `UsageService/GetUsage`. Depot's own
 * example asks for a month as `…-01T00:00:00Z` to `…-30T23:59:59Z`, so the
 * end is treated as inclusive: it is sent one millisecond before `endMs`,
 * which keeps adjacent windows from both counting a boundary instant.
 */
export function getUsage(
  transport: DepotTransport,
  startMs: number,
  endMs: number,
): Promise<WireUsage> {
  return connectCall<WireUsage>(transport, RPC.getUsage, {
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(endMs - 1).toISOString(),
  });
}
