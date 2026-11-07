import {
  createApiClient,
  withCursorPagination,
  type ApiListItem,
  type ApiResponse,
  type CredentialFieldRegion,
  type HttpHostServices,
} from "@infrawrench/plugin-base";
import type {
  components as CloudComponents,
  operations as CloudOperations,
  paths as CloudPaths,
} from "./api-types.cloud.gen.js";
import type {
  operations as DedicatedOperations,
  paths as DedicatedPaths,
} from "./api-types.dedicated.gen.js";

/**
 * InfluxDB Cloud (TSM) and InfluxDB Cloud Serverless share the v2 HTTP API on
 * a per-region host; InfluxDB 3 Cloud Dedicated has a separate Management API
 * at `console.influxdata.com/api/v0`. Verified 2026-10 against the OpenAPI
 * documents in github.com/influxdata/docs-v2 (`api-docs/influxdb/cloud/…`,
 * `api-docs/influxdb3/cloud-serverless/…`,
 * `api-docs/influxdb3/cloud-dedicated/management/openapi.yml`).
 *
 * The v2 API takes `Authorization: Token <API token>`; the Dedicated
 * Management API takes `Authorization: Bearer <management token>`.
 *
 * Typed from `contracts/ref/cloud.yml` in github.com/influxdata/openapi and the
 * Dedicated document above (`plugingen.json`).
 */
export const REGIONS: CredentialFieldRegion[] = [
  {
    id: "us-east-1-1",
    label: "AWS US East (Virginia)",
    location: "us-east-1-1.aws.cloud2.influxdata.com",
    flag: "🇺🇸",
  },
  {
    id: "eu-central-1-1",
    label: "AWS EU Frankfurt",
    location: "eu-central-1-1.aws.cloud2.influxdata.com",
    flag: "🇩🇪",
  },
  {
    id: "us-west-2-1",
    label: "AWS US West (Oregon) 1",
    location: "us-west-2-1.aws.cloud2.influxdata.com",
    flag: "🇺🇸",
  },
  {
    id: "us-west-2-2",
    label: "AWS US West (Oregon) 2",
    location: "us-west-2-2.aws.cloud2.influxdata.com",
    flag: "🇺🇸",
  },
  {
    id: "us-central1-1",
    label: "GCP US Central (Iowa)",
    location: "us-central1-1.gcp.cloud2.influxdata.com",
    flag: "🇺🇸",
  },
  {
    id: "westeurope-1",
    label: "Azure West Europe (Amsterdam)",
    location: "westeurope-1.azure.cloud2.influxdata.com",
    flag: "🇳🇱",
  },
  {
    id: "eastus-1",
    label: "Azure East US (Virginia)",
    location: "eastus-1.azure.cloud2.influxdata.com",
    flag: "🇺🇸",
  },
];

export function hostFor(region: string): string {
  const r = REGIONS.find((x) => x.id === region);
  if (!r?.location) throw new Error(`InfluxDB Cloud plugin: unknown region "${region}"`);
  return `https://${r.location}`;
}

export const DEDICATED_API = "https://console.influxdata.com/api/v0";

export class InfluxApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "InfluxApiError";
    this.status = status;
  }
}

const STATUS_IN_MESSAGE = /InfluxDB API error (\d{3})/;

export function statusOf(err: unknown): number {
  return err instanceof InfluxApiError ? err.status : 0;
}

export function isUnavailable(err: unknown): boolean {
  const s = statusOf(err);
  return s === 403 || s === 404 || s === 405 || s === 501;
}

function friendly(status: number, raw: string): string {
  if (status === 401) {
    return "InfluxDB API error 401: the token was rejected. Check the token and that the region matches the one your organization is in.";
  }
  const start = raw.indexOf("{");
  if (start >= 0) {
    try {
      const parsed: { message?: string; error?: string } = JSON.parse(raw.slice(start));
      const detail = parsed.message ?? parsed.error;
      if (detail) return `InfluxDB API error ${status}: ${detail}`;
    } catch {
      /* not JSON */
    }
  }
  return raw;
}

export interface Transport {
  http?: HttpHostServices;
}

export type Bucket = ApiListItem<CloudOperations["GetBuckets"], "buckets">;
export type Authorization = ApiListItem<CloudOperations["GetAuthorizations"], "authorizations">;
export type Task = ApiListItem<CloudOperations["GetTasks"], "tasks">;
export type Limits = ApiResponse<CloudOperations["GetOrgLimitsID"]>;
export type Permission = CloudComponents["schemas"]["Permission"];
export type RetentionRule = CloudComponents["schemas"]["RetentionRule"];
export type DedicatedDatabase = ApiListItem<DedicatedOperations["GetClusterDatabases"], null>;
export type DedicatedToken = ApiListItem<DedicatedOperations["GetDatabaseTokens"], null>;
export type DedicatedPermission = NonNullable<DedicatedToken["permissions"]>[number];

