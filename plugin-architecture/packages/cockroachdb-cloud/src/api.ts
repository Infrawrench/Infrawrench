import type { HttpHostServices } from "@infrawrench/plugin-base";

/**
 * CockroachDB Cloud API (`https://cockroachlabs.cloud/api/v1`). Verified
 * against the OpenAPI document the official Go SDK vendors
 * (`cockroachdb/cockroach-cloud-sdk-go`, `internal/spec/openapi.json`, API
 * version 2026-09-15) and docs.cockroachlabs.com/docs/cockroachcloud/cloud-api.
 *
 * - Auth: `Authorization: Bearer <secret>` where the secret is an API key of a
 *   service account (`CCDB1_…`), which carries that account's roles.
 * - `Cc-Version` pins the API version; omitting it means "latest".
 * - 10 requests a second per user, answered with 429 + `Retry-After`.
 * - Lists page with `pagination.page` / `pagination.limit` and answer
 *   `pagination.next_page`.
 * - Errors are `{code, message, details}` (gRPC status shape).
 */
export const CRDB_API = "https://cockroachlabs.cloud";
export const CC_VERSION = "2026-09-15";

export interface CrdbContext {
  token: string;
  http?: HttpHostServices;
  caCert?: string;
  baseUrl?: string;
}

export class CrdbApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CrdbApiError";
    this.status = status;
  }
}

export function statusOf(err: unknown): number {
  return err instanceof CrdbApiError ? err.status : 0;
}

export type Query = Record<string, string | number | boolean | undefined>;

export async function crdb<T>(
  ctx: CrdbContext,
  method: string,
  path: string,
  body?: unknown,
  query?: Query,
): Promise<T> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  const url = `${ctx.baseUrl ?? CRDB_API}${path}${qs ? `?${qs}` : ""}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${ctx.token}`,
    Accept: "application/json",
    "Cc-Version": CC_VERSION,
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
  if (status < 200 || status >= 300) throw toError(status, path, text);
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export function toError(status: number, path: string, raw: string): CrdbApiError {
  let message = "";
  try {
    const parsed = JSON.parse(raw) as { message?: unknown };
    if (typeof parsed.message === "string") message = parsed.message;
  } catch {
    message = raw.slice(0, 300);
  }
  if (status === 401) {
    return new CrdbApiError(
      401,
      "CockroachDB Cloud API error 401: the API key was rejected. Create a new key for a service account under Organization > Access Management > Service Accounts.",
    );
  }
  if (status === 429) {
    return new CrdbApiError(
      429,
      `CockroachDB Cloud API error 429 for ${path}: rate limited (10 requests a second). Try again shortly.`,
    );
  }
  return new CrdbApiError(
    status,
    `CockroachDB Cloud API error ${status} for ${path}${message ? `: ${message}` : ""}`,
  );
}

/** Drain a `pagination.page`-paged list. */
export async function paged<T>(
  ctx: CrdbContext,
  path: string,
  key: string,
  query: Query = {},
): Promise<T[]> {
  const out: T[] = [];
  let page: string | undefined;
  for (let i = 0; i < 100; i++) {
    const res = await crdb<Record<string, unknown> & { pagination?: { next_page?: string } }>(
      ctx,
      "GET",
      path,
      undefined,
      { ...query, "pagination.limit": 200, ...(page ? { "pagination.page": page } : {}) },
    );
    const items = res?.[key];
    if (Array.isArray(items)) out.push(...(items as T[]));
    page = res?.pagination?.next_page || undefined;
    if (!page) return out;
  }
  return out;
}

export function enc(s: string): string {
  return encodeURIComponent(s);
}

// ---- wire shapes ---------------------------------------------------------------

export type Plan = "BASIC" | "STANDARD" | "ADVANCED";

export interface CRegion {
  name: string;
  node_count: number;
  sql_dns: string;
  ui_dns: string;
  internal_dns: string;
  primary?: boolean;
  machine_type?: string;
  num_virtual_cpus?: number;
  disk_iops?: number;
}

export interface CCluster {
  id: string;
  name: string;
  cloud_provider: "GCP" | "AWS" | "AZURE";
  cockroach_version: string;
  plan?: Plan;
  edition?: string;
  state: string;
  operation_status: string;
  upgrade_status: string;
  delete_protection?: "ENABLED" | "DISABLED";
  network_visibility?: "PUBLIC" | "PRIVATE";
  egress_traffic_policy?: string;
  parent_id?: string;
  labels?: Record<string, string>;
  sql_dns?: string;
  created_at?: string;
  regions: CRegion[];
  config: {
    dedicated?: {
      machine_type: string;
      num_virtual_cpus: number;
      storage_gib: number;
      memory_gib: number;
      disk_iops: number;
    };
    host?: {
      machine_type: string;
      num_virtual_cpus: number;
      storage_gib: number;
      memory_gib: number;
      disk_iops: number;
    };
    serverless?: {
      routing_id: string;
      upgrade_type?: "MANUAL" | "AUTOMATIC";
      usage_limits?: {
        provisioned_virtual_cpus?: string;
        request_unit_limit?: string;
        storage_mib_limit?: string;
      };
    };
    virtual?: { routing_id: string; workspace_id: string };
  };
}

export interface CBackupConfig {
  enabled: boolean;
  frequency_minutes: number;
  retention_days: number;
}

export interface CAllowlistEntry {
  cidr_ip: string;
  cidr_mask: number;
  name?: string;
  sql: boolean;
  ui: boolean;
}

export interface CFolder {
  resource_id: string;
  name: string;
  parent_id: string;
  path: Array<{ id?: string; name?: string }>;
  labels?: Record<string, string>;
}

export interface CServiceAccount {
  id: string;
  name: string;
  description: string;
  creator_name: string;
  created_at: string;
  roles: Array<{ name: string; resource: { type: string; id?: string } }>;
}

export interface CApiKey {
  id: string;
  name: string;
  service_account_id: string;
  created_at: string;
}

export interface CCurrencyAmount {
  amount?: number;
  currency?: "USD" | "CRDB_CLOUD_CREDITS" | "COCKROACH_CREDITS";
}

export interface CInvoice {
  invoice_id: string;
  period_start: string;
  period_end: string;
  status?: "FINALIZED" | "DRAFT";
  totals: CCurrencyAmount[];
  balances: CCurrencyAmount[];
  adjustments?: Array<{ name: string; amount: CCurrencyAmount }>;
  invoice_items: Array<{
    cluster: Pick<CCluster, "id" | "name" | "regions" | "cloud_provider" | "plan" | "labels">;
    totals: CCurrencyAmount[];
    line_items: Array<{
      description: string;
      quantity: number;
      quantity_unit: string;
      unit_cost: number;
      total: CCurrencyAmount;
    }>;
  }>;
}
