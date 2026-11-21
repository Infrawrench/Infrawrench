/**
 * The HTTP half: Bearer requests against the org-scoped env-files routes
 * (`@infrawrench/api-contract`'s `env-files` domain) and `GET /api/v1/whoami`,
 * through client-core's `createCloudFetch`, the same client the editor
 * extensions use.
 *
 * kill-emudhra comes first, as in every Node process Infrawrench ships
 * (KNOWLEDGE.md "Compromised CA stopgap"). It is imported here rather than in
 * the entry because this module is what every request goes through, and the
 * commands that never make one (`--version`, the hook commands) then skip
 * loading Node's TLS stack at all.
 */
import "kill-emudhra";
import {
  CloudApiError,
  createCloudFetch,
  fetchInfraenvDescribe,
  fetchInfraenvResolve,
  staticAccessToken,
  type CloudFetch,
  type InfraenvDescribeInput,
  type InfraenvDescribeResponse,
  type InfraenvResolveInput,
  type InfraenvResolveResponse,
} from "@infrawrench/client-core";
import type { Credentials } from "./config";
import { Failure } from "./io";
import { VERSION } from "./version";

/** Resolve calls the providers for every resource output, so give it time. */
const REQUEST_TIMEOUT_MS = 120_000;

export interface Whoami {
  readonly userId: string;
  readonly organizationId: string;
  /** `user`, `api_key` or `agent`; a newer server may add more. */
  readonly principal: string;
}

export interface Api {
  readonly baseUrl: string;
  whoami(): Promise<Whoami>;
  /** The response as the server sent it: a newer server's extra fields pass through. */
  resolve(orgId: string, input: InfraenvResolveInput): Promise<InfraenvResolveResponse>;
  describe(orgId: string, input: InfraenvDescribeInput): Promise<InfraenvDescribeResponse>;
}

export function createApi(credentials: Pick<Credentials, "apiKey" | "baseUrl">): Api {
  const client = createCloudFetch({
    tokens: staticAccessToken(credentials.apiKey),
    baseUrl: credentials.baseUrl,
  });
  const init = (): RequestInit => ({
    headers: { "User-Agent": `infraenv/${VERSION} node/${process.versions.node}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const call = async <T>(what: string, run: (client: CloudFetch) => Promise<T | null>) => {
    try {
      const value = await run(client);
      if (value === null || typeof value !== "object") {
        throw new Failure(`${what}: the server sent an empty response.`);
      }
      return value;
    } catch (error) {
      throw toFailure(error, what, credentials.baseUrl);
    }
  };
  return {
    baseUrl: credentials.baseUrl,
    whoami: () => call("Checking the API key", (c) => c.api<Whoami>("/api/v1/whoami", init())),
    resolve: (orgId, input) =>
      call("Resolving .infraenv", (c) => fetchInfraenvResolve(c, orgId, input, init())),
    describe: (orgId, input) =>
      call("Checking .infraenv", (c) => fetchInfraenvDescribe(c, orgId, input, init())),
  };
}

/** The `error` (or `message`) of a JSON error body, else the body's text. */
export function errorText(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // Not JSON: use the text.
  }
  return body.trim().slice(0, 500);
}

export class ApiFailure extends Failure {
  constructor(
    message: string,
    readonly status: number,
    readonly serverMessage: string,
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}

function toFailure(error: unknown, what: string, baseUrl: string): Failure {
  if (error instanceof Failure) return error;
  if (error instanceof CloudApiError) {
    const server = errorText(error.body);
    if (error.status === 401) {
      return new ApiFailure(
        "Infrawrench did not accept the API key: it is unknown, revoked or expired. Run `infraenv login` with a new one, or check INFRAWRENCH_API_KEY.",
        401,
        server,
      );
    }
    return new ApiFailure(
      `${what} failed (HTTP ${error.status})${server ? `: ${server}` : ""}`,
      error.status,
      server,
    );
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return new Failure(`${what}: ${baseUrl} did not answer within two minutes.`);
  }
  const cause =
    error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return new Failure(`${what}: could not reach ${baseUrl} (${cause ?? message}).`);
}
