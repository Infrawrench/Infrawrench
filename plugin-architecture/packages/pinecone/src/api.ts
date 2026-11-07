import {
  createApiClient,
  followableLink,
  hostTransport,
  linkHostsUnder,
  pathEncode,
  restRequest,
  type ApiBody,
  type ApiClient,
  type ApiResponse,
  type HostServices,
  type RestResponse,
  withCursorPagination,
} from "@infrawrench/plugin-base";
import type { paths as AdminPaths } from "./api-types.admin.gen.js";
import type {
  operations as AssistantDataOperations,
  paths as AssistantDataPaths,
} from "./api-types.assistant-data.gen.js";
import type { paths as AssistantPaths } from "./api-types.assistant.gen.js";
import type { paths as ControlPaths } from "./api-types.control.gen.js";
import type { paths as DataPaths } from "./api-types.data.gen.js";
import type { paths as InferencePaths } from "./api-types.inference.gen.js";
import type { operations as OAuthOperations } from "./api-types.oauth.gen.js";
import type { PcPrometheusTargets } from "./types.js";

/**
 * Transport for Pinecone's REST APIs (verified against the published
 * OpenAPI specs in github.com/pinecone-io/pinecone-api, version `2026-07`,
 * the latest stable release as of 2026-10):
 *
 * - Control plane (`https://api.pinecone.io`): indexes, collections, backups,
 *   backup schedules, restore jobs, inference model catalog. Auth is the
 *   project API key in the `Api-Key` header.
 * - Assistant control plane (`https://api.pinecone.io/assistant`): same key.
 * - Data plane (`https://{index host}` / `https://{assistant host}`): index
 *   stats and assistant chat/files. Same key.
 * - Admin API (`https://api.pinecone.io/admin`): projects, project API keys,
 *   service accounts. Auth is `Authorization: Bearer <token>`, where the token
 *   comes from the OAuth2 client-credentials exchange at
 *   `https://login.pinecone.io/oauth/token` (audience
 *   `https://api.pinecone.io/`, ~30 minute lifetime).
 *
 * Every request sends `X-Pinecone-Api-Version`, without which Pinecone falls
 * back to the *oldest* supported version and answers in the pre-2026 shapes.
 * Requests go through `services.http` when the host provides it, which keeps
 * bastion routing and custom CAs working.
 */

export const API_VERSION = "2026-07";
export const API_HOST = "https://api.pinecone.io";
export const LOGIN_HOST = "https://login.pinecone.io";

export class PineconeApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, path: string, body: string) {
    super(`Pinecone API error ${status} for ${path}: ${summarizeBody(body)}`);
    this.name = "PineconeApiError";
    this.status = status;
    this.body = body;
  }
}

/** What a failure's body may hold. Read with `typeof` checks: it is not what a 2xx promises. */
interface ErrorBody {
  error?: string | { code?: string; message?: string };
  error_description?: string;
  message?: string;
}

/** Pinecone errors are `{status, error: {code, message}}`; OAuth uses `{error, error_description}`. */
export function summarizeBody(body: string): string {
  try {
    const parsed: ErrorBody = JSON.parse(body);
    if (typeof parsed.error_description === "string" && parsed.error_description) {
      return parsed.error_description;
    }
    if (parsed.error && typeof parsed.error === "object") {
      const e = parsed.error;
      if (typeof e.message === "string" && e.message) {
        return typeof e.code === "string" ? `${e.code}: ${e.message}` : e.message;
      }
    }
    if (typeof parsed.error === "string" && parsed.error) return parsed.error;
    if (typeof parsed.message === "string" && parsed.message) return parsed.message;
  } catch {
    /* not JSON (the control plane's 401 is text/plain) */
  }
  return body.slice(0, 500);
}

/** `https://` prefix for a bare host Pinecone returns (`x.svc.pinecone.io`). */
export function hostUrl(host: string): string {
  const h = host.trim().replace(/\/+$/, "");
  if (!h) return "";
  return /^https?:\/\//i.test(h) ? h : `https://${h}`;
}

interface TokenCache {
  token: string;
  expiresAt: number;
}

export interface PineconeCredentials {
  apiKey: string;
  clientId: string;
  clientSecret: string;
  caCert: string;
}

type HeaderMap = Record<string, string>;

const JSON_HEADERS = { Accept: "application/json", "X-Pinecone-Api-Version": API_VERSION };

/**
 * 10,000 rows a list. The assistant routes document a maximum `limit` of 100; the
 * control plane's default is 100 with no maximum given.
 */
const PAGING = {
  sizeParam: "limit",
  pageSize: 100,
  maxPages: 100,
  next: "pagination.next",
} as const;

