/**
 * The org's vulnerability feed: stored scanner findings joined to the synced
 * resources running them, with dismissals and the CISA KEV catalog applied.
 * Every surface (web API, MCP-style readers, the alert pass, the scorecard and
 * compliance helpers) reads this one function; the join itself is the pure
 * `computeVulnerabilityFeed` in client-core.
 *
 * A read over Postgres only: plugin manifests come from `loadPlugins()`, which
 * on the edge is the metadata-only registry, so this runs on either runtime.
 */
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import {
  computeVulnerabilityFeed,
  openVulnerabilitiesByResource,
  type ResourceVulnerabilitySummary,
  type StoredVulnerabilityFinding,
  type VulnerabilityListResponse,
  type VulnerabilitySeverity,
  type VulnerabilitySource,
} from "@infrawrench/client-core";
import type { VulnerabilityArtifactKind } from "@infrawrench/plugin-base";
import { db } from "../db/client";
import {
  accountVulnerabilityFindings,
  accountVulnerabilityPolls,
  accounts,
  resources,
} from "../db/schema";
import { loadPlugins } from "../plugin-loader";
import { listVulnerabilityDismissals } from "./dismissals";
import { loadKevCatalog } from "./kev";

export interface ListVulnerabilitiesOptions {
  now?: number;
}

const SEVERITIES = new Set<VulnerabilitySeverity>(["critical", "high", "medium", "low", "unknown"]);
const KINDS = new Set<VulnerabilityArtifactKind>([
  "image",
  "function",
  "host",
  "repository",
  "package",
]);

