/**
 * Cost visibility scopes and per-object sharing: the platform-neutral half.
 *
 * Two related controls that extend the role model rather than sitting beside
 * it.
 *
 * **Cost visibility scopes** narrow *which cost rows* a principal can see.
 * A scope attaches to a role, a member or an API key and names cost centres
 * and/or connected accounts, optionally ANDed with a saved filter. A scoped
 * principal sees only matching rows on every cost surface: the server applies
 * the scope where cost queries are built, not per route. Scopes compose by
 * intersection: a member whose role is scoped *and* who has a member scope of
 * their own sees only rows both allow, and an API key can only narrow its
 * owner. Owners are never scoped.
 *
 * **Object sharing** decides *who can open or edit* a cost report, a report
 * folder or a dashboard: an org-wide default (`editor`, `viewer` or `none`)
 * plus owner/editor/viewer grants per member or role. A grant never exceeds
 * the role: editing still needs `costs:write` / `dashboards:write`.
 *
 * Server contract: `/api/org/:orgId/cost-visibility` (scopes, `team:read` to
 * list, `team:role:write` to change) and `/api/org/:orgId/sharing/:type/:id`
 * (object sharing). See web `api/routes/cost-visibility.ts` and
 * `api/routes/sharing.ts`.
 */
import type { CloudFetch } from "./fetch";

/* ------------------------------------------------------------------ *
 * Cost visibility scopes
 * ------------------------------------------------------------------ */

export const COST_VISIBILITY_PRINCIPAL_KINDS = ["role", "member", "api_key"] as const;
export type CostVisibilityPrincipalKind = (typeof COST_VISIBILITY_PRINCIPAL_KINDS)[number];

/**
 * Upper bounds the API enforces on one scope. Generous on purpose: a scope is
 * a list somebody picks from, and the cap exists to keep the compiled
 * predicate a reasonable size, not to ration access.
 */
export const COST_VISIBILITY_LIMITS = {
  maxCostCentres: 50,
  maxAccounts: 200,
} as const;