function controlLists(client: ApiClient<ControlPaths>) {
  return withCursorPagination(client, { ...PAGING, cursorParam: "paginationToken" });
}

function adminLists(client: ApiClient<AdminPaths>) {
  return withCursorPagination(client, { ...PAGING, cursorParam: "paginationToken" });
}

// The `data` of BackupList, unlike the other control-plane lists, is optional in the document.
function backupLists(client: ApiClient<ControlPaths>) {
  return withCursorPagination(client, {
    ...PAGING,
    cursorParam: "paginationToken",
    missingListIsEmpty: true,
  });
}

// `assistants` is optional in the document, which shows no empty answer.
function assistantLists(client: ApiClient<AssistantPaths>) {
  return withCursorPagination(client, {
    ...PAGING,
    cursorParam: "pagination_token",
    missingListIsEmpty: true,
  });
}

// `files` is optional in the document, which shows no empty answer.
function fileLists(client: ApiClient<AssistantDataPaths>) {
  return withCursorPagination(client, {
    ...PAGING,
    cursorParam: "pagination_token",
    missingListIsEmpty: true,
  });
}

/**
 * A URL from a response, about to get the project API key: an index or assistant host,
 * or a Prometheus target. The document's hosts and the manifest's `egressHosts` are all
 * under pinecone.io, and a bastion refuses anything else anyway. Throws on the rest.
 */
function pineconeUrl(url: string, path: string): string {
  return followableLink(url, `${API_HOST}/`, {
    vendor: "Pinecone",
    path,
    foreignLinks: linkHostsUnder("pinecone.io"),
  });
}

export class PineconeApi {
  private token: TokenCache | undefined;
  private tokenInFlight: Promise<string> | undefined;

  /** Control plane (`https://api.pinecone.io`), with the project API key. */
  readonly control: ReturnType<typeof controlLists>;
  /** The control plane again, for `/backups`, whose list key may be left out. */
  readonly backups: ReturnType<typeof backupLists>;
  /** Inference model catalog (`https://api.pinecone.io`), with the project API key. */
  readonly inference: ApiClient<InferencePaths>;
  /** Assistant control plane (`https://api.pinecone.io/assistant`), with the project API key. */
  readonly assistants: ReturnType<typeof assistantLists>;
  /** Admin API, with a service-account access token. */
  readonly admin: ReturnType<typeof adminLists>;

  constructor(
    private readonly creds: PineconeCredentials,
    private readonly services: HostServices | undefined,
  ) {
    // An account with no key (the credential picker's) only fails on a call that needs one.
    const key = creds.apiKey
      ? { "Api-Key": creds.apiKey }
      : () => ({ "Api-Key": this.requireKey() });
    const control = this.client<ControlPaths>(API_HOST, key);
    this.control = controlLists(control);
    this.backups = backupLists(control);
    this.inference = this.client<InferencePaths>(API_HOST, key);
    // The document's paths start at `/assistants`; errors have always named the whole path.
    this.assistants = assistantLists(
      this.client<AssistantPaths>(`${API_HOST}/assistant`, key, "/assistant"),
    );
    this.admin = adminLists(
      this.client<AdminPaths>(API_HOST, async () => ({
        Authorization: `Bearer ${await this.accessToken()}`,
      })),
    );
  }

  get hasApiKey(): boolean {
    return this.creds.apiKey !== "";
  }

  get hasAdmin(): boolean {
    return this.creds.clientId !== "" && this.creds.clientSecret !== "";
  }

  get apiKey(): string {
    return this.creds.apiKey;
  }

  private client<P>(
    baseUrl: string,
    auth: HeaderMap | (() => HeaderMap | Promise<HeaderMap>),
    errorPrefix = "",
  ): ApiClient<P> {
    return createApiClient<P>({
      vendor: "Pinecone",
      baseUrl,
      headers:
        typeof auth === "function"
          ? async () => ({ ...JSON_HEADERS, ...(await auth()) })
          : { ...JSON_HEADERS, ...auth },
      http: this.services?.http,
      caCert: this.creds.caCert,
      contentType: "with-body",
      emptyBodyIsUndefined: true,
      httpError: ({ status, path, body }) =>
        new PineconeApiError(status, `${errorPrefix}${path}`, body ?? ""),
    });
  }

  private requireKey(): string {
    if (!this.creds.apiKey) {
      throw new PineconeApiError(
        401,
        "control plane",
        "This account has no project API key, so indexes, backups and assistants cannot be read.",
      );
    }
    return this.creds.apiKey;
  }

