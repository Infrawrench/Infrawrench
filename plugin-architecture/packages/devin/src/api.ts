import type { HttpHostServices } from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";
import type { AcusByProduct } from "./pricing.js";

/**
 * Devin API v3 (https://docs.devin.ai/api-reference/overview, OpenAPI at
 * https://docs.devin.ai/v3-openapi.json, checked 2026-10).
 *
 * One host, `https://api.devin.ai`, Bearer auth with either a service user
 * credential (`cog_…`) or a personal access token. Organization endpoints live
 * under `/v3/organizations/{org_id}/…`, enterprise ones under
 * `/v3/enterprise/…`. An enterprise service user inherits the matching
 * org-level permission in every organization, so the org endpoints serve both
 * kinds of key and this plugin only ever calls those (plus the enterprise
 * organization listing, to find the orgs).
 *
 * Lists paginate with `first` (at most 200) and an opaque `after` cursor,
 * answering `{ items, end_cursor, has_next_page }`. Timestamps are Unix
 * seconds everywhere.
 */

export const API_BASE = "https://api.devin.ai";
export const APP_BASE = "https://app.devin.ai";
const PAGE_SIZE = 200;

export interface DevinContext {
  token: string;
  caCert?: string;
  http?: HttpHostServices;
}

export class DevinApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DevinApiError";
    this.status = status;
  }
}

const STATUS_IN_MESSAGE = /Devin API error (\d{3})/;

export function statusOf(err: unknown): number {
  return err instanceof DevinApiError ? err.status : 0;
}

export function isPermissionError(err: unknown): boolean {
  const s = statusOf(err);
  return s === 401 || s === 403;
}

export type QueryValue = string | number | boolean | undefined | null | readonly string[];

