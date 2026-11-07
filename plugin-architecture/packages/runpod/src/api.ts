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
 * API key (verified 2026-10):
 *
 * - REST (`https://rest.runpod.io/v1`, OpenAPI at `/v1/openapi.json`): pods,
 *   Serverless endpoints, templates, network volumes, container registry
 *   auths and billing history. `Authorization: Bearer <key>`. Typed from that
 *   document, through `RunpodApi.rest`.
 * - GraphQL (`https://api.runpod.io/graphql`): the only home of the account
 *   (balance, spend limit, SSH public keys, savings plans), GPU type pricing
 *   and stock, data centers, and pod runtime telemetry. Same Bearer header.
 * - Serverless (`https://api.runpod.ai/v2/{endpointId}`): queue health and
 *   purge. The docs send the bare key in `authorization`. The document at
 *   `api.runpod.ai/openapi.json` covers only the Batch API, so these two and
 *   GraphQL stay hand-written.
 *
 * Requests go through `services.http` when the host provides it (bastion
 * routing, custom CA, no renderer CORS); plain `fetch` otherwise.
 */

export const REST_BASE = "https://rest.runpod.io/v1";
export const GRAPHQL_URL = "https://api.runpod.io/graphql";
export const SERVERLESS_BASE = "https://api.runpod.ai/v2";

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
  errors?: Array<{ message?: string }>;
}

/** REST errors are `{error: "..."}`, GraphQL `{errors: [{message}]}`; show the message. */
export function summarizeBody(body: string): string {
  try {
    const parsed: ProviderErrorBody = JSON.parse(body);
    if (typeof parsed.error === "string" && parsed.error) return parsed.error;
    if (typeof parsed.message === "string" && parsed.message) return parsed.message;
    const first = parsed.errors?.[0]?.message;
    if (first) return first;
  } catch {
    /* not JSON */
  }
  return body.slice(0, 500) || "(empty response)";
}

interface GraphqlAnswer<T> {
  data?: T;
  errors?: Array<{ message?: string; extensions?: { code?: string } }>;
}

export class RunpodApi {
  /** REST calls against `rest.runpod.io/v1`. An empty body answers `undefined`. */
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
