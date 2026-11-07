/**
 * Postmark REST transport.
 *
 * One host, two credentials. `https://api.postmarkapp.com` answers both the
 * account API (servers, domains, sender signatures), which takes the account
 * token in `X-Postmark-Account-Token`, and the server API (message streams,
 * webhooks, templates, suppressions, bounces, stats, messages), which takes a
 * server's own token in `X-Postmark-Server-Token`. The account API hands back
 * each server's tokens in `ApiTokens`, so an account token reaches everything.
 *
 * Errors come back as `{ ErrorCode, Message }` with the HTTP status carrying
 * the class (401 bad token, 404 missing, 422 invalid, 429 slow down).
 *
 * Verified against postmarkapp.com/developer/api/* (2026-10).
 */
import type { HttpHostServices } from "@infrawrench/plugin-base";
import { ListTruncatedError, requireListPage } from "@infrawrench/plugin-base";

export const API_BASE = "https://api.postmarkapp.com";
export const POSTMARK_HOSTNAMES = ["api.postmarkapp.com"];

/** Largest `count` the paged Postmark lists accept. */
export const MAX_PAGE = 500;

export type TokenKind = "account" | "server";

export interface PostmarkTransport {
  caCert?: string;
  http?: HttpHostServices;
}

/** A Postmark error, carrying the HTTP status and Postmark's own `ErrorCode`. */
export class PostmarkApiError extends Error {
  readonly status: number;
  readonly code: number | undefined;

  constructor(status: number, message: string, code?: number) {
    super(message);
    this.name = "PostmarkApiError";
    this.status = status;
    this.code = code;
  }
}

export function statusOf(err: unknown): number | undefined {
  return err instanceof PostmarkApiError ? err.status : undefined;
}

export function isAccessDenied(err: unknown): boolean {
  const s = statusOf(err);
  return s === 401 || s === 403;
}

export type QueryValue = string | number | boolean | undefined;

export interface PostmarkRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, QueryValue>;
  body?: unknown;
}

function describeError(status: number, body: string, path: string): PostmarkApiError {
  let message = body;
  let code: number | undefined;
  try {
    const parsed = JSON.parse(body) as { Message?: string; ErrorCode?: number };
    if (parsed.Message) message = parsed.Message;
    if (typeof parsed.ErrorCode === "number") code = parsed.ErrorCode;
  } catch {
    // Non-JSON body: keep the raw text.
  }
  const hint =
    status === 401
      ? " Check the token: account-level calls need the account API token, server-level calls a server API token."
      : status === 429
        ? " Postmark is rate limiting this token; try again shortly."
        : "";
  return new PostmarkApiError(
    status,
    `Postmark API error ${status} for ${path}: ${message || "(empty)"}${code !== undefined ? ` (code ${code})` : ""}.${hint}`,
    code,
  );
}

/** One request with either token kind. */
export async function postmarkFetch<T>(
  transport: PostmarkTransport,
  kind: TokenKind,
  token: string,
  path: string,
  req: PostmarkRequest = {},
): Promise<T> {
  const method = req.method ?? (req.body !== undefined ? "POST" : "GET");
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (v !== undefined && v !== "") qs.append(k, String(v));
  }
  const query = qs.toString();
  const url = `${API_BASE}${path}${query ? `?${query}` : ""}`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    [kind === "account" ? "X-Postmark-Account-Token" : "X-Postmark-Server-Token"]: token,
  };
  const body = req.body !== undefined ? JSON.stringify(req.body) : undefined;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let status: number;
  let text: string;
  if (transport.http) {
    const res = await transport.http.request({
      url,
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(transport.caCert ? { caCert: transport.caCert } : {}),
    });
    status = res.status;
    text = res.body;
  } else {
    const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
    status = res.status;
    text = await res.text();
  }
  if (status < 200 || status >= 300) throw describeError(status, text, path);
  if (status === 204 || !text) return undefined as T;
  return JSON.parse(text) as T;
}

/**
 * Rows a `count`/`offset` list reads before it throws. 20 pages of 500; no Postmark
 * account is near it for servers, domains, signatures, or a server's templates
 * (Postmark allows 100) and inbound rules.
 */
export const MAX_LIST_ITEMS = 10_000;

/**
 * Walk a `count`/`offset` list. Postmark returns `TotalCount` and the items
 * under a per-endpoint key (`Servers`, `Domains`, `SenderSignatures`,
 * `Templates`, `InboundRules`). A list longer than `maxItems` throws, since a
 * sync reads the rows it did not reach as deleted.
 */
export async function listPaged<T>(
  transport: PostmarkTransport,
  kind: TokenKind,
  token: string,
  path: string,
  key: string,
  query: Record<string, QueryValue> = {},
  maxItems = MAX_LIST_ITEMS,
): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; offset < maxItems; offset += MAX_PAGE) {
    // Untyped JSON: requireListPage checks the list is really an array.
    const res = await postmarkFetch<Record<string, T[] | null | undefined> | undefined>(
      transport,
      kind,
      token,
      path,
      { query: { ...query, count: MAX_PAGE, offset } },
    );
    const items = requireListPage(res?.[key], { vendor: "Postmark", path, key, page: res });
    out.push(...items);
    const total: unknown = res?.["TotalCount"];
    if (items.length < MAX_PAGE || (typeof total === "number" && out.length >= total)) {
      return out;
    }
  }
  throw new ListTruncatedError({ vendor: "Postmark", path, items: out.length, maxItems });
}
