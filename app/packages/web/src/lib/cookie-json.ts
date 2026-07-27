/**
 * Plain cookie-authenticated JSON fetch, for the panel clients that back the
 * shared `@infrawrench/ui` agent and workflow views.
 *
 * Deliberately *not* `api.ts`: those panels render inside a workspace tab and
 * surface failures in their own UI, so they must not inherit `apiFetch`'s
 * navigate-away-on-401 or its host-key/step-up interception.
 */

/** Parse a JSON response, or throw with the server's `error` string attached. */
export async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: string };
      detail = body.error ? `: ${body.error}` : "";
    } catch {
      // Non-JSON error body — the status alone will have to do.
    }
    throw new Error(`Request failed (${res.status})${detail}`);
  }
  return (await res.json()) as T;
}

/** `RequestInit` for a cookie-authenticated JSON request. */
export function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}
