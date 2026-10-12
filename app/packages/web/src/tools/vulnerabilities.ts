/**
 * Vulnerability tools: the MCP/chat view of the Vulnerabilities screen. The
 * feed is the stored scanner findings joined to the synced resources that run
 * them (server-core `vulnerabilities/feed.ts`); reading it makes no provider
 * calls, because the poller collects findings.
 *
 * Mirrors the posture tools (`list_posture_findings` and friends in
 * `./generic`) and the HTTP route (`api/routes/vulnerabilities.ts`): the same
 * permissions and the same audit actions, so a dismissal made through chat is
 * indistinguishable from one made in the UI except for its `source`.
 */
import { z } from "zod";
import {
  filterVulnerabilityFindings,
  type VulnerabilityFilter,
  type VulnerabilitySeverity,
} from "@infrawrench/client-core";
import { listVulnerabilities } from "@infrawrench/server-core/vulnerabilities/feed";
import {
  dismissVulnerability,
  MAX_VULNERABILITY_DISMISSAL_REASON_LENGTH,
  restoreVulnerability,
} from "@infrawrench/server-core/vulnerabilities/dismissals";
import { logAudit } from "../services/audit";
import { err, ok, type ToolDefinition } from "./types";

const SEVERITIES = ["critical", "high", "medium", "low", "unknown"] as const;

