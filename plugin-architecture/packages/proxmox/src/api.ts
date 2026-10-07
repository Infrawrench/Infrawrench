/**
 * Proxmox VE API transport.
 *
 * Everything goes through `services.http` when the host provides it: that is
 * the only path that honours a custom CA (Proxmox ships a self-signed cluster
 * CA by default), routes through a bastion, and avoids CORS in the desktop
 * renderer. Tests and hostless callers fall back to the global `fetch`.
 *
 * Verified against the API viewer schema (pve.proxmox.com/pve-docs/api-viewer,
 * PVE 9.x, 2026-10):
 * - Base path `/api2/json`, every response wrapped as `{ data: ... }`.
 * - API tokens authenticate with `Authorization: PVEAPIToken=USER@REALM!TOKENID=SECRET`
 *   and need no CSRF token for writes.
 * - Write parameters are sent `application/x-www-form-urlencoded`, booleans as 0/1.
 * - Long-running operations (clone, vzdump, migrate, create) return a UPID
 *   string; `/nodes/{node}/tasks/{upid}/status` reports `status: "stopped"`
 *   and `exitstatus: "OK"` when they finish.
 */
import type { HttpHostServices } from "@infrawrench/plugin-base";

export interface ProxmoxCredentials {
  url: string;
  tokenId: string;
  tokenSecret: string;
  caCert?: string;
}

export type FormValue = string | number | boolean | undefined | null;

/** An Error carrying the HTTP status, so the poller can classify failures. */
export class ProxmoxApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ProxmoxApiError";
    this.status = status;
  }
}

/**
 * Normalise whatever the user pasted into the API root:
 * `pve.example.com:8006`, `https://pve.example.com:8006/`, or a URL that
 * already ends in `/api2/json`. An SSH-tunnel rewrite hands back
 * `https://127.0.0.1:<port>/`, which lands here too.
 */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim();
  if (!url) throw new ProxmoxApiError("Proxmox plugin: the Proxmox VE URL is empty", 400);
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/\/+$/, "");
  url = url.replace(/\/api2\/json$/i, "");
  url = url.replace(/\/+$/, "");
  return url;
}

/** Form-encode write parameters the way pve-http-server expects them. */
export function encodeForm(params: Record<string, FormValue>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const v = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return parts.join("&");
}

/** Pull the most useful text out of a Proxmox error body. */
export function describeErrorBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as { errors?: Record<string, string>; message?: string };
    if (parsed.errors && Object.keys(parsed.errors).length > 0) {
      return Object.entries(parsed.errors)
        .map(([k, v]) => `${k}: ${String(v).trim()}`)
        .join("; ");
    }
    if (parsed.message) return parsed.message.trim();
  } catch {
    // not JSON
  }
  return body.trim().slice(0, 500);
}

export class ProxmoxApi {
  readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly caCert: string;
  private readonly http: HttpHostServices | undefined;

  constructor(creds: ProxmoxCredentials, http?: HttpHostServices) {
    this.baseUrl = normalizeBaseUrl(creds.url);
    const tokenId = creds.tokenId.trim();
    const secret = creds.tokenSecret.trim();
    // Accept a pasted full header value too ("PVEAPIToken=user@pam!id=secret").
    const full = tokenId.startsWith("PVEAPIToken=") ? tokenId : `PVEAPIToken=${tokenId}=${secret}`;
    this.authHeader = full;
    this.caCert = creds.caCert?.trim() ?? "";
    this.http = http;
  }

  /** Root of the web UI (for console deep links). */
  get uiUrl(): string {
    return this.baseUrl;
  }

  async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    params?: Record<string, FormValue>,
  ): Promise<T> {
    let url = `${this.baseUrl}/api2/json${path}`;
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: "application/json",
    };
    let body: string | undefined;
    if (params && Object.keys(params).length > 0) {
      const encoded = encodeForm(params);
      if (method === "GET" || method === "DELETE") {
        if (encoded) url += `${url.includes("?") ? "&" : "?"}${encoded}`;
      } else {
        body = encoded;
        headers["Content-Type"] = "application/x-www-form-urlencoded";
      }
    }

    let status: number;
    let text: string;
    let statusText = "";
    try {
      if (this.http) {
        const res = await this.http.request({
          url,
          method,
          headers,
          ...(body !== undefined ? { body } : {}),
          ...(this.caCert ? { caCert: this.caCert } : {}),
        });
        status = res.status;
        text = res.body;
      } else {
        const res = await fetch(url, {
          method,
          headers,
          ...(body !== undefined ? { body } : {}),
        });
        status = res.status;
        statusText = res.statusText;
        text = await res.text();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new ProxmoxApiError(
        `Proxmox VE is unreachable at ${this.baseUrl}: ${msg}. Check the URL, that port 8006 is reachable (directly, through a bastion or an SSH tunnel), and that the CA certificate matches the server's certificate.`,
        503,
      );
    }

    if (status < 200 || status >= 300) {
      const detail = describeErrorBody(text) || statusText;
      if (status === 401) {
        throw new ProxmoxApiError(
          `Proxmox VE rejected the API token (401). Check the token ID (user@realm!tokenid) and secret, and that the token has not expired.`,
          401,
        );
      }
      if (status === 403) {
        throw new ProxmoxApiError(
          `Proxmox VE denied ${method} ${path} (403): ${detail}. The token needs a role granting this on the path; with privilege separation on, the token's own ACL applies, not its user's.`,
          403,
        );
      }
      throw new ProxmoxApiError(
        `Proxmox VE API ${status} for ${method} ${path}: ${detail}`,
        status,
      );
    }
    if (!text) return undefined as T;
    let parsed: { data?: T };
    try {
      parsed = JSON.parse(text) as { data?: T };
    } catch {
      throw new ProxmoxApiError(
        `Proxmox VE returned a non-JSON response for ${path}. Is ${this.baseUrl} the Proxmox VE API (port 8006)?`,
        502,
      );
    }
    return parsed.data as T;
  }

  get<T>(path: string, params?: Record<string, FormValue>): Promise<T> {
    return this.request<T>("GET", path, params);
  }
  post<T>(path: string, params?: Record<string, FormValue>): Promise<T> {
    return this.request<T>("POST", path, params);
  }
  put<T>(path: string, params?: Record<string, FormValue>): Promise<T> {
    return this.request<T>("PUT", path, params);
  }
  delete<T>(path: string, params?: Record<string, FormValue>): Promise<T> {
    return this.request<T>("DELETE", path, params);
  }

  /**
   * Wait for a task (UPID) to finish. Returns `true` when it finished OK,
   * `false` on timeout, and throws when it finished with an error.
   */
  async waitForTask(
    node: string,
    upid: string,
    opts: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  ): Promise<boolean> {
    const timeoutMs = opts.timeoutMs ?? 180_000;
    const intervalMs = opts.intervalMs ?? 2_000;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const st = await this.get<{ status?: string; exitstatus?: string }>(
        `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`,
      );
      if (st?.status === "stopped") {
        if (st.exitstatus && st.exitstatus !== "OK" && !st.exitstatus.startsWith("WARNINGS")) {
          throw new ProxmoxApiError(`Proxmox VE task failed: ${st.exitstatus}`, 500);
        }
        return true;
      }
      if (Date.now() >= deadline) return false;
      await sleep(intervalMs);
    }
  }
}

/** The node a UPID ran on: `UPID:<node>:<pid>:...`. */
export function nodeOfUpid(upid: string): string | undefined {
  const parts = upid.split(":");
  return parts[0] === "UPID" ? parts[1] : undefined;
}
