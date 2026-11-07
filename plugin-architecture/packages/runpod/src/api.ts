import {
  createApiClient,
  restRequest,
  type ApiClient,
  type HostServices,
  type HttpHostServices,
} from "@infrawrench/plugin-base";
import type { paths } from "./api-types.gen.js";

/**
 * Transport for Runpod's three API surfaces, all authenticated with the same
 * API key (verified 2026-11):
 *
 * - REST v2 (`https://api.runpod.io/v2`, OpenAPI at `/v2/openapi.json`): pods,
 *   Serverless endpoints, templates, network volumes, registries, account SSH
 *   keys, the GPU, CPU and data center catalog and billing history.
 *   `Authorization: Bearer <key>`. Typed from that document, through
 *   `RunpodApi.rest`. The document's paths carry the `/v2`.
 * - GraphQL (`https://api.runpod.io/graphql`): what REST v2 has no route for,
 *   which is the account (balance, spend limit, savings plans) and the pod and
 *   template details REST v2 leaves out. Same Bearer header.
 * - Serverless (`https://api.runpod.ai/v2/{endpointId}`): queue health and
 *   purge, the URLs the REST document reports in `requestUrls`. The docs send
 *   the bare key in `authorization`. These two and GraphQL stay hand-written.
 *
 * Requests go through `services.http` when the host provides it (bastion
 * routing, custom CA, no renderer CORS); plain `fetch` otherwise.
 */

export const REST_BASE = "https://api.runpod.io";
export const GRAPHQL_URL = "https://api.runpod.io/graphql";
export const SERVERLESS_BASE = "https://api.runpod.ai/v2";

/** The largest page the document allows, and how many of them one list may take. */
const PAGE_SIZE = 1000;
const MAX_PAGES = 100;

export class RunpodApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, label: string, body: string) {
    super(`Runpod API error ${status} for ${label}: ${summarizeBody(body)}`);
    this.name = "RunpodApiError";
    this.status = status;
    this.body = body;
  }
}

interface ProviderErrorBody {
  error?: string | number | null;
  message?: string | number | null;
  detail?: string | null;
  errors?: Array<{ message?: string } | string>;
}

/**
 * REST v2 errors are RFC 9457 (`{title, status, detail, errors: ["..."]}`),
 * GraphQL `{errors: [{message}]}`, Serverless `{error: "..."}`; show the message.
 */
export function summarizeBody(body: string): string {
  try {
    const parsed: ProviderErrorBody = JSON.parse(body);
    const failures = parsed.errors ?? [];
    if (typeof parsed.detail === "string" && parsed.detail) {
      const reasons = failures.filter((e) => typeof e === "string");
      return reasons.length ? `${parsed.detail}: ${reasons.join("; ")}` : parsed.detail;
    }
    if (typeof parsed.error === "string" && parsed.error) return parsed.error;
    if (typeof parsed.message === "string" && parsed.message) return parsed.message;
    const first = failures[0];
    const message = typeof first === "string" ? first : first?.message;
    if (message) return message;
  } catch {
    /* not JSON */
  }
  return body.slice(0, 500) || "(empty response)";
}

interface GraphqlAnswer<T> {
  data?: T;
  errors?: Array<{ message?: string; extensions?: { code?: string } }>;
}

interface PagedAnswer {
  pagination: { nextCursor: string | null; hasNextPage: boolean };
}

export class RunpodApi {
  /** REST calls against `api.runpod.io`. An empty body answers `undefined`. */
  readonly rest: ApiClient<paths>;
  private readonly http: HttpHostServices | undefined;

  constructor(
    private readonly apiKey: string,
    private readonly caCert: string,
    services: HostServices | undefined,
  ) {
    this.http = services?.http;
    this.rest = createApiClient<paths>({
      vendor: "Runpod",
      baseUrl: REST_BASE,
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      http: this.http,
      caCert,
      contentType: "with-body",
      emptyBodyIsUndefined: true,
      httpError: ({ status, path, body }) => new RunpodApiError(status, path, body ?? ""),
    });
  }

