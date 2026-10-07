import { vi } from "vitest";

export type Route = (url: URL, init: RequestInit) => unknown;

/**
 * Stub global fetch with `METHOD /path` handlers (path without the
 * `/public/api/v1` prefix). Unmatched requests answer 404.
 */
export function mockFetch(routes: Record<string, unknown>) {
  const calls: Array<{
    method: string;
    path: string;
    body: unknown;
    headers: Record<string, string>;
    url: URL;
  }> = [];
  const fn = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/^\/public\/api\/v1/, "") || "/";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({
      method,
      path,
      body,
      headers: (init.headers ?? {}) as Record<string, string>,
      url,
    });
    const handler = routes[`${method} ${path}`];
    if (handler === undefined) {
      return new Response(
        JSON.stringify({ code: "NOT_FOUND", message: `no route ${method} ${path}` }),
        {
          status: 404,
        },
      );
    }
    const value = typeof handler === "function" ? (handler as Route)(url, init) : handler;
    if (value instanceof Response) return value;
    if (value === null) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}