/** Default and ceiling for `limit`: a feed can hold thousands of rows. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export function vulnerabilityTools(): ToolDefinition[] {
  return [
    {
      name: "list_vulnerabilities",
      title: "List vulnerabilities",
      description:
        "Known vulnerabilities (CVEs and other advisories) reported by the scanners the " +
        "organization's connected providers run (container registries, cloud security " +
        "centers, code hosts, artifact scanners), each joined to the synced resources that " +
        "run the affected image, function or host right now. Ordered worst first: severity, " +
        "running before not running, then CISA Known Exploited Vulnerabilities (KEV), then " +
        "CVSS. Each finding has the package, installed and fixed versions, the artifact (with " +
        "the `artifact.key` a dismissal is keyed on), `running` (what runs it; empty means not " +
        "running anywhere synced), `services` (the services those resources belong to) and `kev` (non-null when actively exploited). `sources` lists " +
        "each scanning account with its last collection time and any collection error. " +
        "Purely a read over what the poller already collected; no provider API calls. Use it " +
        "to answer which exposed CVEs are actually deployed, which have a fix, and which are " +
        "being exploited in the wild. Findings dismissed as accepted risks are excluded " +
        "unless you ask for them.",
      inputSchema: {
        severity: z
          .array(z.enum(SEVERITIES))
          .optional()
          .describe(
            "Only return findings of these severities. `unknown` is a finding the scanner did not score.",
          ),
        running: z
          .boolean()
          .optional()
          .describe(
            "true: only findings whose artifact is running on a synced resource; false: only those that are not. Omit for both.",
          ),
        fixAvailable: z
          .boolean()
          .optional()
          .describe("true: only findings the scanner says have a fixed version."),
        kev: z
          .boolean()
          .optional()
          .describe("true: only findings in the CISA Known Exploited Vulnerabilities catalog."),
        pluginId: z
          .string()
          .optional()
          .describe("Only findings reported by this plugin (e.g. `aws`, `github`)."),
        accountId: z
          .string()
          .optional()
          .describe("Only findings reported by this connected account (see list_accounts)."),
        serviceId: z
          .string()
          .optional()
          .describe(
            "Only findings running on a resource of this service (an id from a finding's " +
              "`services`).",
          ),
        resourceId: z
          .string()
          .optional()
          .describe("Only findings running on this Infrawrench resource id."),
        search: z
          .string()
          .optional()
          .describe(
            "Case-insensitive substring over advisory id, aliases, package, artifact name and title.",
          ),
        includeDismissed: z
          .boolean()
          .optional()
          .describe(
            "Also return the findings the organization has dismissed (filtered the same way), " +
              "each with who accepted it, when, and why. They stay out of `findings` either way.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .optional()
          .describe(`Maximum findings to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
      },
      risk: "read",
      // Mirrors `GET /vulnerabilities`.
      permission: "resources:read",
      handler: async (input, auth) => {
        const filter: VulnerabilityFilter = {
          severities: input["severity"] as VulnerabilitySeverity[] | undefined,
          running: input["running"] as boolean | undefined,
          fixAvailable: input["fixAvailable"] === true ? true : undefined,
          kev: input["kev"] === true ? true : undefined,
          pluginId: input["pluginId"] as string | undefined,
          accountId: input["accountId"] as string | undefined,
          serviceId: input["serviceId"] as string | undefined,
          resourceIds: typeof input["resourceId"] === "string" ? [input["resourceId"]] : undefined,
          search: input["search"] as string | undefined,
        };
        const includeDismissed = input["includeDismissed"] === true;
        const limit = (input["limit"] as number | undefined) ?? DEFAULT_LIMIT;

        const feed = await listVulnerabilities(auth.organizationId, { withServices: true });
        const matched = filterVulnerabilityFindings(feed.findings, filter);
        // Counts always describe the whole feed so a filtered view still shows
        // the overall picture; matchedCount is the filtered length, before the cap.
        return ok({
          findings: matched.slice(0, limit),
          matchedCount: matched.length,
          truncated: matched.length > limit,
          totalCount: feed.totalCount,
          counts: feed.counts,
          runningCounts: feed.runningCounts,
          // Always reported as a number so a reader can tell "clean" from
          // "quiet because somebody silenced it"; the rows are opt-in.
          dismissedCount: feed.dismissedCount,
          ...(includeDismissed
            ? { dismissed: filterVulnerabilityFindings(feed.dismissed, filter).slice(0, limit) }
            : {}),
          sources: feed.sources,
          kevUpdatedAt: feed.kevUpdatedAt,
          generatedAt: feed.generatedAt,
        });
      },
    },

    {
      name: "dismiss_vulnerability",
      title: "Dismiss a vulnerability",
      description:
        "Accept a vulnerability as a known risk: it leaves the vulnerability list and stops " +
        "feeding vulnerability alerts. Use only when the user has said the risk is accepted " +
        "(not exploitable in their setup, mitigated elsewhere); this silences a security " +
        "warning. Scope it to one artifact with the finding's `artifact.key`, or pass `*` to " +
        "accept the advisory everywhere in the organization. A dismissal survives rebuilds of " +
        "the same image and re-scans, and is reversible with restore_vulnerability, so nothing " +
        "is destroyed.",
      inputSchema: {
        // `.min(1)` so a blank id is a tool-input error rather than the plain
        // `Error` `dismissVulnerability` throws past the handler: the HTTP
        // route guards this, and this second entry point has to as well.
        advisoryId: z
          .string()
          .trim()
          .min(1)
          .describe("The finding's `advisoryId`, e.g. CVE-2024-3094 or GHSA-…."),
        artifactKey: z
          .string()
          .trim()
          .min(1)
          .describe("The finding's `artifact.key`, or `*` for every artifact in the organization."),
        reason: z
          .string()
          .max(MAX_VULNERABILITY_DISMISSAL_REASON_LENGTH)
          .optional()
          .describe("Why this vulnerability is acceptable, recorded with the dismissal."),
      },
      risk: "write",
      // Mirrors `POST /vulnerabilities/dismissals`: the same trust level as
      // changing a resource, so members cannot silence what they can read.
      permission: "resources:write",
      handler: async (input, auth) => {
        const dismissal = await dismissVulnerability(auth.organizationId, {
          advisoryId: input["advisoryId"] as string,
          artifactKey: input["artifactKey"] as string,
          reason: (input["reason"] as string | undefined) ?? null,
          userId: auth.userId,
        });
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "vulnerability.dismissed",
          entityType: "vulnerability",
          entityId: dismissal.advisoryId,
          metadata: {
            artifactKey: dismissal.artifactKey,
            reason: dismissal.reason,
            source: auth.source,
          },
        });
        return ok({
          dismissed: {
            advisoryId: dismissal.advisoryId,
            artifactKey: dismissal.artifactKey,
            dismissedAt: dismissal.dismissedAt,
            dismissedBy: dismissal.dismissedBy,
            reason: dismissal.reason,
          },
        });
      },
    },

    {
      name: "restore_vulnerability",
      title: "Restore a dismissed vulnerability",
      description:
        "Undo a vulnerability dismissal; the finding returns to the vulnerability list and to " +
        "the alerts. Use when an accepted risk is no longer acceptable, or when it was " +
        "dismissed by mistake. Pass the same advisoryId and artifactKey (or `*`) the " +
        "dismissal was recorded with; list_vulnerabilities with includeDismissed shows them.",
      inputSchema: {
        advisoryId: z.string().trim().min(1).describe("The dismissed advisory id."),
        artifactKey: z
          .string()
          .trim()
          .min(1)
          .describe("The dismissal's artifact key, or `*` for an organization-wide dismissal."),
      },
      risk: "write",
      permission: "resources:write",
      handler: async (input, auth) => {
        const advisoryId = input["advisoryId"] as string;
        const artifactKey = input["artifactKey"] as string;
        const restored = await restoreVulnerability(auth.organizationId, advisoryId, artifactKey);
        if (!restored) return err("That vulnerability is not dismissed.");
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "vulnerability.restored",
          entityType: "vulnerability",
          entityId: advisoryId.trim().toUpperCase(),
          metadata: { artifactKey, source: auth.source },
        });
        return ok({ restored: { advisoryId: advisoryId.trim().toUpperCase(), artifactKey } });
      },
    },
  ];
}
