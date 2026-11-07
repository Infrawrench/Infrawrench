import {
  ListTruncatedError,
  createApiClient,
  followableLink,
  requireListPage,
  restRequest,
  utf8ToBase64,
  type HttpHostServices,
  type ParamValue,
} from "@infrawrench/plugin-base";
import type { paths as ManagementPaths } from "./api-types.management.gen.js";
import type { paths as TelemetryPaths } from "./api-types.telemetry.gen.js";

/**
 * Confluent Cloud has two HTTP surfaces this plugin talks to, both of which
 * authenticate with the same organization-level **Cloud API key** sent as
 * HTTP Basic (`key:secret`), and each typed from its own document
 * (`plugingen.json`):
 *
 * - `https://api.confluent.cloud`: every management API (org, IAM, cmk,
 *   connect, fcpm, ksqldbcm, srcm, networking, byok) and the Billing Costs
 *   API, from https://docs.confluent.io/cloud/current/openapi.yaml.
 * - `https://api.telemetry.confluent.cloud`: the Metrics API
 *   (`POST /v2/metrics/cloud/query`), from
 *   https://api.telemetry.confluent.cloud/docs/api.yaml. A Cloud API key is
 *   required there too; cluster-scoped keys are rejected.
 */
export const MANAGEMENT_API = "https://api.confluent.cloud";
export const TELEMETRY_API = "https://api.telemetry.confluent.cloud";
export const CONSOLE_URL = "https://confluent.cloud";

/** The largest page the document allows on most lists. */
export const PAGE_SIZE = 100;
/** 10,000 rows at {@link PAGE_SIZE}. A cap costs nothing until a list really is that long. */
const MAX_PAGES = 100;
/** The document allows 1,000 on networks, peerings, transit gateways and private link accesses. */
export const NETWORK_PAGE_SIZE = 1000;
/** 50,000 rows at {@link NETWORK_PAGE_SIZE}. */
export const NETWORK_MAX_PAGES = 50;
const VENDOR = "Confluent Cloud";

export interface ConfluentCredentials {
  apiKey: string;
  apiSecret: string;
  caCert?: string;
  http?: HttpHostServices;
}

/** Thrown for any non-2xx answer, carrying the status the callers branch on. */
export class ConfluentApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ConfluentApiError";
    this.status = status;
  }
}

function apiError(status: number, path: string, body: string): ConfluentApiError {
  return new ConfluentApiError(status, `${VENDOR} API error ${status} for ${path}: ${body}`);
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The host's HTTP service whenever there is one, that being the only path that
 * honours bastion egress and a custom CA, and otherwise the global fetch. Either
 * way a 2xx whose body is not JSON reads as no body: action endpoints (connector
 * pause/resume, 202 Accepted) can answer with nothing at all.
 */
function lenientTransport(http: HttpHostServices | undefined): HttpHostServices {
  const send: HttpHostServices["request"] = async (req) => {
    if (http) return http.request(req);
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      ...(req.body !== undefined
        ? { body: typeof req.body === "string" ? req.body : req.body.slice() }
        : {}),
    });
    // Nothing here reads a response header.
    return { status: res.status, headers: {}, body: await res.text() };
  };
  return {
    async request(req) {
      const res = await send(req);
      const ok = res.status >= 200 && res.status < 300;
      return ok && res.body && !isJson(res.body) ? { ...res, body: "" } : res;
    },
  };
}

/** Build everything a request needs. Split out of the client so tests can build one. */
export function createConfluentContext({ apiKey, apiSecret, caCert, http }: ConfluentCredentials) {
  const shared = {
    vendor: VENDOR,
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${utf8ToBase64(`${apiKey}:${apiSecret}`)}`,
    },
    http: lenientTransport(http),
    ...(caCert ? { caCert } : {}),
  };
  const clients = {
    ...shared,
    httpError: ({ status, path, body }: { status: number; path: string; body: string }) =>
      apiError(status, path, body),
    // An empty value means "no filter", so an environment id that came back empty
    // sends no parameter at all rather than `environment=`.
    serializeQuery: (query: Record<string, ParamValue>) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== "") params.set(key, String(value));
      }
      return params.toString();
    },
  };
  return {
    apiKey,
    /** What following a next link needs: no operation in the document has that shape. */
    transport: shared,
    api: createApiClient<ManagementPaths>({ ...clients, baseUrl: MANAGEMENT_API }),
    telemetry: createApiClient<TelemetryPaths>({ ...clients, baseUrl: TELEMETRY_API }),
  };
}

export type ConfluentContext = ReturnType<typeof createConfluentContext>;

/** HTTP status of a failed call, or 0 for a transport error. */
export function statusOf(err: unknown): number {
  return err instanceof ConfluentApiError ? err.status : 0;
}

/** True for the answers that mean "this key's owner may not do that". */
export function isPermissionError(err: unknown): boolean {
  const status = statusOf(err);
  return status === 401 || status === 403;
}

/** What {@link ccList} reads from a page. Every management list fits it. */
interface ListPage<Item> {
  data?: readonly Item[] | null;
  metadata?: { next?: string | null } | null;
}

/** A next link {@link followableLink} has already allowed. */
async function followLink<Page>(ctx: ConfluentContext, url: string): Promise<Page> {
  const errorPath = new URL(url).pathname;
  const { body } = await restRequest<Page>({
    ...ctx.transport,
    url,
    errorPath,
    httpError: ({ status, body: text }) => apiError(status, errorPath, text),
  });
  return body;
}

/**
 * Walk a Confluent list endpoint from its first page, whose call is what types the
 * rows. Every list in the management API shares one shape: `{ data: [...], metadata:
 * { next } }`, where `next` is an absolute URL carrying an opaque `page_token`.
 *
 * The rows are named by the caller because `withLinkPagination` cannot name them: these
 * responses are `List & { data?: Arm[] }`, and its item type infers only the `Arm`,
 * whose `required`-only fields generate as `unknown`.
 */
export async function ccList<Item>(
  ctx: ConfluentContext,
  path: string,
  first: () => Promise<ListPage<Item>>,
  maxPages = MAX_PAGES,
): Promise<Item[]> {
  const out: Item[] = [];
  const place = { vendor: VENDOR, path };
  let url: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res: ListPage<Item> | undefined = url
      ? await followLink<ListPage<Item>>(ctx, url)
      : await first();
    out.push(...requireListPage(res?.data, { ...place, key: "data", page: res }));
    // ListMeta: "If a response does not contain a next link, then there is no more data
    // available." So it alone ends the list, and an empty page that has one does not.
    const next = res?.metadata?.next;
    if (!next) return out;
    url = followableLink(next, url ?? `${MANAGEMENT_API}${path}`, place);
  }
  throw new ListTruncatedError({ ...place, items: out.length, maxPages });
}
