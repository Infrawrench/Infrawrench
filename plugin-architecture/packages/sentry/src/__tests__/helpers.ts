import type { SentryContext } from "../api.js";
import { resolveInstance } from "../regions.js";

export interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * Fake host HTTP service. `route` gets each request (URL parsed, JSON body
 * decoded) and returns either a bare JSON body or a full `Reply`. A reply is
 * recognised by a `body`, `status` or `headers` key alongside nothing else.
 */
export function makeHttp(route: (call: Call) => unknown) {
  const calls: Call[] = [];
  const http = {
    async request(req: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string | Uint8Array;
    }) {
      const call: Call = {
        url: new URL(req.url),
        method: req.method,
        headers: req.headers,
        body: req.body ? JSON.parse(String(req.body)) : undefined,
      };
      calls.push(call);
      const out = route(call);
      const isReply =
        out !== null &&
        typeof out === "object" &&
        !Array.isArray(out) &&
        Object.keys(out).length > 0 &&
        Object.keys(out).every((k) => k === "status" || k === "body" || k === "headers");
      const reply: Reply = isReply ? (out as Reply) : { body: out };
      return {
        status: reply.status ?? 200,
        headers: reply.headers ?? {},
        body: reply.body === undefined ? "" : JSON.stringify(reply.body),
      };
    },
  };
  return { http, calls };
}

export function ctxWith(http: ReturnType<typeof makeHttp>["http"], region = "us"): SentryContext {
  return { token: "sntryu_TEST", instance: resolveInstance(region), http };
}

/** A stats_v2 response with daily intervals starting at `from`. */
export function stats(
  from: string,
  days: number,
  groups: Array<{ by: Record<string, string | number>; series?: number[]; total?: number }>,
) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const intervals = Array.from({ length: days }, (_, i) =>
    new Date(start + i * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
  );
  return {
    start: intervals[0] ?? "",
    end: intervals[intervals.length - 1] ?? "",
    intervals,
    groups: groups.map((g) => ({
      by: g.by,
      totals: { "sum(quantity)": g.total ?? (g.series ?? []).reduce((a, b) => a + b, 0) },
      series: { "sum(quantity)": g.series ?? new Array(days).fill(0) },
    })),
  };
}
