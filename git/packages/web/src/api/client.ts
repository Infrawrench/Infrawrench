/**
 * The typed API client: `api.<group>.<endpoint>({ params, query, payload })`
 * for every endpoint of `@infrawrench/git-contract`, resolving with the
 * server's JSON typed as the endpoint's success.
 *
 * The method and path of each endpoint come from `routes.gen.ts`; the types
 * come from the contract (`types.ts`). A call goes through the transport,
 * which is `fetch` unless the dev mock replaced it (`src/mock`).
 */
import { API_ROUTES } from "./routes.gen";
import type { ApiClient, WireRequest } from "./types";

/** A status outside 2xx. `message` is the server's sentence; `code` is one of the contract's `ERROR_CODES`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export const isNotFound = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 404;

export interface ApiCall {
  readonly group: string;
  readonly endpoint: string;
  readonly method: string;
  /** The contract's path template (`/api/repos/:owner/:repo/tree`). */
  readonly path: string;
  readonly request: WireRequest;
}

export type Transport = (call: ApiCall) => Promise<unknown>;

/** `path` with each `:name` replaced by its URI-escaped value. */
export function fillPath(path: string, params: Readonly<Record<string, unknown>>): string {
  return path.replace(/:(\w+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value === null || value === "." || value === "..") {
      throw new ApiError(0, `Missing path parameter: ${name}`);
    }
    return encodeURIComponent(String(value));
  });
}

/** A query string from the defined values of `query`, with its `?`, or empty. */
export function queryString(query: Readonly<Record<string, unknown>> | undefined): string {
  if (query === undefined) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text === "" ? "" : `?${text}`;
}

const httpTransport: Transport = async ({ method, path, request }) => {
  const url = fillPath(path, request.params ?? {}) + queryString(request.query);
  const hasBody = request.payload !== undefined && method !== "GET";
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: hasBody
        ? { accept: "application/json", "content-type": "application/json" }
        : { accept: "application/json" },
      body: hasBody ? JSON.stringify(request.payload) : null,
    });
  } catch {
    throw new ApiError(0, "The server could not be reached");
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = text === "" ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const record = (typeof body === "object" && body !== null ? body : {}) as {
      error?: unknown;
      code?: unknown;
    };
    throw new ApiError(
      response.status,
      typeof record.error === "string" ? record.error : `Request failed (${response.status})`,
      typeof record.code === "string" ? record.code : undefined,
    );
  }
  return body;
};

let transport: Transport = httpTransport;

/** Replaces how calls are made. The dev mock uses this; nothing else should. */
export function setTransport(next: Transport): void {
  transport = next;
}

type RouteTable = Readonly<Record<string, Readonly<Record<string, readonly [string, string]>>>>;

function makeClient(): ApiClient {
  const routes: RouteTable = API_ROUTES;
  const client: Record<string, Record<string, (request?: WireRequest) => Promise<unknown>>> = {};
  for (const [group, endpoints] of Object.entries(routes)) {
    const methods: Record<string, (request?: WireRequest) => Promise<unknown>> = {};
    for (const [endpoint, [method, path]] of Object.entries(endpoints)) {
      methods[endpoint] = (request) =>
        transport({ group, endpoint, method, path, request: request ?? {} });
    }
    client[group] = methods;
  }
  // The route table is generated from the same contract the type is derived
  // from, and a test holds the two together.
  return client as unknown as ApiClient;
}

export const api: ApiClient = makeClient();
