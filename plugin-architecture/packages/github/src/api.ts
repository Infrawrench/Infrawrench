import {
  createApiClient,
  pathEncode,
  restRequest,
  type ApiClient,
  type ApiClientOptions,
  type HttpHostServices,
  type NoSlashString,
  findNextLink,
} from "@infrawrench/plugin-base";
import type { paths as DotcomPaths } from "./api-types.dotcom.gen.js";
import type { paths as GhecPaths } from "./api-types.ghec.gen.js";
import type { paths as RepoPaths } from "./api-types.repo.gen.js";

/**
 * Where an account's API lives. GitHub.com serves REST from `api.github.com`;
 * GitHub Enterprise Cloud with data residency gives every enterprise its own
 * subdomain of `ghe.com`, with REST and GraphQL at `api.SUBDOMAIN.ghe.com`
 * (GitHub docs, "Network details for GHE.com", verified 2026-10).
 */
export interface GitHubHost {
  /** The host the user signs in at, e.g. `github.com` or `octocorp.ghe.com`. */
  host: string;
  apiUrl: string;
  graphqlUrl: string;
  webUrl: string;
  dataResidency: boolean;
}

const GHE_COM = /^(?:https?:\/\/)?(?:api\.)?([a-z0-9][a-z0-9-]*)(?:\.ghe\.com)?\/?$/i;

/**
 * Accepts what people paste: blank or `github.com` for GitHub.com, and for
 * data residency the bare subdomain (`octocorp`), the sign-in host
 * (`octocorp.ghe.com`), its URL, or the API host. Anything else is rejected
 * rather than guessed at, because a token sent to the wrong host is a token
 * sent to someone else.
 */
export function resolveHost(raw: string | undefined): GitHubHost {
  const value = (raw ?? "").trim().replace(/\/+$/, "");
  const bare = value.replace(/^https?:\/\//i, "").toLowerCase();
  if (
    bare === "" ||
    bare === "github.com" ||
    bare === "www.github.com" ||
    bare === "api.github.com"
  ) {
    return {
      host: "github.com",
      apiUrl: "https://api.github.com",
      graphqlUrl: "https://api.github.com/graphql",
      webUrl: "https://github.com",
      dataResidency: false,
    };
  }
  const match = GHE_COM.exec(bare);
  if (!match || (bare.includes(".") && !bare.endsWith(".ghe.com"))) {
    throw new Error(
      `GitHub plugin: "${value}" is not github.com or a GHE.com subdomain. Enter github.com, or for GitHub Enterprise Cloud with data residency the address you sign in at, such as octocorp.ghe.com.`,
    );
  }
  const sub = match[1]!.toLowerCase();
  return {
    host: `${sub}.ghe.com`,
    apiUrl: `https://api.${sub}.ghe.com`,
    graphqlUrl: `https://api.${sub}.ghe.com/graphql`,
    webUrl: `https://${sub}.ghe.com`,
    dataResidency: true,
  };
}

/** The organization or enterprise an account is scoped to. */
export interface GitHubOwner {
  kind: "org" | "enterprise";
  slug: string;
}

/**
 * The owner credential is stored as `org:<login>` or `enterprise:<slug>`, the
 * ids the picker offers. A bare name typed by hand is an organization, since
 * that is by far the common case.
 */
export function parseOwner(raw: string | undefined): GitHubOwner | undefined {
  const value = (raw ?? "").trim();
  if (!value) return undefined;
  const m = /^(org|organization|enterprise|ent)[:/](.+)$/i.exec(value);
  if (m) {
    const kind = m[1]!.toLowerCase().startsWith("ent") ? "enterprise" : "org";
    return { kind, slug: m[2]!.trim() };
  }
  return { kind: "org", slug: value };
}

export function formatOwner(owner: GitHubOwner): string {
  return `${owner.kind}:${owner.slug}`;
}

/** Everything a request needs. Split out of the client so collectors can be tested alone. */
export interface GitHubContext {
  token: string;
  host: GitHubHost;
  owner: GitHubOwner;
  caCert?: string;
  http?: HttpHostServices;
}

/** What a client needs: the owner only decides which paths a caller writes. */
export type GitHubConnection = Pick<GitHubContext, "token" | "host" | "caCert" | "http">;

/** Thrown for any non-2xx answer, carrying the status callers branch on. */
export class GitHubApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

const STATUS_IN_MESSAGE = /GitHub API error (\d{3}) for ([^:]+): ([\s\S]*)$/;

/** GitHub errors are `{"message": "...", "documentation_url": "..."}`. */
function friendlyMessage(status: number, path: string, body: string): string {
  let detail = body;
  try {
    const parsed: { message?: string; errors?: Array<{ message?: string }> } = JSON.parse(body);
    const extra = (parsed.errors ?? [])
      .map((e) => e.message)
      .filter(Boolean)
      .join("; ");
    detail = [parsed.message, extra].filter(Boolean).join(": ") || body;
  } catch {
    // Not JSON; keep the raw body.
  }
  return `GitHub API error ${status} for ${path}: ${detail}`;
}

/**
 * What a non-2xx answer throws. Read back out of the message on purpose: a path
 * holding a colon, which only a cache id GitHub sent itself can do, does not match
 * and stays a plain `Error`, and a request must not change how it fails.
 */
function failure(status: number, path: string, body: string): Error {
  const message = `GitHub API error ${status} for ${path}: ${body}`;
  const m = STATUS_IN_MESSAGE.exec(message);
  if (!m) return new Error(message);
  const code = Number(m[1]);
  return new GitHubApiError(code, friendlyMessage(code, m[2]!, m[3]!));
}

function headers(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Infrawrench",
  };
}

