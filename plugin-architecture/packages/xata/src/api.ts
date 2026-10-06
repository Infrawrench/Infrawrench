import type { HttpHostServices } from "@infrawrench/plugin-base";

/**
 * Xata control-plane API (`https://api.xata.tech`, OpenAPI at
 * `https://api.xata.tech/openapi.json`; verified 2026-10). This is the
 * current Xata, a Postgres platform with copy-on-write branches; the old
 * `*.xata.sh` workspace/database API is gone.
 *
 * Auth is `Authorization: Bearer <api key>`. Organization keys act as an
 * organization Admin limited by their scopes; user keys act with the
 * creating member's role.
 *
 * SQL does not go through the control plane: the gateway on the branch's own
 * host (`https://{branch}.{region}.xata.tech/sql`) takes the branch
 * connection string in a `Connection-String` header and rejects the API key.
 */
export const XATA_API = "https://api.xata.tech";

export interface XataContext {
  token: string;
  http?: HttpHostServices;
  caCert?: string;
  baseUrl?: string;
}

export class XataApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "XataApiError";
    this.status = status;
  }
}

export function statusOf(err: unknown): number {
  return err instanceof XataApiError ? err.status : 0;
}

export type Query = Record<string, string | number | boolean | undefined>;

export async function send(
  ctx: XataContext,
  method: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  label: string,
): Promise<unknown> {
  const all: Record<string, string> = {
    Accept: "application/json",
    ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...headers,
  };
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  let status: number;
  let text: string;
  if (ctx.http) {
    const res = await ctx.http.request({
      url,
      method,
      headers: all,
      ...(payload !== undefined ? { body: payload } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    });
    status = res.status;
    text = res.body;
  } else {
    const res = await fetch(url, {
      method,
      headers: all,
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

export function toError(status: number, label: string, raw: string): XataApiError {
  let message = "";
  try {
    const parsed = JSON.parse(raw) as { message?: unknown; error?: unknown; id?: unknown };
    const m = parsed.message ?? parsed.error;
    if (typeof m === "string") message = m;
  } catch {
    message = raw.slice(0, 300);
  }
  if (status === 401) {
    return new XataApiError(
      401,
      "Xata API error 401: the API key was rejected. Create a new key in the Xata console under API Keys and update the account.",
    );
  }
  return new XataApiError(
    status,
    `Xata API error ${status} for ${label}${message ? `: ${message}` : ""}`,
  );
}

export async function xata<T>(
  ctx: XataContext,
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
  return (await send(
    ctx,
    method,
    `${ctx.baseUrl ?? XATA_API}${path}${qs ? `?${qs}` : ""}`,
    { Authorization: `Bearer ${ctx.token}` },
    body,
    path,
  )) as T;
}

export function enc(s: string): string {
  return encodeURIComponent(s);
}

// ---- wire shapes ---------------------------------------------------------------

export interface XOrg {
  id: string;
  name: string;
  status: {
    status: "enabled" | "disabled";
    disabled_by_admin: boolean;
    admin_reason?: string;
    billing_status: string;
    billing_reason?: string;
    usage_tier: string;
    created_at?: string;
  };
  marketplace?: string;
}

export interface XScaleToZero {
  enabled: boolean;
  inactivityPeriodMinutes: number;
}

export interface XProject {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  configuration: {
    scaleToZero: { baseBranches: XScaleToZero; childBranches: XScaleToZero };
    ipFiltering?: { enabled: boolean; cidr: Array<{ cidr: string; description?: string }> };
  };
}

export interface XBranchSummary {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  parentID?: string | null;
  region: string;
  publicAccess: boolean;
  backupsEnabled: boolean;
}

export interface XBranch extends XBranchSummary {
  status: {
    status: string;
    statusType: string;
    message?: string;
    lifecycle?: { state?: string; reason?: string; phase?: string };
    instanceCount: number;
    instanceReadyCount: number;
    instances: Array<{ id?: string; status?: string; primary?: boolean; targetPrimary?: boolean }>;
  };
  scaleToZero: XScaleToZero;
  configuration: {
    region: string;
    storage?: number;
    instanceType: string;
    image: string;
    replicas: number;
    postgresConfigurationParameters?: Record<string, string>;
    preloadLibraries?: string[];
  };
  backupConfiguration?: { retentionPeriod?: number; backupTime?: string };
}

export interface XCredentials {
  username: string;
  password: string;
  hostname: string;
  port: number;
  dbname: string;
  connectionString: string;
}

export interface XBackup {
  id: string;
  branchID: string;
  earliestRestore?: string;
  latestRestore?: string;
  description: string;
}

export interface XApiKey {
  id: string;
  name: string;
  preview: string;
  scopes: string[];
  projects: string[];
  branches: string[];
  created_at: string;
  expiry?: string | null;
  last_used?: string | null;
  token?: string;
}

export interface XMember {
  id: string;
  name: string;
  email: string;
  role: "admin" | "editor";
}

export interface XInvitation {
  id: string;
  email: string;
  first_name?: string;
  last_name?: string;
  created_at: string;
  expires_at: string;
  status: "pending" | "expired";
  role: "admin" | "editor";
}

export interface XInstanceType {
  name: string;
  vcpus: number;
  ram: number;
  hourlyRate: number;
  storageMonthlyRate: number;
  region: string;
}

export interface XRegion {
  id: string;
  publicAccess: boolean;
  backupsEnabled: boolean;
  provider: string;
  organizationId?: string;
}

export interface XImage {
  name: string;
  majorVersion: string;
  fullVersion: string;
  region?: string[];
}

export interface XInvoice {
  id: string;
  invoice_number: string;
  amount_due: number;
  currency: string;
  invoice_date: string;
  status: "draft" | "issued" | "paid" | "void" | "synced";
  invoice_pdf?: string;
}

export interface XPgParameter {
  name: string;
  type: "string" | "int" | "float" | "bytes" | "enum" | "duration" | "boolean";
  description: string;
  section: string;
  acceptableRange?: { minValue?: string; maxValue?: string; enumValues?: string[] };
  defaultValue: string;
  currentValue: string;
  restartRequired?: boolean;
}
