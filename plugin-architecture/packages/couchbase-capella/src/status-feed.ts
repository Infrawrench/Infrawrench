/**
 * Capella service health (https://status.couchbase.com, Atlassian
 * Statuspage; verified 2026-10). Components: "Couchbase Capella" group
 * (Operational, Analytics, App Services, Management API, UI, Notifications),
 * an "AWS" group whose children are named "AWS ec2-<region>", and "Azure" /
 * "GCP" groups named after cloud services rather than regions. AWS regions map
 * onto the `region` cluster field; the rest scope by product.
 */
import type {
  StatusComponentMapping,
  StatusFeedDeclaration,
  StatusIncident,
} from "@infrawrench/plugin-base";
import { parseStatuspageIncidents } from "@infrawrench/plugin-base";
import { T } from "./resource-types.js";

const STATUS_PAGE = "https://status.couchbase.com";

export const statusFeed: StatusFeedDeclaration = {
  url: `${STATUS_PAGE}/api/v2/incidents.json`,
  format: "statuspage-v2",
  statusPageUrl: STATUS_PAGE,
};

const DATA_TYPES = [
  T.cluster,
  T.bucket,
  T.scope,
  T.collection,
  T.credential,
  T.backup,
  T.replication,
];

export function mapComponent(name: string): StatusComponentMapping | null {
  const n = name.trim();
  const aws = /^AWS\s+ec2-([a-z]{2}-[a-z]+-\d)$/i.exec(n);
  if (aws) return { regions: [aws[1]!.toLowerCase()], services: [n] };
  switch (n) {
    case "Couchbase Capella Operational":
      return { services: [n], resourceTypes: DATA_TYPES };
    case "Couchbase Capella App Services":
      return { services: [n], resourceTypes: [T.appService] };
    case "Couchbase Capella Management API":
    case "Couchbase Capella UI":
      return { services: [n], providerWide: true };
    case "Couchbase Capella Analytics":
      return { services: [n] };
    case "Capella Notifications":
      return null;
  }
  return { services: [n], resourceTypes: DATA_TYPES };
}

export function parseStatusFeed(body: string): StatusIncident[] {
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  return parseStatuspageIncidents(body, { mapComponent, statusPageUrl: STATUS_PAGE }).filter(
    (i) => !i.resolvedAt || Date.parse(i.resolvedAt) >= cutoff,
  );
}
