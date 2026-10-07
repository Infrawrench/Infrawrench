import type { StatusFeedDeclaration, StatusIncident } from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";

/**
 * status.bunny.net is Atlassian Statuspage (verified 2026-10-07). Its
 * components are products, not regions, so they map to resource types.
 */
export const statusFeed: StatusFeedDeclaration = {
  url: "https://status.bunny.net/api/v2/incidents/unresolved.json",
  format: "statuspage-v2",
  statusPageUrl: "https://status.bunny.net",
};

const COMPONENTS: Array<[RegExp, string[], boolean?]> = [
  [/^CDN Logging$/i, ["pull-zone"]],
  [/^(CDN|Origin Shield|Optimizer|Bunny Shield)$/i, ["pull-zone", "hostname", "edge-rule"]],
  [/^DNS$/i, ["dns-zone", "dns-record"]],
  [/^Edge Storage$/i, ["storage-zone"]],
  [/^(Stream|Stream Service|Stream - Transcoding Service|Live Stream)$/i, ["video-library"]],
  [/^Edge Scripting$/i, ["edge-script"]],
  [/^Magic Containers$/i, ["container-app"]],
  [/^(API|Dashboard)$/i, [], true],
];

export function mapComponent(
  name: string,
): { services: string[]; resourceTypes?: string[]; providerWide?: boolean } | null {
  for (const [re, types, wide] of COMPONENTS) {
    if (re.test(name.trim()))
      return {
        services: [name],
        ...(types.length ? { resourceTypes: types } : {}),
        ...(wide ? { providerWide: true } : {}),
      };
  }
  // Website, Bunny Fonts, Bunny Database and anything new: nothing this plugin manages.
  return null;
}

export function parseStatusFeed(body: string): StatusIncident[] {
  return parseStatuspageIncidents(body, {
    mapComponent,
    statusPageUrl: "https://status.bunny.net",
  });
}
