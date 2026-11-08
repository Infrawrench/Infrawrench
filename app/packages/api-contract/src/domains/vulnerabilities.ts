/**
 * Vulnerabilities: `/api/org/:orgId/vulnerabilities`, the endpoint
 * definitions.
 *
 * Permissions follow posture exactly: reading is `resources:read`, the alert
 * settings are `org:settings:write`, and dismissing (accepting a CVE as a
 * known risk) is `resources:write`, so members cannot silence what they can
 * read. The editor extensions' hover reads the feed with `resourceId`.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { maxLength } from "../schemas";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, OrgParams, Uuid } from "../http/schemas/common";
import { documentedAs, optionalRequestBody, requiredQuery } from "../http/schemas/documented";
import { PluginId } from "../http/schemas/plugin-registry";

const VulnerabilitySeverity = Schema.Literals([
  "critical",
  "high",
  "medium",
  "low",
  "unknown",
]).annotate({
  description:
    "Normalised scanner severity. `unknown` means the scanner has not scored the advisory; " +
    "it is never folded into `low`.",
});

const ArtifactKind = Schema.Literals([
  "image",
  "function",
  "host",
  "repository",
  "package",
]).annotate({
  description:
    "What the finding is about: a container image, a serverless function, a VM or node, a " +
    "source repository, or a stored package. Only images, functions and hosts can be running.",
});

const VulnerabilitySeverityCounts = Schema.Struct({
  critical: Schema.Int,
  high: Schema.Int,
  medium: Schema.Int,
  low: Schema.Int,
  unknown: Schema.Int,
}).annotate({ identifier: "VulnerabilitySeverityCounts" });

const VulnerabilityRunningRef = Schema.Struct({
  resourceId: Schema.String.annotate({ description: "Infrawrench resource id." }),
  pluginId: PluginId,
  resourceTypeId: Schema.String,
  resourceTypeName: Schema.String.annotate({ examples: ["Pod"] }),
  resourceTypePluralName: Schema.String.annotate({ examples: ["Pods"] }),
  accountId: Uuid,
  accountName: Schema.String,
  displayName: Schema.String,
  matchedBy: Schema.Literals(["digest", "resource", "tag"]).annotate({
    description:
      "How the resource was tied to the finding: it runs the scanned image digest, the " +
      "scanner named it directly, or it runs a tag the scanned image carries with no " +
      "digest to confirm it.",
  }),
}).annotate({ identifier: "VulnerabilityRunningRef" });

// Inline rather than a second `ServiceRef` component: the services domain
// defines that name, and two schemas under one name would collide.
const OwningService = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  slug: Schema.String,
  tier: Schema.NullOr(Schema.Literals([1, 2, 3, 4])).annotate({
    description: "Criticality, 1 being the most critical.",
  }),
});

const VulnerabilityKevEntry = Schema.Struct({
  dateAdded: Schema.String.annotate({ description: "Date CISA added it (YYYY-MM-DD)." }),
  dueDate: Schema.NullOr(Schema.String).annotate({
    description: "Federal remediation due date, when set.",
  }),
  knownRansomware: Schema.Boolean.annotate({
    description: "CISA lists known ransomware campaign use.",
  }),
}).annotate({ identifier: "VulnerabilityKevEntry" });

// A field set so `DismissedVulnerabilityFinding` is one flat object.
const findingFields = {
  key: Schema.String.annotate({
    description: "Unique within the organization (account id and finding id).",
  }),
  accountId: Uuid,
  accountName: Schema.String,
  pluginId: PluginId,
  pluginName: Schema.String,
  scanner: Schema.String.annotate({ examples: ["Amazon Inspector"] }),
  findingId: Schema.String.annotate({ description: "The provider's own finding id." }),
  advisoryId: Schema.String.annotate({ examples: ["CVE-2024-3094"] }),
  aliases: Schema.Array(Schema.String).annotate({
    description: "Other ids for the same advisory.",
  }),
  title: Schema.NullOr(Schema.String),
  severity: VulnerabilitySeverity,
  cvssScore: Schema.NullOr(Schema.Finite),
  cvssVector: Schema.NullOr(Schema.String),
  packageName: Schema.NullOr(Schema.String),
  packageEcosystem: Schema.NullOr(Schema.String),
  installedVersion: Schema.NullOr(Schema.String),
  fixedVersion: Schema.NullOr(Schema.String),
  fixAvailable: Schema.NullOr(Schema.Boolean).annotate({
    description: "Null when the scanner does not say.",
  }),
  exploitAvailable: Schema.NullOr(Schema.Boolean).annotate({
    description: "Null when the scanner does not say.",
  }),
  kev: Schema.NullOr(VulnerabilityKevEntry).annotate({
    description: "CISA Known Exploited Vulnerabilities entry, when listed.",
  }),
  artifact: Schema.Struct({
    kind: ArtifactKind,
    name: Schema.String.annotate({
      description: "Image repository without tag or digest, or the artifact name.",
    }),
    digest: Schema.NullOr(Schema.String),
    tags: Schema.Array(Schema.String),
    resourceExternalId: Schema.NullOr(Schema.String),
    url: Schema.NullOr(Schema.String),
    key: Schema.String.annotate({ description: "What a dismissal is keyed on." }),
  }),
  firstSeenAt: Schema.NullOr(IsoDateTime),
  lastSeenAt: Schema.NullOr(IsoDateTime),
  url: Schema.NullOr(Schema.String),
  collectedAt: IsoDateTime,
  running: Schema.Array(VulnerabilityRunningRef).annotate({
    description: "Synced resources running the artifact now; empty when it runs nowhere we see.",
  }),
  services: Schema.Array(OwningService).annotate({
    description:
      "Services the running resources belong to, deduplicated, most critical tier first; " +
      "empty when none of them is in a service.",
  }),
};

const VulnerabilityFinding = Schema.Struct(findingFields).annotate({
  identifier: "VulnerabilityFinding",
});

export const VulnerabilityDismissal = Schema.Struct({
  advisoryId: Schema.String,
  artifactKey: Schema.String.annotate({
    description: "An artifact key from a finding, or `*` for every artifact.",
  }),
  dismissedAt: IsoDateTime,
  dismissedBy: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
}).annotate({ identifier: "VulnerabilityDismissal" });

const DismissedVulnerabilityFinding = Schema.Struct({
  ...findingFields,
  dismissal: VulnerabilityDismissal,
}).annotate({ identifier: "DismissedVulnerabilityFinding" });

const VulnerabilitySource = Schema.Struct({
  accountId: Uuid,
  accountName: Schema.String,
  pluginId: PluginId,
  pluginName: Schema.String,
  scanner: Schema.String,
  consoleUrl: Schema.NullOr(Schema.String),
  partial: Schema.Boolean.annotate({
    description: "The plugin reports a bounded subset of the scanner's findings.",
  }),
  lastCollectedAt: Schema.NullOr(IsoDateTime),
  error: Schema.NullOr(Schema.String).annotate({
    description: "Why the last read failed, when it did.",
  }),
  helpLabel: Schema.NullOr(Schema.String),
  helpUrl: Schema.NullOr(Schema.String),
  findingCount: Schema.Int,
}).annotate({ identifier: "VulnerabilitySource" });

export const VulnerabilityListResponse = Schema.Struct({
  findings: Schema.Array(VulnerabilityFinding).annotate({
    description: "Live findings: worst first, running before not running, then KEV, then CVSS.",
  }),
  totalCount: Schema.Int,
  counts: VulnerabilitySeverityCounts,
  runningCounts: VulnerabilitySeverityCounts,
  dismissed: Schema.Array(DismissedVulnerabilityFinding),
  dismissedCount: Schema.Int,
  sources: Schema.Array(VulnerabilitySource).annotate({
    description: "Every account whose plugin can report findings.",
  }),
  kevUpdatedAt: Schema.NullOr(IsoDateTime),
  generatedAt: IsoDateTime,
}).annotate({ identifier: "VulnerabilityListResponse" });

/** Documented; the handler checks each field itself, with its own sentences. */
const VulnerabilityDismissalCreate = Schema.Struct({
  advisoryId: Schema.String,
  artifactKey: Schema.String.annotate({
    description: "A finding's `artifact.key`, or `*` for every artifact.",
  }),
  reason: Schema.optionalKey(Schema.NullOr(Schema.String.check(maxLength(500)))),
}).annotate({ identifier: "VulnerabilityDismissalCreate" });

