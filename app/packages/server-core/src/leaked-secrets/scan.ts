/**
 * Ingesting leaked secrets from scanner accounts (`manifest.secretScanning`).
 *
 * One scan reads the account's findings (`listLeakedSecrets`), fingerprints
 * each raw value in memory and drops it, attributes the finding (see
 * `match.ts`), and upserts it keyed by `(scanner account, ref)`. It then
 * re-checks the open leaks it already holds: a fingerprint-matched target
 * whose stored value no longer fingerprints the same was rotated somewhere
 * else (the account was edited, the reroll dialog was used), so it is
 * recorded as `detected` and closed upstream.
 *
 * The poller pass (`gateway`: it calls plugin code for arbitrary accounts)
 * claims due accounts with the `next_scan_at` lease, the `alerts/pass.ts`
 * idiom, so any number of replicas scan an account once. Never throws: every
 * failure is logged with the `[leaked-secrets]` prefix and kept on the scan
 * row, which the scanner list shows.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, lte } from "drizzle-orm";
import { leakedSecretHint } from "@infrawrench/client-core";
import type { LeakedSecretFinding } from "@infrawrench/plugin-base";
import { db } from "../db/client";
import { leakedSecretScans, leakedSecrets } from "../db/schema";
import { getOrgAccountClient } from "../org-accounts";
import { loadPlugins, type LoadedPlugin } from "../plugin-loader";
import {
  accountsByPlugin,
  buildStoredSecretIndex,
  currentTargetFingerprint,
  fingerprintSecret,
} from "./fingerprints";
import {
  indexTokenFormats,
  matchLeak,
  resolveTokenOwner,
  type StoredSecretIndex,
  type TokenFormatIndex,
} from "./match";
import { listScannerAccounts, type LeakedSecretRow } from "./store";
import { recordRotation } from "./actions";
import { retryUnnotifiedLeaks } from "./alerts";

/** How often a scanner account is read. Findings are not urgent to the minute; their rotation is. */
export const SCAN_INTERVAL_MS = 30 * 60_000;
/** Lease while a scan runs; a replica that dies mid-scan frees the account at expiry. */
const SCAN_LEASE_MS = 10 * 60_000;
/** Findings read per scan. Open findings come first in every scanner we have. */
const FINDINGS_LIMIT = 1000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Per-org context built once per scan batch: decrypting every credential twice would be waste. */
interface OrgContext {
  formats: TokenFormatIndex;
  index: StoredSecretIndex;
  accountsByPlugin: Map<string, string[]>;
}

async function orgContext(
  organizationId: string,
  plugins: readonly LoadedPlugin[],
): Promise<OrgContext> {
  const [index, byPlugin] = await Promise.all([
    buildStoredSecretIndex(organizationId, plugins),
    accountsByPlugin(organizationId),
  ]);
  return {
    formats: indexTokenFormats(plugins.map((p) => p.plugin)),
    index,
    accountsByPlugin: byPlugin,
  };
}

interface Attribution {
  fingerprint: string | null;
  secretHint: string | null;
  ownerPluginId: string | null;
  tokenFormatId: string | null;
  match: ReturnType<typeof matchLeak>;
}

async function attribute(
  organizationId: string,
  finding: Pick<LeakedSecretFinding, "tokenType" | "secret">,
  ctx: OrgContext,
  storedFingerprint: string | null = null,
): Promise<Attribution> {
  const secret = finding.secret?.trim() || undefined;
  const fingerprint = secret ? await fingerprintSecret(organizationId, secret) : storedFingerprint;
  const owner = resolveTokenOwner(ctx.formats, finding.tokenType, secret);
  return {
    fingerprint,
    secretHint: secret ? leakedSecretHint(secret) : null,
    ownerPluginId: owner?.pluginId ?? null,
    tokenFormatId: owner?.format.id ?? null,
    match: matchLeak({
      fingerprint,
      index: ctx.index,
      owner,
      accountsByPlugin: ctx.accountsByPlugin,
    }),
  };
}

export interface ScanResult {
  found: number;
  newLeakIds: string[];
  detectedRotations: number;
}

