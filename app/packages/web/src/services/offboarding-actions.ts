/**
 * The actions an offboarding checklist row can run, each through the same
 * code path its own surface uses: a principal's revoke through the plugin's
 * declared `invokeAction`, a removal through `deleteResource`, a seat through
 * the seat removal, a membership through the team page's removal (with its
 * owner guards), an on-call slot through the rotation store, a grant through
 * the just-in-time service. Nothing here talks to a provider on its own.
 *
 * The route (`http/domains/offboarding`) owns the permission check, the change
 * freeze and the audit row. A thrown {@link OffboardingActionRefused} is the
 * caller's mistake (an owner guard, a missing target) and becomes a 4xx; any
 * other failure is the provider or the record refusing, and the checklist
 * records it on the row as `failed` with the message.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { OffboardingActionId, OffboardingActionInput } from "@infrawrench/client-core";
import { getOrgAccountClient } from "@infrawrench/server-core/org-accounts";
import { removeSeatForOffboarding } from "@infrawrench/server-core/seats/remove";
import { upsertOwnership } from "@infrawrench/server-core/ownership/store";
import {
  deleteOnCallOverride,
  getOnCallSchedule,
  updateOnCallSchedule,
} from "@infrawrench/server-core/on-call/store";
import { cancelLeaseRecord } from "@infrawrench/server-core/leases/store";
import {
  JitAccessError,
  loadJitCaller,
  revokeJitRequest,
} from "@infrawrench/server-core/jit-access/service";
import { db } from "../db/client";
import { apiKeys, sshKeys } from "../db/schema";
import { logAudit } from "./audit";
import { countOwners, isMemberOwner, removeMembership } from "./membership";
import { releaseSeat } from "./seats";

/** A refusal that is the caller's to fix, mapped to a status by the route. */
export class OffboardingActionRefused extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409,
  ) {
    super(message);
    this.name = "OffboardingActionRefused";
  }
}

export interface OffboardingActionContext {
  organizationId: string;
  userId: string;
  permissions: readonly string[];
  /** The caller holds the owner role (only an owner may remove an owner). */
  callerIsOwner: boolean;
}

export interface OffboardingActionRow {
  kind: string;
  title: string;
  ref: Record<string, string>;
}

function need(ref: Record<string, string>, key: string): string {
  const value = ref[key];
  if (!value) throw new Error(`This row is missing its ${key}; rescan the offboarding.`);
  return value;
}

