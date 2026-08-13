/**
 * Resource ownership rows — upsert/read/delete, plus the owner *lookups* every
 * other feature uses to attribute a resource to a person.
 *
 * Input validation comes from `@infrawrench/client-core`
 * (`validateOwnershipPatch`, `OWNERSHIP_LIMITS`), the same function the editor
 * UIs check with — the server and the form can't disagree about what a valid
 * ticket link is (the `leases/store.ts` stance).
 *
 * The interesting half of this module is not the CRUD, it is
 * {@link lookupResourceOwners}: one batched read that turns a set of resource
 * ids into printable, routable owners. Every consumer — the orphan finder, the
 * alert notifier, the CLI — goes through it, so "who owns this?" is answered
 * the same way everywhere, including the tie-break between a member owner and
 * a free-text one.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  validateOwnershipPatch,
  type OwnerCandidate,
  type ResourceOwnerAnnotation,
  type ResourceOwnership,
  type ResourceOwnershipListResponse,
  type ResourceOwnershipPatch,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { organizationMembers, resourceOwnership, resources, users } from "../db/schema";

/** Thrown for caller mistakes the API maps to 400/404. */
export class OwnershipInputError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = "OwnershipInputError";
  }
}

/** The joined row shape every read in this module produces. */
interface OwnershipRow {
  id: string;
  resourceId: string;
  accountId: string;
  pluginId: string;
  resourceTypeId: string;
  resourceName: string;
  ownerUserId: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerLabel: string | null;
  purpose: string | null;
  ticketUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toWire(row: OwnershipRow): ResourceOwnership {
  return {
    id: row.id,
    resourceId: row.resourceId,
    accountId: row.accountId,
    pluginId: row.pluginId,
    resourceTypeId: row.resourceTypeId,
    resourceName: row.resourceName,
    ownerUserId: row.ownerUserId,
    ownerName: row.ownerName,
    ownerEmail: row.ownerEmail,
    ownerLabel: row.ownerLabel,
    purpose: row.purpose,
    ticketUrl: row.ticketUrl,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Select ownership rows joined to the owning user.
 *
 * A left join, not an inner one: `owner_user_id` is nulled when a user is
 * removed from the system, and the purpose and ticket on that row are still
 * worth reading. The row becomes unowned, not invisible.
 */
function selectOwnership() {
  return db
    .select({
      id: resourceOwnership.id,
      resourceId: resourceOwnership.resourceId,
      accountId: resourceOwnership.accountId,
      pluginId: resourceOwnership.pluginId,
      resourceTypeId: resourceOwnership.resourceTypeId,
      resourceName: resourceOwnership.resourceName,
      ownerUserId: resourceOwnership.ownerUserId,
      ownerName: users.displayName,
      ownerEmail: users.email,
      ownerLabel: resourceOwnership.ownerLabel,
      purpose: resourceOwnership.purpose,
      ticketUrl: resourceOwnership.ticketUrl,
      createdAt: resourceOwnership.createdAt,
      updatedAt: resourceOwnership.updatedAt,
    })
    .from(resourceOwnership)
    .leftJoin(users, eq(users.id, resourceOwnership.ownerUserId));
}

export async function listOwnership(
  organizationId: string,
): Promise<ResourceOwnershipListResponse> {
  const rows = await selectOwnership()
    .where(eq(resourceOwnership.organizationId, organizationId))
    .orderBy(resourceOwnership.resourceName);
  return { ownership: rows.map(toWire) };
}

export async function getOwnershipByResource(
  organizationId: string,
  resourceId: string,
): Promise<ResourceOwnership | null> {
  const rows = await selectOwnership()
    .where(
      and(
        eq(resourceOwnership.organizationId, organizationId),
        eq(resourceOwnership.resourceId, resourceId),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row ? toWire(row) : null;
}

/**
 * Reduce a row to the annotation other features embed, or null when it names
 * nobody.
 *
 * The member owner wins over the free-text one when both are set: a routable
 * owner is strictly more useful than a label, and letting a stale label shadow
 * a real person is how an alert ends up going nowhere. A row whose member was
 * deleted falls back to its label, which is exactly why keeping both is worth
 * the column.
 */
export function toOwnerAnnotation(row: {
  ownerUserId: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerLabel: string | null;
  purpose: string | null;
  ticketUrl: string | null;
}): ResourceOwnerAnnotation | null {
  const memberName = row.ownerName ?? row.ownerEmail;
  if (row.ownerUserId && memberName) {
    return {
      userId: row.ownerUserId,
      displayName: memberName,
      isLabel: false,
      ticketUrl: row.ticketUrl,
      purpose: row.purpose,
    };
  }
  const label = row.ownerLabel?.trim();
  if (label) {
    return {
      userId: null,
      displayName: label,
      isLabel: true,
      ticketUrl: row.ticketUrl,
      purpose: row.purpose,
    };
  }
  return null;
}

/**
 * Batch "who owns these resources?" — the single lookup every consumer uses.
 *
 * Returns a map keyed by resource id, with entries only for resources that
 * have a *nameable* owner: a resource carrying only a purpose is absent, so a
 * caller iterating the map is iterating exactly the attributable set and a
 * missing key means "unowned" without further checks.
 *
 * Chunked because the orphan finder can ask about the whole org at once and
 * Postgres has a bind-parameter ceiling; an empty input never queries.
 */
export async function lookupResourceOwners(
  organizationId: string,
  resourceIds: readonly string[],
): Promise<Map<string, ResourceOwnerAnnotation>> {
  const out = new Map<string, ResourceOwnerAnnotation>();
  const unique = [...new Set(resourceIds)].filter(Boolean);
  if (unique.length === 0) return out;

  const CHUNK = 500;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const rows = await selectOwnership().where(
      and(
        eq(resourceOwnership.organizationId, organizationId),
        inArray(resourceOwnership.resourceId, chunk),
      ),
    );
    for (const row of rows) {
      const owner = toOwnerAnnotation(row);
      if (owner) out.set(row.resourceId, owner);
    }
  }
  return out;
}

/**
 * The owner of one resource, or null — the convenience wrapper alert paths
 * use, where the answer is needed for a single resource and a map would be
 * ceremony.
 */
export async function lookupResourceOwner(
  organizationId: string,
  resourceId: string,
): Promise<ResourceOwnerAnnotation | null> {
  const owners = await lookupResourceOwners(organizationId, [resourceId]);
  return owners.get(resourceId) ?? null;
}

/**
 * Upsert a resource's ownership.
 *
 * Upsert rather than create/update because ownership is a property *of the
 * resource*: the caller knows the resource, not whether a row exists. Omitted
 * fields keep their value, `null` clears — so an editor that only touches the
 * ticket link cannot blank the purpose.
 *
 * A row with nothing left in it is **deleted rather than kept empty**. Clearing
 * every field is how a user says "this isn't tracked", and leaving an all-null
 * row behind would make `lookupResourceOwners` and the unowned count disagree
 * with what the detail panel shows.
 */
export async function upsertOwnership(
  organizationId: string,
  patch: ResourceOwnershipPatch,
  actingUserId?: string,
): Promise<ResourceOwnership | null> {
  const problem = validateOwnershipPatch(patch);
  if (problem) throw new OwnershipInputError(problem);

  const [resource] = await db
    .select({
      id: resources.id,
      accountId: resources.accountId,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
      displayName: resources.displayName,
    })
    .from(resources)
    .where(and(eq(resources.organizationId, organizationId), eq(resources.id, patch.resourceId)))
    .limit(1);
  if (!resource) throw new OwnershipInputError("Resource not found in this organization", 404);

  // An owner has to be someone who can actually be reached in this org.
  // Accepting an arbitrary user id would create ownership that looks routable
  // and silently pages nobody.
  if (patch.ownerUserId) {
    const [member] = await db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.userId, patch.ownerUserId),
        ),
      )
      .limit(1);
    if (!member) throw new OwnershipInputError("Owner must be a member of this organization", 404);
  }

  const existing = await db
    .select()
    .from(resourceOwnership)
    .where(
      and(
        eq(resourceOwnership.organizationId, organizationId),
        eq(resourceOwnership.resourceId, patch.resourceId),
      ),
    )
    .limit(1);
  const current = existing[0] ?? null;

  const next = {
    ownerUserId: pick(patch.ownerUserId, current?.ownerUserId ?? null),
    ownerLabel: pickText(patch.ownerLabel, current?.ownerLabel ?? null),
    purpose: pickText(patch.purpose, current?.purpose ?? null),
    ticketUrl: pickText(patch.ticketUrl, current?.ticketUrl ?? null),
  };

  const empty =
    next.ownerUserId === null &&
    next.ownerLabel === null &&
    next.purpose === null &&
    next.ticketUrl === null;
  if (empty) {
    if (current) await deleteOwnership(organizationId, patch.resourceId);
    return null;
  }

  const now = new Date();
  if (current) {
    await db
      .update(resourceOwnership)
      .set({
        ...next,
        // Refresh the denormalized identity: a resource can be renamed, and
        // the stale name would then show up in an owner report.
        resourceName: resource.displayName,
        accountId: resource.accountId,
        pluginId: resource.pluginId,
        resourceTypeId: resource.resourceTypeId,
        updatedAt: now,
      })
      .where(eq(resourceOwnership.id, current.id));
  } else {
    await db.insert(resourceOwnership).values({
      id: randomUUID(),
      organizationId,
      accountId: resource.accountId,
      resourceId: resource.id,
      pluginId: resource.pluginId,
      resourceTypeId: resource.resourceTypeId,
      resourceName: resource.displayName,
      ...next,
      createdByUserId: actingUserId ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }
  return getOwnershipByResource(organizationId, patch.resourceId);
}

/** One person the owner picker can offer. Client-core (`ownership.ts`) owns the shape. */
export type { OwnerCandidate };

/**
 * Org members an owner can be set to.
 *
 * A deliberately minimal projection — id, name, email — rather than a reuse of
 * the team endpoint's rows. The team list carries roles and membership dates
 * and is gated on `team:read`; requiring that permission to say "this VM is
 * mine" would put ownership out of reach of exactly the people who create
 * resources, and ownership nobody can record is ownership that stays empty.
 */
export async function listOwnerCandidates(organizationId: string): Promise<OwnerCandidate[]> {
  const rows = await db
    .select({
      userId: users.id,
      displayName: users.displayName,
      email: users.email,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(eq(organizationMembers.organizationId, organizationId))
    .orderBy(users.displayName);
  return rows.map((row) => ({
    userId: row.userId,
    name: row.displayName ?? row.email,
    email: row.email,
  }));
}

/** Remove a resource's ownership record. Returns false when there was none. */
export async function deleteOwnership(
  organizationId: string,
  resourceId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(resourceOwnership)
    .where(
      and(
        eq(resourceOwnership.organizationId, organizationId),
        eq(resourceOwnership.resourceId, resourceId),
      ),
    )
    .returning({ id: resourceOwnership.id });
  return deleted.length > 0;
}

/** Omitted keeps, `null` clears, a value sets. */
function pick(value: string | null | undefined, current: string | null): string | null {
  return value === undefined ? current : (value ?? null);
}

/**
 * As {@link pick}, but an all-whitespace string clears too — the editors bind
 * text inputs straight to these fields, and an emptied box means "remove
 * this", not "set it to a space".
 */
function pickText(value: string | null | undefined, current: string | null): string | null {
  if (value === undefined) return current;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed || null;
}
