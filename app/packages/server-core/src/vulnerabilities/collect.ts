/**
 * Collect one account's vulnerability findings from its provider's scanner.
 *
 * Parallel to `quotas/collect.ts`: the host owns scheduling, storage and the
 * join; the plugin owns the provider calls. The account's stored findings are
 * replaced by upsert-and-prune in one transaction, so a finding keeps its
 * `alerted_at` across scans and one the scanner stopped reporting (fixed,
 * suppressed at the provider, image deleted) disappears with it.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";

import {
  ListTruncatedError,
  normalizeVulnerabilityFindings,
  type VulnerabilityFinding,
} from "@infrawrench/plugin-base";

import { chunksOf } from "../db/chunks";
import { db } from "../db/client";
import {
  accountVulnerabilityFindings,
  accountVulnerabilityPolls,
  vulnerabilityResolutions,
} from "../db/schema";
import { renderableHelpLink, renderableHelpUrl } from "../help-links";
import { runListChecked } from "../runtime/request-scope";
import { loadAccountClient } from "../sync-resources";

export interface VulnerabilityCollectionResult {
  findingCount: number;
  droppedCount: number;
}

/**
 * Hard ceiling on stored findings per account. A runaway scanner must not fill the
 * table, and the upserts below run one statement per finding inside one transaction,
 * so the time that transaction stays open grows with this number. Raising it needs
 * those upserts batched first: a poller Lambda has 300 seconds, and at the few
 * milliseconds a round trip to the database takes, 50,000 of them already use most of it.
 */
export const MAX_FINDINGS_PER_ACCOUNT = 50_000;

const RESOLUTIONS_PER_STATEMENT = 500;

/**
 * The list as given, or a refusal when it is over the ceiling. Storing only part
 * of it would delete the stored findings past the cut, which reads as them being
 * fixed, so the account keeps what it last read and shows why instead.
 */
export function requireStorableFindings<T>(findings: T[], scanner: string): T[] {
  if (findings.length <= MAX_FINDINGS_PER_ACCOUNT) return findings;
  throw new ListTruncatedError({
    vendor: scanner,
    path: "vulnerability findings",
    items: findings.length,
    maxItems: MAX_FINDINGS_PER_ACCOUNT,
  });
}

function parseInstant(value: string | undefined): Date | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** Map one normalised finding onto the table's columns (minus ids and bookkeeping). */
export function findingColumns(f: VulnerabilityFinding) {
  return {
    advisoryId: f.advisoryId,
    aliases: f.aliases ?? [],
    title: f.title?.slice(0, 1000) ?? null,
    severity: f.severity,
    cvssScore: f.cvssScore ?? null,
    cvssVector: f.cvssVector ?? null,
    packageName: f.packageName ?? null,
    packageEcosystem: f.packageEcosystem ?? null,
    installedVersion: f.installedVersion ?? null,
    fixedVersion: f.fixedVersion ?? null,
    fixAvailable: f.fixAvailable ?? null,
    exploitAvailable: f.exploitAvailable ?? null,
    artifactKind: f.artifact.kind,
    artifactName: f.artifact.name,
    artifactDigest: f.artifact.digest ?? null,
    artifactTags: f.artifact.tags ?? [],
    artifactResourceId: f.artifact.resourceExternalId ?? null,
    // Plugin-supplied links are rendered as anchors: https only, the
    // `quotas/collect.ts` docsUrl boundary.
    artifactUrl: renderableHelpUrl(f.artifact.url),
    firstSeenAt: parseInstant(f.firstSeenAt),
    lastSeenAt: parseInstant(f.lastSeenAt),
    url: renderableHelpUrl(f.url),
  };
}

/**
 * Read the account's findings and replace the stored set. Throws on failure;
 * the poller's vulnerability pass owns backoff and the error write.
 */
