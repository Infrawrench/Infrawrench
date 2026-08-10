/**
 * The one place Azure HTTP leaves this plugin.
 *
 * Every Azure endpoint the plugin talks to — ARM, the AAD token endpoint, Blob
 * Storage, the ACR token dance and registry API, the Service Bus / Event Hubs
 * data plane, and the public Retail Prices API — goes through
 * {@link azureRequest}. When the host supplies an `HttpHostServices`, the
 * request is proxied through the host process; otherwise it falls straight
 * through to the global `fetch`.
 *
 * **Why this matters.** `services.http` is not a nicety, it is the only path
 * that exists for two things the plugin cannot do itself:
 *
 * - **Bastion routing.** The server host binds an account's HTTP service to
 *   that account's bastion dispatcher (`server-core/src/host-services.ts`), so
 *   a request made through it egresses from the customer's network. A direct
 *   `fetch` from the poller egresses from ours — which for a subscription
 *   whose ARM access is IP-allowlisted simply fails, and for an account bound
 *   to a bastion silently leaks egress that was supposed to be contained.
 * - **Custom CA trust.** The renderer cannot install a trust anchor; only the
 *   Node host can. Azure's own endpoints chain to public roots, so the plugin
 *   declares no `caCert` credential today and passes none — but a corporate
 *   TLS-intercepting proxy in front of `management.azure.com` is the case that
 *   would need one, and routing through the host is the prerequisite for ever
 *   adding it.
 *
 * The return value deliberately mimics the slice of `Response` the call sites
 * already use (`ok` / `status` / `headers.get` / `text()` / `json()`), so
 * migrating a call site is a one-line change and the error strings it builds
 * stay byte-identical. Nothing here throws on a non-2xx: each call site owns
 * its own error message, and several of them (blob delete on 404, ARM DELETE
 * on 202) treat particular non-2xx statuses as success.
 */

import type { HttpHostServices } from "@infrawrench/plugin-base";

/** The subset of `RequestInit` the Azure call sites actually use. */
export interface AzureRequestInit {
  method?: string;
  headers?: Record<string, string>;
  /**
   * `HttpHostServices.request` takes `string | Uint8Array`, which is every
   * body shape this plugin sends: JSON strings, form-urlencoded strings, the
   * raw bytes of an uploaded blob. Streams and `FormData` are deliberately not
   * supported — nothing in an Azure control plane needs them, and they cannot
   * cross the host boundary.
   */
  body?: string | Uint8Array;
}

/** The slice of `Response` the Azure call sites read. */
export interface AzureResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json<T>(): Promise<T>;
}

/**
 * Host services carrying an optional HTTP proxy. Mixed into the per-module
 * context interfaces so every Azure module can reach the host the same way.
 */
export interface AzureHttpTransport {
  /**
   * Host HTTP service, when the host provides one. Absent in the local /
   * renderer case and in tests, where the fall-through to `fetch` applies.
   */
  http?: HttpHostServices | undefined;
}

/** Case-insensitive lookup over the host's plain header record. */
function headerGetter(headers: Record<string, string>): (name: string) => string | null {
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = value;
  return (name: string) => lower[name.toLowerCase()] ?? null;
}

/**
 * Issue one Azure request, preferring the host's HTTP service.
 *
 * Passing `http: undefined` reproduces the previous direct-`fetch` behaviour
 * exactly, down to `res.json()` being the thing that parses the body — which
 * is what keeps the existing per-module tests (which mock `globalThis.fetch`
 * with hand-built `Response` doubles) meaningful.
 */
export async function azureRequest(
  http: HttpHostServices | undefined,
  url: string,
  init: AzureRequestInit = {},
): Promise<AzureResponse> {
  if (!http) {
    const res = await fetch(url, {
      ...(init.method ? { method: init.method } : {}),
      ...(init.headers ? { headers: init.headers } : {}),
      ...(init.body !== undefined ? { body: init.body as BodyInit } : {}),
    });
    return {
      ok: res.ok,
      status: res.status,
      headers: res.headers,
      text: () => res.text(),
      json: <T>() => res.json() as Promise<T>,
    };
  }

  const result = await http.request({
    url,
    method: init.method ?? "GET",
    headers: init.headers ?? {},
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
  const get = headerGetter(result.headers);
  return {
    ok: result.status >= 200 && result.status < 300,
    status: result.status,
    headers: { get },
    text: async () => result.body,
    // An empty body is `{}` rather than a `JSON.parse("")` crash: the host
    // hands back `""` for a 204 or a bodyless 200, where `fetch` call sites
    // guard on status/content-length before ever calling `json()`.
    json: async <T>() => (result.body ? (JSON.parse(result.body) as T) : ({} as T)),
  };
}
