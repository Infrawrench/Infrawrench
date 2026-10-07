import type { HttpHostServices } from "@infrawrench/plugin-base";

/**
 * Pulumi Cloud REST API (https://www.pulumi.com/docs/reference/cloud-rest-api/,
 * OpenAPI spec at https://api.pulumi.com/api/openapi/pulumi-spec.json,
 * verified 2026-10).
 *
 * - `Authorization: token <access token>` (the literal word `token`, not
 *   `Bearer`) and `Accept: application/vnd.pulumi+8` on every call.
 * - Managed Pulumi Cloud is `https://api.pulumi.com`; self-hosted installs
 *   have their own API URL.
 * - Lists page with `continuationToken` (stacks, environments, tokens,
 *   members) or `page`/`pageSize` (updates, deployments).
 * - ESC environment definitions are `application/x-yaml`, not JSON.
 */
export const DEFAULT_API_URL = "https://api.pulumi.com";

export interface PuContext {
  token: string;
  apiUrl: string;
  http?: HttpHostServices;
  caCert?: string;
}

export class PulumiApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PulumiApiError";
    this.status = status;
  }
}

export function statusOf(err: unknown): number {
  return err instanceof PulumiApiError ? err.status : 0;
}

export function isPermissionError(err: unknown): boolean {
  const s = statusOf(err);
  return s === 401 || s === 403;
}

/** `https://api.example.com/` → `https://api.example.com`; refuses anything but https. */
export function normaliseApiUrl(raw: string | undefined): string {
  const v = (raw ?? "").trim().replace(/\/+$/, "");
  if (!v) return DEFAULT_API_URL;
  let u: URL;
  try {
    u = new URL(v.includes("://") ? v : `https://${v}`);
  } catch {
    throw new Error(`Pulumi Cloud plugin: "${raw}" is not a URL`);
  }
  if (u.protocol !== "https:") throw new Error("Pulumi Cloud plugin: the API URL must use https");
  return `https://${u.host}`;
}

/** The console URL that matches an API URL (`api.pulumi.com` → `app.pulumi.com`). */
export function consoleUrl(apiUrl: string): string {
  const host = new URL(apiUrl).host;
  return host.startsWith("api.") ? `https://app.${host.slice(4)}` : `https://${host}`;
}

export type Query = Record<string, string | number | boolean | undefined | string[]>;

export function buildQuery(query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === "") continue;
    if (Array.isArray(v)) for (const x of v) params.append(k, x);
    else params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: string; code?: number };
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // not JSON
  }
  return body.slice(0, 500);
}

export interface RequestOptions {
  method?: string;
  query?: Query;
  body?: unknown;
  /** Send `body` as YAML text (ESC environment definitions). */
  yaml?: boolean;
  accept?: string;
}

/** One request; returns the raw body text. Throws {@link PulumiApiError} outside 2xx. */
export async function puRaw(
  ctx: PuContext,
  path: string,
  opts: RequestOptions = {},
): Promise<string> {
  const url = `${ctx.apiUrl}${path}${buildQuery(opts.query)}`;
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = {
    Accept: opts.accept ?? "application/vnd.pulumi+8",
    Authorization: `token ${ctx.token}`,
  };
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = opts.yaml ? String(opts.body) : JSON.stringify(opts.body);
    headers["Content-Type"] = opts.yaml ? "application/x-yaml" : "application/json";
  }
  let status: number;
  let text: string;
  if (ctx.http) {
    const res = await ctx.http.request({
      url,
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    });
    status = res.status;
    text = res.body;
  } else {
    const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
    status = res.status;
    text = await res.text();
  }
  if (status < 200 || status >= 300) {
    throw new PulumiApiError(
      status,
      `Pulumi Cloud API error ${status} for ${path}: ${errorDetail(text)}`,
    );
  }
  return text;
}

export async function puFetch<T>(
  ctx: PuContext,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const text = await puRaw(ctx, path, opts);
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Every page of a `continuationToken` list (`key` is the array property). */
export async function puPaged<T>(
  ctx: PuContext,
  path: string,
  key: string,
  query: Query = {},
  maxPages = 20,
  tokenParam = "continuationToken",
  nextKey = "continuationToken",
): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const res = await puFetch<Record<string, unknown>>(ctx, path, {
      query: { ...query, ...(token ? { [tokenParam]: token } : {}) },
    });
    const items = res?.[key];
    if (Array.isArray(items)) out.push(...(items as T[]));
    const next = res?.[nextKey];
    token = typeof next === "string" && next ? next : undefined;
    if (!token) break;
  }
  return out;
}

export const enc = encodeURIComponent;

/** `org/project/stack` path segment. */
export function stackPath(org: string, project: string, stack: string): string {
  return `/api/stacks/${enc(org)}/${enc(project)}/${enc(stack)}`;
}

/** The marker Pulumi puts on an encrypted secret value in state and outputs. */
export const SECRET_SIG = "4dabf18193072939515e22adb298388d";

export function isSecretValue(v: unknown): v is { ciphertext?: string; plaintext?: string } {
  return Boolean(
    v &&
    typeof v === "object" &&
    (v as Record<string, unknown>)[SECRET_SIG] === "1b47061264138c4ac30d75fd1eb44270",
  );
}
