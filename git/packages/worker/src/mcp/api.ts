/**
 * How the MCP tools reach the forge: its own JSON API, in this process, with
 * the caller's credential.
 *
 * A tool builds the request a client over the network would send and hands
 * it to the API's handler directly. Nothing about access is decided on this
 * side: authentication, the repository gate (`repoAccess`), a token's scope,
 * what a CI job's token reaches, an archived repository, the limits and the
 * rate budgets are all the API's, as they are for every other caller, so a
 * tool can never do what the same credential could not do with `curl`.
 *
 * What does not cross: the session cookie and the caller's `Origin`. A
 * request made here carries the `Authorization` header and nothing else of
 * the MCP request, so a tool call is never a session's.
 */
export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiAnswer {
  readonly status: number;
  /** The parsed JSON body, or null for none. */
  readonly body: unknown;
  /** `Retry-After`, in seconds, when the API said to wait. */
  readonly retryAfter: number | null;
}

export interface ApiRequestOptions {
  readonly query?: Readonly<Record<string, string | number | boolean | null | undefined>>;
  readonly body?: unknown;
}

export type ApiCall = (
  method: ApiMethod,
  path: string,
  options?: ApiRequestOptions,
) => Promise<ApiAnswer>;

/** The API's handler, already inside the invocation's request scope. */
export type ApiHandle = (request: Request) => Promise<Response>;

export const inProcessApi =
  (handle: ApiHandle, origin: string, authorization: string): ApiCall =>
  async (method, path, options = {}) => {
    const url = new URL(path, origin);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
    }
    const headers = new Headers({ authorization, accept: "application/json" });
    const init: RequestInit = { method, headers };
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(options.body);
    }
    const response = await handle(new Request(url, init));
    const text = await response.text();
    let body: unknown = null;
    if (text !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    return {
      status: response.status,
      body,
      retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
    };
  };

/** A tool's refusal: the message is for the agent, and says what to do next when there is something. */
export class ToolFailure extends Error {
  override readonly name = "ToolFailure";
}

const errorOf = (
  body: unknown,
): { readonly error: string | null; readonly code: string | null } => {
  if (typeof body !== "object" || body === null) return { error: null, code: null };
  const { error, code } = body as { error?: unknown; code?: unknown };
  return {
    error: typeof error === "string" ? error : null,
    code: typeof code === "string" ? code : null,
  };
};

/**
 * The body of an answer that succeeded, or a {@link ToolFailure} saying why
 * it did not, in terms an agent can act on.
 */
export const expectOk = (answer: ApiAnswer, what: string): unknown => {
  if (answer.status >= 200 && answer.status < 300) return answer.body;
  const { error, code } = errorOf(answer.body);
  if (answer.status === 503 && code === "not_implemented") {
    throw new ToolFailure(
      `${what}: this part of the forge is not available on this server yet. Nothing was changed. Carry on without it.`,
    );
  }
  if (answer.status === 401) {
    throw new ToolFailure(`${what}: the credential was not accepted. Sign in again.`);
  }
  if (answer.status === 404) {
    throw new ToolFailure(
      `${what}: ${error ?? "not found"}. It does not exist, or this credential cannot read it.`,
    );
  }
  if (answer.status === 429) {
    throw new ToolFailure(
      `${what}: too many requests. Wait ${answer.retryAfter ?? 60} seconds and try again.`,
    );
  }
  if (answer.status === 400) {
    const issues = (answer.body as { issues?: unknown } | null)?.issues;
    throw new ToolFailure(
      `${what}: the request was not valid: ${error ?? "bad request"}${
        issues === undefined ? "" : ` ${JSON.stringify(issues).slice(0, 2000)}`
      }`,
    );
  }
  throw new ToolFailure(
    `${what}: ${error ?? `the forge answered ${answer.status}`}${code ? ` (${code})` : ""}`,
  );
};
