/**
 * Typed clients over the two documents `plugingen.json` names: the Hub and
 * Inference Endpoints. The router and the Inference Catalog are in neither, so
 * they stay on `hfJson`, and the Playground's stream on its own `fetch`.
 */
import {
  createApiClient,
  nextLinkHeader,
  unencodedSegment,
  withLinkPagination,
  type NoSlashString,
  type ParamValue,
} from "@infrawrench/plugin-base";
import type { paths as EndpointsPaths } from "./api-types.endpoints.gen.js";
import type { paths as HubPaths } from "./api-types.hub.gen.js";
import {
  ENDPOINTS_BASE,
  HUB_BASE,
  encRepo,
  hfError,
  hfRequestOptions,
  labelFor,
  type HfContext,
} from "./http.js";

/**
 * The document writes a repo as `{namespace}/{repo}`, and the plugin holds it as
 * one id and keeps however many slashes it has, including none. So a repo route
 * here takes the whole id as one placeholder, written with {@link repoSegment}.
 */
type RepoAsOneSegment<P> = {
  [
    K in keyof P as K extends `/api/${infer Kind}/{namespace}/{repo}${infer Rest}`
      ? `/api/${Kind}/{repoId}${Rest}`
      : K
  ]: P[K];
};

export type HubApiPaths = RepoAsOneSegment<HubPaths>;

/** A repo id for a path, each part encoded and its slashes kept. */
export function repoSegment(repoId: string): NoSlashString {
  return unencodedSegment(encRepo(repoId));
}

/** Names as written, so `expand[]` keeps its brackets, and values through `encodeURIComponent`. */
function repoQuery(query: Record<string, ParamValue>): string {
  return Object.entries(query)
    .flatMap(([name, value]) =>
      (Array.isArray(value) ? value : [value]).map(
        (item) => `${name}=${encodeURIComponent(String(item))}`,
      ),
    )
    .join("&");
}

export function createHfApis(ctx: HfContext) {
  const shared = {
    ...hfRequestOptions(ctx),
    httpError: ({ status, url, body }: { status: number; url: string; body: string }) =>
      hfError(status, labelFor(url), body),
  };
  const hub = { ...shared, baseUrl: HUB_BASE };
  // The Hub's listings. The document ends one by leaving `rel="next"` out, so an empty
  // page that still names another has more behind it, and huggingface.co is the only
  // host it hands out, so `withLinkPagination` refuses any other by default.
  const links = {
    next: nextLinkHeader(),
    continueOnEmptyPage: true,
    maxPages: 20,
  };
  return {
    hub: withLinkPagination(createApiClient<HubApiPaths>(hub), links),
    /** The Hub's repo routes, which spell their query differently. */
    repos: withLinkPagination(
      createApiClient<HubApiPaths>({ ...hub, serializeQuery: repoQuery }),
      links,
    ),
    endpoints: createApiClient<EndpointsPaths>({ ...shared, baseUrl: ENDPOINTS_BASE }),
  };
}

export type HfApis = ReturnType<typeof createHfApis>;