/** Query string with arrays as repeated keys (`tags=a&tags=b`), the form FastAPI reads. */
export function queryString(query: Record<string, QueryValue>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    const values = Array.isArray(value) ? value : [value as string | number | boolean];
    for (const v of values)
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

export async function devinFetch<T>(
  ctx: DevinContext,
  path: string,
  opts: { method?: string; query?: Record<string, QueryValue>; body?: unknown } = {},
): Promise<T> {
  const method = opts.method ?? "GET";
  try {
    return await jsonRestFetch<T>({
      vendor: "Devin",
      url: `${API_BASE}${path}${queryString(opts.query ?? {})}`,
      errorPath: path,
      headers: { Accept: "application/json", Authorization: `Bearer ${ctx.token}` },
      init: {
        method,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      },
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
      ...(ctx.http ? { http: ctx.http } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = Number(STATUS_IN_MESSAGE.exec(message)?.[1] ?? 0);
    if (status) throw new DevinApiError(status, message);
    throw err;
  }
}

interface Page<T> {
  items?: T[] | null;
  end_cursor?: string | null;
  has_next_page?: boolean;
}

/** Follow `after` cursors until the last page or `maxItems`. */
export async function paginate<T>(
  ctx: DevinContext,
  path: string,
  query: Record<string, QueryValue> = {},
  maxItems = 5000,
): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await devinFetch<Page<T>>(ctx, path, {
      query: { ...query, first: PAGE_SIZE, after },
    });
    out.push(...(page?.items ?? []));
    if (out.length >= maxItems) return out.slice(0, maxItems);
    if (!page?.has_next_page || !page.end_cursor) return out;
    after = page.end_cursor;
  }
}

// ---------------------------------------------------------------------------
// Wire types (the fields this plugin reads)
// ---------------------------------------------------------------------------

export interface DevinSelf {
  principal_type?: string;
  service_user_id?: string;
  service_user_name?: string;
  user_id?: string;
  user_name?: string | null;
  org_id?: string | null;
  devin_sessions_org_id?: string | null;
}

export interface DevinOrg {
  org_id: string;
  name?: string;
  max_session_acu_limit?: number | null;
  max_cycle_acu_limit?: number | null;
  created_at?: number;
}

export interface DevinSession {
  session_id: string;
  url?: string;
  status?: string;
  status_detail?: string | null;
  title?: string | null;
  tags?: string[];
  playbook_id?: string | null;
  user_id?: string | null;
  service_user_id?: string | null;
  org_id?: string;
  created_at?: number;
  updated_at?: number;
  is_archived?: boolean;
  acus_consumed?: number;
  pull_requests?: Array<{ pr_url: string; pr_state?: string | null }>;
  parent_session_id?: string | null;
  child_session_ids?: string[] | null;
  category?: string | null;
  subcategory?: string | null;
  origin?: string | null;
  automation_id?: string | null;
  devin_mode?: string | null;
}

export interface DevinPlaybook {
  playbook_id: string;
  title?: string;
  body?: string;
  macro?: string | null;
  created_by?: string;
  updated_by?: string;
  created_at?: number;
  updated_at?: number;
  access_type?: string;
  structured_output_schema?: Record<string, unknown> | null;
}

export interface DevinNote {
  note_id: string;
  folder_id?: string | null;
  folder_path?: string;
  name?: string;
  body?: string;
  trigger?: string;
  is_enabled?: boolean;
  created_at?: number;
  updated_at?: number;
  access_type?: string;
  macro?: string | null;
  pinned_repo?: string | null;
}

export interface DevinSecret {
  secret_id: string;
  key?: string | null;
  note?: string | null;
  is_sensitive?: boolean;
  created_by?: string;
  created_at?: number;
  secret_type?: string;
  access_type?: string;
  updated_at?: number | null;
  updated_by?: string | null;
}

export interface DevinUser {
  user_id: string;
  email?: string | null;
  name?: string | null;
  role_assignments?: Array<{ role?: { role_name?: string }; org_id?: string | null }>;
}

export interface DevinAutomation {
  automation_id: string;
  name?: string;
  enabled?: boolean;
  triggers?: Array<{ event_type?: string }>;
  created_by?: { type?: string; id?: string; name?: string | null };
  created_at?: number;
  updated_at?: number;
  last_invocation?: { fired_at?: number; status?: string } | null;
  next_run_at?: number | null;
}

export interface ConsumptionDay {
  date: number;
  acus: number;
  acus_by_product?: AcusByProduct;
}

export interface Consumption {
  total_acus?: number;
  consumption_by_date?: ConsumptionDay[];
}

export interface UsageMetrics {
  sessions_count?: number;
  searches_count?: number;
  prs_created_count?: number;
  prs_merged_count?: number;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export const orgPath = (orgId: string, rest = "") =>
  `/v3/organizations/${encodeURIComponent(orgId)}${rest}`;

export function getSelf(ctx: DevinContext): Promise<DevinSelf> {
  return devinFetch<DevinSelf>(ctx, "/v3/self");
}

/**
 * The organizations this key works in. An org-scoped service user names its
 * org in `/v3/self`. An enterprise key (no org there) lists every org in the
 * enterprise. A personal access token tries the enterprise listing too, and
 * falls back to the org its sessions run in.
 */
export async function resolveOrgs(
  ctx: DevinContext,
): Promise<{ self: DevinSelf; orgs: DevinOrg[] }> {
  const self = await getSelf(ctx);
  if (self.org_id && self.principal_type !== "pat_user") {
    return { self, orgs: [{ org_id: self.org_id, name: self.org_id }] };
  }
  try {
    const orgs = await paginate<DevinOrg>(ctx, "/v3/enterprise/organizations");
    if (orgs.length > 0) return { self, orgs };
  } catch (err) {
    if (!isPermissionError(err) && statusOf(err) !== 404) throw err;
  }
  const fallback = self.org_id ?? self.devin_sessions_org_id;
  if (fallback) return { self, orgs: [{ org_id: fallback, name: fallback }] };
  throw new Error(
    "Devin: this key is not scoped to an organization and cannot list the enterprise's organizations. Use an organization service user, or give the enterprise service user a role that can view organizations.",
  );
}

/** Unix seconds of a Devin billing-day boundary: midnight PST, 08:00 UTC, for `YYYY-MM-DD`. */
export function dayStartSeconds(date: string): number {
  return Date.parse(`${date}T08:00:00Z`) / 1000;
}

/** The billing day (`YYYY-MM-DD`) a Unix timestamp falls on, with days starting 08:00 UTC. */
export function billingDay(seconds: number): string {
  return new Date((seconds - 8 * 3600) * 1000).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Daily ACUs for `[fromDate, toDate]` (inclusive billing days) at an org-scoped consumption path. */
export async function fetchConsumption(
  ctx: DevinContext,
  path: string,
  fromDate: string,
  toDate: string,
): Promise<ConsumptionDay[]> {
  const res = await devinFetch<Consumption>(ctx, path, {
    query: {
      time_after: dayStartSeconds(fromDate),
      time_before: dayStartSeconds(addDays(toDate, 1)),
    },
  });
  return (res?.consumption_by_date ?? []).filter((d) => {
    const day = billingDay(d.date);
    return day >= fromDate && day <= toDate;
  });
}

/** Run `fn` over `items`, at most `limit` at a time. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}
