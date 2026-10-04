import type { GrafanaContext } from "../api.js";

export interface Reply {
  status?: number;
  body?: unknown;
}

export interface Recorded {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

/**
 * Fake host HTTP service. `jsonRestFetch` always prefers it when present, so
 * requests are exercised end to end (URL, auth headers, body) offline.
 */
export function makeHttp(route: (url: URL, method: string, body: unknown) => Reply) {
  const calls: Recorded[] = [];
  const http = {
    async request(req: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string | Uint8Array;
    }) {
      const url = new URL(req.url);
      const body =
        typeof req.body === "string" && req.body.length > 0 ? JSON.parse(req.body) : undefined;
      calls.push({ url, method: req.method, headers: req.headers, body });
      const reply = route(url, req.method, body);
      const text = reply.body === undefined ? "" : JSON.stringify(reply.body);
      return { status: reply.status ?? 200, headers: {}, body: text };
    },
  };
  return { http, calls };
}

/** A token in the format Grafana issues: `glc_` + base64 JSON with the org id and region. */
export function fakeToken(orgId = "4242", region = "prod-us-east-0"): string {
  const json = JSON.stringify({ o: orgId, n: "infrawrench", k: "secret", m: { r: region } });
  return `glc_${Buffer.from(json).toString("base64")}`;
}

export function ctxWith(
  http: ReturnType<typeof makeHttp>["http"],
  token = fakeToken(),
): GrafanaContext {
  return { token, http };
}
