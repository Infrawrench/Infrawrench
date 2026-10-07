import { vi } from "vitest";

export type Route = (url: URL, init: RequestInit) => unknown;

/** Stub global fetch with `METHOD host/path` or `METHOD /path` handlers. Unmatched answer 404. */
export function mockFetch(routes: Record<string, unknown>) {
  const calls: Array<{ method: string; url: URL; body: unknown; headers: Record<string, string> }> =
    [];
  const fn = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body, headers: (init.headers ?? {}) as Record<string, string> });
    const handler =
      routes[`${method} ${url.host}${url.pathname}`] ??
      (url.host === "us-east-1-1.aws.cloud2.influxdata.com"
        ? routes[`${method} ${url.pathname}`]
        : undefined);
    if (handler === undefined) {
      return new Response(JSON.stringify({ errors: [{ message: `no route ${method} ${url}` }] }), {
        status: 404,
      });
    }
    const value = typeof handler === "function" ? (handler as Route)(url, init) : handler;
    if (value instanceof Response) return value;
    if (value === null) return new Response(null, { status: 204 });
    return new Response(typeof value === "string" ? value : JSON.stringify(value), { status: 200 });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}
