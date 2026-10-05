/**
 * Enterprise single sign-on: SAML/OIDC through WorkOS, SCIM directory sync,
 * and IdP-group to role mapping, for signing in to Infrawrench itself.
 *
 * Infrawrench organizations are our own rows (`organizations.id` is a UUID we
 * mint), not WorkOS organizations: plain AuthKit sign-in never needed one.
 * Enterprise SSO does, because SSO connections, directories and verified
 * domains all hang off a WorkOS organization. `org_sso_settings` is the link,
 * created lazily the first time an owner opens the Single sign-on page and
 * asks for it, and it carries every org-side switch.
 *
 * Everything an IdP admin configures (the SAML/OIDC connection, the SCIM
 * directory) lives in WorkOS and is reached through the Admin Portal; nothing
 * here duplicates it. What lives here is what WorkOS cannot know: which
 * Infrawrench role a directory group means, who may sign in without SSO when
 * the IdP is down, and which Infrawrench membership a directory user became.
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { organizations, users } from "./core-schema.js";
import { roles } from "./schema.js";

/**
 * One row per org that has started SSO setup. Absent means "never set up",
 * which every reader treats exactly like `enforce_sso = false`.
 */
export const orgSsoSettings = pgTable(
  "org_sso_settings",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The WorkOS organization (`org_...`) the connection and directory belong to. */
    workosOrganizationId: text("workos_organization_id").notNull(),
    /**
     * Require members whose email domain is one of `verified_domains` to have
     * signed in through this org's SSO connection. Enabling is refused unless
     * a verified domain, an active connection and at least one break-glass
     * owner exist, which is the lockout guard.
     */
    enforceSso: boolean("enforce_sso").notNull().default(false),
    /**
     * Snapshot of the WorkOS organization's verified domains, lower-cased.
     * Refreshed on every status read and on `organization_domain.*` webhooks.
     * The enforcement gate reads this on every request, so it must not need a
     * WorkOS round trip; a stale snapshot can only be stale toward the domains
     * an owner verified moments ago, never toward ones they never verified.
     */
    verifiedDomains: jsonb("verified_domains").$type<string[]>().notNull().default([]),
    /**
     * Owners who may sign in without SSO while enforcement is on: the way in
     * when the IdP is down or misconfigured. Each user id must hold the owner
     * role at the moment it is checked; a demoted owner silently stops being
     * exempt. Every bypassing session is audit-logged.
     */
    breakGlassUserIds: jsonb("break_glass_user_ids").$type<string[]>().notNull().default([]),
    /**
     * Create and remove memberships from Directory Sync events. Off by default:
     * an org connects a directory, previews the mappings, and only then lets
     * the directory start changing who is in the org.
     */
    provisioningEnabled: boolean("provisioning_enabled").notNull().default(false),
    /**
     * Role a provisioned member gets when none of their groups is mapped.
     * Null means the system `member` role.
     */
    defaultRoleId: text("default_role_id").references(() => roles.id, { onDelete: "set null" }),
    /**
     * Buy a seat when provisioning needs one. Off means a directory user past
     * the org's seat capacity is recorded as `seat_limit` rather than added,
     * so a directory sync can never grow a bill nobody approved.
     */
    autoAddSeats: boolean("auto_add_seats").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    updatedByUserId: text("updated_by_user_id"),
  },
  (t) => ({
    workosOrgUnique: uniqueIndex("org_sso_settings_workos_org_unique").on(t.workosOrganizationId),
  }),
);

/**
 * "Members of this IdP group get this role." Evaluated in `position` order,
 * first match wins; the preview shows every member whose groups matched more
 * than one row so the order is a decision someone saw, not an accident.
 */
export const ssoGroupRoleMappings = pgTable(
  "sso_group_role_mappings",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** WorkOS directory group id (`directory_group_...`). */
    directoryGroupId: text("directory_group_id").notNull(),
    /** Group name snapshot, so the table reads as names even if WorkOS is down. */
    groupName: text("group_name").notNull(),
    /**
     * Never the owner role: the route refuses it, because an IdP admin is not
     * an Infrawrench owner and a group mapping must not make them one.
     * Cascades: a deleted custom role takes its mappings with it rather than
     * leaving rows that point nowhere.
     */
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    /** Lower wins. Gaps are fine; ties break on `created_at`. */
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgGroupUnique: uniqueIndex("sso_group_role_mappings_org_group_unique").on(
      t.organizationId,
      t.directoryGroupId,
    ),
    orgIdx: index("sso_group_role_mappings_org_idx").on(t.organizationId, t.position),
  }),
);

/**
 * One row per directory user WorkOS has told us about, and the membership it
 * became. Kept even when provisioning is off (status `observed`), so turning it
 * on can preview who would be added before anyone is.
 */
export const ssoDirectoryMembers = pgTable(
  "sso_directory_members",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    directoryId: text("directory_id").notNull(),
    /** WorkOS directory user id (`directory_user_...`). */
    directoryUserId: text("directory_user_id").notNull(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    /** The Infrawrench user this directory user resolved to, once one exists. */
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    /** Directory group ids at the last sync. */
    groupIds: jsonb("group_ids").$type<string[]>().notNull().default([]),
    /**
     * `active` (member, role from mappings), `observed` (provisioning off),
     * `deprovisioned` (removed by the directory), `seat_limit` (no seat to
     * add them to), `domain_unverified` (email outside the org's verified
     * domains, never provisioned), `protected` (deprovision refused because it
     * would remove the last owner).
     */
    status: text("status").notNull(),
    /**
     * Whether the directory created this membership. A member who was invited
     * by hand and later appears in the directory is linked, not owned: their
     * role still follows the mappings, but nothing records that the directory
     * added them.
     */
    provisionedByDirectory: boolean("provisioned_by_directory").notNull().default(false),
    lastSyncedAt: timestamp("last_synced_at").notNull().defaultNow(),
    deprovisionedAt: timestamp("deprovisioned_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    orgUserUnique: uniqueIndex("sso_directory_members_org_dir_user_unique").on(
      t.organizationId,
      t.directoryUserId,
    ),
    orgUserIdx: index("sso_directory_members_org_user_idx").on(t.organizationId, t.userId),
  }),
);

/**
 * Every WorkOS webhook event id processed, for replay protection: WorkOS
 * redelivers on any non-2xx and documents that an event may arrive more than
 * once. The signature's timestamp tolerance stops an old capture being
 * replayed; this stops a fresh one being processed twice. Rows older than the
 * tolerance window are useless and swept on write.
 */
export const workosWebhookEvents = pgTable(
  "workos_webhook_events",
  {
    id: text("id").primaryKey(),
    eventType: text("event_type").notNull(),
    organizationId: text("organization_id"),
    receivedAt: timestamp("received_at").notNull().defaultNow(),
  },
  (t) => ({
    receivedIdx: index("workos_webhook_events_received_idx").on(t.receivedAt),
  }),
);
