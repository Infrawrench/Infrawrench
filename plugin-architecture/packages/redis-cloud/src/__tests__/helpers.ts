import { vi } from "vitest";

export type Route = (url: URL, init: RequestInit) => unknown;

/**
 * Stub global fetch with a table of `METHOD /path` handlers (path without the
 * `/v1` prefix). Unmatched requests answer 404 so a test fails loudly.
 */
export function mockFetch(routes: Record<string, unknown | Route>) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fn = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/^\/v1/, "") || "/";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const handler = routes[`${method} ${path}`];
    if (handler === undefined) {
      return new Response(JSON.stringify({ description: `no route ${method} ${path}` }), {
        status: 404,
      });
    }
    const value = typeof handler === "function" ? (handler as Route)(url, init) : handler;
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

export const completed = (resource: unknown, resourceId?: number) => ({
  taskId: "t-1",
  status: "processing-completed",
  response: { resource, ...(resourceId !== undefined ? { resourceId } : {}) },
});
