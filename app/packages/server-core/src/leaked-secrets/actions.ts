/**
 * Closing the loop on a leak: rotate it, record the rotation, and close the
 * finding on the scanner.
 *
 * Rotation goes through the plugin capabilities the resource reroll already
 * uses, never anything provider-specific here:
 *
 * - `reissue`: `rerollOutput` on the resource that issues the value. The
 *   output references that consume it are then reconciled at once (the same
 *   `reconcileAccountReferences` the poller runs every cycle), so every
 *   consumer gets the new value pushed to its provider.
 * - `replace`: the user supplies the new value; `applySecretReroll` pushes it
 *   upstream when the plugin has it, then the literal is stored.
 * - `account` / `manual`: rotated at the provider; recorded by hand, or
 *   detected by the scan when the stored credential's fingerprint changes.
 *
 * Every recorded rotation is verified where it can be: when the leak matched
 * by fingerprint and the stored value still fingerprints the same afterwards,
 * the rotation is refused rather than recorded, because a plugin that returned
 * without changing anything would otherwise close a live leak.
 */
import { and, eq } from "drizzle-orm";
import {
  SECRET_ROTATED,
  type LeakDismissReason,
  type LeakRotationMethod,
  type LeakedSecret,
} from "@infrawrench/client-core";
import type { LeakedSecretResolutionReason } from "@infrawrench/plugin-base";
import { db } from "../db/client";
import { leakedSecrets } from "../db/schema";
import { getOrgAccountClient } from "../org-accounts";
import { loadPlugins } from "../plugin-loader";
import { setLiteralSecretState } from "../secret-states";
import { reconcileAccountReferences } from "../sync-resources";
import { publishEvent } from "../events/publish";
import { consumerAccountsOf, currentTargetFingerprint } from "./fingerprints";
import { getLeakRow, rotationFor, toLeakedSecrets, type LeakedSecretRow } from "./store";

export class LeakedSecretError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 502 = 400,
  ) {
    super(message);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function mustGet(organizationId: string, id: string): Promise<LeakedSecretRow> {
  const row = await getLeakRow(organizationId, id);
  if (!row) throw new LeakedSecretError("Leaked secret not found", 404);
  return row;
}

async function view(row: LeakedSecretRow): Promise<LeakedSecret> {
  return (await toLeakedSecrets([row]))[0]!;
}

/**
 * Close the finding on the scanner. Never throws: a scanner that refuses
 * (missing write permission, a deleted repository) leaves the error on the
 * row for the UI to show, and the rotation stands either way.
 */
export async function resolveUpstream(
  row: LeakedSecretRow,
  reason: LeakedSecretResolutionReason,
  comment: string,
): Promise<LeakedSecretRow> {
  let patch: Partial<LeakedSecretRow>;
  try {
    const resolved = await getOrgAccountClient(row.scannerAccountId, row.organizationId);
    if (!resolved) throw new Error("The scanner account is gone");
    if (
      !resolved.plugin.manifest.secretScanning?.canResolve ||
      !resolved.client.resolveLeakedSecret
    ) {
      throw new Error("This scanner cannot close findings from Infrawrench");
    }
    await resolved.client.resolveLeakedSecret(row.externalRef, { reason, comment });
    patch = {
      upstreamResolvedAt: new Date(),
      upstreamResolveError: null,
      upstreamState: "resolved",
      upstreamResolution: reason,
    };
  } catch (err) {
    console.error(`[leaked-secrets] closing ${row.id} upstream failed:`, errorMessage(err));
    patch = { upstreamResolveError: errorMessage(err).slice(0, 500) };
  }
  const [updated] = await db
    .update(leakedSecrets)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(leakedSecrets.id, row.id))
    .returning();
  return updated ?? row;
}

/**
 * Mark a leak rotated (conditionally, so two replicas or two clicks record it
 * once), publish `secret.rotated`, and close it upstream when asked and able.
 * Returns null when the row was no longer open.
 */
