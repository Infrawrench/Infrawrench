import { v4 as uuid } from "uuid";
import { and, desc, eq } from "drizzle-orm";
import type { Context } from "hono";
import type { PluginClient } from "@infrawrench/plugin-base";
import { db } from "@/db/client";
import { changeFreezes } from "@/db/schema";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { findActiveChangeFreeze } from "@infrawrench/server-core/change-freezes";
import { logAudit } from "./audit";

/**
 * Org-level change freeze windows.
 *
 * A freeze is "in effect" when it is active, has started, and has not passed
 * its end time. While one is in effect, the destructive mutation paths
 * (resource delete, destructive plugin actions, secret-version destroy,
 * deployment rollback) call {@link checkChangeFreeze} before touching the
 * provider. Callers holding `freezes:override` can bypass a freeze by sending
 * the `x-change-freeze-override: true` header; both blocks and overrides are
 * written to the audit trail.
 */

export const CHANGE_FREEZE_OVERRIDE_HEADER = "x-change-freeze-override";
export const CHANGE_FREEZE_ACTIVE_CODE = "change_freeze_active";

export interface ChangeFreezeRow {
  id: string;
  organizationId: string;
  name: string;
  reason: string | null;
  startsAt: Date;
  endsAt: Date | null;
  active: boolean;
  createdByUserId: string | null;
  endedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The freeze currently in effect for the org, or null. The query itself lives
 * in server-core (`findActiveChangeFreeze`) so the poller's schedule pass can
 * respect freezes without importing the web package.
 */
export async function getActiveChangeFreeze(
  organizationId: string,
  at: Date = new Date(),
): Promise<ChangeFreezeRow | null> {
  return findActiveChangeFreeze(organizationId, at);
}

export function describeFreeze(freeze: ChangeFreezeRow): string {
  const until = freeze.endsAt
    ? `until ${freeze.endsAt.toISOString()}`
    : "until it is ended by an admin";
  return `Change freeze "${freeze.name}" is in effect ${until}.`;
}

/** JSON body of the 423 returned when a freeze blocks a destructive action. */
export function freezeBlockedPayload(freeze: ChangeFreezeRow) {
  return {
    error:
      `${describeFreeze(freeze)} Destructive actions are blocked. ` +
      `Admins can retry with the "${CHANGE_FREEZE_OVERRIDE_HEADER}: true" header to override.`,
    code: CHANGE_FREEZE_ACTIVE_CODE,
    freeze: {
      id: freeze.id,
      name: freeze.name,
      reason: freeze.reason,
      startsAt: freeze.startsAt.toISOString(),
      endsAt: freeze.endsAt ? freeze.endsAt.toISOString() : null,
    },
  };
}

interface FreezeAuditTarget {
  /** The destructive action being attempted, e.g. "resource.delete". */
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * Enforce the org's change freeze on a destructive HTTP mutation.
 *
 * Returns null when the request may proceed (no freeze, or an authorized
 * explicit override — the override itself is audit-logged). Returns a 423
 * `Response` describing the freeze when the request must be blocked; the block
 * is audit-logged too. Call it after resolving/authorizing the target and
 * before performing the provider mutation.
 */
export async function checkChangeFreeze(
  c: Context,
  target: FreezeAuditTarget,
): Promise<Response | null> {
  const organizationId = c.get("organizationId");
  const freeze = await getActiveChangeFreeze(organizationId);
  if (!freeze) return null;

  const session = c.get("session") as { userId?: string } | undefined;
  const userId = session?.userId;
  const baseMeta = {
    ...target.metadata,
    freezeId: freeze.id,
    freezeName: freeze.name,
    attemptedAction: target.action,
  };

  const overrideRequested = c.req.header(CHANGE_FREEZE_OVERRIDE_HEADER)?.toLowerCase() === "true";
  if (overrideRequested) {
    const granted = (c.get("permissions") ?? []) as readonly string[];
    if (hasPermission(granted, "freezes:override")) {
      void logAudit({
        organizationId,
        userId,
        action: "change_freeze.override",
        entityType: target.entityType,
        entityId: target.entityId,
        metadata: baseMeta,
      });
      return null;
    }
    // An override attempt without the permission is still a block — record it.
  }

  void logAudit({
    organizationId,
    userId,
    action: "change_freeze.block",
    entityType: target.entityType,
    entityId: target.entityId,
    metadata: { ...baseMeta, overrideRequested },
  });
  return c.json(freezeBlockedPayload(freeze), 423);
}

/**
 * Freeze gate for non-HTTP server-side callers (MCP tools). Returns a
 * human-readable error string when the mutation must be refused, or null when
 * no freeze is in effect. Tools have no override affordance — end the freeze
 * (or use the web UI's admin override) instead. Blocks are audit-logged.
 */
export async function checkChangeFreezeForTool(
  organizationId: string,
  userId: string | undefined,
  target: FreezeAuditTarget,
): Promise<string | null> {
  const freeze = await getActiveChangeFreeze(organizationId);
  if (!freeze) return null;
  void logAudit({
    organizationId,
    userId,
    action: "change_freeze.block",
    entityType: target.entityType,
    entityId: target.entityId,
    metadata: {
      ...target.metadata,
      freezeId: freeze.id,
      freezeName: freeze.name,
      attemptedAction: target.action,
      overrideRequested: false,
      source: "tool",
    },
  });
  return (
    `${describeFreeze(freeze)} Destructive actions are blocked. ` +
    `An org admin can end the freeze or perform the action with an explicit override from the web app.`
  );
}

/**
 * Whether the plugin declares `actionId` destructive for this resource.
 *
 * There is no server-side action registry — actions live in the detail schema
 * a plugin renders — so we re-render the resource's detail and look for a
 * `plugin-action` with a matching id. Only called while a freeze is in effect,
 * so the extra provider round-trip is confined to freeze windows. Unflagged or
 * unresolvable actions are treated as non-destructive (the flag is opt-in).
 */
export async function isActionDestructive(
  client: PluginClient,
  resourceTypeId: string,
  resourceId: string,
  accountId: string,
  actionId: string,
): Promise<boolean> {
  try {
    const instance = await client.getResource(resourceTypeId, resourceId, accountId);
    const detail = client.renderDetail(instance);
    return schemaDeclaresDestructiveAction(detail, actionId);
  } catch {
    // Can't render the schema (provider hiccup, deleted resource). The flag is
    // opt-in, so fail open rather than blocking routine operations.
    return false;
  }
}

/** Recursively walk an arbitrary schema tree for `{type:"plugin-action"}` nodes. */
export function schemaDeclaresDestructiveAction(node: unknown, actionId: string): boolean {
  if (Array.isArray(node)) {
    return node.some((item) => schemaDeclaresDestructiveAction(item, actionId));
  }
  if (typeof node !== "object" || node === null) return false;
  const obj = node as Record<string, unknown>;
  if (obj["type"] === "plugin-action" && obj["actionId"] === actionId) {
    if (obj["destructive"] === true) return true;
    // Fall through: the same actionId could appear elsewhere in the tree.
  }
  return Object.values(obj).some((value) => schemaDeclaresDestructiveAction(value, actionId));
}

export interface ChangeFreezeInput {
  name: string;
  reason?: string | undefined;
  startsAt?: Date | undefined;
  endsAt?: Date | undefined;
}

export async function listChangeFreezes(organizationId: string): Promise<ChangeFreezeRow[]> {
  return db
    .select()
    .from(changeFreezes)
    .where(eq(changeFreezes.organizationId, organizationId))
    .orderBy(desc(changeFreezes.createdAt));
}

export async function createChangeFreeze(
  organizationId: string,
  input: ChangeFreezeInput,
  createdByUserId: string | null,
): Promise<ChangeFreezeRow> {
  const row = {
    id: uuid(),
    organizationId,
    name: input.name,
    reason: input.reason ?? null,
    startsAt: input.startsAt ?? new Date(),
    endsAt: input.endsAt ?? null,
    active: true,
    createdByUserId,
    endedByUserId: null,
  };
  const inserted = await db.insert(changeFreezes).values(row).returning();
  return inserted[0]!;
}

export async function updateChangeFreeze(
  organizationId: string,
  id: string,
  input: ChangeFreezeInput,
): Promise<ChangeFreezeRow | null> {
  const updated = await db
    .update(changeFreezes)
    .set({
      name: input.name,
      reason: input.reason ?? null,
      ...(input.startsAt ? { startsAt: input.startsAt } : {}),
      endsAt: input.endsAt ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(changeFreezes.id, id), eq(changeFreezes.organizationId, organizationId)))
    .returning();
  return updated[0] ?? null;
}

/** End a freeze now: deactivate and stamp who ended it. Idempotent. */
export async function endChangeFreeze(
  organizationId: string,
  id: string,
  endedByUserId: string | null,
): Promise<ChangeFreezeRow | null> {
  const now = new Date();
  const updated = await db
    .update(changeFreezes)
    .set({ active: false, endsAt: now, endedByUserId, updatedAt: now })
    .where(and(eq(changeFreezes.id, id), eq(changeFreezes.organizationId, organizationId)))
    .returning();
  return updated[0] ?? null;
}

export async function deleteChangeFreeze(organizationId: string, id: string): Promise<boolean> {
  const deleted = await db
    .delete(changeFreezes)
    .where(and(eq(changeFreezes.id, id), eq(changeFreezes.organizationId, organizationId)))
    .returning({ id: changeFreezes.id });
  return deleted.length > 0;
}