/** Load and join everything for one org. */
export async function listVulnerabilities(
  organizationId: string,
  opts: ListVulnerabilitiesOptions = {},
): Promise<VulnerabilityListResponse> {
  const [plugins, orgAccounts, rows, polls, dismissals, kev] = await Promise.all([
    loadPlugins(),
    db
      .select({ id: accounts.id, displayName: accounts.displayName, pluginId: accounts.pluginId })
      .from(accounts)
      .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt))),
    db
      .select()
      .from(accountVulnerabilityFindings)
      .where(eq(accountVulnerabilityFindings.organizationId, organizationId)),
    db
      .select()
      .from(accountVulnerabilityPolls)
      .where(eq(accountVulnerabilityPolls.organizationId, organizationId)),
    listVulnerabilityDismissals(organizationId),
    loadKevCatalog(),
  ]);

  const liveAccounts = new Map(orgAccounts.map((a) => [a.id, a]));
  // Findings of a soft-deleted account must not outlive it (the quota feed's
  // stance): the FK cascade only fires on a hard delete.
  const findings: StoredVulnerabilityFinding[] = rows
    .filter((r) => liveAccounts.has(r.accountId))
    .map((r) => ({
      accountId: r.accountId,
      pluginId: r.pluginId,
      findingId: r.findingId,
      advisoryId: r.advisoryId,
      aliases: r.aliases,
      title: r.title,
      severity: SEVERITIES.has(r.severity as VulnerabilitySeverity)
        ? (r.severity as VulnerabilitySeverity)
        : "unknown",
      cvssScore: r.cvssScore,
      cvssVector: r.cvssVector,
      packageName: r.packageName,
      packageEcosystem: r.packageEcosystem,
      installedVersion: r.installedVersion,
      fixedVersion: r.fixedVersion,
      fixAvailable: r.fixAvailable,
      exploitAvailable: r.exploitAvailable,
      artifactKind: KINDS.has(r.artifactKind as VulnerabilityArtifactKind)
        ? (r.artifactKind as VulnerabilityArtifactKind)
        : "package",
      artifactName: r.artifactName,
      artifactDigest: r.artifactDigest,
      artifactTags: r.artifactTags,
      artifactResourceId: r.artifactResourceId,
      artifactUrl: r.artifactUrl,
      firstSeenAt: r.firstSeenAt?.toISOString() ?? null,
      lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
      url: r.url,
      collectedAt: r.collectedAt.toISOString(),
    }));

  // Only the resources that could join: instances of a type declaring
  // `runningImages`, and any a finding names by id. Reading the whole
  // resource table for a feature that touches a few types would be the
  // expensive half of this read for no reason.
  const runningTypeIds = new Set<string>();
  for (const { plugin } of plugins) {
    for (const t of plugin.resourceTypes) if (t.runningImages) runningTypeIds.add(t.id);
  }
  const namedIds = [
    ...new Set(findings.map((f) => f.artifactResourceId).filter((x): x is string => !!x)),
  ];
  const joinConditions = [
    runningTypeIds.size > 0 ? inArray(resources.resourceTypeId, [...runningTypeIds]) : undefined,
    namedIds.length > 0 ? inArray(resources.externalId, namedIds) : undefined,
    namedIds.length > 0 ? inArray(resources.id, namedIds) : undefined,
  ].filter((c) => c !== undefined);
  const orgResources =
    findings.length === 0 || joinConditions.length === 0
      ? []
      : await db
          .select({
            id: resources.id,
            pluginId: resources.pluginId,
            resourceTypeId: resources.resourceTypeId,
            accountId: resources.accountId,
            displayName: resources.displayName,
            externalId: resources.externalId,
            fieldsJson: resources.fieldsJson,
          })
          .from(resources)
          .where(
            and(
              eq(resources.organizationId, organizationId),
              isNull(resources.deletedAt),
              or(...joinConditions),
            ),
          );

  const scanPlugins = plugins.map(({ plugin }) => ({
    id: plugin.manifest.id,
    displayName: plugin.manifest.displayName,
    vulnerabilities: plugin.manifest.vulnerabilities,
    resourceTypes: plugin.resourceTypes,
  }));
  const pluginById = new Map(scanPlugins.map((p) => [p.id, p]));

  const pollByAccount = new Map(polls.map((p) => [p.accountId, p]));
  const findingCounts = new Map<string, number>();
  for (const f of findings)
    findingCounts.set(f.accountId, (findingCounts.get(f.accountId) ?? 0) + 1);
  const sources: VulnerabilitySource[] = [];
  for (const a of orgAccounts) {
    const p = pluginById.get(a.pluginId);
    if (!p?.vulnerabilities) continue;
    const poll = pollByAccount.get(a.id);
    sources.push({
      accountId: a.id,
      accountName: a.displayName,
      pluginId: a.pluginId,
      pluginName: p.displayName,
      scanner: p.vulnerabilities.label,
      consoleUrl: p.vulnerabilities.consoleUrl ?? null,
      partial: p.vulnerabilities.partial ?? false,
      lastCollectedAt: poll?.lastPolledAt?.toISOString() ?? null,
      error: poll && poll.failureCount > 0 ? poll.lastError : null,
      helpLabel: poll && poll.failureCount > 0 ? poll.lastErrorHelpLabel : null,
      helpUrl: poll && poll.failureCount > 0 ? poll.lastErrorHelpUrl : null,
      findingCount: findingCounts.get(a.id) ?? 0,
    });
  }
  sources.sort(
    (x, y) =>
      x.pluginName.localeCompare(y.pluginName) || x.accountName.localeCompare(y.accountName),
  );

  return computeVulnerabilityFeed({
    plugins: scanPlugins,
    accounts: orgAccounts,
    resources: orgResources.map((r) => ({
      id: r.id,
      pluginId: r.pluginId,
      resourceTypeId: r.resourceTypeId,
      accountId: r.accountId,
      displayName: r.displayName,
      externalId: r.externalId,
      fields: r.fieldsJson,
    })),
    findings,
    dismissals,
    kev: kev.entries,
    kevUpdatedAt: kev.updatedAt,
    sources,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
}

/**
 * Open (undismissed) vulnerabilities per running resource, at or above
 * `minSeverity` (default `high`): the helper the service scorecard check and
 * compliance evidence call. Returns `resourceId → counts + advisory ids`;
 * resources with none are absent. See `openVulnerabilitiesByResource` in
 * client-core for the semantics.
 */
export async function listOpenVulnerabilitiesByResource(
  organizationId: string,
  options: { minSeverity?: VulnerabilitySeverity } = {},
): Promise<Map<string, ResourceVulnerabilitySummary>> {
  const feed = await listVulnerabilities(organizationId);
  return openVulnerabilitiesByResource(feed, options);
}
