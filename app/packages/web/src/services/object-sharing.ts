/**
 * Per-object sharing for cost reports, report folders and dashboards.
 *
 * Each object has an org-wide default (`editor`, `viewer` or `none`; no row
 * means `editor`, how every object behaved before sharing existed) plus
 * owner/editor/viewer grants per member or role. A caller's level on an
 * object is the highest of:
 *
 * - the org default,
 * - a grant to them as a member, or to their role,
 * - implicit ownership of a report they created (`created_by_user_id`),
 * - for a report in a folder, and a folder in a folder: the *explicit*
 *   sharing of every folder above it. A folder left at the default adds
 *   nothing, otherwise "nobody in the org" on a report would be undone by
 *   the folder it sits in.
 *
 * Holders of `sharing:override` (admins and owners through their
 * catalog-derived sets) see and manage everything, so an object whose owner
 * left is never stranded.
 *
 * Levels only ever narrow what the role allows: viewing still needs
 * `costs:read` / `dashboards:read`, editing `costs:write` / `dashboards:write`.
 * The routes check those first; this module answers "which objects".
 *
 * The principal rides an `AsyncLocalStorage`, like cost visibility, so the
 * services shared by the HTTP routes and the MCP/chat tools enforce sharing
 * identically. No store means a system caller (the poller, org config apply)
 * with full access.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  DEFAULT_ORG_ACCESS,
  SHARING_LIMITS,
  canViewObject,
  maxAccessLevel,
  type EffectiveAccessLevel,
  type ObjectAccessGrant,
  type ObjectAccessLevel,
  type ObjectSharing,
  type ObjectSharingInput,
  type OrgAccessLevel,
  type ShareableObjectType,
} from "@infrawrench/client-core";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { db } from "../db/client";
import {
  costCanvases,
  costReportFolders,
  costReports,
  dashboards,
  objectAccessGrants,
  organizationMembers,
  roles,
  users,
} from "../db/schema";

export interface SharingPrincipal {
  organizationId: string;
  userId: string;
  roleId: string | null;
  /** Holds `sharing:override`: full access to every object. */
  override: boolean;
}

const storage = new AsyncLocalStorage<SharingPrincipal>();

/** Types whose creator is their implicit owner (`created_by_user_id`). */
function hasImplicitCreatorOwner(type: ShareableObjectType): boolean {
  return type === "cost_report" || type === "cost_canvas";
}

/** Types that sit in the report-folder tree and inherit its explicit sharing. */
function inFolderTree(type: ShareableObjectType): boolean {
  return type === "cost_report" || type === "cost_report_folder";
}

export function runWithSharingPrincipal<T>(principal: SharingPrincipal, fn: () => T): T {
  return storage.run(principal, fn);
}

/** Build the principal for a user from their live membership. */
export async function resolveSharingPrincipal(
  organizationId: string,
  userId: string,
  permissions: readonly string[],
): Promise<SharingPrincipal> {
  const [member] = await db
    .select({ roleId: organizationMembers.roleId })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
      ),
    )
    .limit(1);
  return {
    organizationId,
    userId,
    roleId: member?.roleId ?? null,
    override: hasPermission(permissions, "sharing:override"),
  };
}

function currentPrincipal(organizationId: string): SharingPrincipal | null {
  const p = storage.getStore();
  if (!p) return null;
  if (p.organizationId !== organizationId) {
    throw new Error(
      `Sharing principal was established for organization ${p.organizationId} but an object in ${organizationId} was requested.`,
    );
  }
  return p.override ? null : p;
}

/** A caller below `viewer` on the object: answered as 404, never 403. */
export class ObjectNotVisibleError extends Error {
  override readonly name = "ObjectNotVisibleError";
  constructor() {
    super("Not found");
  }
}

/** A caller who can see the object but lacks the level the action needs. */
export class ObjectAccessDeniedError extends Error {
  override readonly name = "ObjectAccessDeniedError";
  constructor(readonly needed: ObjectAccessLevel) {
    super(
      needed === "owner"
        ? "Only an owner of this item can do that. Ask an owner to share it with you as an owner."
        : "You can view this item but not edit it. Ask an owner to share it with you as an editor.",
    );
  }
}

