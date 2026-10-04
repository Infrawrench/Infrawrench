import type { FastlyContext } from "../api.js";

export interface Reply {
  status?: number;
  body?: unknown;
  /** Sent verbatim instead of JSON-encoding `body`. */
  text?: string;
}

export interface Recorded {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** Fake host HTTP service: every request goes through it, offline. */
export function makeHttp(route: (url: URL, method: string, body: string | undefined) => Reply) {
  const calls: Recorded[] = [];
  const http = {
    async request(req: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string | Uint8Array;
    }) {
      const url = new URL(req.url);
      const body = typeof req.body === "string" ? req.body : undefined;
      calls.push({ url, method: req.method, headers: req.headers, ...(body ? { body } : {}) });
      const reply = route(url, req.method, body);
      const text = reply.text ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));
      return { status: reply.status ?? 200, headers: {}, body: text };
    },
  };
  return { http, calls };
}

export function ctxWith(http: ReturnType<typeof makeHttp>["http"]): FastlyContext {
  return { token: "test-token", http };
}
