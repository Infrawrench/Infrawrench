import type { MetricSeries } from "@infrawrench/plugin-base";
import type { SplunkContext } from "./api.js";
import { SplunkApiError, streamBase, withQuery } from "./api.js";

/**
 * SignalFlow over the REST transport: `POST /v2/signalflow/execute` on the
 * stream host with the program as a `text/plain` body and `start`, `stop`,
 * `resolution` and `immediate=true`. The answer is a Server-Sent Events
 * stream (`event: metadata|data|control-message|message|error`, `data:` JSON)
 * that ends with an `END_OF_CHANNEL` control message once `stop` is reached,
 * so a bounded, past window reads as one finite response body. Message
 * shapes follow the official `signalfx-python` client (`signalflow/messages.py`):
 * metadata `{tsId, properties}`, data `{logicalTimestampMs, data: [{tsId, value}]}`,
 * error `{errors: [{code, context}]}`.
 */

export const METRICS_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_SERIES = 20;

interface SseEvent {
  event: string;
  data: string;
}

export function parseSse(body: string): SseEvent[] {
  const out: SseEvent[] = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length) out.push({ event, data: data.join("\n") });
  }
  return out;
}

/**
 * The coarsest standard SignalFlow resolution that still gives at least ~120
 * points over the window, in milliseconds.
 */
export function resolutionFor(windowMs: number): number {
  const steps = [10_000, 60_000, 300_000, 3_600_000, 86_400_000];
  const target = windowMs / 120;
  return [...steps].reverse().find((s) => s <= target) ?? 10_000;
}

function seriesLabel(props: Record<string, unknown> | undefined, tsId: string): string {
  if (!props) return tsId;
  const label = String(
    props["sf_streamLabel"] ?? props["sf_originatingMetric"] ?? props["sf_metric"] ?? "",
  );
  const dims = Object.entries(props)
    .filter(([k, v]) => !k.startsWith("sf_") && typeof v === "string" && v)
    .map(([, v]) => String(v))
    .slice(0, 3);
  return [label || tsId, dims.length ? `(${dims.join(", ")})` : ""].filter(Boolean).join(" ");
}

/** Decode an SSE body into chart series. Throws when the computation reported errors. */
export function decodeSignalFlow(body: string): MetricSeries[] {
  const meta = new Map<string, Record<string, unknown>>();
  const points = new Map<string, Array<{ timestamp: number; value: number }>>();
  for (const ev of parseSse(body)) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = ev.event !== "message" ? ev.event : String(payload["type"] ?? "message");
    if (type === "metadata" && typeof payload["tsId"] === "string") {
      meta.set(payload["tsId"], (payload["properties"] as Record<string, unknown>) ?? {});
    } else if (type === "data") {
      const ts = Number(payload["logicalTimestampMs"]);
      for (const d of (payload["data"] as Array<{ tsId?: string; value?: unknown }>) ?? []) {
        if (!d.tsId || typeof d.value !== "number" || !Number.isFinite(ts)) continue;
        const list = points.get(d.tsId) ?? [];
        list.push({ timestamp: ts, value: d.value });
        points.set(d.tsId, list);
      }
    } else if (type === "error") {
      const errors =
        (payload["errors"] as Array<{ code?: string; context?: unknown; message?: string }>) ?? [];
      const text = errors.map((e) => e.message ?? e.code ?? JSON.stringify(e.context)).join("; ");
      throw new SplunkApiError(400, `SignalFlow error: ${text || "the program could not run"}`);
    }
  }
  return Array.from(points.entries())
    .slice(0, MAX_SERIES)
    .map(([tsId, pts]) => ({ label: seriesLabel(meta.get(tsId), tsId), points: pts }));
}

/** Run a SignalFlow program over a past window and return its published series. */
export async function runSignalFlow(
  ctx: SplunkContext,
  program: string,
  range: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const path = "/v2/signalflow/execute";
  const url = withQuery(`${streamBase(ctx)}${path}`, {
    start: Math.floor(range.startMs),
    stop: Math.floor(range.endMs),
    resolution: resolutionFor(range.endMs - range.startMs),
    immediate: true,
  });
  const headers = {
    "Content-Type": "text/plain",
    Accept: "text/event-stream",
    "X-SF-Token": ctx.token,
  };
  let body: string;
  if (ctx.http) {
    const res = await ctx.http.request({
      url,
      method: "POST",
      headers,
      body: program,
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new SplunkApiError(
        res.status,
        `Splunk Observability API error ${res.status} for ${path}: ${res.body}`,
      );
    }
    body = res.body;
  } else {
    // No host HTTP service (tests, bare renderer): the global fetch path. The
    // body is an event stream, not JSON, so jsonRestFetch does not fit.
    const res = await fetch(url, { method: "POST", headers, body: program });
    const text = await res.text();
    if (!res.ok) {
      throw new SplunkApiError(
        res.status,
        `Splunk Observability API error ${res.status} for ${path}: ${text}`,
      );
    }
    body = text;
  }
  return decodeSignalFlow(body);
}

export function rangeOrDefault(
  range: { startMs: number; endMs: number } | undefined,
  windowMs = METRICS_WINDOW_MS,
): { startMs: number; endMs: number } {
  if (range && range.endMs > range.startMs) return range;
  const endMs = Date.now();
  return { startMs: endMs - windowMs, endMs };
}