export async function recordRotation(
  row: LeakedSecretRow,
  method: LeakRotationMethod,
  actor: { userId: string | null; userLabel?: string | null },
  options: { resolveUpstream: boolean },
): Promise<LeakedSecretRow | null> {
  const now = new Date();
  const [claimed] = await db
    .update(leakedSecrets)
    .set({
      status: "rotated",
      rotatedAt: now,
      rotatedByUserId: actor.userId,
      rotationMethod: method,
      updatedAt: now,
    })
    .where(and(eq(leakedSecrets.id, row.id), eq(leakedSecrets.status, "open")))
    .returning();
  if (!claimed) return null;

  let final = claimed;
  const plugins = await loadPlugins();
  const scanner = plugins.find((p) => p.plugin.manifest.id === row.scannerPluginId)?.plugin;
  if (options.resolveUpstream && scanner?.manifest.secretScanning?.canResolve) {
    final = await resolveUpstream(claimed, "revoked", "Rotated in Infrawrench.");
  }

  const leak = (await toLeakedSecrets([final]))[0]!;
  await publishEvent(
    SECRET_ROTATED,
    row.organizationId,
    {
      leakId: leak.id,
      tokenType: leak.tokenType,
      tokenTypeLabel: leak.tokenTypeLabel,
      ownerPluginId: leak.ownerPluginId,
      matchKind: leak.matchKind,
      matchedAccountId: leak.matchedAccountId,
      matchedResourceId: leak.matchedResourceId,
      method,
      rotatedBy: actor.userLabel ?? leak.rotatedBy,
      upstreamResolved: final.upstreamResolvedAt != null,
    },
    {
      title: `Leaked ${leak.tokenTypeLabel} rotated`,
      ...(leak.matchedAccountId ? { accountId: leak.matchedAccountId } : {}),
      url: leak.url,
      idempotencyKey: `leaked-secret:${leak.id}:rotated:${now.getTime()}`,
    },
  );
  return final;
}

/** Fail when the stored value still fingerprints as the leaked one. */
async function assertChanged(row: LeakedSecretRow): Promise<void> {
  if (row.matchConfidence !== "fingerprint" || !row.fingerprint) return;
  const current = await currentTargetFingerprint(row.organizationId, row);
  if (current && current === row.fingerprint) {
    throw new LeakedSecretError(
      "The stored value is still the leaked one. Nothing was rotated.",
      409,
    );
  }
}

export interface RotateLeakInput {
  value?: string | undefined;
  resolveUpstream?: boolean | undefined;
}

/** `POST /leaked-secrets/:id/rotate`: the one-click rotation. */
export async function rotateLeak(
  organizationId: string,
  id: string,
  input: RotateLeakInput,
  actor: { userId: string | null; userLabel?: string | null },
): Promise<LeakedSecret> {
  const row = await mustGet(organizationId, id);
  if (row.status !== "open") throw new LeakedSecretError("This leak is not open", 409);
  const plugins = await loadPlugins();
  const { mode } = rotationFor(row, plugins);
  if (mode !== "reissue" && mode !== "replace") {
    throw new LeakedSecretError(
      "Infrawrench cannot rotate this one itself. Rotate it at the provider, then mark it rotated.",
    );
  }
  if (!row.matchedAccountId || !row.matchedResourceId || !row.matchedFieldKey) {
    throw new LeakedSecretError("The leak no longer points at a stored secret", 409);
  }
  const resolved = await getOrgAccountClient(row.matchedAccountId, organizationId);
  if (!resolved) throw new LeakedSecretError("The matched account is gone", 409);
  const { client } = resolved;
  const typeId = row.matchedResourceTypeId ?? "";

  let method: LeakRotationMethod;
  if (mode === "reissue") {
    if (!client.rerollOutput) {
      throw new LeakedSecretError(
        "This provider cannot reissue that value. Paste a new one instead.",
      );
    }
    try {
      await client.rerollOutput(
        typeId,
        row.matchedResourceId,
        row.matchedFieldKey,
        row.matchedAccountId,
      );
    } catch (err) {
      throw new LeakedSecretError(`The provider refused the reissue: ${errorMessage(err)}`, 502);
    }
    if (row.matchKind === "output") {
      // Push the new value to every consumer now rather than on the next sync
      // cycle, so the stored caches move and the rotation verifies.
      for (const accountId of await consumerAccountsOf(organizationId, row.matchedResourceId)) {
        await reconcileAccountReferences(accountId, organizationId).catch((err) =>
          console.error(`[leaked-secrets] reconcile after reissue failed:`, errorMessage(err)),
        );
      }
    }
    method = "reissued";
  } else {
    const value = input.value?.trim();
    if (!value) throw new LeakedSecretError("Paste the new value to store");
    try {
      if (client.applySecretReroll) {
        await client.applySecretReroll(
          typeId,
          row.matchedResourceId,
          row.matchedAccountId,
          row.matchedFieldKey,
          value,
        );
      }
    } catch (err) {
      throw new LeakedSecretError(`The provider refused the new value: ${errorMessage(err)}`, 502);
    }
    await setLiteralSecretState(row.matchedResourceId, row.matchedFieldKey, value);
    method = "replaced";
  }

  await assertChanged(row);
  const recorded = await recordRotation(row, method, actor, {
    resolveUpstream: input.resolveUpstream ?? true,
  });
  return view(recorded ?? (await mustGet(organizationId, id)));
}

