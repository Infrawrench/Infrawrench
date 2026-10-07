import type { HttpHostServices } from "@infrawrench/plugin-base";

/**
 * Everything one Vault request needs. Vault takes the token in
 * `X-Vault-Token` and, on Enterprise and HCP Vault, the namespace in
 * `X-Vault-Namespace`. With AppRole credentials the context logs in at
 * `POST /v1/auth/<mount>/login` and caches the client token until shortly
 * before its lease runs out.
 */
export interface VaultContext {
  /** Origin without a trailing slash, e.g. `https://vault.example.com:8200`. */
  address: string;
  namespace?: string;
  token?: string;
  appRole?: { roleId: string; secretId: string; mount: string };
  caCert?: string;
  http?: HttpHostServices;
  /** AppRole login result, cached. */
  login?: { token: string; until: number };
}

export class VaultApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "VaultApiError";
    this.status = status;
  }
}

export function statusOf(err: unknown): number {
  return err instanceof VaultApiError ? err.status : 0;
}

/** `vault.example.com` → `https://vault.example.com:8200`-style origin, minus `/v1` and `/ui`. */
export function normaliseAddress(raw: string): string {
  let value = raw.trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  return value
    .replace(/\/+$/, "")
    .replace(/\/(v1|ui)(\/.*)?$/i, "")
    .replace(/\/+$/, "");
}

export function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { errors?: unknown[] };
    const errs = (parsed.errors ?? []).map(String).filter(Boolean);
    if (errs.length) return errs.join("; ");
  } catch {
    // Not JSON.
  }
  return body.slice(0, 500);
}

export type Query = Record<string, string | number | boolean | undefined>;

function buildQuery(query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query))
    if (v !== undefined && v !== "") params.set(k, String(v));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** Encode each segment of a Vault path, keeping the slashes. */
export function encodePath(path: string): string {
  return path
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
}

export interface RequestOptions {
  method?: string;
  query?: Query;
  body?: unknown;
  /** Return the parsed body for these non-2xx statuses instead of throwing (sys/health). */
  acceptStatuses?: number[];
  /** Override the Content-Type (PATCH needs `application/merge-patch+json`). */
  contentType?: string;
}

async function send(
  ctx: VaultContext,
  path: string,
  headers: Record<string, string>,
  opts: RequestOptions,
): Promise<{ status: number; text: string }> {
  const url = `${ctx.address}/v1${path}${buildQuery(opts.query)}`;
  const method = opts.method ?? "GET";
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const all: Record<string, string> = {
    Accept: "application/json",
    ...(ctx.namespace ? { "X-Vault-Namespace": ctx.namespace } : {}),
    ...(body !== undefined ? { "Content-Type": opts.contentType ?? "application/json" } : {}),
    ...headers,
  };
  if (ctx.http) {
    const res = await ctx.http.request({
      url,
      method,
      headers: all,
      ...(body !== undefined ? { body } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    });
    return { status: res.status, text: res.body };
  }
  const res = await fetch(url, { method, headers: all, ...(body !== undefined ? { body } : {}) });
  return { status: res.status, text: await res.text() };
}

async function appRoleLogin(ctx: VaultContext): Promise<string> {
  const role = ctx.appRole!;
  const res = await send(
    ctx,
    `/auth/${encodePath(role.mount)}/login`,
    {},
    {
      method: "POST",
      body: { role_id: role.roleId, secret_id: role.secretId },
    },
  );
  if (res.status < 200 || res.status >= 300) {
    throw new VaultApiError(
      res.status,
      `Vault AppRole login failed (${res.status}): ${errorDetail(res.text)}`,
    );
  }
  const auth = (
    JSON.parse(res.text) as { auth?: { client_token?: string; lease_duration?: number } }
  ).auth;
  if (!auth?.client_token) throw new VaultApiError(500, "Vault AppRole login returned no token");
  const ttl = auth.lease_duration && auth.lease_duration > 0 ? auth.lease_duration : 3600;
  // Renew by logging in again at 80% of the lease.
  ctx.login = { token: auth.client_token, until: Date.now() + ttl * 800 };
  return auth.client_token;
}

async function token(ctx: VaultContext): Promise<string> {
  if (ctx.token) return ctx.token;
  if (!ctx.appRole) throw new VaultApiError(401, "Vault plugin: no token or AppRole credentials");
  if (ctx.login && ctx.login.until > Date.now()) return ctx.login.token;
  return appRoleLogin(ctx);
}

/**
 * One authenticated Vault request; returns the parsed JSON body (or
 * undefined for 204). With AppRole a 403 caused by an expired login token
 * logs in again once.
 */
export async function vaultFetch<T>(
  ctx: VaultContext,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  let res = await send(ctx, path, { "X-Vault-Token": await token(ctx) }, opts);
  if (res.status === 403 && ctx.appRole && !ctx.token && ctx.login) {
    delete ctx.login;
    res = await send(ctx, path, { "X-Vault-Token": await token(ctx) }, opts);
  }
  const accepted = opts.acceptStatuses?.includes(res.status) ?? false;
  if (!accepted && (res.status < 200 || res.status >= 300)) {
    throw new VaultApiError(
      res.status,
      `Vault API error ${res.status} for ${path}: ${errorDetail(res.text)}`,
    );
  }
  if (!res.text) return undefined as T;
  try {
    return JSON.parse(res.text) as T;
  } catch {
    return res.text as unknown as T;
  }
}

/** A `LIST` (sent as `GET ?list=true`, which every proxy passes through); 404 means an empty list. */
export async function vaultList(ctx: VaultContext, path: string): Promise<string[]> {
  try {
    const res = await vaultFetch<{ data?: { keys?: string[] } }>(ctx, path, {
      query: { list: true },
    });
    return res?.data?.keys ?? [];
  } catch (err) {
    if (statusOf(err) === 404) return [];
    throw err;
  }
}

/** `sys/*` responses carry their payload in `data` on current Vault and at the top level on older ones. */
export function payload<T extends object>(res: unknown): T {
  const r = (res ?? {}) as { data?: unknown };
  return (r.data && typeof r.data === "object" ? r.data : r) as T;
}