/** Scan one scanner account now. Throws on a scanner failure; the pass records it. */
export async function scanLeakedSecretAccount(
  organizationId: string,
  accountId: string,
  ctxCache?: Map<string, OrgContext>,
): Promise<ScanResult> {
  const plugins = await loadPlugins();
  const resolved = await getOrgAccountClient(accountId, organizationId);
  if (!resolved) throw new Error("Scanner account not found");
  const decl = resolved.plugin.manifest.secretScanning;
  if (!decl || !resolved.client.listLeakedSecrets) {
    throw new Error("This account's provider does not scan for secrets");
  }
  const page = await resolved.client.listLeakedSecrets({
    limit: FINDINGS_LIMIT,
    includeResolved: true,
  });

  let ctx = ctxCache?.get(organizationId);
  if (!ctx) {
    ctx = await orgContext(organizationId, plugins);
    ctxCache?.set(organizationId, ctx);
  }

  const existing = await db
    .select()
    .from(leakedSecrets)
    .where(eq(leakedSecrets.scannerAccountId, accountId));
  const byRef = new Map(existing.map((r) => [r.externalRef, r]));
  const now = new Date();
  const newLeakIds: string[] = [];

  for (const finding of page.findings) {
    const prior = byRef.get(finding.ref);
    const upstream = {
      upstreamState: finding.state,
      upstreamResolution: finding.resolution ?? null,
      upstreamUrl: finding.url ?? null,
      validity: finding.validity ?? null,
      publiclyLeaked: finding.publiclyLeaked ?? false,
      tokenTypeLabel: finding.tokenTypeLabel ?? null,
      repository: finding.location?.repository ?? null,
      path: finding.location?.path ?? null,
      line: finding.location?.line ?? null,
      commitSha: finding.location?.commitSha ?? null,
      lastSeenAt: now,
    };
    if (!prior) {
      // A finding that was already closed upstream before we ever saw it
      // is history, not news: store it resolved so the list is complete,
      // never alert on it.
      const a = await attribute(organizationId, finding, ctx);
      const id = randomUUID();
      const inserted = await db
        .insert(leakedSecrets)
        .values({
          id,
          organizationId,
          scannerAccountId: accountId,
          scannerPluginId: resolved.account.pluginId,
          externalRef: finding.ref,
          tokenType: finding.tokenType,
          ownerPluginId: a.ownerPluginId,
          tokenFormatId: a.tokenFormatId,
          fingerprint: a.fingerprint,
          secretHint: a.secretHint,
          detectedAt: new Date(finding.detectedAt),
          firstSeenAt: now,
          ...upstream,
          ...a.match,
          status: finding.state === "resolved" ? "resolved" : "open",
          // Pre-claimed so the alert never fires for history.
          notifiedAt: finding.state === "resolved" ? now : null,
        })
        .onConflictDoNothing()
        .returning({ id: leakedSecrets.id });
      if (inserted.length > 0 && finding.state === "open") newLeakIds.push(id);
      continue;
    }

    const patch: Partial<LeakedSecretRow> = { ...upstream, updatedAt: now };
    // Closed by someone on the scanner before it was rotated here. A row we
    // closed upstream ourselves keeps the status we gave it.
    if (finding.state === "resolved" && prior.status === "open" && !prior.upstreamResolvedAt) {
      patch.status = "resolved";
    }
    // Reopened on the scanner after it was closed there.
    if (finding.state === "open" && prior.status === "resolved") patch.status = "open";
    // Attribution is re-run for open leaks: an account connected since the
    // last scan may be the one it belongs to.
    if ((patch.status ?? prior.status) === "open") {
      const a = await attribute(organizationId, finding, ctx, prior.fingerprint);
      Object.assign(patch, a.match, {
        fingerprint: a.fingerprint,
        ownerPluginId: a.ownerPluginId,
        tokenFormatId: a.tokenFormatId,
        ...(a.secretHint ? { secretHint: a.secretHint } : {}),
      });
    }
    await db.update(leakedSecrets).set(patch).where(eq(leakedSecrets.id, prior.id));
  }

  const detectedRotations = await detectRotations(organizationId, accountId);
  return { found: page.findings.length, newLeakIds, detectedRotations };
}

/**
 * Record rotations done outside the leak screen: an open, fingerprint-matched
 * leak whose stored target now fingerprints differently (or is gone) was
 * replaced.
 */
async function detectRotations(organizationId: string, scannerAccountId: string): Promise<number> {
  const open = await db
    .select()
    .from(leakedSecrets)
    .where(
      and(
        eq(leakedSecrets.scannerAccountId, scannerAccountId),
        eq(leakedSecrets.status, "open"),
        eq(leakedSecrets.matchConfidence, "fingerprint"),
      ),
    );
  let detected = 0;
  for (const row of open) {
    if (!row.fingerprint) continue;
    const current = await currentTargetFingerprint(organizationId, row);
    if (current === row.fingerprint) continue;
    // Gone entirely (account deleted, field cleared) is not a rotation:
    // the token may still be live at the provider. Leave it open.
    if (current === null) continue;
    const recorded = await recordRotation(
      row,
      "detected",
      { userId: null },
      { resolveUpstream: true },
    );
    if (recorded) detected += 1;
  }
  return detected;
}

