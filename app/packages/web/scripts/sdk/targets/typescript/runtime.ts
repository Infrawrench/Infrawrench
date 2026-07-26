/**
 * The hand-written half of the generated TypeScript SDK.
 *
 * This file is **not imported by anything in this repo** — the generator reads
 * it off disk and inlines it at the top of `sdk/typescript/index.ts`, ahead of
 * the generated models and namespace classes. Keeping it as real source (rather
 * than a template string) means it is typechecked by `pnpm typecheck` and
 * formatted by `pnpm format` like everything else, so a mistake in the request
 * plumbing shows up here instead of in generated output nobody reads.
 *
 * Two tokens are substituted at generation time — see `SUBSTITUTIONS` in
 * `./index.ts`. They are written as plain string literals so this file still
 * typechecks on its own.
 *
 * Nothing here may import anything: the published package has zero
 * dependencies and must run on stock Node 18+ / any modern browser.
 */

// --8<-- everything below this line is inlined into the generated SDK --8<--

/** Replaced with the first server advertised by the spec. */
const DEFAULT_BASE_URL = "@@BASE_URL@@";

/**
 * Replaced with the path parameter the client can carry as configuration
 * (`orgId`), or `null` if the API has no such parameter.
 */
const SCOPE_PARAM: string | null = "@@SCOPE_PARAM@@";

export interface ClientOptions {
  /** Base URL of the deployment. Defaults to the production API. */
  baseUrl?: string;
  /**
   * API key or WorkOS access token, sent as `Authorization: Bearer <token>`.
   * Omit it only if you are supplying the header yourself.
   */
  apiKey?: string;
  /**
   * Default organization id. Every org-scoped call accepts `orgId`; set it here
   * once and you can leave it off the call sites.
   */
  orgId?: string;
  /** Headers merged into every request. Per-call headers win. */
  headers?: Record<string, string>;
  /** Abort requests after this many milliseconds. No timeout by default. */
  timeoutMs?: number;
  /** Swap the fetch implementation — for tests, proxies, or custom agents. */
  fetch?: typeof globalThis.fetch;
}

/** Per-call overrides, accepted as the last argument of every method. */
export interface RequestOptions {
  /** Cancel the request. Combined with `timeoutMs` if both are set. */
  signal?: AbortSignal;
  /** Headers for this call only. */
  headers?: Record<string, string>;
  /** Timeout for this call only, overriding the client-wide one. */
  timeoutMs?: number;
}

/**
 * Thrown for any non-2xx response. The parsed response body is on `.body`, and
 * `.code` carries the machine-readable discriminator when the API sends one
 * (e.g. `reauthentication_required` on a step-up 403) — branch on that, not on
 * the message.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly body: unknown;
  readonly method: string;
  readonly url: string;

  constructor(init: {
    status: number;
    message: string;
    code: string | undefined;
    body: unknown;
    method: string;
    url: string;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.body = init.body;
    this.method = init.method;
    this.url = init.url;
  }
}

/** A single HTTP call, as described by the generated namespace methods. */
export interface RequestSpec {
  method: string;
  /** URL template with `{param}` placeholders, e.g. `/api/org/{orgId}/accounts`. */
  path: string;
  pathParams?: Record<string, unknown> | undefined;
  query?: Record<string, unknown> | undefined;
  /** JSON request body. */
  body?: unknown;
  /** `multipart/form-data` fields. Mutually exclusive with `body`. */
  form?: Record<string, unknown> | undefined;
  /** What the endpoint returns. Defaults to `json`. */
  accept?: "json" | "binary" | "empty" | undefined;
}

/**
 * Request plumbing shared by every namespace.
 *
 * Exported because the generated namespace classes take one in their
 * constructor; it is not part of the stable surface, and you should reach for
 * `APIV1Client` instead.
 */
