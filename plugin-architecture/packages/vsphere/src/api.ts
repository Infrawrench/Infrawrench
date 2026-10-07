/**
 * vSphere Automation REST API (`/api`) transport.
 *
 * Verified against developer.broadcom.com/xapis/vsphere-automation-api
 * (9.1.1, 2026-10):
 * - `POST /api/session` with HTTP Basic credentials returns the session token
 *   as a bare JSON string; later calls send it as `vmware-api-session-id`.
 *   Sessions expire after idle time, so a 401 triggers one re-login.
 * - Errors are `{ error_type: "NOT_FOUND", messages: [{ default_message }] }`.
 * - Bodies are JSON. Actions are query parameters (`?action=clone`).
 *
 * The REST API exists only on vCenter Server; a standalone ESXi host has no
 * `/api` endpoint.
 */
import type { HttpHostServices } from "@infrawrench/plugin-base";
import { base64ToUtf8, utf8ToBase64 } from "@infrawrench/plugin-base";

export interface VsphereCredentials {
  url: string;
  username: string;
  password: string;
  caCert?: string;
}

export class VsphereApiError extends Error {
  readonly status: number;
  readonly errorType: string;
  constructor(message: string, status: number, errorType = "") {
    super(message);
    this.name = "VsphereApiError";
    this.status = status;
    this.errorType = errorType;
  }
}

export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim();
  if (!url) throw new VsphereApiError("vSphere plugin: the vCenter URL is empty", 400);
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/\/+$/, "");
  url = url.replace(/\/(api|rest|ui|sdk)$/i, "");
  return url.replace(/\/+$/, "");
}

export function describeVapiError(body: string): { type: string; message: string } {
  try {
    const parsed = JSON.parse(body) as {
      error_type?: string;
      type?: string;
      messages?: Array<{ default_message?: string }>;
      value?: { messages?: Array<{ default_message?: string }> };
    };
    const msgs = parsed.messages ?? parsed.value?.messages ?? [];
    return {
      type: parsed.error_type ?? parsed.type ?? "",
      message: msgs
        .map((m) => m.default_message ?? "")
        .filter(Boolean)
        .join("; "),
    };
  } catch {
    return { type: "", message: body.trim().slice(0, 400) };
  }
}

export type Query = Record<string, string | number | boolean | string[] | undefined>;

export function buildQuery(query: Query | undefined): string {
  if (!query) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    const values = Array.isArray(v) ? v : [v];
    for (const one of values)
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(one))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

export class VsphereApi {
  readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly caCert: string;
  private readonly http: HttpHostServices | undefined;
  private session: Promise<string> | undefined;

  constructor(creds: VsphereCredentials, http?: HttpHostServices) {
    this.baseUrl = normalizeBaseUrl(creds.url);
    this.username = creds.username;
    this.password = creds.password;
    this.caCert = creds.caCert?.trim() ?? "";
    this.http = http;
  }

  private async raw(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<{ status: number; body: string }> {
    try {
      if (this.http) {
        const res = await this.http.request({
          url,
          method,
          headers,
          ...(body !== undefined ? { body } : {}),
          ...(this.caCert ? { caCert: this.caCert } : {}),
        });
        return { status: res.status, body: res.body };
      }
      const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
      return { status: res.status, body: await res.text() };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new VsphereApiError(
        `vCenter is unreachable at ${this.baseUrl}: ${msg}. Check the URL, network path (bastion or SSH tunnel for private vCenters) and the CA certificate.`,
        503,
      );
    }
  }

  /** Log in (or reuse the live session). */
  login(force = false): Promise<string> {
    if (!force && this.session) return this.session;
    const basic = utf8ToBase64(`${this.username}:${this.password}`);
    const p = this.raw("POST", `${this.baseUrl}/api/session`, {
      Authorization: `Basic ${basic}`,
      Accept: "application/json",
    }).then((res) => {
      if (res.status === 401 || res.status === 403) {
        throw new VsphereApiError(
          "vCenter rejected the username or password. Use a vCenter SSO user such as svc-infrawrench@vsphere.local.",
          401,
        );
      }
      if (res.status === 404) {
        throw new VsphereApiError(
          `${this.baseUrl}/api/session was not found. The vSphere Automation REST API needs vCenter Server 7.0 or later; a standalone ESXi host has no /api endpoint.`,
          404,
        );
      }
      if (res.status < 200 || res.status >= 300) {
        const err = describeVapiError(res.body);
        throw new VsphereApiError(
          `vCenter login failed (${res.status}): ${err.message || err.type}`,
          res.status,
          err.type,
        );
      }
      try {
        return JSON.parse(res.body) as string;
      } catch {
        throw new VsphereApiError("vCenter returned an unexpected login response", 502);
      }
    });
    p.catch(() => {
      if (this.session === p) this.session = undefined;
    });
    this.session = p;
    return p;
  }

  async request<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}/api${path}${buildQuery(opts.query)}`;
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.login(attempt > 0);
      const headers: Record<string, string> = {
        "vmware-api-session-id": token,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      };
      const res = await this.raw(method, url, headers, body);
      if (res.status === 401 && attempt === 0) continue;
      if (res.status < 200 || res.status >= 300) {
        const err = describeVapiError(res.body);
        const detail = err.message || err.type || res.body.slice(0, 200);
        if (res.status === 403) {
          throw new VsphereApiError(
            `vCenter denied ${method} ${path} (403): ${detail}. The vCenter role assigned to this user lacks the privilege.`,
            403,
            err.type,
          );
        }
        throw new VsphereApiError(
          `vCenter API ${res.status} for ${method} ${path}: ${detail}`,
          res.status,
          err.type,
        );
      }
      if (!res.body) return undefined as T;
      try {
        return JSON.parse(res.body) as T;
      } catch {
        return res.body as unknown as T;
      }
    }
    throw new VsphereApiError("vCenter session could not be established", 401);
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, query ? { query } : {});
  }
  post<T>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>("POST", path, {
      ...(body !== undefined ? { body } : {}),
      ...(query ? { query } : {}),
    });
  }
  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", path, { body });
  }
  delete<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>("DELETE", path, query ? { query } : {});
  }
}

/** For tests: decode a Basic header. */
export function decodeBasic(header: string): string {
  return base64ToUtf8(header.replace(/^Basic /, ""));
}
