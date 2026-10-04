export interface Call {
  method: string;
  url: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Fake host HTTP service. `jsonRestFetch` prefers it when present, so the URL,
 * Bearer header, query and JSON body are exercised end to end offline.
 * `route` returns the JSON body, or `{ status, body }` via `reply`.
 */
export interface Reply {
  __reply: true;
  status: number;
  body: unknown;
}
export const reply = (status: number, body: unknown = {}): Reply => ({
  __reply: true,
  status,
  body,
});

export function makeHttp(route: (call: Call) => unknown) {
  const calls: Call[] = [];
  const http = {
    async request(req: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string | Uint8Array;
    }) {
      const u = new URL(req.url);
      const call: Call = {
        method: req.method,
        url: req.url,
        path: u.pathname,
        query: u.searchParams,
        headers: req.headers,
        body: req.body ? JSON.parse(String(req.body)) : undefined,
      };
      calls.push(call);
      const out = route(call);
      if (out && typeof out === "object" && (out as Reply).__reply) {
        const r = out as Reply;
        return { status: r.status, headers: {}, body: JSON.stringify(r.body) };
      }
      return { status: 200, headers: {}, body: out === undefined ? "" : JSON.stringify(out) };
    },
  };
  return { http, calls };
}

/** Unix seconds of a Devin billing day boundary (08:00 UTC). */
export const day = (iso: string) => Date.parse(`${iso}T08:00:00Z`) / 1000;

export const page = <T>(items: T[]) => ({ items, has_next_page: false, end_cursor: null });