export class ApiTransport {
  /** Normalized base URL, without a trailing slash. */
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly defaults: Record<string, string | undefined>;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.defaults = SCOPE_PARAM === null ? {} : { [SCOPE_PARAM]: options.orgId };
    this.headers = { ...options.headers };
    this.timeoutMs = options.timeoutMs;
    const impl = options.fetch ?? globalThis.fetch;
    if (typeof impl !== "function") {
      throw new TypeError(
        "No global fetch is available in this runtime — pass one as `fetch` in ClientOptions.",
      );
    }
    this.fetchImpl = impl;
  }

  async request<T>(spec: RequestSpec, options: RequestOptions = {}): Promise<T> {
    const url = this.baseUrl + this.resolvePath(spec) + serializeQuery(spec.query);

    const headers: Record<string, string> = {
      accept: spec.accept === "binary" ? "application/octet-stream" : "application/json",
      ...this.headers,
      ...options.headers,
    };
    if (this.apiKey !== undefined && this.apiKey !== "") {
      headers["authorization"] = `Bearer ${this.apiKey}`;
    }

    let body: BodyInit | undefined;
    if (spec.form !== undefined) {
      // Leave content-type unset: fetch has to add the multipart boundary.
      body = toFormData(spec.form);
    } else if (spec.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(spec.body);
    }

    const signal = combineSignals(options.signal, options.timeoutMs ?? this.timeoutMs);
    // Built up rather than declared inline: `RequestInit` types `body` as
    // `BodyInit | null`, so handing it an explicit `undefined` is a type error.
    const init: RequestInit = { method: spec.method, headers };
    if (body !== undefined) init.body = body;
    if (signal !== undefined) init.signal = signal;

    const response = await this.fetchImpl(url, init);

    if (!response.ok) throw await toApiError(response, spec.method, url);
    if (spec.accept === "binary") return (await response.blob()) as T;
    if (spec.accept === "empty" || response.status === 204 || response.status === 205) {
      return undefined as T;
    }

    const text = await response.text();
    if (text === "") return undefined as T;
    if (!(response.headers.get("content-type") ?? "").includes("json")) return text as T;
    return JSON.parse(text) as T;
  }

  /** Fill `{param}` placeholders from the call, falling back to client config. */
  private resolvePath(spec: RequestSpec): string {
    return spec.path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
      const value = spec.pathParams?.[name] ?? this.defaults[name];
      if (value === undefined || value === null || value === "") {
        const hint =
          name === SCOPE_PARAM
            ? ` — pass it, or set \`${name}\` when constructing the client.`
            : ".";
        throw new TypeError(
          `Missing path parameter "${name}" for ${spec.method} ${spec.path}${hint}`,
        );
      }
      return encodeURIComponent(String(value));
    });
  }
}

function serializeQuery(query: Record<string, unknown> | undefined): string {
  if (query === undefined) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value as unknown[]) {
        if (item !== undefined && item !== null) params.append(key, String(item));
      }
    } else {
      params.append(key, String(value));
    }
  }
  const encoded = params.toString();
  return encoded === "" ? "" : `?${encoded}`;
}

function toFormData(fields: Record<string, unknown>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (value instanceof Blob) form.append(key, value);
    else form.append(key, String(value));
  }
  return form;
}

function combineSignals(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  if (timeoutMs === undefined) return signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  if (signal === undefined) return timeout;
  // `AbortSignal.any` is Node 20.3+ / modern browsers. Without it the caller's
  // own signal wins, which is the safer of the two to lose.
  const combine = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  return typeof combine === "function" ? combine.call(AbortSignal, [signal, timeout]) : signal;
}

async function toApiError(response: Response, method: string, url: string): Promise<ApiError> {
  const text = await response.text().catch(() => "");
  let body: unknown = text;
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON — keep the raw text as the body.
    }
  }
  const record: Record<string, unknown> =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const detail =
    typeof record["error"] === "string"
      ? record["error"]
      : typeof record["message"] === "string"
        ? record["message"]
        : `${response.status} ${response.statusText || "Request failed"}`;
  return new ApiError({
    status: response.status,
    message: `${method} ${url} failed: ${detail}`,
    code: typeof record["code"] === "string" ? record["code"] : undefined,
    body,
    method,
    url,
  });
}