  /**
   * Every item of a cursor-paged list. The host prunes what a sync stops seeing, so
   * this throws rather than return part of a list: a page with no list or no
   * pagination block, a cursor that does not move, or a list past the page cap.
   * `withCursorPagination` reads a non-array page as the end of the list (#436).
   */
  async listAll<Page extends PagedAnswer, Item>(
    path: string,
    fetchPage: (query: { limit: number; cursor?: string }) => Promise<Page>,
    read: (page: Page) => Item[],
  ): Promise<Item[]> {
    const items: Item[] = [];
    let cursor: string | undefined;
    for (let n = 0; n < MAX_PAGES; n++) {
      const page = await fetchPage({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
      const batch = page ? read(page) : undefined;
      const more = page?.pagination?.hasNextPage;
      if (!Array.isArray(batch) || typeof more !== "boolean") {
        throw new Error(
          `Runpod answered ${path} with an unexpected page after ${items.length} items, so the list was not read`,
        );
      }
      items.push(...batch);
      if (!more) return items;
      const next = page.pagination.nextCursor;
      if (!next || next === cursor) {
        throw new Error(
          `Runpod said ${path} has more after ${items.length} items but gave no new cursor, so the list was not read`,
        );
      }
      cursor = next;
    }
    throw new Error(
      `Runpod's ${path} did not finish within ${MAX_PAGES} pages (${items.length} items), so the list was not read`,
    );
  }

  /** The transport of the two surfaces the document does not cover; the body comes back as text. */
  private async send(
    url: string,
    label: string,
    method: string,
    authorization: string,
    body: object | undefined,
  ): Promise<string> {
    const answer = await restRequest<string>({
      vendor: "Runpod",
      url,
      headers: { Accept: "application/json", Authorization: authorization },
      init: { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
      ...(this.http ? { http: this.http } : {}),
      ...(this.caCert ? { caCert: this.caCert } : {}),
      contentType: "with-body",
      responseAs: "text",
      httpError: ({ status, body: text }) => new RunpodApiError(status, label, text ?? ""),
    });
    return answer.body ?? "";
  }

  /**
   * GraphQL call. Runpod answers application errors with HTTP 200 and an
   * `errors` array; those become a `RunpodApiError` with status 400 (or 401/403
   * when the message says so) so callers can classify them like REST errors.
   */
  async graphql<T>(query: string, variables?: object): Promise<T | undefined> {
    const text = await this.send(GRAPHQL_URL, "graphql", "POST", `Bearer ${this.apiKey}`, {
      query,
      ...(variables ? { variables } : {}),
    });
    const parsed: GraphqlAnswer<T> = text ? JSON.parse(text) : {};
    if (parsed.errors?.length) {
      const first = parsed.errors[0];
      const code = first?.extensions?.code ?? "";
      const msg = first?.message ?? "";
      const status =
        code === "UNAUTHENTICATED" || /unauthori[sz]ed|api key/i.test(msg)
          ? 401
          : code === "FORBIDDEN" || /permission|forbidden/i.test(msg)
            ? 403
            : 400;
      throw new RunpodApiError(status, "graphql", text);
    }
    return parsed.data;
  }

  /** Serverless endpoint operation (`api.runpod.ai/v2/{id}/{op}`). */
  async serverless<T>(
    endpointId: string,
    op: string,
    method: "GET" | "POST" = "GET",
  ): Promise<T | undefined> {
    const path = `/${encodeURIComponent(endpointId)}/${op}`;
    const text = await this.send(
      `${SERVERLESS_BASE}${path}`,
      path,
      method,
      this.apiKey,
      method === "POST" ? {} : undefined,
    );
    return text ? JSON.parse(text) : undefined;
  }
}

export function isStatus(err: unknown, ...statuses: number[]): boolean {
  return err instanceof RunpodApiError && statuses.includes(err.status);
}
