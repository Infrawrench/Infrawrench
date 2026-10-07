/**
 * OpenStack transport: Keystone v3 auth, the service catalog, and per-service
 * requests.
 *
 * Verified against docs.openstack.org/api-ref (2026-10):
 * - `POST {auth_url}/auth/tokens` returns the token in the `X-Subject-Token`
 *   header and the catalog in `token.catalog[].endpoints[]`
 *   (`interface`, `region_id`, `url`). Password auth scopes to a project by
 *   id or by name + domain; application credentials carry their own scope.
 * - `GET /v3/auth/projects` lists the projects an unscoped token may scope to.
 * - Nova microversions are sent as `OpenStack-API-Version: compute 2.47`
 *   (plus the legacy `X-OpenStack-Nova-API-Version`). 2.47 embeds the flavor
 *   (vcpus, ram, disk, original_name) in each server.
 *
 * Every request goes through `services.http` when available (bastion, CA,
 * desktop CORS); catalog endpoints are followed as published, so they must
 * be reachable from wherever the host runs.
 */
import type { HttpHostServices } from "@infrawrench/plugin-base";

export interface OpenStackCredentials {
  authUrl: string;
  applicationCredentialId?: string;
  applicationCredentialSecret?: string;
  username?: string;
  password?: string;
  userDomain?: string;
  project?: string;
  projectDomain?: string;
  region?: string;
  interface?: string;
  caCert?: string;
}

export class OpenStackApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "OpenStackApiError";
    this.status = status;
  }
}

export interface CatalogEntry {
  type: string;
  name?: string;
  endpoints: Array<{ interface: string; region_id?: string; region?: string; url: string }>;
}

export interface TokenInfo {
  token: string;
  expiresAt: number;
  projectId: string;
  projectName: string;
  userId: string;
  catalog: CatalogEntry[];
}

/** Catalog service types, most specific first (service-types-authority aliases). */
export const SERVICE_TYPES: Record<string, string[]> = {
  compute: ["compute"],
  image: ["image"],
  "block-storage": ["block-storage", "volumev3", "volume", "volumev2"],
  network: ["network"],
  "load-balancer": ["load-balancer"],
  "object-store": ["object-store"],
  dns: ["dns"],
  orchestration: ["orchestration"],
  metric: ["metric"],
  identity: ["identity"],
};

export type Service = keyof typeof SERVICE_TYPES;

/** API version segments the client writes into its paths, stripped from endpoints. */
const VERSION_IN_PATH: Partial<Record<Service, RegExp>> = {
  image: /\/v2(\.\d+)?$/,
  network: /\/v2\.0$/,
  "load-balancer": /\/v2(\.0)?$/,
  dns: /\/v2$/,
  metric: /\/v1$/,
};

export function normalizeAuthUrl(raw: string): string {
  let url = raw.trim();
  if (!url) throw new OpenStackApiError("OpenStack plugin: the Keystone URL is empty", 400);
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/\/+$/, "").replace(/\/auth\/tokens$/, "");
  if (!/\/v3$/.test(url)) url = `${url.replace(/\/v2\.0$/, "")}/v3`;
  return url;
}

export function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

export function describeOpenStackError(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    // Nova/Cinder: {"badRequest": {"message": ".."}}; Neutron: {"NeutronError": {"message"}};
    // Keystone: {"error": {"message"}}; Octavia/Designate: {"faultstring"} / {"message"}.
    for (const v of Object.values(parsed)) {
      if (v && typeof v === "object" && typeof (v as { message?: unknown }).message === "string") {
        return (v as { message: string }).message;
      }
    }
    if (typeof parsed["faultstring"] === "string") return parsed["faultstring"];
    if (typeof parsed["message"] === "string") return parsed["message"];
    if (typeof parsed["title"] === "string")
      return `${parsed["title"]}${parsed["description"] ? `: ${String(parsed["description"])}` : ""}`;
  } catch {
    // not JSON
  }
  return body
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

export function isUuidLike(v: string): boolean {
  return /^[0-9a-f]{32}$/i.test(v) || /^[0-9a-f-]{36}$/i.test(v);
}

export type Query = Record<string, string | number | boolean | undefined>;

function qs(query?: Query): string {
  if (!query) return "";
  const parts = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  rawBody?: Uint8Array;
}

export class OpenStackApi {
  readonly authUrl: string;
  readonly region: string;
  readonly iface: string;
  private readonly creds: OpenStackCredentials;
  private readonly caCert: string;
  private readonly http: HttpHostServices | undefined;
  private tokenPromise: Promise<TokenInfo> | undefined;

  constructor(creds: OpenStackCredentials, http?: HttpHostServices) {
    this.creds = creds;
    this.authUrl = normalizeAuthUrl(creds.authUrl);
    this.region = creds.region?.trim() ?? "";
    this.iface = (creds.interface?.trim() || "public").toLowerCase();
    this.caCert = creds.caCert?.trim() ?? "";
    this.http = http;
  }