/** `POST /leaked-secrets/:id/mark-rotated`: rotated at the provider. */
export async function markLeakRotated(
  organizationId: string,
  id: string,
  input: { resolveUpstream?: boolean | undefined },
  actor: { userId: string | null; userLabel?: string | null },
): Promise<LeakedSecret> {
  const row = await mustGet(organizationId, id);
  if (row.status !== "open") throw new LeakedSecretError("This leak is not open", 409);
  // An account credential is rotated at the provider and then updated here;
  // marking it before the update would leave the leaked token in the account.
  if (row.matchKind === "account") await assertChanged(row);
  const recorded = await recordRotation(row, "manual", actor, {
    resolveUpstream: input.resolveUpstream ?? true,
  });
  return view(recorded ?? (await mustGet(organizationId, id)));
}

const DISMISS_TO_UPSTREAM: Record<LeakDismissReason, LeakedSecretResolutionReason> = {
  "false-positive": "false-positive",
  "used-in-tests": "used-in-tests",
  "wont-fix": "wont-fix",
};

/** `POST /leaked-secrets/:id/dismiss`. */
export async function dismissLeak(
  organizationId: string,
  id: string,
  input: {
    reason: LeakDismissReason;
    comment?: string | undefined;
    resolveUpstream?: boolean | undefined;
  },
  actor: { userId: string | null },
): Promise<LeakedSecret> {
  const row = await mustGet(organizationId, id);
  if (row.status !== "open") throw new LeakedSecretError("This leak is not open", 409);
  const comment = input.comment?.trim().slice(0, 500) || null;
  const now = new Date();
  const [updated] = await db
    .update(leakedSecrets)
    .set({
      status: "dismissed",
      dismissedReason: input.reason,
      dismissedComment: comment,
      dismissedAt: now,
      dismissedByUserId: actor.userId,
      updatedAt: now,
    })
    .where(and(eq(leakedSecrets.id, row.id), eq(leakedSecrets.status, "open")))
    .returning();
  if (!updated) throw new LeakedSecretError("This leak is not open", 409);
  let final = updated;
  if (input.resolveUpstream ?? true) {
    const plugins = await loadPlugins();
    const scanner = plugins.find((p) => p.plugin.manifest.id === row.scannerPluginId)?.plugin;
    if (scanner?.manifest.secretScanning?.canResolve) {
      final = await resolveUpstream(
        updated,
        DISMISS_TO_UPSTREAM[input.reason],
        comment ?? "Dismissed in Infrawrench.",
      );
    }
  }
  return view(final);
}

/** `POST /leaked-secrets/:id/reopen`: undo a dismissal or a rotation recorded by mistake. */
export async function reopenLeak(organizationId: string, id: string): Promise<LeakedSecret> {
  const row = await mustGet(organizationId, id);
  if (row.status === "open") return view(row);
  const [updated] = await db
    .update(leakedSecrets)
    .set({
      status: "open",
      rotatedAt: null,
      rotatedByUserId: null,
      rotationMethod: null,
      dismissedReason: null,
      dismissedComment: null,
      dismissedAt: null,
      dismissedByUserId: null,
      updatedAt: new Date(),
    })
    .where(eq(leakedSecrets.id, row.id))
    .returning();
  return view(updated ?? row);
}
