import type {
  CostChargeType,
  CostFetchRange,
  CostFetchResult,
  CostRow,
} from "@infrawrench/plugin-base";
import type { AivenContext } from "./api.js";
import { aivenFetch, enc } from "./api.js";
import type { AvBillingGroup, AvInvoice, AvInvoiceLine } from "./types.js";

/**
 * Spend from billing-group invoices (verified 2026-10):
 *
 * - `GET /billing-group` lists the groups the token can see.
 * - `GET /billing-group/{id}/invoice` lists invoices, including the current
 *   month's running `estimate`, each with `period_begin`/`period_end`.
 * - `GET /billing-group/{id}/invoice/{n}/lines` returns lines with
 *   `line_total_usd`, project, service, plan, cloud, billing tags, a
 *   `line_type`, and for time-billed resources `timestamp_begin`/`end`.
 *
 * Aiven bills services by the hour but only exposes the totals per invoice
 * line, so each line is spread evenly over the days it covers (its own
 * timestamps, else the invoice period, never past today). The estimate
 * invoice grows through the month, so the host re-fetches the whole month
 * (`restatementDays: 35`). Amounts are in USD.
 */
const DAY_MS = 86_400_000;

export function chargeTypeOf(lineType: string | undefined): CostChargeType {
  switch (lineType) {
    case "credit_consumption":
      return "credit";
    case "commitment_fee":
      return "commitment_fee";
    case "support_charge":
      return "support";
    case "rounding":
    case "multiplier":
      return "adjustment";
    case "extra_charge":
    case "other_event":
      return "other";
    default:
      return "usage";
  }
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Spread one line over the UTC days it covers, keeping the days inside the range. */
export function spreadLine(
  line: AvInvoiceLine,
  invoice: AvInvoice,
  range: CostFetchRange,
  now: number = Date.now(),
): CostRow[] {
  const total = Number(line.line_total_usd ?? 0);
  if (!Number.isFinite(total) || total === 0) return [];
  let begin = Date.parse(line.timestamp_begin ?? invoice.period_begin ?? "");
  let end = Date.parse(line.timestamp_end ?? invoice.period_end ?? "");
  if (!Number.isFinite(begin)) return [];
  if (!Number.isFinite(end) || end <= begin) end = begin + 1;
  end = Math.min(end, Math.max(now, begin + 1));
  begin = Math.floor(begin / DAY_MS) * DAY_MS;
  const days: string[] = [];
  for (let t = begin; t < end; t += DAY_MS) days.push(day(t));
  if (!days.length) days.push(day(begin));
  const per = total / days.length;
  const service = line.service_type
    ? serviceLabel(line.service_type)
    : (line.description ?? "Aiven");
  const resourceId =
    line.project_name && line.service_name
      ? `${line.project_name}/${line.service_name}`
      : undefined;
  const tags: Record<string, string> = { ...(line.tags ?? {}) };
  if (line.project_name) tags["project"] = line.project_name;
  if (line.service_plan) tags["plan"] = line.service_plan;
  return days
    .filter((d) => d >= range.fromDate && d <= range.toDate)
    .map((date) => ({
      date,
      service,
      ...(line.cloud_name ? { region: line.cloud_name } : {}),
      ...(resourceId ? { resourceId } : {}),
      ...(Object.keys(tags).length ? { tags } : {}),
      currency: "USD",
      amount: Math.round(per * 1e6) / 1e6,
      chargeType: chargeTypeOf(line.line_type),
    }));
}

const LABELS: Record<string, string> = {
  pg: "PostgreSQL",
  mysql: "MySQL",
  kafka: "Kafka",
  kafka_connect: "Kafka Connect",
  kafka_mirrormaker: "Kafka MirrorMaker",
  opensearch: "OpenSearch",
  elasticsearch: "Elasticsearch",
  clickhouse: "ClickHouse",
  valkey: "Valkey",
  redis: "Redis",
  dragonfly: "Dragonfly",
  grafana: "Grafana",
  flink: "Flink",
  thanos: "Thanos",
  cassandra: "Cassandra",
  m3db: "M3DB",
};

export function serviceLabel(type: string): string {
  return LABELS[type] ?? type;
}

export async function fetchAivenCostData(
  ctx: AivenContext,
  range: CostFetchRange,
): Promise<CostRow[] | CostFetchResult> {
  const groups =
    (await aivenFetch<{ billing_groups?: AvBillingGroup[] }>(ctx, "GET", "/billing-group"))
      ?.billing_groups ?? [];
  const rows: CostRow[] = [];
  let degraded = false;
  const from = Date.parse(`${range.fromDate}T00:00:00Z`);
  const to = Date.parse(`${range.toDate}T23:59:59Z`);
  for (const g of groups) {
    if (!g.billing_group_id) continue;
    let invoices: AvInvoice[] = [];
    try {
      invoices =
        (
          await aivenFetch<{ invoices?: AvInvoice[] }>(
            ctx,
            "GET",
            `/billing-group/${enc(g.billing_group_id)}/invoice`,
          )
        )?.invoices ?? [];
    } catch {
      degraded = true;
      continue;
    }
    for (const inv of invoices) {
      if (!inv.invoice_number) continue;
      const pb = Date.parse(inv.period_begin ?? "");
      const pe = Date.parse(inv.period_end ?? "");
      if (Number.isFinite(pb) && pb > to) continue;
      if (Number.isFinite(pe) && pe < from) continue;
      try {
        const lines =
          (
            await aivenFetch<{ lines?: AvInvoiceLine[] }>(
              ctx,
              "GET",
              `/billing-group/${enc(g.billing_group_id)}/invoice/${enc(inv.invoice_number)}/lines`,
            )
          )?.lines ?? [];
        for (const line of lines) rows.push(...spreadLine(line, inv, range));
      } catch {
        degraded = true;
      }
    }
  }
  return degraded ? { rows, degraded: true } : rows;
}
