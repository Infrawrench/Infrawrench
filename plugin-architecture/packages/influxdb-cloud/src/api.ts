import type { CredentialFieldRegion, HttpHostServices } from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";

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
      const parsed = JSON.parse(raw.slice(start)) as { message?: string; error?: string };
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

export async function influxJson<T>(
  t: Transport,
  method: string,
  url: string,
  authorization: string,
  body?: unknown,
): Promise<T> {
  try {
    return await jsonRestFetch<T>({
      vendor: "InfluxDB",
      url,
      errorPath: new URL(url).pathname,
      headers: { Accept: "application/json", Authorization: authorization },
      init: { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
      ...(t.http ? { http: t.http } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = Number(STATUS_IN_MESSAGE.exec(message)?.[1] ?? 0);
    if (status) throw new InfluxApiError(status, friendly(status, message));
    throw err;
  }
}

/** A request whose answer is text (annotated CSV, usage CSV). */
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
