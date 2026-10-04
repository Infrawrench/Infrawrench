import type { GitHubContext } from "../api.js";
import { parseOwner, resolveHost } from "../api.js";

export interface Reply {
  status?: number;
  body?: unknown;
  raw?: string;
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
      const text = reply.raw ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));
      return { status: reply.status ?? 200, headers: {}, body: text };
    },
  };
  return { http, calls };
}

export function ctxWith(
  http: ReturnType<typeof makeHttp>["http"],
  owner = "org:octo-org",
  host = "github.com",
): GitHubContext {
  return { token: "tok", host: resolveHost(host), owner: parseOwner(owner)!, http };
}

export function credentials(owner = "org:octo-org"): Record<string, string> {
  return { token: "tok", host: "github.com", owner };
}
