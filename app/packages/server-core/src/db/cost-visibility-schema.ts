/**
 * Cost visibility scopes and per-object sharing.
 *
 * Both extend the role model rather than running beside it: a scope narrows
 * which cost *rows* a role, member or API key can see, and a sharing grant
 * narrows (or, for explicit grants, opens) which *objects* a member or role can
 * open. Neither ever exceeds the permission set the role already grants; they
 * only answer the questions a permission string cannot ("which spend?",
 * "which report?").
 */
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { organizations } from "./core-schema.js";

/**
 * One cost visibility scope: the cost rows a principal is allowed to see.
 *
 * `principal_kind` + `principal_id` name a role (`roles.id`), a member
 * (`organization_members.user_id`) or an API key (`api_keys.id`). At most one
 * scope per principal, and every scope that applies to a request is
 * **intersected**: a member's own scope can only narrow what their role's
 * scope allows, and a key's scope can only narrow its owner. Owners are never
 * scoped (the route refuses it and the resolver ignores one).
 *
 * A row matches a cost row when `(account in account_ids OR row allocates to
 * one of cost_centre_ids or a descendant)` and, when set, the saved filter
 * also matches. With no accounts and no centres the saved filter alone
 * decides; with nothing at all the scope matches **no** rows, so an empty
 * scope fails closed rather than meaning "everything".
 *
 * Deliberately no foreign keys to the principal or to the referenced ids. A
 * dangling centre, account or principal must make the scope match *less*,
 * never more, and an FK with `ON DELETE CASCADE` would delete the restriction
 * (widening access) the moment a cost centre was removed. The routes delete a
 * member's or role's scope when the member or role itself goes; anything else
 * that dangles simply matches nothing. Saved filters are protected the other
 * way round: deleting one a scope references is refused.
 */
export const costVisibilityScopes = pgTable(
  "cost_visibility_scopes",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    principalKind: text("principal_kind").$type<"role" | "member" | "api_key">().notNull(),
    principalId: text("principal_id").notNull(),
    costCentreIds: jsonb("cost_centre_ids").$type<string[]>().notNull().default([]),
    accountIds: jsonb("account_ids").$type<string[]>().notNull().default([]),
    savedFilterId: text("saved_filter_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    principalUnique: uniqueIndex("cost_visibility_scopes_principal_unique").on(
      t.organizationId,
      t.principalKind,
      t.principalId,
    ),
    orgIdx: index("cost_visibility_scopes_org_idx").on(t.organizationId),
    kindCheck: check(
      "cost_visibility_scopes_kind_check",
      sql`${t.principalKind} IN ('role', 'member', 'api_key')`,
    ),
  }),
);

/**
 * Who may open or edit one shareable object: a cost report, a report folder
 * or a dashboard.
 *
 * One table for both halves of a sharing document. `principal_kind = 'org'`
 * (with an empty `principal_id`) is the org-wide default: `editor`, `viewer`
 * or `none`; no such row means `editor`, which is how every object behaved
 * before sharing existed. `member` and `role` rows are explicit grants and
 * carry `owner`, `editor` or `viewer`; a grant only ever adds access, so
 * `none` is never a grant level.
 *
 * Polymorphic `object_id` with no foreign key, because it points at three
 * tables. The object routes delete an object's rows when the object is
 * deleted; a row left behind for a soft-deleted object is inert (nothing
 * resolves it).
 */
export const objectAccessGrants = pgTable(
  "object_access_grants",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    objectType: text("object_type")
      .$type<"cost_report" | "cost_report_folder" | "dashboard">()
      .notNull(),
    objectId: text("object_id").notNull(),
    principalKind: text("principal_kind").$type<"org" | "member" | "role">().notNull(),
    /** Member user id or role id; `''` for the org-wide row. */
    principalId: text("principal_id").notNull().default(""),
    level: text("level").$type<"owner" | "editor" | "viewer" | "none">().notNull(),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    grantUnique: uniqueIndex("object_access_grants_unique").on(
      t.organizationId,
      t.objectType,
      t.objectId,
      t.principalKind,
      t.principalId,
    ),
    objectIdx: index("object_access_grants_object_idx").on(
      t.organizationId,
      t.objectType,
      t.objectId,
    ),
    kindCheck: check(
      "object_access_grants_kind_check",
      sql`${t.principalKind} IN ('org', 'member', 'role')`,
    ),
    levelCheck: check(
      "object_access_grants_level_check",
      sql`(${t.principalKind} = 'org' AND ${t.level} IN ('editor', 'viewer', 'none')) OR (${t.principalKind} <> 'org' AND ${t.level} IN ('owner', 'editor', 'viewer'))`,
    ),
  }),
);
