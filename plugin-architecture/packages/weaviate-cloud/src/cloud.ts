import type { HostServices } from "@infrawrench/plugin-base";
import type { WcCluster, WcRegion, WcWhoAmI } from "./types.js";

/**
 * Weaviate Cloud's provisioning API, the organization-level half of the
 * plugin. It is not in docs.weaviate.io: the source of truth is Weaviate's
 * own CLI, `wcloud` (github.com/weaviate/weaviate-cloud, MIT, beta v0.1,
 * checked 2026-10 at v0.1.1), whose `internal/api` package calls exactly
 * these routes:
 *
 *   GET  /v1/whoami          {user_id, email, org_id}
 *   GET  /v1/regions         [{id, name, cloud_provider, status, is_default}]
 *   GET  /v1/clusters        this organization's READY clusters, unpaginated
 *   GET  /v1/clusters/{id}   one cluster; carries the one-time `api_key`
 *                            on its first READY read
 *   POST /v1/clusters        {name?, region?, tier?} + `Idempotency-Key`
 *
 * Bodies are enveloped `{data, metadata}`, errors `{error: {code, message}}`
 * with frozen codes (`quota_exceeded`, `cluster_not_found`, ...). There are
 * no routes for delete, resize, upgrade, backups, members, API keys or
 * billing, and the only tier the API accepts is `free`.
 *
 * Auth is OAuth only, no API keys: `wcloud auth login` runs a PKCE flow with
 * a 127.0.0.1 redirect against auth.weaviate.cloud and caches the tokens in
 * `<user config dir>/wcloud/credentials.json`. The plugin takes that
 * session's refresh token and trades it for access tokens with the CLI's
 * public client id, the same `refresh_token` grant the CLI itself sends.
 */

export const CLOUD_API_BASE = "https://api-cloud.weaviate.cloud";
export const CLOUD_AUTH_BASE = "https://auth.weaviate.cloud";
/** `defaultAuthClientID` in weaviate-cloud `internal/config/auth.go`: a public PKCE client with no secret. */
export const WCLOUD_CLIENT_ID =
  "UGV1YzEyeTAyVUEwZUFFRDFkcVNqRTVIdEdVcnBCc3g6VFBBM0VkOEVPZ2tJa2NqUjJLak1WUEVWR00zOE4y";

/** Statuses after which a cluster will not become READY on its own. */
export const TERMINAL_STATUSES = ["FAILED", "DELETED", "EXPIRED", "SUSPENDED"];

export class WeaviateCloudError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "WeaviateCloudError";
    this.status = status;
    this.code = code;
  }
}

/** Friendlier text for the error codes the provisioning API documents as frozen. */
function explain(status: number, code: string, message: string): string {
  switch (code) {
    case "quota_exceeded":
      return "Weaviate Cloud allows one free cluster per user across all of their organizations, and this sign-in already has one (possibly in another organization). Delete it in the console first.";
    case "auth_required":
      return "The Weaviate Cloud sign-in has expired or was revoked. Run `wcloud auth login` again and paste the new refresh token into the account.";
    case "permission_denied":
    case "access_restricted":
      return `Weaviate Cloud refused this for the signed-in user: ${message}`;
    case "rate_limited":
      return "Weaviate Cloud is rate limiting this sign-in. Try again in a minute.";
    default:
      return `Weaviate Cloud API error ${status}${code ? ` (${code})` : ""}: ${message}`;
  }
}

/**
 * The account credential accepts either the bare refresh token or the whole
 * `credentials.json` the CLI writes, so nobody has to pick a field out of it.
 */
export function parseRefreshToken(raw: string): string {
  const t = raw.trim();
  if (!t.startsWith("{")) return t;
  try {
    const parsed = JSON.parse(t) as { refresh_token?: unknown };
    return typeof parsed.refresh_token === "string" ? parsed.refresh_token.trim() : "";
  } catch {
    return "";
  }
}

