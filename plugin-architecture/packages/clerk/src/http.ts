import type { HostServices, HttpHostServices } from "@infrawrench/plugin-base";

/** A failed call: {@link apiError}'s shape, read in a `.catch`. */
export type ClerkFailure = Error & { status?: number };

/**
 * Send through the host HTTP service when there is one (bastion routing and
 * custom CAs only work on that path), falling back to the global fetch in the
 * renderer and in tests.
 */
export function clerkTransport(services: HostServices | undefined): HttpHostServices {
  return {
    request: async (req) => {
      if (services?.http) {
        const result = await services.http.request(req);
        return { ...result, body: result.body ?? "" };
      }
      if (req.caCert) {
        throw new Error(
          "Clerk plugin: a custom CA certificate needs the host HTTP service, which is not available here",
        );
      }
      const { url, method, headers, body } = req;
      const res = await fetch(url, {
        method,
        headers,
        // The client only ever sends text.
        ...(typeof body === "string" ? { body } : {}),
      });
      const answer: Record<string, string> = {};
      res.headers?.forEach?.((value, key) => {
        answer[key.toLowerCase()] = value;
      });
      return { status: res.status, headers: answer, body: await res.text() };
    },
  };
}

/** Clerk's error body. Not validated, so anything can be in these fields. */
interface ClerkErrorBody {
  errors?: Array<{
    message?: string | number | boolean | null;
    long_message?: string | number | boolean | null;
    code?: string | number | boolean | null;
  }>;
}

/** An API error carrying the HTTP status, which the poller classifies on. */
export function apiError(status: number, path: string, body: string): Error {
  let detail = body.slice(0, 500);
  try {
    const parsed: ClerkErrorBody = JSON.parse(body);
    const first = parsed.errors?.[0];
    if (first) {
      const text =
        typeof first.long_message === "string" ? first.long_message : String(first.message ?? "");
      detail = typeof first.code === "string" ? `${text} (${first.code})` : text;
    }
  } catch {
    // Not JSON: keep the raw (truncated) body.
  }
  return Object.assign(new Error(`Clerk API error ${status} for ${path}: ${detail}`), {
    status,
  });
}
