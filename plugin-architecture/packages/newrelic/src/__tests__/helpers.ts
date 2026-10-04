import type { NewRelicContext } from "../api.js";
import { resolveRegion } from "../regions.js";

export interface GraphQlCall {
  url: string;
  headers: Record<string, string>;
  query: string;
  variables: Record<string, unknown>;
}

/**
 * Fake host HTTP service answering NerdGraph. `jsonRestFetch` prefers it when
 * present, so the request (URL, `API-Key` header, GraphQL body) is exercised
 * end to end offline. `route` returns the GraphQL `data` (or a full
 * `{ data, errors }` body when it returns an object with `errors`).
 */
export function makeHttp(route: (call: GraphQlCall) => unknown) {
  const calls: GraphQlCall[] = [];
  const http = {
    async request(req: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string | Uint8Array;
    }) {
      const parsed = JSON.parse(String(req.body ?? "{}")) as {
        query: string;
        variables?: Record<string, unknown>;
      };
      const call: GraphQlCall = {
        url: req.url,
        headers: req.headers,
        query: parsed.query,
        variables: parsed.variables ?? {},
      };
      calls.push(call);
      const out = route(call);
      const body =
        out && typeof out === "object" && "errors" in (out as Record<string, unknown>)
          ? out
          : { data: out };
      return { status: 200, headers: {}, body: JSON.stringify(body) };
    },
  };
  return { http, calls };
}

export function ctxWith(http: ReturnType<typeof makeHttp>["http"], region = "us"): NewRelicContext {
  return { apiKey: "NRAK-TEST", region: resolveRegion(region), http };
}

/** NerdGraph `nrql.results` wrapper. */
export function nrqlData(results: unknown[]) {
  return { actor: { account: { nrql: { results } } } };
}

/** `beginTimeSeconds` for a UTC day. */
export const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000;