export class SharingInputError extends Error {
  override readonly name = "SharingInputError";
}

type GrantRow = typeof objectAccessGrants.$inferSelect;

/** Metadata the resolver needs beyond the grants. */
export interface ObjectMeta {
  createdByUserId?: string | null;
  /** Folder of a report, or parent of a folder. */
  folderId?: string | null;
}

interface Resolver {
  level(objectId: string, meta?: ObjectMeta): EffectiveAccessLevel;
  /** Whether anyone holds owner on it (explicit grant or report creator). */
  hasOwner(objectId: string, meta?: ObjectMeta): boolean;
}

const FULL_ACCESS: Resolver = { level: () => "owner", hasOwner: () => true };

function grantsByObject(rows: readonly GrantRow[]): Map<string, GrantRow[]> {
  const map = new Map<string, GrantRow[]>();
  for (const r of rows) {
    const list = map.get(r.objectId) ?? [];
    list.push(r);
    map.set(r.objectId, list);
  }
  return map;
}

/** Levels the principal gets from one object's own rows. */
function ownLevels(
  rows: readonly GrantRow[],
  p: SharingPrincipal,
  includeDefault: boolean,
): EffectiveAccessLevel[] {
  const levels: EffectiveAccessLevel[] = [];
  const orgRow = rows.find((r) => r.principalKind === "org");
  if (orgRow) levels.push(orgRow.level as OrgAccessLevel);
  else if (includeDefault) levels.push(DEFAULT_ORG_ACCESS);
  for (const r of rows) {
    if (r.principalKind === "member" && r.principalId === p.userId) {
      levels.push(r.level as ObjectAccessLevel);
    }
    if (r.principalKind === "role" && p.roleId && r.principalId === p.roleId) {
      levels.push(r.level as ObjectAccessLevel);
    }
  }
  return levels;
}

/**
 * A resolver for every object of `type` in the org, loaded in one or two
 * queries so list endpoints can filter without a query per row.
 */
export async function loadAccessResolver(
  organizationId: string,
  type: ShareableObjectType,
): Promise<Resolver> {
  const p = currentPrincipal(organizationId);
  if (!p) return FULL_ACCESS;

  const types: ShareableObjectType[] =
    type === "cost_report" ? ["cost_report", "cost_report_folder"] : [type];
  const rows = await db
    .select()
    .from(objectAccessGrants)
    .where(
      and(
        eq(objectAccessGrants.organizationId, organizationId),
        inArray(objectAccessGrants.objectType, types),
      ),
    );
  const own = grantsByObject(rows.filter((r) => r.objectType === type));
  const folderGrants = grantsByObject(rows.filter((r) => r.objectType === "cost_report_folder"));

  // Folder parents, for walking a report's (or folder's) chain upward.
  let folderParent = new Map<string, string | null>();
  if (inFolderTree(type)) {
    const folders = await db
      .select({ id: costReportFolders.id, parent: costReportFolders.parentFolderId })
      .from(costReportFolders)
      .where(eq(costReportFolders.organizationId, organizationId));
    folderParent = new Map(folders.map((f) => [f.id, f.parent]));
  }

  const chainLevels = (folderId: string | null | undefined): EffectiveAccessLevel[] => {
    const out: EffectiveAccessLevel[] = [];
    const seen = new Set<string>();
    let cur = folderId ?? null;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      out.push(...ownLevels(folderGrants.get(cur) ?? [], p, false));
      cur = folderParent.get(cur) ?? null;
    }
    return out;
  };

  return {
    level(objectId, meta) {
      const levels = ownLevels(own.get(objectId) ?? [], p, true);
      if (
        hasImplicitCreatorOwner(type) &&
        meta?.createdByUserId &&
        meta.createdByUserId === p.userId
      ) {
        levels.push("owner");
      }
      if (inFolderTree(type)) {
        const parent = type === "cost_report" ? meta?.folderId : folderParent.get(objectId);
        levels.push(...chainLevels(parent));
      }
      return maxAccessLevel(levels);
    },
    hasOwner(objectId, meta) {
      if (hasImplicitCreatorOwner(type) && meta?.createdByUserId) return true;
      return (own.get(objectId) ?? []).some((r) => r.level === "owner");
    },
  };
}