/** Insert a schedule row for every scanner account that lacks one, due now. */
async function ensureScanRows(plugins: readonly LoadedPlugin[]): Promise<void> {
  const scannerAccounts = await listScannerAccounts(null, plugins);
  if (scannerAccounts.length === 0) return;
  await db
    .insert(leakedSecretScans)
    .values(scannerAccounts.map((a) => ({ accountId: a.id, organizationId: a.organizationId })))
    .onConflictDoNothing();
}

async function finishScan(
  accountId: string,
  outcome: { count: number } | { error: string },
  nextAt: Date,
) {
  const now = new Date();
  await db
    .update(leakedSecretScans)
    .set(
      "error" in outcome
        ? { lastError: outcome.error.slice(0, 500), nextScanAt: nextAt, updatedAt: now }
        : {
            lastError: null,
            lastCount: outcome.count,
            lastScannedAt: now,
            nextScanAt: nextAt,
            updatedAt: now,
          },
    )
    .where(eq(leakedSecretScans.accountId, accountId));
}

async function scanAndNotify(
  rows: Array<{ accountId: string; organizationId: string }>,
): Promise<{ scanned: number; newLeaks: number; errors: number }> {
  const ctxCache = new Map<string, OrgContext>();
  const newByOrg = new Map<string, string[]>();
  let scanned = 0;
  let errors = 0;
  for (const row of rows) {
    try {
      const result = await scanLeakedSecretAccount(row.organizationId, row.accountId, ctxCache);
      await finishScan(
        row.accountId,
        { count: result.found },
        new Date(Date.now() + SCAN_INTERVAL_MS),
      );
      scanned += 1;
      if (result.newLeakIds.length > 0) {
        newByOrg.set(row.organizationId, [
          ...(newByOrg.get(row.organizationId) ?? []),
          ...result.newLeakIds,
        ]);
      }
    } catch (err) {
      errors += 1;
      console.error(`[leaked-secrets] scan of account ${row.accountId} failed:`, errorMessage(err));
      await finishScan(
        row.accountId,
        { error: errorMessage(err) },
        new Date(Date.now() + SCAN_INTERVAL_MS),
      ).catch(() => undefined);
    }
  }
  let newLeaks = 0;
  for (const ids of newByOrg.values()) newLeaks += ids.length;
  // Every org scanned, not only those with something new: a leak whose alert
  // reached nobody last time (no channel yet, every transport down) is still
  // unannounced and gets another try.
  for (const organizationId of new Set(rows.map((r) => r.organizationId))) {
    await retryUnnotifiedLeaks(organizationId);
  }
  return { scanned, newLeaks, errors };
}

/** The poller pass: claim up to `limit` due scanner accounts and scan each. */
export async function runLeakedSecretScanPass(
  options: { limit?: number } = {},
): Promise<{ scanned: number; newLeaks: number; errors: number }> {
  try {
    const plugins = await loadPlugins();
    await ensureScanRows(plugins);
    const now = new Date();
    const claimed = await db
      .update(leakedSecretScans)
      .set({ nextScanAt: new Date(now.getTime() + SCAN_LEASE_MS) })
      .where(
        inArray(
          leakedSecretScans.accountId,
          db
            .select({ id: leakedSecretScans.accountId })
            .from(leakedSecretScans)
            .where(lte(leakedSecretScans.nextScanAt, now))
            .orderBy(leakedSecretScans.nextScanAt)
            .limit(options.limit ?? 10)
            .for("update", { skipLocked: true }),
        ),
      )
      .returning({
        accountId: leakedSecretScans.accountId,
        organizationId: leakedSecretScans.organizationId,
      });
    if (claimed.length === 0) return { scanned: 0, newLeaks: 0, errors: 0 };
    return await scanAndNotify(claimed);
  } catch (err) {
    console.error("[leaked-secrets] scan pass failed:", errorMessage(err));
    return { scanned: 0, newLeaks: 0, errors: 1 };
  }
}

/** `POST /leaked-secrets/scan`: every scanner account in the org, now. */
export async function scanOrgLeakedSecretsNow(
  organizationId: string,
): Promise<{ scanned: number; newLeaks: number; errors: number }> {
  const plugins = await loadPlugins();
  await ensureScanRows(plugins);
  const lease = new Date(Date.now() + SCAN_LEASE_MS);
  const claimed = await db
    .update(leakedSecretScans)
    .set({ nextScanAt: lease })
    // No lease check: a scan racing one already running is harmless (inserts
    // are keyed by finding, rotations are conditional updates), and the
    // person who pressed the button wants an answer now.
    .where(eq(leakedSecretScans.organizationId, organizationId))
    .returning({
      accountId: leakedSecretScans.accountId,
      organizationId: leakedSecretScans.organizationId,
    });
  return scanAndNotify(claimed);
}
