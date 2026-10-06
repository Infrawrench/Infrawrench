import type { HttpHostServices } from "@infrawrench/plugin-base";

/**
 * Convex has two HTTP APIs, both verified against their OpenAPI documents
 * (2026-10):
 *
 * - The **Management API** at `https://api.convex.dev/v1`
 *   (`/v1/openapi.json`): teams, projects, deployments, deploy keys, custom
 *   domains, members, invites, custom roles, access tokens, default
 *   environment variables. `Authorization: Bearer <token>`.
 * - The **Deployment API** on every deployment at `{deploymentUrl}/api/v1`
 *   (`@convex-dev/platform/deployment-openapi.json` in convex-backend):
 *   environment variables, pause/unpause, log streams, usage limits, current
 *   usage, canonical URLs, audit log. `Authorization: Convex <token>`, where
 *   a team access token works as well as a deploy key.
 *
 * Writes on both are `POST /…/verb_noun` RPC-style calls rather than REST
 * verbs, except `PATCH /projects/{id}` and `PATCH /deployments/{name}`.
 */
export const CONVEX_API = "https://api.convex.dev/v1";

export interface ConvexContext {
  token: string;
  http?: HttpHostServices;
  caCert?: string;
  /** Overridable for tests; production always uses {@link CONVEX_API}. */
  baseUrl?: string;
}

/** Thrown for any non-2xx answer, carrying the status the poller classifies on. */
export class ConvexApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, message: string, code = "") {
    super(message);
    this.name = "ConvexApiError";
    this.status = status;
    this.code = code;
  }
}

export function statusOf(err: unknown): number {
  return err instanceof ConvexApiError ? err.status : 0;
}

export type Query = Record<string, string | number | boolean | undefined>;

function withQuery(url: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

async function request(
  ctx: ConvexContext,
  method: string,
  url: string,
  authorization: string,
  body: unknown,
  label: string,
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: authorization,
    Accept: "application/json",
    ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
  };
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  let status: number;
  let text: string;
  if (ctx.http) {
    const res = await ctx.http.request({
      url,
      method,
      headers,
      ...(payload !== undefined ? { body: payload } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    });
    status = res.status;
    text = res.body;
  } else {
    const res = await fetch(url, {
      method,
      headers,
      ...(payload !== undefined ? { body: payload } : {}),
    });
    status = res.status;
    text = await res.text();
  }
  if (status < 200 || status >= 300) throw toError(status, label, text);
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Convex errors are `{code, message}`. */
export function toError(status: number, label: string, raw: string): ConvexApiError {
  let code = "";
  let message = "";
  try {
    const parsed = JSON.parse(raw) as { code?: unknown; message?: unknown };
    code = typeof parsed.code === "string" ? parsed.code : "";
    message = typeof parsed.message === "string" ? parsed.message : "";
  } catch {
    message = raw.slice(0, 300);
  }
  if (status === 401) {
    return new ConvexApiError(
      401,
      "Convex API error 401: the access token was rejected. Create a new team access token under Team Settings > Access Tokens and update the account.",
      code,
    );
  }
  return new ConvexApiError(
    status,
    `Convex API error ${status} for ${label}${code ? ` (${code})` : ""}${message ? `: ${message}` : ""}`,
    code,
  );
}

/** Management API call. */
export async function mgmt<T>(
  ctx: ConvexContext,
  method: string,
  path: string,
  body?: unknown,
  query?: Query,
): Promise<T> {
  return (await request(
    ctx,
    method,
    withQuery(`${ctx.baseUrl ?? CONVEX_API}${path}`, query),
    `Bearer ${ctx.token}`,
    body,
    path,
  )) as T;
}

/** Deployment API call against one deployment's own URL. */
export async function deploymentApi<T>(
  ctx: ConvexContext,
  deploymentUrl: string,
  method: string,
  path: string,
  body?: unknown,
  query?: Query,
): Promise<T> {
  return (await request(
    ctx,
    method,
    withQuery(`${deploymentUrl.replace(/\/+$/, "")}/api/v1${path}`, query),
    `Convex ${ctx.token}`,
    body,
    path,
  )) as T;
}

/** Drain a `{items, pagination: {hasMore, nextCursor}}` listing. */
export async function paged<T>(ctx: ConvexContext, path: string, query: Query = {}): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const res = await mgmt<{
      items?: T[];
      pagination?: { hasMore?: boolean; nextCursor?: string | null };
    }>(ctx, "GET", path, undefined, { ...query, limit: 100, ...(cursor ? { cursor } : {}) });
    out.push(...(res?.items ?? []));
    cursor = res?.pagination?.nextCursor ?? undefined;
    if (!res?.pagination?.hasMore || !cursor) return out;
  }
  return out;
}

