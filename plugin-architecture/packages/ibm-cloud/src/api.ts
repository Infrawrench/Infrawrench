import {
  createApiClient,
  restRequest,
  type ApiClient,
  type ApiResponse,
  type HttpHostServices,
  type ParamValue,
} from "@infrawrench/plugin-base";
import type { paths as CodeEnginePaths } from "./api-types.code-engine.gen.js";
import type { paths as ContainersPaths } from "./api-types.containers.gen.js";
import type { paths as CosConfigPaths } from "./api-types.cos-config.gen.js";
import type { paths as DatabasesPaths } from "./api-types.databases.gen.js";
import type { operations as IamOperations } from "./api-types.iam.gen.js";
import type { paths as ResourceControllerPaths } from "./api-types.resource-controller.gen.js";
import type { paths as ResourceManagerPaths } from "./api-types.resource-manager.gen.js";
import type { paths as UsagePaths } from "./api-types.usage.gen.js";
import type { paths as VpcPaths } from "./api-types.vpc.gen.js";
import {
  BILLING,
  CONTAINERS,
  COS_CONFIG,
  RESOURCE_CONTROLLER,
  codeEngineBase,
  databasesBase,
  vpcBase,
} from "./regions.js";

/**
 * IBM Cloud transport. One API key is exchanged at IAM
 * (`POST https://iam.cloud.ibm.com/identity/token`,
 * `grant_type=urn:ibm:params:oauth:grant-type:apikey`) for a bearer token
 * that every service accepts; the token lasts an hour and is refreshed a
 * few minutes early, or once on a 401. Requests go through the host HTTP
 * service when there is one (bastion egress, custom CA, and IAM sends no
 * CORS headers).
 *
 * Each service has its own OpenAPI document and so its own typed client, all
 * over one `HttpHostServices` wrapper that holds the token, the retries and
 * the error format. Object Storage's S3 endpoints have no document and speak
 * XML, so they stay on `requestXml`.
 */

export const IAM_TOKEN_URL = "https://iam.cloud.ibm.com/identity/token";

/** An IBM Cloud API failure with the HTTP status and the service's own error code. */
export class IbmApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly serviceMessage: string,
    readonly path: string,
  ) {
    super(`IBM Cloud API error ${status}${code ? ` ${code}` : ""} for ${path}: ${serviceMessage}`);
    this.name = "IbmApiError";
  }
}

export function isPermissionGap(err: unknown): boolean {
  return err instanceof IbmApiError && (err.status === 403 || err.status === 401);
}

/** Every field of every error shape below. None of the documents describes these answers. */
interface IbmErrorBody {
  errors?: Array<{ code?: string; message?: string }>;
  error_code?: string;
  errorCode?: string;
  code?: string;
  message?: string;
  errorMessage?: string;
  description?: string;
  error?: string;
}

/**
 * Pull `code` and `message` out of the several error shapes IBM services
 * use: VPC and Code Engine `{errors:[{code,message}]}`, Resource Controller
 * `{error_code,message}`, Kubernetes Service `{code,description}`, IAM
 * `{errorCode,errorMessage}`.
 */
export function parseIbmError(body: string): { code: string; message: string } {
  try {
    const p: IbmErrorBody = JSON.parse(body);
    const first = p.errors;
    if (Array.isArray(first) && first[0] && typeof first[0] === "object") {
      const e = first[0];
      return { code: String(e.code ?? ""), message: String(e.message ?? body) };
    }
    return {
      code: String(p.error_code ?? p.errorCode ?? p.code ?? ""),
      message: String(p.message ?? p.errorMessage ?? p.description ?? p.error ?? body),
    };
  } catch {
    return { code: "", message: body.slice(0, 500) };
  }
}

interface Token {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string;
  iamId: string;
  subject: string;
}

/** The claims of an IAM token this plugin reads. */
interface IamClaims {
  account?: { bss?: string };
  iam_id?: string;
  sub?: string;
  name?: string;
}

/** Decode a JWT payload (no verification: IAM just issued it to us). */
export function decodeJwt(token: string): IamClaims {
  const part = token.split(".")[1] ?? "";
  const b64 = part
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(part.length / 4) * 4, "=");
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return {};
  }
}

type Query = Record<string, ParamValue>;

const MAX_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function queryString(query: Query): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join("&");
}