  /** A data-plane client for an index or assistant host, with the project API key. */
  private onHost<P>(host: string, path: string): ApiClient<P> {
    const base = hostUrl(host);
    if (!base) throw new PineconeApiError(404, path, "This resource has no host yet.");
    pineconeUrl(base, path);
    return this.client<P>(base, { "Api-Key": this.requireKey() });
  }

  async describeIndexStats(host: string) {
    const path = "/describe_index_stats";
    return this.onHost<DataPaths>(host, path).post(path, { body: {} });
  }

  async listAssistantFiles(host: string, assistant: string) {
    const path = `/files/${pathEncode(assistant)}` as const;
    return fileLists(this.onHost<AssistantDataPaths>(host, path)).getAll(path, "files");
  }

  async chatCompletion(
    host: string,
    assistant: string,
    body: ApiBody<AssistantDataOperations["chat_completion_assistant"]>,
  ) {
    const path = `/chat/${pathEncode(assistant)}/chat/completions` as const;
    return this.onHost<AssistantDataPaths>(host, path).post(path, { body });
  }

  /**
   * Prometheus endpoints (discovery and the scrape targets) take the project
   * API key as a Bearer token rather than in `Api-Key`. These stay outside the
   * clients: a scrape target is a URL discovery named, and the docs' `/metrics/discovery`
   * is not in the document, which spells it `/metrics/discover`.
   */
  private async prometheus<T>(
    url: string,
    accept: string,
    responseAs?: "text",
  ): Promise<RestResponse<T>> {
    const token = this.requireKey();
    const u = new URL(pineconeUrl(url, "Prometheus scrape target"));
    const path = `${u.pathname}${u.search}`;
    return restRequest<T>({
      vendor: "Pinecone",
      url: `${u.origin}${path}`,
      headers: {
        Accept: accept,
        "X-Pinecone-Api-Version": API_VERSION,
        Authorization: `Bearer ${token}`,
      },
      init: { method: "GET" },
      contentType: "with-body",
      emptyBodyIsUndefined: true,
      ...(responseAs ? { responseAs } : {}),
      ...this.transport(),
      httpError: ({ status, body }) => new PineconeApiError(status, path, body ?? ""),
    });
  }

  private transport() {
    return hostTransport(this.services?.http, this.creds.caCert);
  }

  /** The scrape targets a project's discovery endpoint names. */
  async prometheusTargets(url: string): Promise<PcPrometheusTargets> {
    return (await this.prometheus<PcPrometheusTargets>(url, "application/json")).body;
  }

  /** One scrape target's Prometheus text. */
  async prometheusScrape(url: string): Promise<string> {
    const { body } = await this.prometheus<string>(url, "text/plain", "text");
    return body ?? "";
  }

  /** OAuth2 client-credentials exchange, cached until a minute before expiry. */
  async accessToken(): Promise<string> {
    if (!this.hasAdmin) {
      throw new PineconeApiError(
        401,
        "/oauth/token",
        "Add a service account client ID and secret to this account to manage projects, API keys and service accounts.",
      );
    }
    if (this.token && Date.now() < this.token.expiresAt) return this.token.token;
    if (this.tokenInFlight) return this.tokenInFlight;
    this.tokenInFlight = (async () => {
      try {
        const grant: ApiBody<OAuthOperations["get_token"]> = {
          grant_type: "client_credentials",
          client_id: this.creds.clientId,
          client_secret: this.creds.clientSecret,
          audience: `${API_HOST}/`,
        };
        // Read as text: an empty 200 here is a failed exchange, not a list with nothing in it.
        const { body } = await restRequest<string>({
          vendor: "Pinecone",
          url: `${LOGIN_HOST}/oauth/token`,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Pinecone-Api-Version": API_VERSION,
          },
          init: { method: "POST", body: JSON.stringify(grant) },
          contentType: "with-body",
          responseAs: "text",
          ...this.transport(),
          httpError: ({ status, body: text }) =>
            new PineconeApiError(status, "/oauth/token", text ?? ""),
        });
        const parsed: ApiResponse<OAuthOperations["get_token"]> = JSON.parse(body ?? "");
        if (!parsed.access_token) {
          throw new PineconeApiError(502, "/oauth/token", "No access token in the response.");
        }
        const ttl = Math.max(60, Number(parsed.expires_in) || 1800);
        this.token = { token: parsed.access_token, expiresAt: Date.now() + (ttl - 60) * 1000 };
        return parsed.access_token;
      } finally {
        this.tokenInFlight = undefined;
      }
    })();
    return this.tokenInFlight;
  }
}

export function isStatus(err: unknown, ...statuses: number[]): boolean {
  return err instanceof PineconeApiError && statuses.includes(err.status);
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
