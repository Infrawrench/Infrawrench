import type { ApiClient, ApiResponse, HttpHostServices } from "@infrawrench/plugin-base";
import {
  createApiClient,
  jsonRestFetch,
  requireListPage,
  utf8ToBase64,
} from "@infrawrench/plugin-base";
import type { paths as DeveloperPaths } from "./api-types.developer.gen.js";
import type { paths as QStashPaths } from "./api-types.qstash.gen.js";

/**
 * Two Upstash APIs, verified 2026-10 against the published OpenAPI documents
 * (`https://upstash.com/docs/devops/developer-api/openapi.yaml` and
 * `https://upstash.com/docs/qstash/openapi.yaml`):
 *
 * - **Developer API** `https://api.upstash.com/v2`: HTTP Basic auth with the
 *   account email and a Developer API key (Console, Account, Developer API).
 *   Manages Redis databases, Vector and Search indexes, QStash accounts,
 *   teams and the audit log. Only native Upstash accounts can use it; accounts
 *   created through Vercel or Fly.io cannot.
 * - **QStash API** `https://qstash-{region}.upstash.io/v2`: Bearer auth with
 *   the QStash token of one regional QStash account. The Developer API hands
 *   those tokens out in `GET /qstash/users`, so the user never types one.
 *
 * Errors are plain text or `{ "error": "..." }`.
 */
export const DEVELOPER_API = "https://api.upstash.com/v2";

export function qstashBase(region: string | undefined): string {
  return `https://qstash-${region || "eu-central-1"}.upstash.io`;
}

export interface UpstashContext {
  email: string;
  apiKey: string;
  caCert?: string;
  http?: HttpHostServices;
  /** Overridable for tests. */
  baseUrl?: string;
  qstashBaseUrl?: (region: string | undefined) => string;
}

export class UpstashApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "UpstashApiError";
    this.status = status;
  }
}

export function statusOf(err: unknown): number {
  return err instanceof UpstashApiError ? err.status : 0;
}

export type DeveloperClient = ApiClient<DeveloperPaths>;
export type QStashClient = ApiClient<QStashPaths>;

/** The regional QStash account a call acts as. */
export interface QStashAccount {
  token: string;
  region?: string | undefined;
}

const STATUS_IN_MESSAGE = /API error (\d{3})/;

function rethrow(err: unknown, vendor: string): never {
  const message = err instanceof Error ? err.message : String(err);
  const status = Number(STATUS_IN_MESSAGE.exec(message)?.[1] ?? 0);
  if (!status) throw err;
  let detail = message.replace(/^.*?: /, "");
  const jsonStart = detail.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed: { error?: string; message?: string } = JSON.parse(detail.slice(jsonStart));
      detail = parsed.error ?? parsed.message ?? detail;
    } catch {
      /* keep text */
    }
  }
  const hint =
    status === 401
      ? vendor === "Upstash"
        ? " Check the email and Developer API key, and that the account was created on upstash.com (Vercel and Fly.io accounts cannot use the Developer API)."
        : " The QStash token was rejected; reset it from the QStash account if it was rotated elsewhere."
      : status === 403
        ? " The key is read-only or lacks access to this resource."
        : "";
  throw new UpstashApiError(
    status,
    `${vendor} API error ${status}: ${detail.trim() || "(empty)"}${hint}`,
  );
}

/**
 * Run a call, with the provider's errors explained. `undefined` is an answer that
 * was not JSON: a few writes answer 200 with a bare "OK".
 */
async function answered<T>(vendor: string, call: () => Promise<T>): Promise<T | undefined> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof SyntaxError) return undefined;
    rethrow(err, vendor);
  }
}

/**
 * What a list read answered. `answered` gives `undefined` for a 2xx that is not JSON,
 * which is fine for a write and not for a list: a sync prunes whatever a list stops
 * returning. A JSON `null` stays empty: the Go timestamps in these APIs point to a Go
 * backend, where an empty slice can marshal that way, and the document does not rule
 * it out for an account with nothing in it.
 */
export function listOf<T>(
  vendor: string,
  path: string,
  answer: readonly T[] | null | undefined,
): T[] {
  return answer === null ? [] : requireListPage(answer, { vendor, path, key: null });
}

/** A Developer API call (Basic auth). */
export function dev<T>(
  ctx: UpstashContext,
  call: (api: DeveloperClient) => Promise<T>,
): Promise<T | undefined> {
  return answered("Upstash", () =>
    call(
      createApiClient<DeveloperPaths>({
        vendor: "Upstash",
        baseUrl: ctx.baseUrl ?? DEVELOPER_API,
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${utf8ToBase64(`${ctx.email}:${ctx.apiKey}`)}`,
        },
        http: ctx.http,
        caCert: ctx.caCert,
      }),
    ),
  );
}

const qstashHeaders = (account: QStashAccount) => ({
  Accept: "application/json",
  Authorization: `Bearer ${account.token}`,
});

/** A QStash API call (Bearer QStash token of one regional account). */
export function qstash<T>(
  ctx: UpstashContext,
  account: QStashAccount,
  call: (api: QStashClient) => Promise<T>,
): Promise<T | undefined> {
  return answered("QStash", () =>
    call(
      createApiClient<QStashPaths>({
        vendor: "QStash",
        baseUrl: (ctx.qstashBaseUrl ?? qstashBase)(account.region),
        headers: qstashHeaders(account),
        http: ctx.http,
        caCert: ctx.caCert,
      }),
    ),
  );
}

/**
 * A QStash POST whose body goes as it stands, because it is the user's message, and
 * whose path may hold a destination URL verbatim. `Op` is what the document says it
 * answers; the client only writes JSON bodies and checked paths.
 */
export function qstashPost<Op>(
  ctx: UpstashContext,
  account: QStashAccount,
  path: string,
  body: string,
  headers: Record<string, string>,
): Promise<ApiResponse<Op> | undefined> {
  return answered("QStash", () =>
    jsonRestFetch<ApiResponse<Op>>({
      vendor: "QStash",
      url: `${(ctx.qstashBaseUrl ?? qstashBase)(account.region)}${path}`,
      errorPath: path,
      headers: { ...qstashHeaders(account), ...headers },
      init: { method: "POST", body },
      ...(ctx.http ? { http: ctx.http } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    }),
  );
}
