/**
 * Billed spend from Exoscale's FOCUS report.
 *
 * `GET /v2/focus-report/{YYYY-MM}` ([BETA] in the API spec, 2026-10) returns
 * `{ "focus-report": { presigned_url, expires_in } }`; the URL points at the
 * organization's cost report for the month in the FinOps FOCUS schema. The
 * spec does not state the file encoding, so the body is sniffed: gzip is
 * inflated with `DecompressionStream`, then JSON (an array or JSON Lines)
 * or CSV with a header row is accepted. Parquet is refused with a setup
 * error rather than guessed at.
 *
 * Rows aggregate `BilledCost` per `ChargePeriodStart` day, `ServiceName`,
 * `RegionId`, `ResourceId` and tags, with `ChargeCategory` mapped onto the
 * host's charge types. `/usage-report` was not used: it gives quantities
 * without prices.
 */

import type {
  CostChargeType,
  CostFetchRange,
  CostRow,
  HostServices,
} from "@infrawrench/plugin-base";
import { CostSetupError } from "@infrawrench/plugin-base";
import { DEFAULT_ZONE, type ExoscaleApi, statusOf } from "./api.js";

type FocusRow = Record<string, unknown>;

export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  while (d.toISOString().slice(0, 7) <= to.slice(0, 7) && out.length < 24) {
    out.push(d.toISOString().slice(0, 7));
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

/** Minimal RFC 4180 CSV parser (quoted fields, doubled quotes, CRLF). */
export function parseCsv(text: string): FocusRow[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.some((x) => x !== "")) rows.push(row);
  }
  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ""])));
}

export function parseFocusBody(text: string): FocusRow[] {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith("PAR1")) {
    throw new CostSetupError(
      "Exoscale sent the FOCUS report as Parquet, which Infrawrench cannot read yet.",
    );
  }
  if (t.startsWith("[")) return JSON.parse(t) as FocusRow[];
  if (t.startsWith("{")) {
    return t
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as FocusRow);
  }
  return parseCsv(t);
}

function chargeType(row: FocusRow, amount: number): CostChargeType | undefined {
  const cat = String(row["ChargeCategory"] ?? "").toLowerCase();
  if (cat === "tax") return "tax";
  if (cat === "credit" || amount < 0) return "credit";
  if (cat === "adjustment") return "adjustment";
  return undefined;
}

function parseTags(v: unknown): Record<string, string> | undefined {
  if (!v) return undefined;
  let obj: unknown = v;
  if (typeof v === "string") {
    try {
      obj = JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  if (!obj || typeof obj !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(obj as Record<string, unknown>)) out[k] = String(val ?? "");
  return Object.keys(out).length ? out : undefined;
}

export function focusRows(rows: FocusRow[], range: CostFetchRange): CostRow[] {
  const map = new Map<string, CostRow>();
  for (const r of rows) {
    const amount = Number(r["BilledCost"] ?? 0);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const date = String(r["ChargePeriodStart"] ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < range.fromDate || date > range.toDate) continue;
    const service = String(r["ServiceName"] ?? r["ServiceCategory"] ?? "Other") || "Other";
    const region = String(r["RegionId"] ?? r["RegionName"] ?? "");
    const resourceId = String(r["ResourceId"] ?? "");
    const tags = parseTags(r["Tags"]);
    const type = chargeType(r, amount);
    const currency = String(r["BillingCurrency"] ?? "CHF") || "CHF";
    const key = [
      date,
      service,
      region,
      resourceId,
      JSON.stringify(tags ?? {}),
      type ?? "",
      currency,
    ].join("|");
    const existing = map.get(key);
    if (existing) existing.amount += amount;
    else
      map.set(key, {
        date,
        service,
        ...(region ? { region } : {}),
        ...(resourceId ? { resourceId } : {}),
        ...(tags ? { tags } : {}),
        currency,
        amount,
        ...(type ? { chargeType: type } : {}),
      });
  }
  return [...map.values()].map((r) => ({ ...r, amount: Math.round(r.amount * 1e6) / 1e6 }));
}

async function download(url: string, services?: HostServices): Promise<string> {
  let bytes: Uint8Array;
  if (services?.http) {
    const res = await services.http.request({
      url,
      method: "GET",
      headers: {},
      responseEncoding: "binary",
    });
    if (res.status < 200 || res.status >= 300)
      throw new Error(`FOCUS report download failed: ${res.status}`);
    bytes = res.rawBody ?? new TextEncoder().encode(res.body);
  } else {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`FOCUS report download failed: ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }
  return new TextDecoder().decode(bytes);
}

export async function fetchExoscaleCostData(
  api: ExoscaleApi,
  range: CostFetchRange,
  services?: HostServices,
): Promise<CostRow[]> {
  const out: CostRow[] = [];
  for (const month of monthsBetween(range.fromDate, range.toDate)) {
    let url: string | undefined;
    try {
      const res = await api.get<{ "focus-report"?: { presigned_url?: string } }>(
        DEFAULT_ZONE,
        `/focus-report/${month}`,
      );
      url = res["focus-report"]?.presigned_url;
    } catch (err) {
      const status = statusOf(err);
      if (status === 404) continue;
      if (status === 401 || status === 403) {
        throw new CostSetupError(
          "This API key's role cannot read billing reports. Give its IAM role access to the organization's billing.",
          {
            label: "Manage IAM roles",
            url: "https://portal.exoscale.com/iam/roles",
          },
        );
      }
      throw err;
    }
    if (!url) continue;
    out.push(...focusRows(parseFocusBody(await download(url, services)), range));
  }
  return out;
}