/** One stored scope, as `GET /cost-visibility` lists it. */
export interface CostVisibilityScope {
  id: string;
  principalKind: CostVisibilityPrincipalKind;
  /** Role id, member user id, or API key id. */
  principalId: string;
  /**
   * The role name, member email or key name, resolved at read time; null when
   * the principal no longer exists (a revoked key, a deleted role).
   */
  principalLabel: string | null;
  costCentreIds: string[];
  accountIds: string[];
  savedFilterId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Body of `PUT /cost-visibility` (an upsert keyed by principal). */
export interface CostVisibilityScopeInput {
  principalKind: CostVisibilityPrincipalKind;
  principalId: string;
  costCentreIds: string[];
  accountIds: string[];
  savedFilterId: string | null;
}

/**
 * One layer of the caller's own restriction, as `/team/me` reports it.
 * `kind` says where it came from so a surface can explain it ("your role
 * limits you to the Platform cost centre").
 */
export interface CostVisibilitySource {
  kind: CostVisibilityPrincipalKind;
  label: string | null;
  costCentreIds: string[];
  accountIds: string[];
  savedFilterId: string | null;
}

/** `costVisibility` on `GET /team/me`. */
export interface CostVisibilitySummary {
  /** False means the caller sees every cost row the org holds. */
  restricted: boolean;
  /** Every layer that applies, intersected. Empty when unrestricted. */
  sources: CostVisibilitySource[];
}

/** An empty scope (nothing picked) matches no rows. */
export function costVisibilityScopeIsEmpty(
  scope: Pick<CostVisibilityScopeInput, "costCentreIds" | "accountIds" | "savedFilterId">,
): boolean {
  return scope.costCentreIds.length === 0 && scope.accountIds.length === 0 && !scope.savedFilterId;
}

/**
 * The error code a route returns (403) when a cost-scoped principal reaches a
 * surface that is org-wide by nature (exports, invoices, team changes). Also
 * the `code` mobile and the CLI branch on to explain the refusal.
 */
export const COST_SCOPE_RESTRICTED_CODE = "cost_scope_restricted";

export async function fetchCostVisibilityScopes(
  api: CloudFetch,
  orgId: string,
): Promise<CostVisibilityScope[]> {
  const res = await api.org<{ scopes: CostVisibilityScope[] }>(orgId, "/cost-visibility");
  return res?.scopes ?? [];
}

/* ------------------------------------------------------------------ *
 * Object sharing
 * ------------------------------------------------------------------ */

export const SHAREABLE_OBJECT_TYPES = ["cost_report", "cost_report_folder", "dashboard"] as const;
export type ShareableObjectType = (typeof SHAREABLE_OBJECT_TYPES)[number];

export const OBJECT_ACCESS_LEVELS = ["owner", "editor", "viewer"] as const;
export type ObjectAccessLevel = (typeof OBJECT_ACCESS_LEVELS)[number];

export const ORG_ACCESS_LEVELS = ["editor", "viewer", "none"] as const;
export type OrgAccessLevel = (typeof ORG_ACCESS_LEVELS)[number];

/** What a caller can do with one object, highest first. */
export type EffectiveAccessLevel = ObjectAccessLevel | "none";

/**
 * The org-wide default for an object with no sharing row: everyone in the org
 * can edit, which is exactly how every report and dashboard behaved before
 * sharing existed. Changing it would silently lock people out of objects they
 * use today.
 */
export const DEFAULT_ORG_ACCESS: OrgAccessLevel = "editor";

export const SHARING_GRANT_PRINCIPAL_KINDS = ["member", "role"] as const;
export type SharingGrantPrincipalKind = (typeof SHARING_GRANT_PRINCIPAL_KINDS)[number];

/** Upper bound on explicit grants per object. */
export const SHARING_LIMITS = { maxGrants: 100 } as const;

export interface ObjectAccessGrant {
  principalKind: SharingGrantPrincipalKind;
  /** Member user id or role id. */
  principalId: string;
  /** Member email or role name, resolved at read time; null when gone. */
  principalLabel: string | null;
  level: ObjectAccessLevel;
  /**
   * True for the report creator's ownership, which is implied by
   * `created_by_user_id` rather than stored as a grant. Shown so the dialog
   * lists every owner; never needs to be sent back.
   */
  implicit: boolean;
}

/** `GET /sharing/:type/:id`. */
export interface ObjectSharing {
  objectType: ShareableObjectType;
  objectId: string;
  orgAccess: OrgAccessLevel;
  grants: ObjectAccessGrant[];
  /** What the caller can do with this object right now. */
  callerLevel: EffectiveAccessLevel;
  /**
   * For a report inside a folder: the access the folder chain already gives
   * the caller, so the dialog can say "also shared through the Finance
   * folder". Null when there is no folder or it adds nothing.
   */
  inheritedFrom: { folderId: string; folderName: string; level: EffectiveAccessLevel } | null;
}

/** Body of `PUT /sharing/:type/:id`: replaces the whole document. */
export interface ObjectSharingInput {
  orgAccess: OrgAccessLevel;
  grants: Array<{
    principalKind: SharingGrantPrincipalKind;
    principalId: string;
    level: ObjectAccessLevel;
  }>;
}

const LEVEL_RANK: Record<EffectiveAccessLevel, number> = {
  none: 0,
  viewer: 1,
  editor: 2,
  owner: 3,
};

export function accessLevelRank(level: EffectiveAccessLevel): number {
  return LEVEL_RANK[level];
}

/** The highest of several levels; `none` for an empty list. */
export function maxAccessLevel(levels: Iterable<EffectiveAccessLevel>): EffectiveAccessLevel {
  let best: EffectiveAccessLevel = "none";
  for (const level of levels) if (LEVEL_RANK[level] > LEVEL_RANK[best]) best = level;
  return best;
}

export function canViewObject(level: EffectiveAccessLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK.viewer;
}

export function canEditObject(level: EffectiveAccessLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK.editor;
}

export function canShareObject(level: EffectiveAccessLevel): boolean {
  return level === "owner";
}

/** `none` is an org default, never a grant: a grant only ever adds access. */
export function orgAccessAsLevel(orgAccess: OrgAccessLevel): EffectiveAccessLevel {
  return orgAccess;
}

export async function fetchObjectSharing(
  api: CloudFetch,
  orgId: string,
  objectType: ShareableObjectType,
  objectId: string,
): Promise<ObjectSharing | null> {
  return await api.org<ObjectSharing>(
    orgId,
    `/sharing/${objectType}/${encodeURIComponent(objectId)}`,
  );
}
