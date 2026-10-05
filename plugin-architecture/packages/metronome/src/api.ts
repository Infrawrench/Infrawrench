import type { HostServices } from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";

/**
 * Metronome's REST API. One host for every customer, bearer-token auth, and
 * cursor pagination through a `next_page` query parameter on every list
 * (including the POST usage query).
 *
 * Verified 2026-10-04 against https://docs.metronome.com/api-reference/authentication
 * and the OpenAPI document each reference page embeds
 * (`servers: https://api.metronome.com`).
 */
export const METRONOME_BASE_URL = "https://api.metronome.com";

/** The documented maximum for every `limit` parameter. */
export const PAGE_LIMIT = 100;

/** Upper bound on pages for one listing, so a cursor bug cannot loop forever. */
const MAX_PAGES = 500;

/**
 * Metronome's documented id for the USD (cents) pricing unit; the
 * List pricing units reference calls it out by value.
 * https://docs.metronome.com/api-reference/settings/list-pricing-units
 */
export const USD_CENTS_CREDIT_TYPE_ID = "2714e483-4ff1-48e4-9e25-ac732e8f24f2";

export interface MetronomeCustomer {
  id: string;
  name?: string;
  external_id?: string;
  ingest_aliases?: string[];
  customer_config?: { salesforce_account_id?: string | null };
  custom_fields?: Record<string, string>;
  created_at?: string;
  updated_at?: string;
  archived_at?: string | null;
  current_billable_status?: { value?: string; effective_at?: string | null };
}

export interface MetronomePropertyFilter {
  name: string;
  exists?: boolean;
  in_values?: string[];
  not_in_values?: string[];
}

export interface MetronomeBillableMetric {
  id: string;
  name: string;
  aggregation_type?: string;
  aggregation_key?: string;
  event_type_filter?: { in_values?: string[]; not_in_values?: string[] };
  property_filters?: MetronomePropertyFilter[];
  group_keys?: string[][];
  custom_fields?: Record<string, string>;
  sql?: string;
  archived_at?: string;
}

export interface MetronomeCreditType {
  id: string;
  name: string;
  is_currency?: boolean;
}

export interface MetronomeUsageAggregate {
  customer_id: string;
  billable_metric_id: string;
  billable_metric_name?: string;
  start_timestamp: string;
  end_timestamp: string;
  value: number | null;
  groups?: Record<string, number | null>;
}

export interface MetronomeInvoice {
  id: string;
  customer_id: string;
  credit_type?: { id: string; name: string };
  status?: string;
  type?: string;
  total?: number;
  start_timestamp?: string;
  end_timestamp?: string;
  issued_at?: string;
  breakdown_start_timestamp?: string;
  breakdown_end_timestamp?: string;
}

export interface MetronomePage<T> {
  data?: T[];
  next_page?: string | null;
}

export interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
}

