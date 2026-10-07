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
      "Okta plugin: a custom CA certificate needs the host HTTP service, which is not available here",
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
    const parsed = JSON.parse(body) as {
      errorSummary?: unknown;
      errorCode?: unknown;
      errorCauses?: Array<{ errorSummary?: unknown }>;
      error?: unknown;
      error_description?: unknown;
    };
    const summary = typeof parsed.errorSummary === "string" ? parsed.errorSummary : "";
    const causes = (parsed.errorCauses ?? [])
      .map((c) => (typeof c.errorSummary === "string" ? c.errorSummary : ""))
      .filter(Boolean)
      .join("; ");
    const code = typeof parsed.errorCode === "string" ? parsed.errorCode : "";
    const oauth = typeof parsed.error === "string" ? parsed.error : "";
    const oauthDesc = typeof parsed.error_description === "string" ? parsed.error_description : "";
    const text =
      [summary, causes].filter(Boolean).join(": ") || [oauth, oauthDesc].filter(Boolean).join(": ");
    if (text) detail = code ? `${text} (${code})` : text;
  } catch {
    // Not JSON: keep the raw (truncated) body.
  }
  return Object.assign(new Error(`Okta API error ${status} for ${path}: ${detail}`), {
    status,
  });
}
