/**
 * Telling people, and systems, about new leaks.
 *
 * People: one routed alert per scan batch under the `leakedSecretAlerts`
 * trigger (critical by default, so it pages through the same rules as any
 * critical alert and reaches phones), never one per finding, because the
 * first scan of a busy organization can turn up dozens. The rows are claimed
 * through `notified_at` first and released when nobody was reached
 * (`alertReached`), so a later scan retries rather than going quiet.
 *
 * Systems: one `secret.leaked` event per leak, idempotent per leak, raised
 * whether or not any rule took the alert. Neither carries the secret or its
 * hint.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  SECRET_LEAKED,
  leakLocationLabel,
  leakSeverity,
  type LeakedSecret,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { leakedSecrets } from "../db/schema";
import { alertReached, routeAlert } from "../alerts/route";
import { orgAppUrl } from "../app-url";
import { publishEvent } from "../events/publish";
import { toLeakedSecrets } from "./store";

function describe(leak: LeakedSecret): string {
  const where = leakLocationLabel(leak) || leak.scannerAccountName;
  const target =
    leak.matchKind === "account" && leak.matchedAccountName
      ? ` (account ${leak.matchedAccountName}${leak.matchConfidence === "token-type" ? ", by token type" : ""})`
      : (leak.matchKind === "output" || leak.matchKind === "secret-field") &&
          leak.matchedResourceName
        ? ` (stored on ${leak.matchedResourceName})`
        : "";
  return `${leak.tokenTypeLabel} in ${where}${target}`;
}

export function formatLeakAlert(leaks: readonly LeakedSecret[]): {
  title: string;
  body: string;
  pushBody: string;
} {
  const matched = leaks.filter((l) => l.matchKind !== "none").length;
  const title =
    leaks.length === 1
      ? `Leaked credential: ${leaks[0]!.tokenTypeLabel}`
      : `${leaks.length} leaked credentials found`;
  const lines = leaks.slice(0, 10).map((l) => `• ${describe(l)}`);
  if (leaks.length > 10) lines.push(`• and ${leaks.length - 10} more`);
  const tail =
    matched > 0
      ? `${matched} ${matched === 1 ? "matches a credential" : "match credentials"} Infrawrench holds and can be rotated from the Posture tab.`
      : "None match a credential Infrawrench holds; rotate them at the provider.";
  return {
    title,
    body: `${lines.join("\n")}\n\n${tail}`,
    pushBody: leaks.length === 1 ? describe(leaks[0]!) : `${leaks.length} found. ${tail}`,
  };
}

export async function notifyNewLeaks(
  organizationId: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  try {
    const all = await toLeakedSecrets(
      await db
        .select()
        .from(leakedSecrets)
        .where(inArray(leakedSecrets.id, [...ids])),
    );
    const url = orgAppUrl(organizationId, "posture");
    for (const leak of all) {
      await publishEvent(
        SECRET_LEAKED,
        organizationId,
        {
          leakId: leak.id,
          tokenType: leak.tokenType,
          tokenTypeLabel: leak.tokenTypeLabel,
          ownerPluginId: leak.ownerPluginId,
          matchKind: leak.matchKind,
          matchedAccountId: leak.matchedAccountId,
          matchedResourceId: leak.matchedResourceId,
          scannerPluginId: leak.scannerPluginId,
          scannerAccountId: leak.scannerAccountId,
          matchConfidence: leak.matchConfidence,
          repository: leak.repository,
          path: leak.path,
          url: leak.url,
          validity: leak.validity,
          publiclyLeaked: leak.publiclyLeaked,
          detectedAt: leak.detectedAt,
        },
        {
          title: `Leaked credential: ${leak.tokenTypeLabel}`,
          severity: leakSeverity(leak) === "critical" ? "critical" : "warning",
          ...(leak.matchedAccountId ? { accountId: leak.matchedAccountId } : {}),
          url: leak.url ?? url,
          idempotencyKey: `leaked-secret:${leak.id}`,
        },
      );
    }

    // Claim what has not been announced yet.
    const now = new Date();
    const claimed = await db
      .update(leakedSecrets)
      .set({ notifiedAt: now })
      .where(
        and(
          inArray(leakedSecrets.id, [...ids]),
          eq(leakedSecrets.status, "open"),
          isNull(leakedSecrets.notifiedAt),
        ),
      )
      .returning({ id: leakedSecrets.id });
    if (claimed.length === 0) return;
    const claimedIds = new Set(claimed.map((c) => c.id));
    const leaks = all.filter((l) => claimedIds.has(l.id));
    const { title, body, pushBody } = formatLeakAlert(leaks);
    const single = leaks.length === 1 ? leaks[0]! : null;
    const routed = await routeAlert({
      organizationId,
      trigger: "leakedSecretAlerts",
      severity: leaks.some((l) => leakSeverity(l) === "critical") ? "critical" : "warning",
      title,
      body,
      pushBody,
      context: "Leaked credentials",
      url,
      pushData: {
        type: "leaked_secret",
        orgId: organizationId,
        ...(single ? { leakId: single.id } : {}),
      },
      facts: {
        ...(single?.matchedAccountId ? { accountId: single.matchedAccountId } : {}),
        ...(single?.ownerPluginId ? { pluginId: single.ownerPluginId } : {}),
        ...(single ? { key: single.tokenType } : {}),
      },
    });
    if (!alertReached(routed)) {
      await db
        .update(leakedSecrets)
        .set({ notifiedAt: null })
        .where(inArray(leakedSecrets.id, [...claimedIds]));
    }
  } catch (err) {
    console.error(
      "[leaked-secrets] notifying new leaks failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Retry the alert for leaks a previous scan could not deliver. */
export async function retryUnnotifiedLeaks(organizationId: string): Promise<void> {
  const rows = await db
    .select({ id: leakedSecrets.id })
    .from(leakedSecrets)
    .where(
      and(
        eq(leakedSecrets.organizationId, organizationId),
        eq(leakedSecrets.status, "open"),
        isNull(leakedSecrets.notifiedAt),
      ),
    )
    .limit(50);
  await notifyNewLeaks(
    organizationId,
    rows.map((r) => r.id),
  );
}
