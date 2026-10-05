import { vi } from "vitest";

export interface FetchCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

/** Route fetches by `METHOD path` (no query); the handler gets the parsed URL and body. */
export function installFetch(
  handler: (route: string, url: URL, body: unknown) => Response | Promise<Response>,
): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({
      url: String(input),
      method,
      body,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return handler(`${method} ${url.pathname}`, url, body);
  }) as typeof fetch);
  return calls;
}