/**
 * Throw unless the current principal holds `needed` on the object.
 * `delete` is owner, or editor when nobody owns the object (objects created
 * before sharing existed, so editors can still tidy them up).
 */
export async function requireObjectAccess(
  organizationId: string,
  type: ShareableObjectType,
  objectId: string,
  meta: ObjectMeta,
  needed: ObjectAccessLevel | "delete",
): Promise<EffectiveAccessLevel> {
  const resolver = await loadAccessResolver(organizationId, type);
  const level = resolver.level(objectId, meta);
  if (!canViewObject(level)) throw new ObjectNotVisibleError();
  const want: ObjectAccessLevel =
    needed === "delete" ? (resolver.hasOwner(objectId, meta) ? "owner" : "editor") : needed;
  const rank = { viewer: 1, editor: 2, owner: 3 } as const;
  const have = level === "none" ? 0 : rank[level];
  if (have < rank[want]) throw new ObjectAccessDeniedError(want);
  return level;
}

/** Record the creator as owner of a new dashboard or folder. */
export async function grantCreatorOwnership(
  organizationId: string,
  type: ShareableObjectType,
  objectId: string,
  userId: string | null | undefined,
): Promise<void> {
  if (!userId) return;
  await db
    .insert(objectAccessGrants)
    .values({
      id: randomUUID(),
      organizationId,
      objectType: type,
      objectId,
      principalKind: "member",
      principalId: userId,
      level: "owner",
      createdByUserId: userId,
    })
    .onConflictDoNothing();
}

/** Drop every sharing row of a deleted object. */
export async function deleteObjectSharing(
  organizationId: string,
  type: ShareableObjectType,
  objectId: string,
): Promise<void> {
  await db
    .delete(objectAccessGrants)
    .where(
      and(
        eq(objectAccessGrants.organizationId, organizationId),
        eq(objectAccessGrants.objectType, type),
        eq(objectAccessGrants.objectId, objectId),
      ),
    );
}

/** The object's metadata, or null when it does not exist in the org. */
export async function loadObjectMeta(
  organizationId: string,
  type: ShareableObjectType,
  objectId: string,
): Promise<(ObjectMeta & { name: string }) | null> {
  if (type === "cost_report") {
    const [row] = await db
      .select({
        name: costReports.name,
        createdByUserId: costReports.createdByUserId,
        folderId: costReports.folderId,
        deletedAt: costReports.deletedAt,
      })
      .from(costReports)
      .where(and(eq(costReports.id, objectId), eq(costReports.organizationId, organizationId)))
      .limit(1);
    return row && !row.deletedAt ? row : null;
  }
  if (type === "cost_canvas") {
    const [row] = await db
      .select({
        name: costCanvases.name,
        createdByUserId: costCanvases.createdByUserId,
        deletedAt: costCanvases.deletedAt,
      })
      .from(costCanvases)
      .where(and(eq(costCanvases.id, objectId), eq(costCanvases.organizationId, organizationId)))
      .limit(1);
    return row && !row.deletedAt ? { name: row.name, createdByUserId: row.createdByUserId } : null;
  }
  if (type === "cost_report_folder") {
    const [row] = await db
      .select({ name: costReportFolders.name, folderId: costReportFolders.parentFolderId })
      .from(costReportFolders)
      .where(
        and(
          eq(costReportFolders.id, objectId),
          eq(costReportFolders.organizationId, organizationId),
        ),
      )
      .limit(1);
    return row ?? null;
  }
  const [row] = await db
    .select({ name: dashboards.name, deletedAt: dashboards.deletedAt })
    .from(dashboards)
    .where(and(eq(dashboards.id, objectId), eq(dashboards.organizationId, organizationId)))
    .limit(1);
  return row && !row.deletedAt ? { name: row.name } : null;
}

