import {
  createApiClient,
  requireListPage,
  withCursorPagination,
  type ApiClient,
  type ApiClientOptions,
  type HttpHostServices,
  type ParamValue,
} from "@infrawrench/plugin-base";
import type { paths as accountPaths } from "./api-types.account.gen.js";
import type { paths as billingPaths } from "./api-types.billing.gen.js";
import type { paths as bookingPaths } from "./api-types.booking.gen.js";
import type { paths as clusterAuthPaths } from "./api-types.cluster-auth.gen.js";
import type { paths as clusterBackupPaths } from "./api-types.cluster-backup.gen.js";
import type { paths as clusterPaths } from "./api-types.cluster.gen.js";
import type { paths as databasePaths } from "./api-types.database.gen.js";
import type { paths as hybridPaths } from "./api-types.hybrid.gen.js";
import type { paths as meteringPaths } from "./api-types.metering.gen.js";
import type { paths as monitoringPaths } from "./api-types.monitoring.gen.js";
import type { paths as platformPaths } from "./api-types.platform.gen.js";
import type { paths as quotaPaths } from "./api-types.quota.gen.js";

/**
 * Transport for the Qdrant Cloud public API (REST/JSON gateway of the gRPC
 * services in github.com/qdrant/qdrant-cloud-public-api, verified 2026-10).
 *
 * - Management API at `https://api.cloud.qdrant.io/api/<service>/v1/...`,
 *   authenticated with a Cloud Management Key as
 *   `Authorization: apikey <key>`. Every route is scoped to an account id.
 * - Each cluster's own database REST API at `<endpoint url>:6333`,
 *   authenticated with a *database* API key in the `api-key` header. The
 *   management key does not work there; the plugin mints a database key on
 *   request and keeps it in the host's secret store.
 *
 * Errors come back as gRPC status JSON (`{code, message, details}`); the
 * HTTP status is what the poller classifies on.
 */

export const API_HOST = "https://api.cloud.qdrant.io";

export const VENDOR = "Qdrant Cloud";

/** The document gives no largest page size, so this stays what the plugin has always sent. */
const PAGE_SIZE = 100;
/** 50,000 rows, the ceiling for a list that goes through the resource sync. */
const MAX_PAGES = 500;

export class QdrantApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, path: string, body: string) {
    super(`Qdrant Cloud API error ${status} for ${path}: ${summarizeBody(body)}`);
    this.name = "QdrantApiError";
    this.status = status;
    this.body = body;
  }
}

/** gRPC-gateway errors are `{code, message}`; the database API uses `{status: {error}}`. */
export function summarizeBody(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      if ("message" in parsed && typeof parsed.message === "string" && parsed.message) {
        return parsed.message;
      }
      if ("status" in parsed && parsed.status && typeof parsed.status === "object") {
        const { status } = parsed;
        if ("error" in status && typeof status.error === "string" && status.error) {
          return status.error;
        }
      }
    }
  } catch {
    /* not JSON */
  }
  return body.slice(0, 500);
}

/** An empty value is left out, so a blank region or cluster id never reaches the query. */
function buildQuery(query: Record<string, ParamValue>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.append(key, String(value));
  }
  return params.toString();
}

/** What every request needs from the account it runs for. */
export interface QdrantConnection {
  caCert: string;
  http: HttpHostServices | undefined;
}

function clientOptions({
  caCert,
  http,
}: QdrantConnection): Omit<ApiClientOptions, "baseUrl" | "headers"> {
  return {
    vendor: VENDOR,
    caCert,
    http,
    contentType: "with-body",
    emptyBodyIsUndefined: true,
    serializeQuery: buildQuery,
    httpError: ({ status, path, body }) => new QdrantApiError(status, path, body ?? ""),
  };
}

/** The Management API, which is one host across the services it has a document each for. */
type CloudPaths = accountPaths &
  billingPaths &
  bookingPaths &
  clusterAuthPaths &
  clusterBackupPaths &
  clusterPaths &
  hybridPaths &
  meteringPaths &
  monitoringPaths &
  platformPaths &
  quotaPaths;

export type QdrantCloudApi = ReturnType<typeof createCloudApi>;

/** One cluster's own database REST API. */
export type QdrantDatabaseApi = ApiClient<databasePaths>;

export function createCloudApi(apiKey: string, connection: QdrantConnection) {
  const api = createApiClient<CloudPaths>({
    ...clientOptions(connection),
    baseUrl: API_HOST,
    headers: { Accept: "application/json", Authorization: `apikey ${apiKey}` },
  });
  return withCursorPagination(api, {
    cursorParam: "pageToken",
    sizeParam: "pageSize",
    next: "nextPageToken",
    pageSize: PAGE_SIZE,
    maxPages: MAX_PAGES,
    // The document on nextPageToken: "If this field is omitted, there are no subsequent pages."
    continueOnEmptyPage: true,
    // A gRPC gateway answering in proto3 JSON, which leaves an empty repeated field out.
    missingListIsEmpty: true,
  });
}

/**
 * The rows of a list answer the document does not page. An absent `items` is empty, as
 * proto3 JSON writes it, but no answer at all and anything that is not an array throw.
 */
export function listItems<T>(page: { items?: T[] } | undefined, path: string): T[] {
  return requireListPage(page ? (page.items ?? null) : undefined, {
    vendor: VENDOR,
    path,
    key: "items",
    page,
  });
}

export function createDatabaseApi(
  baseUrl: string,
  dbKey: string,
  connection: QdrantConnection,
): QdrantDatabaseApi {
  return createApiClient({
    ...clientOptions(connection),
    baseUrl: baseUrl.replace(/\/+$/, ""),
    headers: { Accept: "application/json", "api-key": dbKey },
  });
}

export function isStatus(err: unknown, ...statuses: number[]): boolean {
  return err instanceof QdrantApiError && statuses.includes(err.status);
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Protobuf JSON `Duration` (`"604800s"`) to whole days, rounding down. */
export function durationToDays(d: string | undefined): number | undefined {
  if (!d) return undefined;
  const m = /^(\d+(?:\.\d+)?)s$/.exec(d.trim());
  if (!m) return undefined;
  return Math.floor(Number(m[1]) / 86_400);
}

export function daysToDuration(days: number): string {
  return `${Math.round(days * 86_400)}s`;
}

/** Strip a protobuf enum prefix: `CLUSTER_PHASE_HEALTHY` → `HEALTHY`. */
export function enumTail(value: string | undefined, prefix: string): string {
  if (!value) return "";
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/** Millicents (int64 serialised as string or number) to currency units. */
export function millicents(v: string | number | undefined | null): number {
  if (v === undefined || v === null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n / 100_000 : 0;
}