export async function collectAccountVulnerabilities(
  accountId: string,
  organizationId: string,
): Promise<VulnerabilityCollectionResult> {
  const { account, plugin, client } = await loadAccountClient(accountId, organizationId);
  if (!plugin.manifest.vulnerabilities || !client.listVulnerabilityFindings) {
    throw new Error(`Plugin "${account.pluginId}" does not report vulnerability findings`);
  }

  const listFindings = client.listVulnerabilityFindings.bind(client);
  const raw = await runListChecked(() => listFindings(accountId));
  const findings = requireStorableFindings(
    normalizeVulnerabilityFindings(raw),
    plugin.manifest.vulnerabilities.label,
  );
  const collectedAt = new Date();

  await db.transaction(async (tx) => {
    for (const f of findings) {
      const values = {
        organizationId,
        accountId,
        pluginId: account.pluginId,
        findingId: f.id,
        ...findingColumns(f),
        collectedAt,
      };
      await tx
        .insert(accountVulnerabilityFindings)
        .values({ id: randomUUID(), ...values })
        .onConflictDoUpdate({
          target: [accountVulnerabilityFindings.accountId, accountVulnerabilityFindings.findingId],
          // `alertedAt` is deliberately not in the set: it is what makes the
          // alert fire once per finding rather than once per scan.
          set: values,
        });
    }
    const seen = new Set(findings.map((f) => f.id));
    const stored = await tx
      .select({ findingId: accountVulnerabilityFindings.findingId })
      .from(accountVulnerabilityFindings)
      .where(eq(accountVulnerabilityFindings.accountId, accountId));
    const gone = stored.map((row) => row.findingId).filter((id) => !seen.has(id));
    const pruned = [];
    for (const findingIds of chunksOf(gone)) {
      pruned.push(
        ...(await tx
          .delete(accountVulnerabilityFindings)
          .where(
            and(
              eq(accountVulnerabilityFindings.accountId, accountId),
              inArray(accountVulnerabilityFindings.findingId, findingIds),
            ),
          )
          .returning({
            findingId: accountVulnerabilityFindings.findingId,
            advisoryId: accountVulnerabilityFindings.advisoryId,
            severity: accountVulnerabilityFindings.severity,
            artifactKind: accountVulnerabilityFindings.artifactKind,
            artifactName: accountVulnerabilityFindings.artifactName,
            firstSeenAt: accountVulnerabilityFindings.firstSeenAt,
            createdAt: accountVulnerabilityFindings.createdAt,
          })),
      );
    }
    // The time-to-fix log. Only a read with nothing dropped may say a finding was
    // fixed: `normalizeVulnerabilityFindings` drops the ones it cannot use.
    if (pruned.length > 0 && raw.length === findings.length) {
      // Eleven parameters a row, so a large scan's worth would not fit in one statement.
      for (const batch of chunksOf(pruned, RESOLUTIONS_PER_STATEMENT)) {
        await tx.insert(vulnerabilityResolutions).values(
          batch.map((p) => ({
            id: randomUUID(),
            organizationId,
            accountId,
            pluginId: account.pluginId,
            findingId: p.findingId,
            advisoryId: p.advisoryId,
            severity: p.severity,
            artifactKind: p.artifactKind,
            artifactName: p.artifactName,
            firstSeenAt: p.firstSeenAt ?? p.createdAt,
            resolvedAt: collectedAt,
          })),
        );
      }
    }
  });

  return { findingCount: findings.length, droppedCount: raw.length - findings.length };
}

export async function markVulnerabilityPollSuccess(
  accountId: string,
  organizationId: string,
  nextPollAt: Date,
): Promise<void> {
  const values = {
    organizationId,
    lastPolledAt: new Date(),
    nextPollAt,
    failureCount: 0,
    lastError: null,
    lastErrorHelpLabel: null,
    lastErrorHelpUrl: null,
  };
  await db
    .insert(accountVulnerabilityPolls)
    .values({ accountId, ...values })
    .onConflictDoUpdate({ target: accountVulnerabilityPolls.accountId, set: values });
}

/**
 * Record a failure and back off. `VulnerabilityAccessError` is matched
 * structurally (plugins bundle their own plugin-base, so `instanceof` would
 * never match) and its link goes through `renderableHelpLink`: the
 * `markQuotaPollFailure` boundaries exactly.
 */
export async function markVulnerabilityPollFailure(
  accountId: string,
  organizationId: string,
  error: unknown,
  nextPollAt: Date,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const candidate = error as { name?: unknown; helpLabel?: unknown; helpUrl?: unknown } | null;
  const link =
    candidate?.name === "VulnerabilityAccessError"
      ? renderableHelpLink(candidate.helpLabel, candidate.helpUrl)
      : null;

  const [existing] = await db
    .select({ failureCount: accountVulnerabilityPolls.failureCount })
    .from(accountVulnerabilityPolls)
    .where(eq(accountVulnerabilityPolls.accountId, accountId))
    .limit(1);

  const values = {
    organizationId,
    nextPollAt,
    failureCount: (existing?.failureCount ?? 0) + 1,
    lastError: message.slice(0, 500),
    lastErrorHelpLabel: link?.label ?? null,
    lastErrorHelpUrl: link?.url ?? null,
  };
  await db
    .insert(accountVulnerabilityPolls)
    .values({ accountId, ...values })
    .onConflictDoUpdate({ target: accountVulnerabilityPolls.accountId, set: values });
}
