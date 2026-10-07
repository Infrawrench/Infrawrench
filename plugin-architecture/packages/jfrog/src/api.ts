import type { HttpHostServices } from "@infrawrench/plugin-base";

/**
 * Everything one JFrog Platform request needs. Split out of the client so the
 * preflight probe and the tests can run without one.
 *
 * Every service of the platform hangs off the same origin: Artifactory under
 * `/artifactory/api`, Access (users, groups, permissions, tokens) under
 * `/access/api`, Xray under `/xray/api`. One base URL and one Bearer token
 * reach all of them.
 */
export interface JfrogContext {
  /** Platform origin without a trailing slash, e.g. `https://acme.jfrog.io`. */
  baseUrl: string;
  token: string;
  caCert?: string;
  http?: HttpHostServices;
}

/** Thrown for any non-2xx answer, carrying the status the poller classifies on. */
export class JfrogApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "JfrogApiError";
    this.status = status;
  }
}

/** HTTP status of a failed call, or 0 for a transport error. */
export function statusOf(err: unknown): number {
  return err instanceof JfrogApiError ? err.status : 0;
}

export type Query = Record<string, string | number | boolean | undefined>;

export function buildQuery(query: Query = {}): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === "") continue;
    // Artifactory uses bare flags (`?list&deep=1`): `true` renders as a flag.
    parts.push(
      v === true
        ? encodeURIComponent(k)
        : `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
    );
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

/**
 * Normalise what the user typed into a platform origin: add `https://`, drop
 * a trailing slash and any `/artifactory` or `/ui` suffix copied from the
 * browser's address bar.
 */
export function normaliseBaseUrl(raw: string): string {
  let value = raw.trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  value = value.replace(/\/+$/, "");
  value = value.replace(/\/(artifactory|ui|xray|access)(\/.*)?$/i, "");
  return value.replace(/\/+$/, "");
}

/**
 * JFrog errors come in three shapes: Artifactory's `{"errors":[{"status","message"}]}`,
 * Xray's `{"error":"..."}` and Access's `{"errors":[{"code","message"}]}`.
 * Pull the human message out of whichever it is.
 */
export function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      errors?: Array<{ message?: unknown }>;
      error?: unknown;
      message?: unknown;
    };
    const fromList = (parsed.errors ?? [])
      .map((e) => (typeof e.message === "string" ? e.message : ""))
      .filter(Boolean)
      .join("; ");
    if (fromList) return fromList;
    if (typeof parsed.error === "string") return parsed.error;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // Not JSON: fall through to the raw body.
  }
  return body.slice(0, 500);
}

export interface RequestOptions {
  method?: string;
  query?: Query;
  /** JSON-encoded unless it is already a string or bytes. */
  body?: unknown;
  contentType?: string;
}

/**
 * One request against the platform, with the token as a Bearer header.
 * Returns the raw text: several Artifactory endpoints answer `text/plain`
 * (`/system/ping`, `/storageinfo/calculate`, `/build/delete`).
 *
 * Routed through the host HTTP service whenever there is one: that is the
 * only path that honours bastion egress and a custom CA, which a self-hosted
 * platform behind a private CA needs.
 */
export async function jfrogText(
  ctx: JfrogContext,
  path: string,
  opts: RequestOptions = {},
): Promise<{ status: number; text: string }> {
  const url = `${ctx.baseUrl}${path}${buildQuery(opts.query)}`;
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
    Authorization: `Bearer ${ctx.token}`,
  };
  let body: string | Uint8Array | undefined;
  if (opts.body !== undefined) {
    if (typeof opts.body === "string" || opts.body instanceof Uint8Array) {
      body = opts.body;
      headers["Content-Type"] = opts.contentType ?? "application/octet-stream";
    } else {
      body = JSON.stringify(opts.body);
      headers["Content-Type"] = opts.contentType ?? "application/json";
    }
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
    const res = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: body as BodyInit } : {}),
    });
    status = res.status;
    text = await res.text();
  }
  if (status < 200 || status >= 300) {
    throw new JfrogApiError(status, `JFrog API error ${status} for ${path}: ${errorDetail(text)}`);
  }
  return { status, text };
}

/** `jfrogText` parsed as JSON (undefined for an empty body). */
export async function jfrogFetch<T>(
  ctx: JfrogContext,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const { text } = await jfrogText(ctx, path, opts);
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

/**
 * Every page of an Access `v2` list (`users`, `groups`, `permissions`), which
 * pages with an opaque `cursor` echoed back in the body. Bounded so a server
 * that keeps returning the same cursor cannot spin forever.
 */
export async function accessPaged<T>(
  ctx: JfrogContext,
  path: string,
  listKey: string,
  query: Query = {},
  maxPages = 20,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await jfrogFetch<Record<string, unknown>>(ctx, path, {
      query: { limit: 500, ...query, ...(cursor ? { cursor } : {}) },
    });
    const items = Array.isArray(res?.[listKey]) ? (res[listKey] as T[]) : [];
    out.push(...items);
    const next = typeof res?.["cursor"] === "string" ? (res["cursor"] as string) : undefined;
    if (!next || next === cursor || items.length === 0) break;
    cursor = next;
  }
  return out;
}

/** Encode each segment of a repository path, keeping the slashes. */
export function encodePath(path: string): string {
  return path
    .split("/")
    .filter((s) => s !== "")
    .map(encodeURIComponent)
    .join("/");
}
