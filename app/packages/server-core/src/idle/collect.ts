/**
 * Collect metric-based idle findings for one account.
 *
 * The `quotas/collect.ts` shape: the host owns scheduling, storage and the
 * org's settings; the plugin owns the provider calls and the verdicts. The
 * plugin is handed the account's stored rows of every enabled rule's types,
 * so it never re-lists what the resource pass already synced, and the
 * resolved thresholds, so it never sees the settings table.
 *
 * The stored set is *replaced*: a resource that was idle yesterday and is
 * busy today must leave the savings list, which is why plugins throw rather
 * than return a short list. `first_detected_at` survives across collections
 * for a finding that stays, so "flagged since" means something.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import {
  normalizeIdleFindings,
  primitiveFields,
  type IdleScanRequest,
  type IdleScanResource,
} from "@infrawrench/plugin-base";

import { db } from "../db/client.js";
import { accountIdleFindings, accountIdlePolls, resources } from "../db/schema.js";
import { renderableHelpLink } from "../help-links.js";
import { loadAccountClient } from "../sync-resources.js";
import { getOrgIdleSettings, idleRuleRequests } from "./settings.js";

export interface IdleCollectionResult {
  /** Findings stored after normalisation. */
  findingCount: number;
  /** Findings the plugin returned that normalisation dropped. */
  droppedCount: number;
  /** False when the org or every rule is switched off: nothing was read. */
  ran: boolean;
}

/** String-valued resolved outputs (ARNs and the like), for plugins that address by them. */
function stringOutputs(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Read the account's idle verdicts and record them.
 *
 * Throws on failure: the caller (the poller's idle pass) owns backoff and the
 * error write, exactly as the quota pass does.
 */
export async function collectAccountIdleFindings(
  accountId: string,
  organizationId: string,
  now: Date = new Date(),
): Promise<IdleCollectionResult> {
  const { account, plugin, client } = await loadAccountClient(accountId, organizationId);
  const declaration = plugin.manifest.idleFindings;
  if (!declaration || !client.fetchIdleFindings) {
    throw new Error(`Plugin "${account.pluginId}" does not report idle findings`);
  }

  const settings = await getOrgIdleSettings(organizationId);
  const rules = idleRuleRequests(account.pluginId, declaration, settings);
  const enabledRuleIds = Object.keys(rules);

  if (enabledRuleIds.length === 0) {
    // Switched off: clear what was stored so the list stops showing it.
    await db.delete(accountIdleFindings).where(eq(accountIdleFindings.accountId, accountId));
    return { findingCount: 0, droppedCount: 0, ran: false };
  }

  const typeIds = [
    ...new Set(declaration.rules.filter((r) => rules[r.id]).flatMap((r) => r.resourceTypeIds)),
  ];
  const rows =
    typeIds.length === 0
      ? []
      : await db
          .select({
            id: resources.id,
            resourceTypeId: resources.resourceTypeId,
            externalId: resources.externalId,
            displayName: resources.displayName,
            fieldsJson: resources.fieldsJson,
            outputsJson: resources.outputsJson,
          })
          .from(resources)
          .where(
            and(
              eq(resources.accountId, accountId),
              inArray(resources.resourceTypeId, typeIds),
              isNull(resources.deletedAt),
            ),
          );

  const scanResources: IdleScanResource[] = rows.map((r) => ({
    id: r.id,
    resourceTypeId: r.resourceTypeId,
    externalId: r.externalId,
    displayName: r.displayName,
    fields: primitiveFields(r.fieldsJson),
    resolvedOutputs: stringOutputs(r.outputsJson),
  }));

  const request: IdleScanRequest = {
    lookbackDays: settings.lookbackDays,
    windowEnd: now.toISOString(),
    rules,
    resources: scanResources,
  };
  const raw = await client.fetchIdleFindings(accountId, request);
  const findings = normalizeIdleFindings(raw, request);

  await db.transaction(async (tx) => {
    for (const f of findings) {
      const values = {
        organizationId,
        accountId,
        pluginId: account.pluginId,
        ruleId: f.ruleId,
        subjectKey: f.subjectKey,
        resourceId: f.resourceId,
        resourceTypeId: f.resourceTypeId,
        displayName: f.displayName,
        subjectLabel: f.subjectLabel ?? null,
        reason: f.reason,
        evidence: f.evidence,
        estimate: f.estimate,
        fields: f.fields ?? {},
        lookbackDays: settings.lookbackDays,
        evaluatedAt: now,
      };
      await tx
        .insert(accountIdleFindings)
        .values({ id: randomUUID(), ...values, firstDetectedAt: now })
        .onConflictDoUpdate({
          target: [
            accountIdleFindings.accountId,
            accountIdleFindings.ruleId,
            accountIdleFindings.subjectKey,
          ],
          // `first_detected_at` deliberately not in the set: it is the
          // finding's age, kept for as long as the finding stays.
          set: values,
        });
    }
    // Everything this collection did not confirm is gone: a resource that got
    // busy, was deleted, or belongs to a rule that was switched off.
    await tx
      .delete(accountIdleFindings)
      .where(
        and(eq(accountIdleFindings.accountId, accountId), ne(accountIdleFindings.evaluatedAt, now)),
      );
  });

  return { findingCount: findings.length, droppedCount: raw.length - findings.length, ran: true };
}

/** Record a successful collection: clear the error, schedule the next read. */
export async function markIdlePollSuccess(
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
    .insert(accountIdlePolls)
    .values({ accountId, ...values })
    .onConflictDoUpdate({ target: accountIdlePolls.accountId, set: values });
}

/**
 * Record a failure and back off. An `IdleFindingAccessError` keeps its help
 * link (matched structurally: plugins bundle their own plugin-base, so
 * `instanceof` would never match), through `renderableHelpLink` so only
 * `https:` survives. The stored findings are left as they were: a failed read
 * is "could not tell", not "nothing is idle".
 */
export async function markIdlePollFailure(
  accountId: string,
  organizationId: string,
  error: unknown,
  nextPollAt: Date,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const candidate = error as { name?: unknown; helpLabel?: unknown; helpUrl?: unknown } | null;
  const link =
    candidate?.name === "IdleFindingAccessError"
      ? renderableHelpLink(candidate.helpLabel, candidate.helpUrl)
      : null;
  const [existing] = await db
    .select({ failureCount: accountIdlePolls.failureCount })
    .from(accountIdlePolls)
    .where(eq(accountIdlePolls.accountId, accountId))
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
    .insert(accountIdlePolls)
    .values({ accountId, ...values })
    .onConflictDoUpdate({ target: accountIdlePolls.accountId, set: values });
}
