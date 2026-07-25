import type { TokenManager } from "./tokens";

/**
 * Bearer-authenticated fetch against the cloud API, ported from the desktop's
 * `cloud-data/shared.ts` cloudFetch: 401 → force refresh → retry once,
 * 204 → null, non-OK → throw with body text.
 */

export interface CloudFetchOptions {
  tokens: TokenManager;
  /** Cloud origin, e.g. `https://app.infrawrench.com`. */
  baseUrl: string;
  fetch?: typeof fetch;
  /**
   * Called with the parsed body of a 409 response before it is thrown —
   * lets hosts implement the SSH host-key trust prompt. Return true to retry
   * the request once (after e.g. POSTing /ssh-host-keys/trust).
   */
  on409?: (body: unknown) => Promise<boolean>;
}

export class CloudApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = "CloudApiError";
  }
}

export interface CloudFetch {
  /** Request an org-scoped path (`/accounts`, `/costs/...`) as JSON. */
  org<T>(orgId: string, path: string, init?: RequestInit): Promise<T | null>;
  /** Request a user-scoped path (`/api/auth/me`, `/api/push/devices`). */
  api<T>(path: string, init?: RequestInit): Promise<T | null>;
  /** Raw authenticated fetch (streaming responses, uploads). */
  raw(url: string, init?: RequestInit): Promise<Response>;
  readonly baseUrl: string;
}

export function createCloudFetch(opts: CloudFetchOptions): CloudFetch {
  const fetchImpl = opts.fetch ?? fetch;

  async function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
    let token = await opts.tokens.getAccessToken();
    if (!token) throw new CloudApiError("Not authenticated to Infrawrench Cloud", 401, "");
    const buildInit = (t: string): RequestInit => ({
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${t}`,
        ...(init.body && typeof init.body === "string"
          ? { "Content-Type": "application/json" }
          : {}),
      },
    });
    let res = await fetchImpl(url, buildInit(token));
    if (res.status === 401) {
      const refreshed = await opts.tokens.forceRefreshAccessToken();
      if (!refreshed) {
        throw new CloudApiError("Authentication expired; please sign in again", 401, "");
      }
      token = refreshed;
      res = await fetchImpl(url, buildInit(token));
    }
    if (res.status === 409 && opts.on409) {
      const cloned = res.clone();
      let body: unknown = null;
      try {
        body = await cloned.json();
      } catch {
        return res;
      }
      if (await opts.on409(body)) {
        res = await fetchImpl(url, buildInit(token));
      }
    }
    return res;
  }

  async function jsonFetch<T>(url: string, init: RequestInit = {}): Promise<T | null> {
    const res = await authedFetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new CloudApiError(
        `Cloud request failed: ${res.status} ${url} ${text}`,
        res.status,
        text,
      );
    }
    if (res.status === 204) return null;
    return (await res.json()) as T;
  }

  return {
    baseUrl: opts.baseUrl,
    org: <T>(orgId: string, path: string, init?: RequestInit) =>
      jsonFetch<T>(`${opts.baseUrl}/api/org/${encodeURIComponent(orgId)}${path}`, init),
    api: <T>(path: string, init?: RequestInit) => jsonFetch<T>(`${opts.baseUrl}${path}`, init),
    raw: (url: string, init?: RequestInit) =>
      authedFetch(url.startsWith("http") ? url : `${opts.baseUrl}${url}`, init),
  };
}