/** The sharing document for one object, with the caller's own level. */
export async function getObjectSharing(
  organizationId: string,
  type: ShareableObjectType,
  objectId: string,
): Promise<ObjectSharing> {
  const meta = await loadObjectMeta(organizationId, type, objectId);
  if (!meta) throw new ObjectNotVisibleError();
  const callerLevel = await requireObjectAccess(organizationId, type, objectId, meta, "viewer");

  const rows = await db
    .select()
    .from(objectAccessGrants)
    .where(
      and(
        eq(objectAccessGrants.organizationId, organizationId),
        eq(objectAccessGrants.objectType, type),
        eq(objectAccessGrants.objectId, objectId),
      ),
    );
  const orgRow = rows.find((r) => r.principalKind === "org");
  const grantRows = rows.filter((r) => r.principalKind !== "org");

  const userIds = grantRows.filter((r) => r.principalKind === "member").map((r) => r.principalId);
  const roleIds = grantRows.filter((r) => r.principalKind === "role").map((r) => r.principalId);
  const [userRows, roleRows] = await Promise.all([
    userIds.length > 0
      ? db
          .select({ id: users.id, label: users.email })
          .from(users)
          .where(inArray(users.id, userIds))
      : Promise.resolve([]),
    roleIds.length > 0
      ? db
          .select({ id: roles.id, label: roles.name })
          .from(roles)
          .where(and(eq(roles.organizationId, organizationId), inArray(roles.id, roleIds)))
      : Promise.resolve([]),
  ]);
  const labels = new Map<string, string>();
  for (const r of userRows) labels.set(`member:${r.id}`, r.label);
  for (const r of roleRows) labels.set(`role:${r.id}`, r.label);

  const grants: ObjectAccessGrant[] = grantRows.map((r) => ({
    principalKind: r.principalKind as "member" | "role",
    principalId: r.principalId,
    principalLabel: labels.get(`${r.principalKind}:${r.principalId}`) ?? null,
    level: r.level as ObjectAccessLevel,
    implicit: false,
  }));
  if (hasImplicitCreatorOwner(type) && meta.createdByUserId) {
    const creator = meta.createdByUserId;
    if (!grants.some((g) => g.principalKind === "member" && g.principalId === creator)) {
      const [u] = await db
        .select({ label: users.email })
        .from(users)
        .where(eq(users.id, creator))
        .limit(1);
      grants.unshift({
        principalKind: "member",
        principalId: creator,
        principalLabel: u?.label ?? null,
        level: "owner",
        implicit: true,
      });
    }
  }

  let inheritedFrom: ObjectSharing["inheritedFrom"] = null;
  if (inFolderTree(type) && meta.folderId) {
    const folder = await loadObjectMeta(organizationId, "cost_report_folder", meta.folderId);
    if (folder) {
      const resolver = await loadAccessResolver(organizationId, "cost_report_folder");
      const level = resolver.level(meta.folderId, folder);
      const folderRows = await db
        .select({ id: objectAccessGrants.id })
        .from(objectAccessGrants)
        .where(
          and(
            eq(objectAccessGrants.organizationId, organizationId),
            eq(objectAccessGrants.objectType, "cost_report_folder"),
            eq(objectAccessGrants.objectId, meta.folderId),
          ),
        )
        .limit(1);
      if (folderRows.length > 0) {
        inheritedFrom = { folderId: meta.folderId, folderName: folder.name, level };
      }
    }
  }

  return {
    objectType: type,
    objectId,
    orgAccess: (orgRow?.level as OrgAccessLevel | undefined) ?? DEFAULT_ORG_ACCESS,
    grants,
    callerLevel,
    inheritedFrom,
  };
}

