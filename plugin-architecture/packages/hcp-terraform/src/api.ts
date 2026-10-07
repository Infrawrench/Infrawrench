import type { HttpHostServices } from "@infrawrench/plugin-base";

/**
 * HCP Terraform / Terraform Enterprise API v2
 * (https://developer.hashicorp.com/terraform/cloud-docs/api-docs, sources in
 * hashicorp/web-unified-docs, verified 2026-10).
 *
 * - Every request: `Authorization: Bearer <token>` and the JSON:API media
 *   type `application/vnd.api+json`.
 * - Base URL is `https://<hostname>/api/v2`; `app.terraform.io` for HCP
 *   Terraform, `app.eu.terraform.io` for HCP Europe, anything else is a
 *   Terraform Enterprise install.
 * - Lists page with `page[number]` / `page[size]` (max 100) and report
 *   `meta.pagination.next-page`.
 * - 30 requests a second per user; a 429 is waited out once.
 * - Missing entitlements and missing access both answer 404.
 */
export const DEFAULT_HOSTNAME = "app.terraform.io";

export interface TfContext {
  token: string;
  hostname: string;
  http?: HttpHostServices;
  caCert?: string;
  sleep?: (ms: number) => Promise<void>;
}

export class TfApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "TfApiError";
    this.status = status;
  }
}

export function statusOf(err: unknown): number {
  return err instanceof TfApiError ? err.status : 0;
}

export function isPermissionError(err: unknown): boolean {
  const s = statusOf(err);
  return s === 401 || s === 403;
}

/**
 * Normalise what the user typed into a bare hostname: drops a scheme, a path
 * and a trailing slash. Throws on anything that is not a plain DNS name.
 */
export function normaliseHostname(raw: string | undefined): string {
  let h = (raw ?? "").trim().toLowerCase();
  if (!h) return DEFAULT_HOSTNAME;
  h = h.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/.test(h)) {
    throw new Error(
      `HCP Terraform plugin: "${raw}" is not a hostname. Use app.terraform.io, app.eu.terraform.io or your Terraform Enterprise host, e.g. tfe.example.com.`,
    );
  }
  return h;
}

/** Hostnames that must never receive the token from a shared server. */
export function unsafeServerHostname(hostname: string): string | null {
  const h = hostname.replace(/:\d+$/, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return "an IP address";
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal")
  ) {
    return "a local name";
  }
  return null;
}

export function apiBase(ctx: TfContext): string {
  return `https://${ctx.hostname}/api/v2`;
}

export function appUrl(ctx: TfContext, path: string): string {
  return `https://${ctx.hostname}/app/${path.replace(/^\//, "")}`;
}

export type Query = Record<string, string | number | boolean | undefined>;

export function buildQuery(query: Query = {}): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

/** The human part of a JSON:API error document. */
export function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      errors?: Array<{ title?: string; detail?: string } | string>;
      message?: string;
    };
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      return parsed.errors
        .map((e) => (typeof e === "string" ? e : [e.title, e.detail].filter(Boolean).join(": ")))
        .filter(Boolean)
        .join("; ");
    }
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // Not JSON.
  }
  return body.slice(0, 500);
}

export interface RequestOptions {
  method?: string;
  query?: Query;
  body?: unknown;
  /** Send no Authorization header (archivist blob URLs carry their own secret). */
  anonymous?: boolean;
}

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

async function once(
  ctx: TfContext,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
): Promise<RawResponse> {
  if (ctx.http) {
    const res = await ctx.http.request({
      url,
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    });
    return { status: res.status, headers: res.headers ?? {}, text: res.body };
  }
  const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    out[k] = v;
  });
  return { status: res.status, headers: out, text: await res.text() };
}

