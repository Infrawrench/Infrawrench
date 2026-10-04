import type { AtlasContext } from "../api.js";
import { DEFAULT_BASE_URL } from "../api.js";

export interface Call {
  url: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Reply = { status?: number; headers?: Record<string, string>; body?: unknown };

/**
 * Fake host HTTP service. `route` sees every request except the OAuth token
 * call (answered with a fixed token) and returns a body (status 200) or a
 * full `{ status, headers, body }` reply via {@link reply}.
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
      const u = new URL(req.url);
      if (u.pathname === "/api/oauth/token") {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ access_token: "tok", expires_in: 3600, token_type: "Bearer" }),
        };
      }
      let body: unknown;
      try {
        body = req.body ? JSON.parse(String(req.body)) : undefined;
      } catch {
        body = req.body;
      }
      const call: Call = {
        url: req.url,
        path: u.pathname + u.search,
        method: req.method,
        headers: req.headers,
        body,
      };
      calls.push(call);
      const out = route(call);
      if (out && typeof out === "object" && REPLY in (out as object)) {
        const r = out as Reply & { [REPLY]: true };
        return {
          status: r.status ?? 200,
          headers: r.headers ?? {},
          body: r.body === undefined ? "" : JSON.stringify(r.body),
        };
      }
      return { status: 200, headers: {}, body: out === undefined ? "" : JSON.stringify(out) };
    },
  };
  return { http, calls };
}

const REPLY = Symbol("reply");

export function reply(r: Reply): Reply {
  return Object.assign({ [REPLY]: true }, r);
}

export function ctxWith(http: ReturnType<typeof makeHttp>["http"]): AtlasContext {
  return {
    auth: { kind: "service-account", clientId: "mdb_sa_id_x", clientSecret: "mdb_sa_sk_y" },
    baseUrl: DEFAULT_BASE_URL,
    http,
  };
}

export const CREDS = {
  clientId: "mdb_sa_id_test",
  clientSecret: "mdb_sa_sk_test",
  orgId: "org1",
};
