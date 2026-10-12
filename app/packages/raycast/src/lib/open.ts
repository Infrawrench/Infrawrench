import { open } from "@raycast/api";
import {
  desktopDeepLink,
  webIncidentUrl,
  webResourceUrl,
  webServiceUrl,
  webVulnerabilitiesUrl,
  type DesktopDeepLink,
} from "@infrawrench/client-core";
import type { Client } from "./client";

/** Both destinations for one thing, so actions can offer either. */
export interface Destinations {
  web: string;
  desktop: string;
}

export function destinationsFor(client: Client, link: DesktopDeepLink): Destinations {
  const web =
    link.kind === "resource"
      ? webResourceUrl(client.cloudUrl, client.orgId, link)
      : link.kind === "incident"
        ? webIncidentUrl(client.cloudUrl, client.orgId, link.incidentId)
        : link.kind === "vulnerabilities"
          ? webVulnerabilitiesUrl(client.cloudUrl, client.orgId)
          : webServiceUrl(client.cloudUrl, client.orgId, link.serviceId);
  return { web, desktop: desktopDeepLink(link) };
}

/** The org's Vulnerabilities tab, in whichever app the user prefers. */
export function vulnerabilitiesDestinations(client: Client): Destinations {
  return destinationsFor(client, { kind: "vulnerabilities", orgId: client.orgId });
}

export async function openPreferred(client: Client, d: Destinations): Promise<void> {
  await open(client.openIn === "desktop" ? d.desktop : d.web);
}