export function enc(s: string | number): string {
  return encodeURIComponent(String(s));
}

// ---- wire shapes ---------------------------------------------------------------

export type DeploymentType = "dev" | "prod" | "preview" | "custom";

export interface CvTokenDetails {
  type: "teamToken" | "projectToken";
  id: number;
  teamId?: number;
  projectId?: number;
  name: string;
  createTime: number;
}

export interface CvProject {
  id: number;
  name: string;
  slug: string;
  teamId: number;
  teamSlug: string;
  createTime: number;
  prodDeploymentName?: string | null;
  devDeploymentName?: string | null;
}

export interface CvDeployment {
  kind: "cloud" | "local";
  id?: number;
  name: string;
  createTime: number;
  lastDeployTime?: number | null;
  deploymentType: DeploymentType;
  projectId: number;
  creator?: number | null;
  previewIdentifier?: string | null;
  region?: string;
  isDefault?: boolean;
  reference?: string;
  dashboardEditConfirmation?: boolean | null;
  deploymentUrl?: string;
  expiresAt?: number | null;
  class?: string;
  sendLogsToClient?: boolean | null;
}

export interface CvDeployKey {
  id: number;
  name: string;
  creationTime: number;
  lastUsedTime?: number | null;
  expiresAt?: number | null;
  creator?: number | null;
  managedBy?: unknown;
  allowedActions: string[];
}

export interface CvCustomDomain {
  creationTime: number;
  deploymentName: string;
  requestDestination: "convexCloud" | "convexSite";
  domain: string;
  verificationTime?: number | null;
}

export interface CvMember {
  id: number;
  name?: string | null;
  email: string;
  role: "admin" | "developer" | "custom";
  customRoles?: number[] | null;
}

export interface CvInvite {
  email: string;
  expired: boolean;
  role: string;
  customRoles?: number[] | null;
}

export interface CvCustomRole {
  id: number;
  teamId: number;
  name: string;
  description?: string | null;
  statements: Array<{ effect: string; actions: string | string[]; resource: string }>;
  creator?: number | null;
  createTime: number;
}

export interface CvAccessToken {
  id: number;
  name: string;
  creationTime: number;
  lastUsedTime?: number | null;
  expiresAt?: number | null;
  creator?: number | null;
}

export interface CvDefaultEnvVar {
  name: string;
  value: string;
  deploymentTypes: DeploymentType[];
}

export interface CvUsageLimit {
  id: string;
  metric: string;
  window: "day" | "month";
  limitType: "warning" | "disable";
  limit: number;
  enabled: boolean;
}

export interface CvUsage {
  metrics: Record<string, { unit: string; usage: { current_day: number; current_month: number } }>;
  seedStatus: "pending" | "partial" | "complete" | "failed";
}

export type CvLogStreamStatus =
  { type: "pending" | "restarting" | "active" | "deleting" } | { type: "failed"; reason: string };

export interface CvLogStream {
  logStreamType: string;
  id: string;
  status: CvLogStreamStatus;
  [key: string]: unknown;
}