/** FNV-1a, to notice when the pasted credential changed under a rotated token. */
export function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** Where a rotated refresh token is kept, keyed to the account. */
export const SESSION_FIELD = "wcloudSession";
export function sessionResourceId(accountId: string): string {
  return `${accountId}:organization:session`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  return `iw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export class WeaviateCloudApi {
  private access: { token: string; expiresAt: number } | undefined;
  private refreshing: Promise<string> | undefined;
  private readonly seed: string;

  constructor(
    rawCredential: string,
    private readonly services: HostServices | undefined,
  ) {
    this.seed = parseRefreshToken(rawCredential);
    if (!this.seed) {
      throw new Error(
        "Weaviate Cloud sign-in: paste the refresh_token from wcloud's credentials.json, or the whole file.",
      );
    }
  }

  private async send(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
  ): Promise<{ status: number; body: string }> {
    const http = this.services?.http;
    if (http) {
      const res = await http.request({
        url,
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
      });
      return { status: res.status, body: res.body ?? "" };
    }
    const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
    return { status: res.status, body: await res.text() };
  }

  /**
   * The refresh token to use: a rotated one stored for this account wins,
   * unless the pasted credential has changed since it was stored.
   */
  private async currentRefreshToken(accountId: string): Promise<string> {
    const stored = await this.services?.secrets
      ?.getPlaintext(sessionResourceId(accountId), SESSION_FIELD)
      .catch(() => null);
    if (stored) {
      try {
        const s = JSON.parse(stored) as { seed?: string; token?: string };
        if (s.seed === fingerprint(this.seed) && s.token) return s.token;
      } catch {
        /* unreadable: fall back to the credential */
      }
    }
    return this.seed;
  }

  private async exchange(accountId: string): Promise<string> {
    const refreshToken = await this.currentRefreshToken(accountId);
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: WCLOUD_CLIENT_ID,
      refresh_token: refreshToken,
    });
    const res = await this.send(
      `${CLOUD_AUTH_BASE}/oauth2/v1/apps/token`,
      "POST",
      { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      form.toString(),
    );
    if (res.status >= 400) {
      if (res.status >= 500 || res.status === 429) {
        throw new WeaviateCloudError(res.status, "service_unavailable", res.body.slice(0, 300));
      }
      throw new WeaviateCloudError(res.status, "auth_required", explain(401, "auth_required", ""));
    }
    let tr: TokenResponse;
    try {
      tr = JSON.parse(res.body) as TokenResponse;
    } catch {
      throw new WeaviateCloudError(res.status, "internal_error", "Unreadable token response");
    }
    if (!tr.access_token) {
      throw new WeaviateCloudError(401, "auth_required", explain(401, "auth_required", ""));
    }
    if (tr.refresh_token && tr.refresh_token !== refreshToken) {
      // The auth server rotated the refresh token; keep the new one or the
      // next exchange would present a retired token.
      await this.services?.secrets
        ?.setPlaintext?.(
          sessionResourceId(accountId),
          SESSION_FIELD,
          JSON.stringify({ seed: fingerprint(this.seed), token: tr.refresh_token }),
        )
        .catch(() => undefined);
    }
    const ttl = (tr.expires_in && tr.expires_in > 0 ? tr.expires_in : 300) * 1000;
    this.access = { token: tr.access_token, expiresAt: Date.now() + ttl - 60_000 };
    return tr.access_token;
  }

  private async token(accountId: string): Promise<string> {
    if (this.access && Date.now() < this.access.expiresAt) return this.access.token;
    this.refreshing ??= this.exchange(accountId).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  async request<T>(
    accountId: string,
    path: string,
    opts: { method?: "GET" | "POST"; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const token = await this.token(accountId);
    const method = opts.method ?? "GET";
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(opts.headers ?? {}),
    };
    const res = await this.send(`${CLOUD_API_BASE}/v1${path}`, method, headers, body);
    if (res.status >= 400) {
      let code = "";
      let message = res.body.slice(0, 300);
      try {
        const env = JSON.parse(res.body) as { error?: { code?: string; message?: string } };
        code = env.error?.code ?? "";
        message = env.error?.message ?? message;
      } catch {
        /* not the envelope */
      }
      if (res.status === 401) this.access = undefined;
      throw new WeaviateCloudError(res.status, code, explain(res.status, code, message));
    }
    if (!res.body) return undefined as unknown as T;
    return (JSON.parse(res.body) as { data: T }).data;
  }

  whoami(accountId: string): Promise<WcWhoAmI> {
    return this.request<WcWhoAmI>(accountId, "/whoami");
  }

  async regions(accountId: string): Promise<WcRegion[]> {
    return (await this.request<WcRegion[] | null>(accountId, "/regions")) ?? [];
  }

  async clusters(accountId: string): Promise<WcCluster[]> {
    return (await this.request<WcCluster[] | null>(accountId, "/clusters")) ?? [];
  }

  cluster(accountId: string, id: string): Promise<WcCluster> {
    return this.request<WcCluster>(accountId, `/clusters/${encodeURIComponent(id)}`);
  }

  /** Never retried: a replayed create can provision (and bill) a second cluster. */
  createCluster(
    accountId: string,
    body: { name?: string; region?: string; tier?: string },
  ): Promise<WcCluster> {
    return this.request<WcCluster>(accountId, "/clusters", {
      method: "POST",
      body,
      headers: { "Idempotency-Key": newIdempotencyKey() },
    });
  }
}