/** One request; returns the raw body. Throws {@link TfApiError} outside 2xx. */
export async function tfRaw(
  ctx: TfContext,
  pathOrUrl: string,
  opts: RequestOptions = {},
): Promise<string> {
  const url = /^https:\/\//.test(pathOrUrl)
    ? pathOrUrl
    : `${apiBase(ctx)}${pathOrUrl}${buildQuery(opts.query)}`;
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = opts.anonymous
    ? {}
    : {
        Accept: "application/vnd.api+json",
        Authorization: `Bearer ${ctx.token}`,
      };
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  if (body !== undefined) headers["Content-Type"] = "application/vnd.api+json";
  let res = await once(ctx, url, method, headers, body);
  if (res.status === 429) {
    const reset = Number(header(res.headers, "x-ratelimit-reset") ?? 1);
    const waitMs = Math.min(10_000, Math.max(1, Number.isFinite(reset) ? reset : 1) * 1000);
    await (ctx.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(waitMs);
    res = await once(ctx, url, method, headers, body);
  }
  if (res.status < 200 || res.status >= 300) {
    const label = url.startsWith(apiBase(ctx))
      ? url.slice(apiBase(ctx).length).split("?")[0]
      : "blob download";
    throw new TfApiError(
      res.status,
      `HCP Terraform API error ${res.status} for ${label}: ${errorDetail(res.text)}`,
    );
  }
  return res.text;
}

// ---------------------------------------------------------------------------
// JSON:API
// ---------------------------------------------------------------------------

export interface Rel {
  data?: { id: string; type: string } | Array<{ id: string; type: string }> | null;
  links?: Record<string, string>;
}

export interface Doc<A = Record<string, unknown>> {
  id: string;
  type: string;
  attributes: A;
  relationships?: Record<string, Rel>;
  links?: Record<string, string>;
}

interface Envelope<T> {
  data: T;
  included?: Doc[];
  meta?: {
    pagination?: { "next-page"?: number | null; "total-count"?: number };
    continuation?: string | null;
  };
}

/** The id of a to-one relationship, if set. */
export function relId(doc: Doc, name: string): string | undefined {
  const d = doc.relationships?.[name]?.data;
  return d && !Array.isArray(d) ? d.id : undefined;
}

/** The ids of a to-many relationship. */
export function relIds(doc: Doc, name: string): string[] {
  const d = doc.relationships?.[name]?.data;
  return Array.isArray(d) ? d.map((x) => x.id) : [];
}

export async function tfGet<A>(
  ctx: TfContext,
  path: string,
  query: Query = {},
): Promise<Envelope<Doc<A>>> {
  return JSON.parse(await tfRaw(ctx, path, { query })) as Envelope<Doc<A>>;
}

/** POST/PATCH a JSON:API document; returns the response document (or undefined on 204). */
export async function tfWrite<A>(
  ctx: TfContext,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<Doc<A> | undefined> {
  const text = await tfRaw(ctx, path, { method, ...(body !== undefined ? { body } : {}) });
  if (!text) return undefined;
  const parsed = JSON.parse(text) as Envelope<Doc<A>>;
  return parsed.data;
}

export interface Page<A> {
  data: Doc<A>[];
  included: Doc[];
  total?: number;
}

/** Every page of a list, up to `maxPages` × 100 items. */
export async function tfList<A>(
  ctx: TfContext,
  path: string,
  query: Query = {},
  maxPages = 20,
): Promise<Page<A>> {
  const data: Doc<A>[] = [];
  const included: Doc[] = [];
  let page = 1;
  let total: number | undefined;
  for (let i = 0; i < maxPages; i++) {
    const res = JSON.parse(
      await tfRaw(ctx, path, {
        query: { ...query, "page[size]": query["page[size]"] ?? 100, "page[number]": page },
      }),
    ) as Envelope<Doc<A>[]>;
    data.push(...(Array.isArray(res.data) ? res.data : []));
    included.push(...(res.included ?? []));
    total = res.meta?.pagination?.["total-count"] ?? total;
    const next = res.meta?.pagination?.["next-page"];
    if (!next) break;
    page = next;
  }
  return { data, included, ...(total !== undefined ? { total } : {}) };
}

/** Only the total of a list (one item fetched). */
export async function tfCount(
  ctx: TfContext,
  path: string,
  query: Query = {},
): Promise<number | undefined> {
  const res = JSON.parse(
    await tfRaw(ctx, path, { query: { ...query, "page[size]": 1 } }),
  ) as Envelope<Doc[]>;
  return (
    res.meta?.pagination?.["total-count"] ?? (Array.isArray(res.data) ? res.data.length : undefined)
  );
}

/** Build a JSON:API request document. */
export function doc(
  type: string,
  attributes: Record<string, unknown>,
  relationships?: Record<string, unknown>,
  id?: string,
): { data: Record<string, unknown> } {
  return {
    data: {
      type,
      ...(id ? { id } : {}),
      attributes,
      ...(relationships && Object.keys(relationships).length > 0 ? { relationships } : {}),
    },
  };
}

export const enc = encodeURIComponent;

/**
 * Terraform logs with structured run output are JSON lines carrying
 * `@message`; older ones are plain text with ANSI colour. Both become text.
 */
export function cleanTerraformLog(raw: string): string {
  const out: string[] = [];
  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    const t = line.trim();
    if (t.startsWith("{") && t.endsWith("}")) {
      try {
        const j = JSON.parse(t) as { "@message"?: string; "@level"?: string };
        if (typeof j["@message"] === "string") {
          out.push(
            j["@level"] && j["@level"] !== "info"
              ? `[${j["@level"]}] ${j["@message"]}`
              : j["@message"],
          );
          continue;
        }
      } catch {
        // fall through
      }
    }
    out.push(line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/[\u0002\u0003]/g, ""));
  }
  return out.join("\n");
}
