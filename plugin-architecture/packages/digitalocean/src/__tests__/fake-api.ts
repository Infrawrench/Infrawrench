import type { DoApi } from "../api.js";

type Fetch = (path: string, init?: RequestInit) => unknown;

interface Call {
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * The typed client over a `fetch(path, init)` mock, for tests that drive one module
 * directly and assert on the path and body it asks for. A GET with nothing else on
 * it reaches the mock with the path alone.
 */
export function fakeApi(fetch: Fetch): DoApi {
  const call =
    (method: string) =>
    async (path: string, { query, body, headers }: Call = {}) => {
      const written = Object.entries(query ?? {})
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
        .join("&");
      const target = written ? `${path}?${written}` : path;
      if (method === "GET") return fetch(target);
      return fetch(target, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(headers ? { headers } : {}),
      });
    };
  const api = {
    get: call("GET"),
    post: call("POST"),
    put: call("PUT"),
    patch: call("PATCH"),
    delete: call("DELETE"),
    written: async (path: string, request?: RequestInit) =>
      request ? fetch(path, request) : fetch(path),
    fetch: (url: string, init?: RequestInit) => globalThis.fetch(url, init),
  };
  return api as unknown as DoApi;
}