/**
 * Routed through the host HTTP service whenever there is one: that is the only
 * path that honours bastion egress and a custom CA.
 */
function clientOptions(ctx: GitHubConnection): ApiClientOptions {
  return {
    vendor: "GitHub",
    baseUrl: ctx.host.apiUrl,
    headers: headers(ctx.token),
    http: ctx.http,
    caCert: ctx.caCert,
    httpError: ({ status, path, body }) => failure(status, path, body),
  };
}

export type DotcomApi = ApiClient<DotcomPaths>;
export type GhecApi = ApiClient<GhecPaths>;

/**
 * GitHub publishes one document per product and neither is a superset: only the
 * github.com one has the organization billing routes, only the Enterprise Cloud
 * one has `/enterprises/...`. A GHE.com host answers the same paths as github.com.
 */
export function dotcomApi(ctx: GitHubConnection): DotcomApi {
  return createApiClient<DotcomPaths>(clientOptions(ctx));
}

export function ghecApi(ctx: GitHubConnection): GhecApi {
  return createApiClient<GhecPaths>(clientOptions(ctx));
}

/**
 * The actions cache routes of one repository. Its id goes in the base URL because
 * it is not always two segments: each `/` in it stays a path separator, however
 * many there are.
 */
export function repoApi(ctx: GitHubConnection, fullName: string): ApiClient<RepoPaths> {
  const root = `/repos/${fullName.split("/").map(encodeURIComponent).join("/")}`;
  return createApiClient<RepoPaths>({
    ...clientOptions(ctx),
    baseUrl: `${ctx.host.apiUrl}${root}`,
    httpError: ({ status, path, body }) => failure(status, `${root}${path}`, body),
  });
}

/**
 * The owner's own call: organizations and enterprises have parallel routes in
 * different documents, so each writes its own path and gets its own types.
 */
export function byOwner<OrgAnswer, EnterpriseAnswer>(
  ctx: GitHubContext,
  calls: {
    org: (api: DotcomApi, org: NoSlashString) => Promise<OrgAnswer>;
    enterprise: (api: GhecApi, enterprise: NoSlashString) => Promise<EnterpriseAnswer>;
  },
): Promise<OrgAnswer | EnterpriseAnswer> {
  const slug = ownerSegment(ctx.owner);
  return ctx.owner.kind === "org"
    ? calls.org(dotcomApi(ctx), slug)
    : calls.enterprise(ghecApi(ctx), slug);
}

/**
 * For the list endpoints that paginate by cursor in the `Link` header
 * (`after`/`before`), where page numbers are refused. These never sent a
 * `Content-Type`, and a failure is always a {@link GitHubApiError}.
 */