const MinSeverity = Schema.Literals(["critical", "high"]);

export const VulnerabilitySettings = Schema.Struct({
  alertsEnabled: Schema.Boolean,
  minSeverity: MinSeverity.annotate({
    description: "Lowest severity that alerts. CISA KEV-listed findings alert regardless.",
  }),
  runningOnly: Schema.Boolean.annotate({
    description: "Only alert on findings whose artifact is running somewhere.",
  }),
  lastNotifiedAt: Schema.NullOr(IsoDateTime).annotate({
    description: "When the alert scan last ran. Owned by the poller; not writable.",
  }),
}).annotate({ identifier: "VulnerabilitySettings" });

/** Documented; the handler checks each field itself, with its own sentences. */
const VulnerabilitySettingsUpdate = Schema.Struct({
  alertsEnabled: Schema.optionalKey(Schema.Boolean),
  minSeverity: Schema.optionalKey(MinSeverity),
  runningOnly: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "VulnerabilitySettingsUpdate" });

/** At most 100 is checked by the handler, after trimming and deduplicating. */
const ResourceIdsQuery = Schema.Array(Schema.String)
  .check(Schema.makeFilter(() => true, { toJsonSchema: () => ({ maxItems: 100 }) }))
  .annotate({
    description:
      "Only findings running on any of these Infrawrench resource ids. Repeat the " +
      "parameter for several (at most 100).",
  });

