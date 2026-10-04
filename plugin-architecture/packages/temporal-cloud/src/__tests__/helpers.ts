import type { TemporalContext } from "../api.js";

export interface Reply {
  status?: number;
  body?: unknown;
  text?: string;
}

export interface Recorded {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

/**
 * Fake host HTTP service. Every request path in the plugin prefers it when
 * present, so URLs, auth headers and bodies are exercised end to end offline.
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
      const text = reply.text ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));
      return { status: reply.status ?? 200, headers: {}, body: text };
    },
  };
  return { http, calls };
}

export function ctxWith(http: ReturnType<typeof makeHttp>["http"]): TemporalContext {
  return { apiKey: "api-key", metricsApiKey: "metrics-key", http };
}