function cursorClientOptions(ctx: GitHubConnection): ApiClientOptions {
  return {
    ...clientOptions(ctx),
    contentType: "with-body",
    emptyBodyIsUndefined: true,
    httpError: ({ status, path, body }) =>
      new GitHubApiError(status, friendlyMessage(status, path, body)),
  };
}

/** One page of the owner's Dependabot alerts, with the (lower-cased) response headers. */
export function dependabotAlertsPage(ctx: GitHubContext, query: { after?: string }) {
  const options = cursorClientOptions(ctx);
  const slug = ownerSegment(ctx.owner);
  const paged = { state: "open", per_page: 100, ...query };
  return ctx.owner.kind === "org"
    ? createApiClient<DotcomPaths>(options).getResponse(`/orgs/${slug}/dependabot/alerts`, {
        query: paged,
      })
    : createApiClient<GhecPaths>(options).getResponse(`/enterprises/${slug}/dependabot/alerts`, {
        query: paged,
      });
}

/** The `rel="next"` URL of a `Link` header, if there is one. */
export function nextLink(link: string | undefined): URL | undefined {
  const next = findNextLink(link);
  if (!next) return undefined;
  try {
    return new URL(next);
  } catch {
    return undefined;
  }
}

/** POST a GraphQL query. Returns `data` and any field errors; never throws on partial data. */
export async function ghGraphql<T>(
  ctx: GitHubConnection,
  query: string,
): Promise<{ data?: T; errors?: Array<{ message?: string; type?: string }> }> {
  const answer = await restRequest<{
    data?: T;
    errors?: Array<{ message?: string; type?: string }>;
  }>({
    vendor: "GitHub",
    url: ctx.host.graphqlUrl,
    errorPath: "/graphql",
    headers: headers(ctx.token),
    init: { method: "POST", body: JSON.stringify({ query, variables: {} }) },
    ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    ...(ctx.http ? { http: ctx.http } : {}),
    httpError: ({ status, body }) => failure(status, "/graphql", body),
  });
  return answer.body;
}

/** The paging parameters of one page, for a call to spread into its `query`. */
export interface PageQuery {
  per_page: number;
  page: number;
}

/**
 * Page through a list endpoint (`per_page` / `page`, 100 a page at most).
 * `pick` extracts the array from GitHub's `{ total_count, <things>: [] }`
 * wrapper. Stops on a short page and hard-stops at `maxPages`.
 */
export async function ghPaged<T, R>(
  fetchPage: (query: PageQuery) => Promise<R>,
  pick: (res: R) => readonly T[] | undefined,
  maxPages = 50,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetchPage({ per_page: 100, page });
    const batch = pick(res) ?? [];
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

/** HTTP status of a failed call, or 0 for a transport error. */
export function statusOf(err: unknown): number {
  return err instanceof GitHubApiError ? err.status : 0;
}

/** URL path segment for the owner: `/orgs/acme` style roots differ per API family. */
export function ownerSegment(owner: GitHubOwner): NoSlashString {
  return pathEncode(owner.slug);
}

/**
 * The billing family lives under `/organizations/{org}/settings/billing/…`
 * for organizations and `/enterprises/{enterprise}/settings/billing/…` for
 * enterprises. Note `organizations`, not `orgs`: the enhanced billing
 * platform's routes use the long form.
 */
export function billingBase(owner: GitHubOwner): string {
  return owner.kind === "org"
    ? `/organizations/${ownerSegment(owner)}/settings/billing`
    : `/enterprises/${ownerSegment(owner)}/settings/billing`;
}

/** Root of the classic org/enterprise families (`/orgs/{org}`, `/enterprises/{enterprise}`). */
export function ownerBase(owner: GitHubOwner): string {
  return owner.kind === "org"
    ? `/orgs/${ownerSegment(owner)}`
    : `/enterprises/${ownerSegment(owner)}`;
}

/**
 * A row the plugin reads without relying on any field: answers are not validated
 * at runtime, and rows are also built here from what a form or a list already held.
 */
export type Sparse<T> = T extends readonly (infer Item)[]
  ? readonly Sparse<Item>[]
  : T extends object
    ? { [K in keyof T]?: Sparse<T[K]> }
    : T;
