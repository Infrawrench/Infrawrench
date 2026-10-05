import { vi } from "vitest";

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Record<string, string>;
}

type Route = (call: Call) => unknown;

export const state: { calls: Call[]; routes: Record<string, Route> } = { calls: [], routes: {} };

export function route(method: string, path: string, handler: Route | unknown): void {
  state.routes[`${method} ${path}`] =
    typeof handler === "function" ? (handler as Route) : () => handler;
}

/** Stub global fetch with a tiny router keyed by `METHOD /path`. Unrouted → 404. */
export function installFetch(): void {
  state.calls = [];
  state.routes = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const u = new URL(url);
      const call: Call = {
        method: init.method ?? "GET",
        path: u.pathname,
        query: u.searchParams,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        headers: init.headers as Record<string, string>,
      };
      state.calls.push(call);
      const handler = state.routes[`${call.method} ${call.path}`];
      if (!handler) {
        return new Response(JSON.stringify({ detail: "Not found" }), { status: 404 });
      }
      const out = handler(call);
      if (out instanceof Response) return out;
      return new Response(JSON.stringify(out ?? {}), { status: 200 });
    }),
  );
}
