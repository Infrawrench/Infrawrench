import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const VulnerabilitySeverity = z.enum(["critical", "high", "medium", "low", "unknown"]).openapi({
  description:
    "Normalised scanner severity. `unknown` means the scanner has not scored the advisory; " +
    "it is never folded into `low`.",
});

const ArtifactKind = z.enum(["image", "function", "host", "repository", "package"]).openapi({
  description:
    "What the finding is about: a container image, a serverless function, a VM or node, a " +
    "source repository, or a stored package. Only images, functions and hosts can be running.",
});

export function registerVulnerabilityPaths(ctx: BuildContext) {
  const { registry, enums } = ctx;

  const Counts = strict({
    critical: z.number().int(),
    high: z.number().int(),
    medium: z.number().int(),
    low: z.number().int(),
    unknown: z.number().int(),
  }).openapi("VulnerabilitySeverityCounts");

  const RunningRef = strict({
    resourceId: z.string().describe("Infrawrench resource id."),
    pluginId: enums.PluginId,
    resourceTypeId: z.string(),
    resourceTypeName: z.string().openapi({ example: "Pod" }),
    resourceTypePluralName: z.string().openapi({ example: "Pods" }),
    accountId: Uuid,
    accountName: z.string(),
    displayName: z.string(),
    matchedBy: z.enum(["digest", "resource", "tag"]).openapi({
      description:
        "How the resource was tied to the finding: it runs the scanned image digest, the " +
        "scanner named it directly, or it runs a tag the scanned image carries with no " +
        "digest to confirm it.",
    }),
  }).openapi("VulnerabilityRunningRef");

  const Kev = strict({
    dateAdded: z.string().describe("Date CISA added it (YYYY-MM-DD)."),
    dueDate: z.string().nullable().describe("Federal remediation due date, when set."),
    knownRansomware: z.boolean().describe("CISA lists known ransomware campaign use."),
  }).openapi("VulnerabilityKevEntry");

  const findingShape = {
    key: z.string().describe("Unique within the organization (account id and finding id)."),
    accountId: Uuid,
    accountName: z.string(),
    pluginId: enums.PluginId,
    pluginName: z.string(),
    scanner: z.string().openapi({ example: "Amazon Inspector" }),
    findingId: z.string().describe("The provider's own finding id."),
    advisoryId: z.string().openapi({ example: "CVE-2024-3094" }),
    aliases: z.array(z.string()).describe("Other ids for the same advisory."),
    title: z.string().nullable(),
    severity: VulnerabilitySeverity,
    cvssScore: z.number().nullable(),
    cvssVector: z.string().nullable(),
    packageName: z.string().nullable(),
    packageEcosystem: z.string().nullable(),
    installedVersion: z.string().nullable(),
    fixedVersion: z.string().nullable(),
    fixAvailable: z.boolean().nullable().describe("Null when the scanner does not say."),
    exploitAvailable: z.boolean().nullable().describe("Null when the scanner does not say."),
    kev: Kev.nullable().describe("CISA Known Exploited Vulnerabilities entry, when listed."),
    artifact: strict({
      kind: ArtifactKind,
      name: z.string().describe("Image repository without tag or digest, or the artifact name."),
      digest: z.string().nullable(),
      tags: z.array(z.string()),
      resourceExternalId: z.string().nullable(),
      url: z.string().nullable(),
      key: z.string().describe("What a dismissal is keyed on."),
    }),
    firstSeenAt: IsoDateTime.nullable(),
    lastSeenAt: IsoDateTime.nullable(),
    url: z.string().nullable(),
    collectedAt: IsoDateTime,
    running: z
      .array(RunningRef)
      .describe("Synced resources running the artifact now; empty when it runs nowhere we see."),
  } as const;

  const Finding = strict(findingShape).openapi("VulnerabilityFinding");

  const Dismissal = strict({
    advisoryId: z.string(),
    artifactKey: z.string().describe("An artifact key from a finding, or `*` for every artifact."),
    dismissedAt: IsoDateTime,
    dismissedBy: z.string().nullable(),
    reason: z.string().nullable(),
  }).openapi("VulnerabilityDismissal");

  const DismissedFinding = strict({ ...findingShape, dismissal: Dismissal }).openapi(
    "DismissedVulnerabilityFinding",
  );

  const Source = strict({
    accountId: Uuid,
    accountName: z.string(),
    pluginId: enums.PluginId,
    pluginName: z.string(),
    scanner: z.string(),
    consoleUrl: z.string().nullable(),
    partial: z.boolean().describe("The plugin reports a bounded subset of the scanner's findings."),
    lastCollectedAt: IsoDateTime.nullable(),
    error: z.string().nullable().describe("Why the last read failed, when it did."),
    helpLabel: z.string().nullable(),
    helpUrl: z.string().nullable(),
    findingCount: z.number().int(),
  }).openapi("VulnerabilitySource");

  const ListResponse = strict({
    findings: z
      .array(Finding)
      .describe("Live findings: worst first, running before not running, then KEV, then CVSS."),
    totalCount: z.number().int(),
    counts: Counts,
    runningCounts: Counts.describe("Live findings whose artifact is running, per severity."),
    dismissed: z.array(DismissedFinding),
    dismissedCount: z.number().int(),
    sources: z.array(Source).describe("Every account whose plugin can report findings."),
    kevUpdatedAt: IsoDateTime.nullable(),
    generatedAt: IsoDateTime,
  }).openapi("VulnerabilityListResponse");

  const DismissalCreate = strict({
    advisoryId: z.string(),
    artifactKey: z.string().describe("A finding's `artifact.key`, or `*` for every artifact."),
    reason: z.string().max(500).nullable().optional(),
  }).openapi("VulnerabilityDismissalCreate");

  const Settings = strict({
    alertsEnabled: z.boolean(),
    minSeverity: z.enum(["critical", "high"]).openapi({
      description: "Lowest severity that alerts. CISA KEV-listed findings alert regardless.",
    }),
    runningOnly: z.boolean().openapi({
      description: "Only alert on findings whose artifact is running somewhere.",
    }),
    lastNotifiedAt: IsoDateTime.nullable().openapi({
      description: "When the alert scan last ran. Owned by the poller; not writable.",
    }),
  }).openapi("VulnerabilitySettings");

  const SettingsUpdate = strict({
    alertsEnabled: z.boolean().optional(),
    minSeverity: z.enum(["critical", "high"]).optional(),
    runningOnly: z.boolean().optional(),
  }).openapi("VulnerabilitySettingsUpdate");

  const tags = ["Vulnerabilities"];

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/vulnerabilities",
    tags,
    summary: "List vulnerability findings joined to running resources",
    description:
      "Open findings from each connected provider's own scanner (Amazon Inspector, Artifact " +
      "Analysis, Defender for Cloud, Dependabot, GitLab, JFrog Xray), joined to the synced " +
      "resources that run the affected image or are the affected resource, and marked when " +
      "the advisory is in the CISA Known Exploited Vulnerabilities catalog. Read from what the " +
      "poller last collected; no provider calls are made. Dismissed findings are reported " +
      "under `dismissed` and excluded from `findings`, the counts and the alerts.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "The vulnerability feed",
        content: { "application/json": { schema: ListResponse } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/vulnerabilities/dismissals",
    tags,
    summary: "Dismiss a vulnerability",
    description:
      "Accept an advisory as a known risk for one artifact (keyed on the image repository, so " +
      'it survives rebuilds) or, with `artifactKey: "*"`, everywhere. Idempotent.',
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: DismissalCreate } } },
    },
    responses: {
      200: {
        description: "The recorded dismissal",
        content: { "application/json": { schema: Dismissal } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/vulnerabilities/dismissals",
    tags,
    summary: "Restore a dismissed vulnerability",
    description: "The key is in the query string because artifact keys contain slashes.",
    request: {
      params: OrgIdParam,
      query: strict({ advisoryId: z.string(), artifactKey: z.string() }),
    },
    responses: {
      204: { description: "The dismissal was removed" },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/vulnerabilities/settings",
    tags,
    summary: "Get the vulnerability alert settings",
    description: "Defaults when never saved: alerts on, critical only, running only.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Vulnerability alert settings",
        content: { "application/json": { schema: Settings } },
      },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/vulnerabilities/settings",
    tags,
    summary: "Update the vulnerability alert settings",
    description: "Saving never resets the alert cooldown.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: SettingsUpdate } } },
    },
    responses: {
      200: {
        description: "The updated settings",
        content: { "application/json": { schema: Settings } },
      },
      400: ErrorResponses[400],
    },
  });
}