export class VulnerabilitiesGroup extends HttpApiGroup.make("vulnerabilities")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      query: {
        serviceId: Schema.optionalKey(
          Uuid.annotate({ description: "Only findings running on a resource of this service." }),
        ),
        resourceId: Schema.optionalKey(ResourceIdsQuery),
      },
      success: VulnerabilityListResponse,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List vulnerability findings joined to running resources")
      .annotate(
        OpenApi.Description,
        "Open findings from each connected provider's own scanner (Amazon Inspector, Artifact " +
          "Analysis, Defender for Cloud, Dependabot, GitLab, JFrog Xray), joined to the synced " +
          "resources that run the affected image or are the affected resource, and marked when " +
          "the advisory is in the CISA Known Exploited Vulnerabilities catalog. Read from what the " +
          "poller last collected; no provider calls are made. Dismissed findings are reported " +
          "under `dismissed` and excluded from `findings`, the counts and the alerts. Each finding " +
          "names the services its running resources belong to. `serviceId` and `resourceId` " +
          "narrow the findings (and `dismissed`) to those running there and recompute the counts; " +
          "`sources` always describes every scanner.",
      )
      .annotate(SuccessDescription, "The vulnerability feed"),
    HttpApiEndpoint.post("dismiss", "/dismissals", {
      params: OrgParams,
      payload: VulnerabilityDismissalCreate,
      success: VulnerabilityDismissal,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Dismiss a vulnerability")
      .annotate(
        OpenApi.Description,
        "Accept an advisory as a known risk for one artifact (keyed on the image repository, so " +
          'it survives rebuilds) or, with `artifactKey: "*"`, everywhere. Idempotent.',
      )
      .annotate(SuccessDescription, "The recorded dismissal")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.delete("restore", "/dismissals", {
      params: OrgParams,
      query: {
        advisoryId: Schema.optionalKey(documentedAs(Schema.String)),
        artifactKey: Schema.optionalKey(documentedAs(Schema.String)),
      },
      success: HttpApiSchema.NoContent,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Restore a dismissed vulnerability")
      .annotate(
        OpenApi.Description,
        "The key is in the query string because artifact keys contain slashes.",
      )
      .annotate(SuccessDescription, "The dismissal was removed")
      .annotate(OpenApi.Transform, requiredQuery(["advisoryId", "artifactKey"])),
    HttpApiEndpoint.get("getSettings", "/settings", {
      params: OrgParams,
      success: VulnerabilitySettings,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Get the vulnerability alert settings")
      .annotate(
        OpenApi.Description,
        "Defaults when never saved: alerts on, critical only, running only.",
      )
      .annotate(SuccessDescription, "Vulnerability alert settings"),
    HttpApiEndpoint.put("updateSettings", "/settings", {
      params: OrgParams,
      payload: VulnerabilitySettingsUpdate,
      success: VulnerabilitySettings,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Update the vulnerability alert settings")
      .annotate(OpenApi.Description, "Saving never resets the alert cooldown.")
      .annotate(SuccessDescription, "The updated settings")
      .annotate(OpenApi.Transform, optionalRequestBody),
  )
  .prefix("/api/org/:orgId/vulnerabilities")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Vulnerabilities") {}

export class VulnerabilitiesApi extends withApiDefaults(
  HttpApi.make("vulnerabilities").add(VulnerabilitiesGroup),
) {}