export function withQuery(url: string, query: Query | undefined): string {
  const written = query ? queryString(query) : "";
  if (!written) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${written}`;
}

/** IAM's answer to the API key grant. */
type IamToken = ApiResponse<IamOperations["getToken_ApiKey"]>;

const JSON_ACCEPT = { accept: "application/json" };

export class IbmApi {
  private token: Token | null = null;
  private pending: Promise<Token> | null = null;

  /** What every typed client sends through: adds the token, retries, and throws `IbmApiError`. */
  private readonly transport: HttpHostServices = {
    request: (req) => this.authorized(req),
  };

  readonly resourceController: ApiClient<ResourceControllerPaths>;
  readonly resourceManager: ApiClient<ResourceManagerPaths>;
  readonly containers: ApiClient<ContainersPaths>;
  readonly usage: ApiClient<UsagePaths>;
  readonly cosConfig: ApiClient<CosConfigPaths>;

  constructor(
    private readonly apiKey: string,
    private readonly http: HttpHostServices | undefined,
    private readonly caCert: string,
  ) {
    this.resourceController = this.client<ResourceControllerPaths>(RESOURCE_CONTROLLER);
    this.resourceManager = this.client<ResourceManagerPaths>(RESOURCE_CONTROLLER);
    this.containers = this.client<ContainersPaths>(CONTAINERS);
    this.usage = this.client<UsagePaths>(BILLING);
    this.cosConfig = this.client<CosConfigPaths>(COS_CONFIG);
  }

  private client<P>(baseUrl: string): ApiClient<P> {
    return createApiClient<P>({
      vendor: "IBM Cloud",
      baseUrl,
      headers: JSON_ACCEPT,
      http: this.transport,
      contentType: "with-body",
      serializeQuery: queryString,
    });
  }

  vpc(region: string): ApiClient<VpcPaths> {
    return this.client<VpcPaths>(vpcBase(region));
  }

  codeEngine(region: string): ApiClient<CodeEnginePaths> {
    return this.client<CodeEnginePaths>(codeEngineBase(region));
  }

  databases(region: string): ApiClient<DatabasesPaths> {
    return this.client<DatabasesPaths>(databasesBase(region));
  }

  async send(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | Uint8Array | undefined,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    if (this.http) {
      const res = await this.http.request({
        url,
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        ...(this.caCert ? { caCert: this.caCert } : {}),
      });
      const lower: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers ?? {})) lower[k.toLowerCase()] = v;
      return { status: res.status, headers: lower, body: res.body };
    }
    const res = await fetch(url, {
      method,
      headers,
      ...(body !== undefined
        ? { body: typeof body === "string" ? body : new Uint8Array(body) }
        : {}),
    });
    const lower: Record<string, string> = {};
    res.headers.forEach((v, k) => (lower[k.toLowerCase()] = v));
    return { status: res.status, headers: lower, body: await res.text() };
  }

  private async exchange(): Promise<Token> {
    const body = `grant_type=${encodeURIComponent("urn:ibm:params:oauth:grant-type:apikey")}&apikey=${encodeURIComponent(this.apiKey)}`;
    const res = await this.send(
      IAM_TOKEN_URL,
      "POST",
      { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
    );
    if (res.status < 200 || res.status >= 300) {
      const e = parseIbmError(res.body);
      throw new IbmApiError(res.status, e.code, e.message, "/identity/token");
    }
    const data: IamToken = JSON.parse(res.body);
    const claims = decodeJwt(data.access_token);
    const account = claims.account;
    const expiresAt = data.expiration
      ? data.expiration * 1000
      : Date.now() + (data.expires_in ?? 3600) * 1000;
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? "",
      expiresAt,
      accountId: account?.bss ?? "",
      iamId: String(claims.iam_id ?? ""),
      subject: String(claims.sub ?? claims.name ?? ""),
    };
  }

  async getToken(force = false): Promise<Token> {
    if (!force && this.token && this.token.expiresAt - Date.now() > 5 * 60_000) return this.token;
    if (!this.pending) {
      this.pending = this.exchange()
        .then((t) => {
          this.token = t;
          return t;
        })
        .finally(() => {
          this.pending = null;
        });
    }
    return this.pending;
  }

  async accountId(): Promise<string> {
    return (await this.getToken()).accountId;
  }

  private async authorized(req: Parameters<HttpHostServices["request"]>[0]) {
    const { url, method, body } = req;
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) lower[k.toLowerCase()] = v;
    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      const token = await this.getToken();
      const headers: Record<string, string> = {
        accept: "application/json",
        authorization: `Bearer ${token.accessToken}`,
        ...lower,
      };
      const res = await this.send(url, method, headers, body);
      if (res.status >= 200 && res.status < 300) {
        // A delete answers with nothing, text or JSON depending on the service,
        // and nothing reads it, so it must not fail on being parsed.
        return method === "DELETE" ? { ...res, body: "" } : res;
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.getToken(true);
        continue;
      }
      if (
        (res.status === 429 || res.status === 502 || res.status === 503) &&
        attempt < MAX_ATTEMPTS
      ) {
        await sleep(Math.min(8000, 500 * 2 ** (attempt - 1)));
        continue;
      }
      const e = res.headers["content-type"]?.includes("xml")
        ? {
            code: /<Code>([^<]*)<\/Code>/.exec(res.body)?.[1] ?? "",
            message: /<Message>([^<]*)<\/Message>/.exec(res.body)?.[1] ?? res.body,
          }
        : parseIbmError(res.body);
      throw new IbmApiError(res.status, e.code, e.message, new URL(url).pathname);
    }
  }

  /** A next link as the provider wrote it, typed by the caller from the list it came from. */
  async followLink<T>(url: string): Promise<T> {
    const answer = await restRequest<T>({
      vendor: "IBM Cloud",
      url,
      headers: JSON_ACCEPT,
      http: this.transport,
      contentType: "with-body",
    });
    return answer.body;
  }

  /** An S3-compatible Object Storage call, which no document covers: the answer is its text. */
  async requestXml(req: {
    url: string;
    method?: string;
    query?: Query;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
  }): Promise<string> {
    const res = await this.authorized({
      url: withQuery(req.url, req.query),
      method: req.method ?? "GET",
      headers: req.headers ?? {},
      ...(req.body !== undefined ? { body: req.body } : {}),
    });
    return res.body;
  }
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
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
