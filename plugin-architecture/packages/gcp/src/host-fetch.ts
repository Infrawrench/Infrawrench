import { hostFetch, type HostServices } from "@infrawrench/plugin-base";

export interface GcpHostContext {
  readonly hostServices: HostServices | undefined;
}

/** `fetch`, through the host's HTTP service when it has one. */
export function hostedFetch(
  ctx: GcpHostContext,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  return hostFetch({ http: ctx.hostServices?.http }, url, init);
}