  async raw(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: string | Uint8Array,
    binary = false,
  ): Promise<RawResponse> {
    try {
      if (this.http) {
        const res = await this.http.request({
          url,
          method,
          headers,
          ...(body !== undefined ? { body } : {}),
          ...(this.caCert ? { caCert: this.caCert } : {}),
          ...(binary ? { responseEncoding: "binary" as const } : {}),
        });
        return res;
      }
      const res = await fetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body: body as BodyInit } : {}),
      });
      const hdrs: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        hdrs[k] = v;
      });
      if (binary)
        return {
          status: res.status,
          headers: hdrs,
          body: "",
          rawBody: new Uint8Array(await res.arrayBuffer()),
        };
      return { status: res.status, headers: hdrs, body: await res.text() };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new OpenStackApiError(
        `OpenStack endpoint ${new URL(url).host} is unreachable: ${msg}. Every service endpoint in the catalog must be reachable from here (directly or through a bastion), and the CA certificate must match.`,
        503,
      );
    }
  }

  /** Body for `POST /auth/tokens`. Exported for tests. */
  authBody(scoped: boolean, projectOverride?: string): Record<string, unknown> {
    const c = this.creds;
    if (c.applicationCredentialId && c.applicationCredentialSecret) {
      return {
        auth: {
          identity: {
            methods: ["application_credential"],
            application_credential: {
              id: c.applicationCredentialId,
              secret: c.applicationCredentialSecret,
            },
          },
        },
      };
    }
    if (!c.username || !c.password) {
      throw new OpenStackApiError(
        "OpenStack plugin: enter an application credential ID and secret, or a username and password.",
        400,
      );
    }
    const userDomain = c.userDomain?.trim() || "Default";
    const identity = {
      methods: ["password"],
      password: {
        user: {
          ...(isUuidLike(c.username)
            ? { id: c.username }
            : {
                name: c.username,
                domain: isUuidLike(userDomain) ? { id: userDomain } : { name: userDomain },
              }),
          password: c.password,
        },
      },
    };
    const project = (projectOverride ?? c.project ?? "").trim();
    if (!scoped || !project) return { auth: { identity } };
    const projectDomain = c.projectDomain?.trim() || userDomain;
    const scope = isUuidLike(project)
      ? { project: { id: project } }
      : {
          project: {
            name: project,
            domain: isUuidLike(projectDomain) ? { id: projectDomain } : { name: projectDomain },
          },
        };
    return { auth: { identity, scope } };
  }

  private async issueToken(scoped: boolean): Promise<TokenInfo> {
    const res = await this.raw(
      "POST",
      `${this.authUrl}/auth/tokens`,
      { "Content-Type": "application/json", Accept: "application/json" },
      JSON.stringify(this.authBody(scoped)),
    );
    if (res.status === 401) {
      throw new OpenStackApiError(
        `Keystone rejected the credentials (401): ${describeOpenStackError(res.body)}`,
        401,
      );
    }
    if (res.status < 200 || res.status >= 300) {
      throw new OpenStackApiError(
        `Keystone authentication failed (${res.status}): ${describeOpenStackError(res.body)}`,
        res.status,
      );
    }
    const token = headerValue(res.headers, "x-subject-token");
    if (!token) throw new OpenStackApiError("Keystone returned no X-Subject-Token header", 502);
    const parsed = JSON.parse(res.body) as {
      token?: {
        expires_at?: string;
        project?: { id?: string; name?: string };
        user?: { id?: string };
        catalog?: CatalogEntry[];
      };
    };
    return {
      token,
      expiresAt: parsed.token?.expires_at
        ? Date.parse(parsed.token.expires_at)
        : Date.now() + 3_600_000,
      projectId: parsed.token?.project?.id ?? "",
      projectName: parsed.token?.project?.name ?? "",
      userId: parsed.token?.user?.id ?? "",
      catalog: parsed.token?.catalog ?? [],
    };
  }

  /** The project-scoped token, renewed a minute before expiry. */
  async token(force = false): Promise<TokenInfo> {
    if (!force && this.tokenPromise) {
      const t = await this.tokenPromise.catch(() => undefined);
      if (t && t.expiresAt - Date.now() > 60_000) return t;
    }
    const p = this.issueToken(true);
    this.tokenPromise = p;
    p.catch(() => {
      if (this.tokenPromise === p) this.tokenPromise = undefined;
    });
    const t = await p;
    if (!t.projectId) {
      throw new OpenStackApiError(
        "The token is not scoped to a project. Pick a project (and its domain) on the account, or use an application credential.",
        400,
      );
    }
    return t;
  }

  /** Projects the user may scope to (for the project picker). */
  async listProjects(): Promise<Array<{ id: string; name: string; domain_id?: string }>> {
    const t = await this.issueToken(false);
    const res = await this.raw("GET", `${this.authUrl}/auth/projects`, {
      "X-Auth-Token": t.token,
      Accept: "application/json",
    });
    if (res.status < 200 || res.status >= 300) {
      throw new OpenStackApiError(
        `Keystone could not list projects (${res.status}): ${describeOpenStackError(res.body)}`,
        res.status,
      );
    }
    return (
      (
        JSON.parse(res.body) as {
          projects?: Array<{ id: string; name: string; domain_id?: string }>;
        }
      ).projects ?? []
    );
  }

  /** Regions present in the catalog. */
  static catalogRegions(catalog: CatalogEntry[]): string[] {
    const set = new Set<string>();
    for (const s of catalog)
      for (const e of s.endpoints)
        if (e.region_id ?? e.region) set.add((e.region_id ?? e.region) as string);
    return [...set].sort();
  }

  /** Resolve a service endpoint from the catalog, or `undefined` when the cloud lacks it. */
  static pickEndpoint(
    catalog: CatalogEntry[],
    service: Service,
    region: string,
    iface: string,
  ): string | undefined {
    for (const type of SERVICE_TYPES[service] ?? [service]) {
      const entry = catalog.find((c) => c.type === type);
      if (!entry) continue;
      const candidates = entry.endpoints.filter(
        (e) => !region || (e.region_id ?? e.region) === region,
      );
      const ep =
        candidates.find((e) => e.interface === iface) ??
        candidates.find((e) => e.interface === "public") ??
        candidates[0];
      if (ep) {
        let url = ep.url.replace(/\/+$/, "");
        const strip = VERSION_IN_PATH[service];
        if (strip) url = url.replace(strip, "");
        return url;
      }
    }
    return undefined;
  }

  async endpoint(service: Service): Promise<string> {
    const t = await this.token();
    const url = OpenStackApi.pickEndpoint(t.catalog, service, this.region, this.iface);
    if (!url) {
      throw new OpenStackApiError(
        `This OpenStack cloud has no ${service} service${this.region ? ` in region ${this.region}` : ""} in its catalog.`,
        404,
      );
    }
    return url
      .replace("%(tenant_id)s", t.projectId)
      .replace("$(tenant_id)s", t.projectId)
      .replace("%(project_id)s", t.projectId);
  }

  async hasService(service: Service): Promise<boolean> {
    const t = await this.token();
    return OpenStackApi.pickEndpoint(t.catalog, service, this.region, this.iface) !== undefined;
  }

  async request(
    service: Service,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD",
    path: string,
    opts: {
      query?: Query;
      body?: unknown;
      headers?: Record<string, string>;
      rawBody?: string | Uint8Array;
      binary?: boolean;
    } = {},
  ): Promise<RawResponse> {
    const base = path.startsWith("http") ? "" : await this.endpoint(service);
    const url = `${base}${path}${qs(opts.query)}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = await this.token(attempt > 0);
      const headers: Record<string, string> = {
        "X-Auth-Token": t.token,
        Accept: "application/json",
        ...(service === "compute"
          ? { "OpenStack-API-Version": "compute 2.47", "X-OpenStack-Nova-API-Version": "2.47" }
          : {}),
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(opts.headers ?? {}),
      };
      const body =
        opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
      const res = await this.raw(method, url, headers, body, opts.binary ?? false);
      if (res.status === 401 && attempt === 0) continue;
      if (res.status < 200 || res.status >= 300) {
        const detail = describeOpenStackError(res.body);
        if (res.status === 403) {
          throw new OpenStackApiError(
            `OpenStack ${service} denied ${method} ${path} (403): ${detail}. The user's roles on this project do not allow it.`,
            403,
          );
        }
        throw new OpenStackApiError(
          `OpenStack ${service} API ${res.status} for ${method} ${path}: ${detail}`,
          res.status,
        );
      }
      return res;
    }
    throw new OpenStackApiError("OpenStack token could not be renewed", 401);
  }

  async json<T>(
    service: Service,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    opts: { query?: Query; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const res = await this.request(service, method, path, opts);
    if (!res.body) return undefined as T;
    try {
      return JSON.parse(res.body) as T;
    } catch {
      return res.body as unknown as T;
    }
  }

  get<T>(service: Service, path: string, query?: Query): Promise<T> {
    return this.json<T>(service, "GET", path, query ? { query } : {});
  }

  /**
   * Every page of a marker-paginated list (`?limit=&marker=<last id>`), the
   * scheme Nova, Neutron, Cinder, Octavia, Designate and Heat share.
   */
  async paginate<T extends Record<string, unknown>>(
    service: Service,
    path: string,
    key: string,
    query: Query = {},
    opts: { limit?: number; markerField?: string; maxPages?: number } = {},
  ): Promise<T[]> {
    const limit = opts.limit ?? 500;
    const markerField = opts.markerField ?? "id";
    const out: T[] = [];
    let marker: string | undefined;
    for (let page = 0; page < (opts.maxPages ?? 100); page++) {
      const data = await this.get<Record<string, unknown>>(service, path, {
        ...query,
        limit,
        ...(marker ? { marker } : {}),
      });
      const items = (data?.[key] as T[] | undefined) ?? [];
      out.push(...items);
      if (items.length < limit) break;
      const last = items[items.length - 1]?.[markerField];
      if (typeof last !== "string" || last === marker) break;
      marker = last;
    }
    return out;
  }
}