/**
 * Replace an object's sharing document. Owner only. Every member and role
 * named must exist in the org, and at least one owner must remain (the
 * caller cannot strand an object nobody can share again; admins could, via
 * `sharing:override`, but the document should not need them to).
 */
export async function putObjectSharing(
  organizationId: string,
  type: ShareableObjectType,
  objectId: string,
  input: ObjectSharingInput,
  actorUserId: string,
): Promise<ObjectSharing> {
  const meta = await loadObjectMeta(organizationId, type, objectId);
  if (!meta) throw new ObjectNotVisibleError();
  await requireObjectAccess(organizationId, type, objectId, meta, "owner");

  if (input.grants.length > SHARING_LIMITS.maxGrants) {
    throw new SharingInputError(`At most ${SHARING_LIMITS.maxGrants} people and roles per item.`);
  }
  const seen = new Set<string>();
  for (const g of input.grants) {
    const key = `${g.principalKind}:${g.principalId}`;
    if (seen.has(key)) throw new SharingInputError("Each person or role can appear only once.");
    seen.add(key);
  }
  const memberIds = input.grants
    .filter((g) => g.principalKind === "member")
    .map((g) => g.principalId);
  const roleIds = input.grants.filter((g) => g.principalKind === "role").map((g) => g.principalId);
  if (memberIds.length > 0) {
    const found = await db
      .select({ id: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          inArray(organizationMembers.userId, memberIds),
        ),
      );
    if (found.length !== new Set(memberIds).size) {
      throw new SharingInputError("One of the people is not a member of this organization.");
    }
  }
  if (roleIds.length > 0) {
    const found = await db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.organizationId, organizationId), inArray(roles.id, roleIds)));
    if (found.length !== new Set(roleIds).size) {
      throw new SharingInputError("One of the roles does not exist in this organization.");
    }
  }
  const implicitOwner = hasImplicitCreatorOwner(type) && !!meta.createdByUserId;
  if (!implicitOwner && !input.grants.some((g) => g.level === "owner")) {
    throw new SharingInputError("Keep at least one owner, so somebody can still share this item.");
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(objectAccessGrants)
      .where(
        and(
          eq(objectAccessGrants.organizationId, organizationId),
          eq(objectAccessGrants.objectType, type),
          eq(objectAccessGrants.objectId, objectId),
        ),
      );
    const values = [
      // The org row is written even at the default so that an explicit
      // folder setting is distinguishable from an untouched one.
      {
        id: randomUUID(),
        organizationId,
        objectType: type,
        objectId,
        principalKind: "org" as const,
        principalId: "",
        level: input.orgAccess,
        createdByUserId: actorUserId,
      },
      ...input.grants.map((g) => ({
        id: randomUUID(),
        organizationId,
        objectType: type,
        objectId,
        principalKind: g.principalKind,
        principalId: g.principalId,
        level: g.level,
        createdByUserId: actorUserId,
      })),
    ];
    await tx.insert(objectAccessGrants).values(values);
  });
  return await getObjectSharing(organizationId, type, objectId);
}

/**
 * Reset an object to the default (everyone in the org can edit, no explicit
 * grants). Owner only. A report's creator stays its implicit owner.
 */
export async function resetObjectSharing(
  organizationId: string,
  type: ShareableObjectType,
  objectId: string,
): Promise<void> {
  const meta = await loadObjectMeta(organizationId, type, objectId);
  if (!meta) throw new ObjectNotVisibleError();
  await requireObjectAccess(organizationId, type, objectId, meta, "owner");
  await deleteObjectSharing(organizationId, type, objectId);
}

/** Filter a list to the objects the current principal can view. */
export async function filterVisibleObjects<T>(
  organizationId: string,
  type: ShareableObjectType,
  items: readonly T[],
  idOf: (item: T) => string,
  metaOf: (item: T) => ObjectMeta = () => ({}),
): Promise<T[]> {
  const resolver = await loadAccessResolver(organizationId, type);
  if (resolver === FULL_ACCESS) return [...items];
  return items.filter((item) => canViewObject(resolver.level(idOf(item), metaOf(item))));
}
