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
 * Fake host HTTP service. The plugin always prefers it when present, so
 * requests are exercised end to end (URL, auth header, body) offline.
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
