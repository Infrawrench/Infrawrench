import type { HostServices } from "@infrawrench/plugin-base";

/** A raw HTTP response, decoded as UTF-8 text. */
export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface RawRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * Send one request through the host HTTP service when there is one (bastion
 * routing and custom CAs only work on that path), falling back to the global
 * fetch in the renderer and in tests.
 */
export async function sendRaw(
  req: RawRequest,
  services: HostServices | undefined,
  caCert: string,
): Promise<RawResponse> {
  if (services?.http) {
    const result = await services.http.request({
      url: req.url,
      method: req.method,
      headers: req.headers,
      ...(req.body !== undefined ? { body: req.body } : {}),
      ...(caCert ? { caCert } : {}),
    });
    return { status: result.status, headers: lowerKeys(result.headers), body: result.body ?? "" };
  }
  if (caCert) {
    throw new Error(
      "Infisical plugin: a custom CA certificate needs the host HTTP service, which is not available here",
    );
  }
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    ...(req.body !== undefined ? { body: req.body } : {}),
  });
  const headers: Record<string, string> = {};
  res.headers?.forEach?.((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return { status: res.status, headers, body: await res.text() };
}

function lowerKeys(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) out[key.toLowerCase()] = value;
  return out;
}

/** An API error carrying the HTTP status, which the poller classifies on. */
export function apiError(status: number, path: string, body: string): Error {
  let detail = body.slice(0, 500);
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown };
    const message = typeof parsed.message === "string" ? parsed.message : "";
    const error = typeof parsed.error === "string" ? parsed.error : "";
    if (message || error) detail = [error, message].filter(Boolean).join(": ");
  } catch {
    // Not JSON: keep the raw (truncated) body.
  }
  return Object.assign(new Error(`Infisical API error ${status} for ${path}: ${detail}`), {
    status,
  });
}
