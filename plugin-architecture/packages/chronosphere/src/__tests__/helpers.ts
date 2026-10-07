export interface Reply {
  status?: number;
  body?: unknown;
}

export interface Recorded {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
  rawBody?: string;
}

/** Fake host HTTP service; `jsonRestFetch` always prefers it when present. */
export function makeHttp(route: (url: URL, method: string, body: unknown) => Reply | undefined) {
  const calls: Recorded[] = [];
  const http = {
    async request(req: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string | Uint8Array;
    }) {
      const url = new URL(req.url);
      const raw = typeof req.body === "string" ? req.body : undefined;
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      calls.push({
        url,
        method: req.method,
        headers: req.headers,
        body,
        ...(raw ? { rawBody: raw } : {}),
      });
      const reply = route(url, req.method, body) ?? {
        status: 404,
        body: { error: { message: "nope" } },
      };
      const text = reply.body === undefined ? "" : JSON.stringify(reply.body);
      return { status: reply.status ?? 200, headers: {}, body: text };
    },
  };
  return { http, calls };
}

export const CREDS = { org: "acme", apiToken: "chrono-token" };
