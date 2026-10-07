import {
  remediationField,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
  type RemediationResource,
} from "@infrawrench/plugin-base";
import { T } from "./resource-types.js";

/**
 * Remediation for Couchbase Capella savings findings. Capella has no official
 * CLI for the Management API, so every command is `curl` against the v4 routes
 * this plugin's own actions call, authenticated with a Management API key.
 *
 * - Clusters and App Services on a sleep schedule: turn off / turn on through
 *   `activationState` (free-tier clusters live under `clusters/freeTier/`).
 * - An empty bucket (orphan): delete it to release its memory quota.
 * - An inactive organization user (orphan): remove them from the organization.
 *
 * Reference (Management API v4):
 * https://docs.couchbase.com/cloud/management-api-reference/index.html
 *   POST|DELETE .../clusters/{clusterId}/activationState
 *   POST|DELETE .../clusters/freeTier/{clusterId}/activationState
 *   POST|DELETE .../clusters/{clusterId}/appservices/{appServiceId}/activationState
 *   DELETE .../clusters/{clusterId}/buckets/{bucketId}
 *   DELETE .../clusters/{clusterId}/buckets/freeTier/{bucketId}
 *   DELETE /v4/organizations/{organizationId}/users/{userId}
 */
export function capellaRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind === "sleep-schedule") return sleepSchedule(finding.resource);
  if (finding.kind === "orphan") return orphan(finding.resource);
  return [];
}

function sleepSchedule(resource: RemediationResource): RemediationCommand[] {
  if (resource.resourceTypeId === T.cluster) {
    const [p, c] = ids(resource, ["projectId", "clusterId"]);
    if (!p || !c) return [];
    const free = resource.fields["freeTier"] === true || resource.fields["freeTier"] === "true";
    const url = `${project(p)}/clusters/${free ? "freeTier/" : ""}${enc(c)}/activationState`;
    return [
      request("DELETE", url, "Turn the cluster off; compute stops billing while storage is kept."),
      request(
        "POST",
        url,
        free
          ? "Turn the cluster on again."
          : "Turn the cluster on again, with its linked App Service.",
        free ? undefined : { turnOnLinkedAppService: true },
      ),
    ];
  }
  if (resource.resourceTypeId === T.appService) {
    const [p, c, a] = ids(resource, ["projectId", "clusterId", "appServiceId"]);
    if (!p || !c || !a) return [];
    const url = `${project(p)}/clusters/${enc(c)}/appservices/${enc(a)}/activationState`;
    return [
      request("DELETE", url, "Turn the App Service off."),
      request("POST", url, "Turn the App Service on again (its cluster must be on)."),
    ];
  }
  return [];
}

function orphan(resource: RemediationResource): RemediationCommand[] {
  if (resource.resourceTypeId === T.bucket) {
    const [p, c, b] = ids(resource, ["projectId", "clusterId", "bucketId"]);
    if (!p || !c || !b) return [];
    return [
      {
        ...request(
          "DELETE",
          `${project(p)}/clusters/${enc(c)}/buckets/${enc(b)}`,
          "Delete the empty bucket, releasing its memory quota on the cluster. On a free-tier cluster the path is buckets/freeTier/{bucketId}.",
        ),
        destructive: true,
      },
    ];
  }
  if (resource.resourceTypeId === T.user) {
    const userId = remediationField(resource, "userId") || (resource.externalId ?? "").trim();
    if (!userId) return [];
    return [
      {
        ...request(
          "DELETE",
          `${ORG}/users/${enc(userId)}`,
          "Remove the inactive user from the Capella organization.",
        ),
        destructive: true,
      },
    ];
  }
  return [];
}

const API = "https://cloudapi.cloud.couchbase.com";
/** The organization id is account-level and not on every row, so it is a placeholder. */
const ORG = `${API}/v4/organizations/$CAPELLA_ORG_ID`;

const PLACEHOLDERS: RemediationPlaceholder[] = [
  {
    name: "CAPELLA_API_KEY",
    description: "A Capella Management API key token for this organization",
  },
  {
    name: "CAPELLA_ORG_ID",
    description: "The Capella organization id this account is connected to",
  },
];

const enc = (v: string) => encodeURIComponent(v);
const project = (p: string) => `${ORG}/projects/${enc(p)}`;

/**
 * The named fields, falling back to the `/`-joined externalId segments
 * (`project/cluster[/child]`, each segment percent-encoded by the lister).
 */
function ids(resource: RemediationResource, keys: string[]): string[] {
  const parts = (resource.externalId ?? "").split("/");
  return keys.map((k, i) => {
    const fromField = remediationField(resource, k);
    if (fromField) return fromField;
    try {
      return decodeURIComponent(parts[i] ?? "").trim();
    } catch {
      return "";
    }
  });
}

/**
 * One API call. Ids in the URL are percent-encoded; the URL is double-quoted
 * so `$CAPELLA_ORG_ID` expands, which is safe because an encoded id holds no
 * `"`, `$`, backtick or backslash.
 */
function request(
  method: "POST" | "DELETE",
  url: string,
  description: string,
  body?: Record<string, unknown>,
): RemediationCommand {
  return {
    tool: "curl",
    command:
      `curl -sS -X ${method} "${url}" -H "Authorization: Bearer $CAPELLA_API_KEY"` +
      (body ? ` -H 'Content-Type: application/json' -d ${shellQuote(JSON.stringify(body))}` : ""),
    description,
    destructive: false,
    placeholders: PLACEHOLDERS,
  };
}