/**
 * Checks, notification rules and notification endpoints go through one mapper.
 * Each is a union on `type` and these fields are on only some of its members.
 */
export type AlertRow = (
  | ApiListItem<CloudOperations["GetChecks"], "checks">
  | ApiListItem<CloudOperations["GetNotificationRules"], "notificationRules">
  | ApiListItem<CloudOperations["GetNotificationEndpoints"], "notificationEndpoints">
) & {
  every?: string;
  endpointID?: string;
  url?: string;
  lastRunStatus?: string;
  lastRunError?: string;
};

function jsonApi<P>(t: Transport, baseUrl: string, authorization: string) {
  return createApiClient<P>({
    vendor: "InfluxDB",
    baseUrl,
    headers: { Accept: "application/json", Authorization: authorization },
    encodeQuery: encodeURIComponent,
    http: t.http,
    httpError: ({ status, url, body }) =>
      new Error(`InfluxDB API error ${status} for ${new URL(url).pathname}: ${body}`),
  });
}

/** `limit` is at most 100 on every paged v2 list but tasks, so 100 pages is 10,000 rows. */
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

/** The v2 API on one region's host. Calls go through {@link influxCall}. */
export function cloudApi(t: Transport, host: string, token: string) {
  return withCursorPagination(jsonApi<CloudPaths>(t, host, `Token ${token}`), {
    cursorParam: "offset",
    firstCursor: 0,
    sizeParam: "limit",
    pageSize: PAGE_SIZE,
    maxPages: MAX_PAGES,
    next: ({ cursor, items }) => Number(cursor) + items.length,
    stopOnShortPage: true,
  });
}

/** The Management API of one Dedicated cluster. Calls go through {@link influxCall}. */
export function dedicatedApi(t: Transport, accountId: string, clusterId: string, token: string) {
  return jsonApi<DedicatedPaths>(
    t,
    `${DEDICATED_API}/accounts/${encodeURIComponent(accountId)}/clusters/${encodeURIComponent(clusterId)}`,
    `Bearer ${token}`,
  );
}

export type CloudApi = ReturnType<typeof cloudApi>;
export type DedicatedApi = ReturnType<typeof dedicatedApi>;

/** The v2 API for the usage CSV: no `Content-Type`, and an answer left as text. */
export function usageApi(t: Transport, host: string, token: string) {
  return createApiClient<CloudPaths>({
    vendor: "InfluxDB",
    baseUrl: host,
    headers: { Authorization: `Token ${token}`, Accept: "text/csv" },
    contentType: "with-body",
    encodeQuery: encodeURIComponent,
    http: t.http,
    httpError: ({ status, url, body }) =>
      new InfluxApiError(
        status,
        friendly(status, `InfluxDB API error ${status} for ${new URL(url).pathname}: ${body}`),
      ),
  });
}

/** Make one JSON call, turning whatever failure names a status into an {@link InfluxApiError}. */
export async function influxCall<V>(call: () => Promise<V>): Promise<V> {
  try {
    return await call();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = Number(STATUS_IN_MESSAGE.exec(message)?.[1] ?? 0);
    if (status) throw new InfluxApiError(status, friendly(status, message));
    throw err;
  }
}

/**
 * A request whose answer is text and whose verb is not GET: the Flux query, which
 * the typed client cannot read as anything but JSON.
 */
export async function influxText(
  t: Transport,
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string,
): Promise<string> {
  if (t.http) {
    const res = await t.http.request({
      url,
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new InfluxApiError(
        res.status,
        friendly(
          res.status,
          `InfluxDB API error ${res.status} for ${new URL(url).pathname}: ${res.body}`,
        ),
      );
    }
    return res.body;
  }
  const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
  const text = await res.text();
  if (!res.ok) {
    throw new InfluxApiError(
      res.status,
      friendly(
        res.status,
        `InfluxDB API error ${res.status} for ${new URL(url).pathname}: ${text}`,
      ),
    );
  }
  return text;
}

/**
 * Parse Flux annotated CSV into rows. Tables are separated by blank lines and
 * each starts with `#…` annotation rows and a header row; the leading
 * `result`/`table` columns are dropped.
 */
export function parseAnnotatedCsv(text: string): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  let header: string[] | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) {
      header = null;
      continue;
    }
    if (raw.startsWith("#")) continue;
    const cells = splitCsvLine(raw);
    if (!header) {
      header = cells;
      continue;
    }
    const row: Record<string, string> = {};
    header.forEach((h, i) => {
      if (!h || h === "result" || h === "table") return;
      row[h] = cells[i] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