/** Thin transport: bearer auth, host HTTP routing, JSON in and out. */
export class MetronomeApi {
  constructor(
    private readonly token: string,
    private readonly services?: HostServices,
    private readonly caCert = "",
  ) {}

  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const init: RequestInit = { method: opts.method ?? "GET" };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    if (opts.signal) init.signal = opts.signal;
    return jsonRestFetch<T>({
      vendor: "Metronome",
      url: `${METRONOME_BASE_URL}${path}`,
      errorPath: path.split("?")[0] ?? path,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
      },
      init,
      ...(this.services?.http ? { http: this.services.http } : {}),
      ...(this.caCert ? { caCert: this.caCert } : {}),
    });
  }

  /**
   * Follow `next_page` until it comes back null. `onPage` may throw to stop
   * early (the row cap does); the error propagates rather than truncating.
   */
  async paginate<T>(
    path: string,
    query: Record<string, string>,
    opts: RequestOptions & { onPage?: (rows: T[], total: number) => void } = {},
  ): Promise<T[]> {
    const out: T[] = [];
    let cursor = "";
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params = new URLSearchParams(query);
      if (cursor) params.set("next_page", cursor);
      const qs = params.toString();
      const body = await this.request<MetronomePage<T>>(`${path}${qs ? `?${qs}` : ""}`, opts);
      const rows = body?.data ?? [];
      out.push(...rows);
      opts.onPage?.(rows, out.length);
      const next = body?.next_page ?? "";
      if (!next || next === cursor) return out;
      cursor = next;
    }
    throw new Error(
      `Metronome returned more than ${MAX_PAGES} pages for ${path}; stopping rather than returning a partial answer.`,
    );
  }

  /** GET /v1/customers: active customers by default, or only archived ones. */
  listCustomers(opts: { archived?: boolean; signal?: AbortSignal } = {}) {
    const query: Record<string, string> = { limit: String(PAGE_LIMIT) };
    if (opts.archived) query["only_archived"] = "true";
    return this.paginate<MetronomeCustomer>(
      "/v1/customers",
      query,
      opts.signal ? { signal: opts.signal } : {},
    );
  }

  async getCustomer(id: string): Promise<MetronomeCustomer> {
    const body = await this.request<{ data: MetronomeCustomer }>(
      `/v1/customers/${encodeURIComponent(id)}`,
    );
    return body.data;
  }

  /** GET /v1/billable-metrics: archived metrics are excluded unless asked for. */
  listBillableMetrics(opts: { includeArchived?: boolean; signal?: AbortSignal } = {}) {
    const query: Record<string, string> = { limit: String(PAGE_LIMIT) };
    if (opts.includeArchived) query["include_archived"] = "true";
    return this.paginate<MetronomeBillableMetric>(
      "/v1/billable-metrics",
      query,
      opts.signal ? { signal: opts.signal } : {},
    );
  }

  async getBillableMetric(id: string, signal?: AbortSignal): Promise<MetronomeBillableMetric> {
    const body = await this.request<{ data: MetronomeBillableMetric }>(
      `/v1/billable-metrics/${encodeURIComponent(id)}`,
      signal ? { signal } : {},
    );
    return body.data;
  }

  /** GET /v1/credit-types/list: fiat currencies plus custom pricing units. */
  listCreditTypes(signal?: AbortSignal) {
    return this.paginate<MetronomeCreditType>(
      "/v1/credit-types/list",
      { limit: String(PAGE_LIMIT) },
      signal ? { signal } : {},
    );
  }

  /** GET /v1/customers/{id}/invoices, newest first, one page. */
  async listRecentInvoices(customerId: string, limit = 10): Promise<MetronomeInvoice[]> {
    const params = new URLSearchParams({ limit: String(limit), sort: "date_desc" });
    const body = await this.request<MetronomePage<MetronomeInvoice>>(
      `/v1/customers/${encodeURIComponent(customerId)}/invoices?${params.toString()}`,
    );
    return body?.data ?? [];
  }
}

/**
 * Metronome states money in the pricing unit's own denomination: USD is the
 * one currency it carries in cents, and says so in the unit's name
 * ("USD (cents)"); every other currency is in whole units.
 * https://docs.metronome.com/guides/pricing-packaging/make-pricing-changes/use-currency-custompricingunits
 */
export function creditTypeDivisor(name: string | undefined): number {
  return name && /\(cents\)\s*$/i.test(name) ? 100 : 1;
}

/** "USD (cents)" reads as "USD" once the amount is in whole units. */
export function creditTypeUnit(name: string | undefined): string {
  return (name ?? "").replace(/\s*\(cents\)\s*$/i, "").trim();
}

/** Format an amount in a pricing unit's own denomination. */
export function formatCreditAmount(amount: number | undefined, creditTypeName?: string): string {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return "";
  const value = amount / creditTypeDivisor(creditTypeName);
  const unit = creditTypeUnit(creditTypeName);
  return `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ""}`;
}