/** Run one action; resolves with the provider's message (or null). */
export async function runOffboardingAction(
  ctx: OffboardingActionContext,
  row: OffboardingActionRow,
  input: OffboardingActionInput,
): Promise<string | null> {
  const { organizationId } = ctx;
  const { ref } = row;
  const action: OffboardingActionId = input.action;

  switch (action) {
    case "revoke":
    case "remove": {
      const accountId = need(ref, "accountId");
      const resourceTypeId = need(ref, "resourceTypeId");
      const resourceId = need(ref, "resourceId");
      const account = await getOrgAccountClient(accountId, organizationId);
      if (!account) throw new Error("The account this belongs to is no longer connected.");
      if (action === "revoke") {
        const actionId = need(ref, "revokeActionId");
        if (!account.client.invokeAction) {
          throw new Error(`${account.plugin.manifest.displayName} does not support actions.`);
        }
        await account.client.invokeAction(resourceTypeId, resourceId, actionId, accountId);
      } else {
        if (!account.client.deleteResource) {
          throw new Error(`${account.plugin.manifest.displayName} does not support deletion.`);
        }
        await account.client.deleteResource(resourceTypeId, resourceId, accountId);
      }
      return null;
    }

    case "remove-seat": {
      const result = await removeSeatForOffboarding(
        organizationId,
        need(ref, "seatId"),
        ctx.userId,
      );
      await logAudit({
        organizationId,
        userId: ctx.userId,
        action: "seat.removed",
        entityType: "seat",
        entityId: result.seat.id,
        metadata: {
          accountId: result.seat.accountId,
          pluginId: result.seat.pluginId,
          product: result.seat.product,
          memberId: result.seat.memberId,
          effective: result.effective,
          via: "offboarding",
        },
      });
      return (
        result.message ??
        (result.effective === "end-of-cycle"
          ? "Removed. The provider bills it until the end of the cycle."
          : null)
      );
    }

    case "remove-member": {
      const userId = need(ref, "userId");
      if (userId === ctx.userId) {
        throw new OffboardingActionRefused("You can't remove yourself from here.", 409);
      }
      if (await isMemberOwner(organizationId, userId)) {
        if (!ctx.callerIsOwner) {
          throw new OffboardingActionRefused("Only an owner can remove another owner.", 403);
        }
        if ((await countOwners(organizationId)) <= 1) {
          throw new OffboardingActionRefused("Cannot remove the last owner.", 409);
        }
      }
      const revokedApiKeyIds = await removeMembership(organizationId, userId);
      await logAudit({
        organizationId,
        userId: ctx.userId,
        action: "member.remove",
        entityType: "member",
        entityId: userId,
        metadata: { revokedApiKeyIds, via: "offboarding" },
      });
      // Best-effort, as on the team page: the member is out either way.
      await releaseSeat(organizationId).catch((err: unknown) => {
        console.error(`[offboarding] releasing a seat for org ${organizationId} failed:`, err);
      });
      return revokedApiKeyIds.length > 0
        ? `Their ${revokedApiKeyIds.length} API key(s) were revoked with the membership.`
        : null;
    }

    case "revoke-api-key": {
      const apiKeyId = need(ref, "apiKeyId");
      await db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(apiKeys.id, apiKeyId),
            eq(apiKeys.organizationId, organizationId),
            isNull(apiKeys.revokedAt),
          ),
        );
      await logAudit({
        organizationId,
        userId: ctx.userId,
        action: "api_key.revoke",
        entityType: "api_key",
        entityId: apiKeyId,
        metadata: { via: "offboarding" },
      });
      return null;
    }

    case "delete-ssh-key": {
      const sshKeyId = need(ref, "sshKeyId");
      await db
        .delete(sshKeys)
        .where(and(eq(sshKeys.id, sshKeyId), eq(sshKeys.organizationId, organizationId)));
      await logAudit({
        organizationId,
        userId: ctx.userId,
        action: "ssh_key.delete",
        entityType: "ssh_key",
        entityId: sshKeyId,
        metadata: { via: "offboarding" },
      });
      return null;
    }

    case "transfer-ownership": {
      const target = input.targetUserId;
      if (!target) throw new OffboardingActionRefused("Choose who takes it over.", 400);
      await upsertOwnership(
        organizationId,
        { resourceId: need(ref, "resourceId"), ownerUserId: target },
        ctx.userId,
      );
      return null;
    }

    case "reassign-on-call":
    case "remove-from-rotation": {
      const scheduleId = need(ref, "scheduleId");
      const leaving = need(ref, "userId");
      const schedule = await getOnCallSchedule(organizationId, scheduleId);
      if (!schedule) throw new Error("The rotation no longer exists.");
      const target = action === "reassign-on-call" ? input.targetUserId : null;
      if (action === "reassign-on-call" && !target) {
        throw new OffboardingActionRefused("Choose who takes their place.", 400);
      }
      const current = schedule.participants.map((p) => p.userId);
      if (!current.includes(leaving)) return "They are no longer in this rotation.";
      // Replacing in place keeps everyone else's turn where it was; somebody
      // already in the rotation just loses the departing person's slot.
      const next = current.flatMap((id) => {
        if (id !== leaving) return [id];
        return target && !current.includes(target) ? [target] : [];
      });
      await updateOnCallSchedule(organizationId, scheduleId, { participantUserIds: next });
      return null;
    }

    case "cancel-cover": {
      const deleted = await deleteOnCallOverride(organizationId, need(ref, "overrideId"));
      return deleted ? null : "The cover had already been removed.";
    }

    case "cancel-lease": {
      await cancelLeaseRecord(organizationId, need(ref, "leaseId"));
      return null;
    }

    case "revoke-jit": {
      const caller = await loadJitCaller(organizationId, ctx.userId, ctx.permissions);
      try {
        const request = await revokeJitRequest(
          organizationId,
          need(ref, "requestId"),
          caller,
          "the offboarding checklist",
        );
        // A revoke the provider refused stays on the grant's own retry loop;
        // the row reads failed until it lands.
        if (request.status === "revoke_failed") {
          throw new Error(request.lastError ?? "The provider refused the revoke.");
        }
        return null;
      } catch (err) {
        if (err instanceof JitAccessError && err.status === 403) {
          throw new OffboardingActionRefused(err.message, 403);
        }
        throw err;
      }
    }
  }
}
