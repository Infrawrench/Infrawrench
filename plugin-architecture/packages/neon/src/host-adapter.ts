import { hostFetch, type HttpHostServices } from "@infrawrench/plugin-base";
import type { Api, ApiConfig } from "@neondatabase/api-client";

/** axios's adapter function, which the SDK takes but does not export a name for. */
type Adapter = Extract<NonNullable<ApiConfig<unknown>["adapter"]>, (config: never) => unknown>;
type AdapterConfig = Parameters<Adapter>[0];
type AdapterResponse = Awaited<ReturnType<Adapter>>;

/** Read as an axios error: the plugin and its callers go by `response.status`. */
class NeonHttpError extends Error {
  readonly isAxiosError = true;
  readonly status: number;
  readonly config: AdapterConfig;
  readonly response: AdapterResponse;

  constructor(response: AdapterResponse) {
    super(`Request failed with status code ${response.status}`);
    this.name = "AxiosError";
    this.status = response.status;
    this.config = response.config;
    this.response = response;
  }
}

/**
 * The SDK's requests, through the host's HTTP service.
 *
 * A function rather than axios's `fetch` adapter with `env.fetch`: that adapter caches
 * forever per `fetch` it is given, which is one entry per client here, and it wraps what
 * it catches, which loses the host's own errors for a dropped bastion or a call only the
 * gateway can make.
 */
export function hostAdapter(http: HttpHostServices, api: () => Api<unknown>): Adapter {
  return async (config) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(config.headers.toJSON())) {
      if (typeof value === "string") headers[name] = value;
    }
    const method = (config.method ?? "get").toUpperCase();
    const res = await hostFetch({ http }, api().instance.getUri(config), {
      method,
      headers,
      ...(config.data != null ? { body: config.data } : {}),
    });
    const response: AdapterResponse = {
      data: await res.text(),
      status: res.status,
      statusText: res.statusText,
      headers: Object.fromEntries(res.headers.entries()),
      config,
      request: {},
    };
    const accepted = config.validateStatus ? config.validateStatus(res.status) : true;
    if (!accepted) throw new NeonHttpError(response);
    return response;
  };
}
