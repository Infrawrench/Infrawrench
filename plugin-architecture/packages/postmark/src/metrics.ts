/**
 * Daily sending metrics from Postmark's Stats API (`/stats/outbound/*`,
 * server token). Postmark aggregates per day only, so every series is one
 * point per day. `messagestream` narrows a server's stats to one stream.
 */
import type { MetricSeries } from "@infrawrench/plugin-base";
import type { PostmarkTransport } from "./api.js";
import { postmarkFetch } from "./api.js";

export const METRICS_WINDOW_MS = 30 * 24 * 3600_000;

export function rangeOrDefault(timeRange: { startMs: number; endMs: number } | undefined): {
  startMs: number;
  endMs: number;
} {
  if (timeRange) return timeRange;
  const endMs = Date.now();
  return { startMs: endMs - METRICS_WINDOW_MS, endMs };
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

type DayRow = Record<string, unknown> & { Date?: string };

interface SeriesSpec {
  path: string;
  /** Each label sums these fields of the day row. */
  series: Array<{ label: string; fields: string[]; unit: string }>;
}

const SPECS: SeriesSpec[] = [
  { path: "/stats/outbound/sends", series: [{ label: "Sent", fields: ["Sent"], unit: "emails" }] },
  {
    path: "/stats/outbound/bounces",
    series: [
      { label: "Hard bounces", fields: ["HardBounce"], unit: "emails" },
      { label: "Soft bounces", fields: ["SoftBounce", "Transient"], unit: "emails" },
      { label: "SMTP API errors", fields: ["SMTPApiError"], unit: "emails" },
    ],
  },
  {
    path: "/stats/outbound/spam",
    series: [{ label: "Spam complaints", fields: ["SpamComplaint"], unit: "emails" }],
  },
  {
    path: "/stats/outbound/opens",
    series: [
      { label: "Opens", fields: ["Opens"], unit: "opens" },
      { label: "Unique opens", fields: ["Unique"], unit: "opens" },
    ],
  },
  {
    path: "/stats/outbound/clicks",
    series: [
      { label: "Clicks", fields: ["Clicks"], unit: "clicks" },
      { label: "Unique clicks", fields: ["Unique"], unit: "clicks" },
    ],
  },
];

const n = (v: unknown): number => {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
};

export function seriesFromDays(
  days: DayRow[],
  spec: SeriesSpec["series"][number],
): MetricSeries | null {
  const points = days
    .filter((d) => typeof d.Date === "string")
    .map((d) => ({
      timestamp: Date.parse(`${String(d.Date).slice(0, 10)}T00:00:00Z`),
      value: spec.fields.reduce((sum, k) => sum + n(d[k]), 0),
    }))
    .filter((p) => Number.isFinite(p.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);
  if (points.length === 0) return null;
  return { label: spec.label, unit: spec.unit, points };
}

/**
 * Daily sends, bounces, complaints, opens and clicks for one server, or one
 * stream on it. A stat Postmark refuses (opens on a server without tracking
 * still answers, but be tolerant) is skipped rather than failing the chart.
 */
export async function statsSeries(
  transport: PostmarkTransport,
  serverToken: string,
  range: { startMs: number; endMs: number },
  messageStream?: string,
): Promise<MetricSeries[]> {
  const query = {
    fromdate: day(range.startMs),
    todate: day(range.endMs),
    ...(messageStream ? { messagestream: messageStream } : {}),
  };
  const results = await Promise.all(
    SPECS.map((spec) =>
      postmarkFetch<{ Days?: DayRow[] }>(transport, "server", serverToken, spec.path, {
        query,
      }).catch(() => undefined),
    ),
  );
  if (results.every((r) => r === undefined)) {
    throw new Error("Postmark plugin: the Stats API answered none of the metric requests");
  }
  const out: MetricSeries[] = [];
  SPECS.forEach((spec, i) => {
    const days = results[i]?.Days ?? [];
    for (const s of spec.series) {
      const series = seriesFromDays(days, s);
      if (series) out.push(series);
    }
  });
  return out;
}

export interface OutboundOverview {
  Sent?: number;
  Bounced?: number;
  BounceRate?: number;
  SMTPApiErrors?: number;
  SpamComplaints?: number;
  SpamComplaintsRate?: number;
  Opens?: number;
  UniqueOpens?: number;
  TotalClicks?: number;
  UniqueLinksClicked?: number;
  Tracked?: number;
  WithOpenTracking?: number;
  WithLinkTracking?: number;
}

/** `GET /stats/outbound`: the 30-day totals shown on the detail pages. */
export function outboundOverview(
  transport: PostmarkTransport,
  serverToken: string,
  messageStream?: string,
): Promise<OutboundOverview> {
  const end = Date.now();
  return postmarkFetch<OutboundOverview>(transport, "server", serverToken, "/stats/outbound", {
    query: {
      fromdate: day(end - METRICS_WINDOW_MS),
      todate: day(end),
      ...(messageStream ? { messagestream: messageStream } : {}),
    },
  });
}
