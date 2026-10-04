import type { HttpHostServices } from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";

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
    const parsed = JSON.parse(body) as { message?: string; errors?: Array<{ message?: string }> };
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

type Query = Record<string, string | number | boolean | undefined>;

function headers(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Infrawrench",
  };
}

/**
 * JSON request against the account's API host. Routed through the host HTTP
 * service whenever there is one: that is the only path that honours bastion
 * egress and a custom CA.
 */
export async function ghFetch<T>(
  ctx: Pick<GitHubContext, "token" | "host" | "caCert" | "http">,
  path: string,
  init?: Omit<RequestInit, "body"> & { query?: Query; body?: unknown },
): Promise<T> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(init?.query ?? {})) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  const { query: _query, body, ...rest } = init ?? {};
  const requestInit: RequestInit = {
    ...rest,
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  };
  try {
    return await jsonRestFetch<T>({
      vendor: "GitHub",
      url: `${ctx.host.apiUrl}${path}${qs ? `?${qs}` : ""}`,
      errorPath: path,
      headers: headers(ctx.token),
      ...(Object.keys(requestInit).length > 0 ? { init: requestInit } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
      ...(ctx.http ? { http: ctx.http } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const m = STATUS_IN_MESSAGE.exec(message);
    if (m) {
      const status = Number(m[1]);
      throw new GitHubApiError(status, friendlyMessage(status, m[2]!, m[3]!));
    }
    throw err;
  }
}

/** POST a GraphQL query. Returns `data` and any field errors; never throws on partial data. */
export async function ghGraphql<T>(
  ctx: Pick<GitHubContext, "token" | "host" | "caCert" | "http">,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<{ data?: T; errors?: Array<{ message?: string; type?: string }> }> {
  try {
    return await jsonRestFetch({
      vendor: "GitHub",
      url: ctx.host.graphqlUrl,
      errorPath: "/graphql",
      headers: headers(ctx.token),
      init: { method: "POST", body: JSON.stringify({ query, variables }) },
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
      ...(ctx.http ? { http: ctx.http } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const m = STATUS_IN_MESSAGE.exec(message);
    if (m) {
      const status = Number(m[1]);
      throw new GitHubApiError(status, friendlyMessage(status, m[2]!, m[3]!));
    }
    throw err;
  }
}

/**
 * Page through a list endpoint (`per_page` / `page`, 100 a page at most).
 * `pick` extracts the array from GitHub's `{ total_count, <things>: [] }`
 * wrapper. Stops on a short page and hard-stops at `maxPages`.
 */
export async function ghPaged<T, R = unknown>(
  ctx: GitHubContext,
  path: string,
  pick: (res: R) => T[] | undefined,
  query: Query = {},
  maxPages = 50,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await ghFetch<R>(ctx, path, { query: { ...query, per_page: 100, page } });
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
export function ownerSegment(owner: GitHubOwner): string {
  return encodeURIComponent(owner.slug);
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
