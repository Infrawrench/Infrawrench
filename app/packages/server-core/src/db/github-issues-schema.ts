import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  GithubIacSource,
  GithubIssueRoute,
  GithubRepoRef,
  SavingsFindingFilter,
  SavingsFindingSort,
} from "@infrawrench/client-core";

import { organizations } from "./core-schema.js";

/**
 * GitHub issue filing for findings, through the org's existing GitHub App
 * installation (`github_installations`). One settings row per org; routes and
 * Terraform sources are stored inline as jsonb because they are edited and
 * reasoned about as one document (the settings PUT is whole-document, like
 * alert rules, since route order is part of the meaning).
 */
export const githubIssueSettings = pgTable(
  "github_issue_settings",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    defaultRepo: jsonb("default_repo").$type<GithubRepoRef | null>(),
    labels: jsonb("labels").$type<string[]>().notNull().default([]),
    assignees: jsonb("assignees").$type<string[]>().notNull().default([]),
    routes: jsonb("routes").$type<GithubIssueRoute[]>().notNull().default([]),
    resolveAction: text("resolve_action").notNull().default("comment"),
    pullRequestsEnabled: boolean("pull_requests_enabled").notNull().default(false),
    iacSources: jsonb("iac_sources").$type<GithubIacSource[]>().notNull().default([]),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    resolveActionValid: check(
      "github_issue_settings_resolve_action_valid",
      sql`${t.resolveAction} IN ('close', 'comment', 'none')`,
    ),
  }),
);

/**
 * A finding filed as a GitHub issue. Unlike the Jira/Linear link tables this
 * one has a lifecycle: `state` follows the issue (closed when the savings scan
 * resolves it, or when GitHub reports it closed on the next file attempt), and
 * at most one **open** link may exist per finding fingerprint, which is the
 * database half of "comment on the open issue instead of duplicating".
 */
export const githubIssueLinks = pgTable(
  "github_issue_links",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind").notNull(),
    /** The finding's own id, opaque here (findings live in several tables). */
    sourceId: text("source_id").notNull(),
    /** Hash of (org, kind, source id); also written into the issue body. */
    fingerprint: text("fingerprint").notNull(),
    installationId: integer("installation_id").notNull(),
    /** `owner/name` at filing time. */
    repo: text("repo").notNull(),
    issueNumber: integer("issue_number").notNull(),
    issueUrl: text("issue_url").notNull(),
    state: text("state").notNull().default("open"),
    autoFiled: boolean("auto_filed").notNull().default(false),
    pullRequestNumber: integer("pull_request_number"),
    pullRequestUrl: text("pull_request_url"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at"),
  },
  (t) => ({
    openFingerprintUnique: uniqueIndex("github_issue_links_open_fingerprint_unique")
      .on(t.organizationId, t.fingerprint)
      .where(sql`${t.state} = 'open'`),
    orgKindIdx: index("github_issue_links_org_kind_idx").on(t.organizationId, t.sourceKind),
    stateValid: check("github_issue_links_state_valid", sql`${t.state} IN ('open', 'closed')`),
    sourceKindValid: check(
      "github_issue_links_source_kind_valid",
      sql`${t.sourceKind} IN ('cost_anomaly', 'orphan', 'oversized', 'posture_finding', 'expiring', 'probe', 'commitment_idle')`,
    ),
  }),
);

/**
 * The savings findings' memory, written by the savings scan (every six hours,
 * unscoped) and by `GET /savings/findings` (observations only):
 *
 * - which findings exist, so the scan raises `savingsFindings` for new ones
 *   only and can tell when one has gone away. Findings are recomputed on read,
 *   so without this there is no "new";
 * - each finding's lifecycle (`status`, who changed it and when, a note, how a
 *   completed one got there): the savings workflow;
 * - a snapshot of what the finding was (title, account, region, tags, monthly
 *   savings), because a completed finding is usually one the finder no longer
 *   reports, and it must still be listable with what it was worth.
 *
 * Rows are kept when a finding goes away (`gone_at`), never deleted: the
 * workflow history would go with them. `alert_pending` replaces the old
 * "delete the row to re-raise it" trick: a row first written by a read, or
 * held back by the scan's alert cap, is raised by the next scan. It defaults
 * to false so the rows that existed before the column (all already raised)
 * are not raised a second time.
 */
export const savingsFindingStates = pgTable(
  "savings_finding_states",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** `orphan` | `oversized` | `extended_support` | `seat`. */
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    /** Detected date: the first observation of this occurrence. */
    firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
    /** Set when a successful scan stopped reporting it; cleared when it returns. */
    goneAt: timestamp("gone_at"),
    /** True until the scan has raised (or baselined) the finding's alert. */
    alertPending: boolean("alert_pending").notNull().default(false),
    status: text("status").notNull().default("ready"),
    statusChangedAt: timestamp("status_changed_at"),
    /** No FK: a departed member's changes stay attributed by id. */
    statusChangedByUserId: text("status_changed_by_user_id"),
    statusNote: text("status_note"),
    /** For `completed`: `manual`, or `resolved` (a scan stopped reporting it). */
    resolution: text("resolution"),
    title: text("title").notNull().default(""),
    detail: text("detail"),
    pluginId: text("plugin_id"),
    pluginName: text("plugin_name"),
    accountId: text("account_id"),
    accountName: text("account_name"),
    region: text("region"),
    /** `resources.id`, no FK: the commonest completion is the resource's deletion. */
    resourceId: text("resource_id"),
    resourceName: text("resource_name").notNull().default(""),
    resourceTypeId: text("resource_type_id"),
    resourceTypeName: text("resource_type_name"),
    tags: jsonb("tags").$type<Record<string, string>>().notNull().default({}),
    monthlyAmount: doublePrecision("monthly_amount"),
    currency: text("currency"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.organizationId, t.sourceKind, t.sourceId] }),
    orgStatusIdx: index("savings_finding_states_org_status_idx").on(t.organizationId, t.status),
    statusValid: check(
      "savings_finding_states_status_valid",
      sql`${t.status} IN ('ready', 'in_progress', 'completed', 'archived')`,
    ),
    resolutionValid: check(
      "savings_finding_states_resolution_valid",
      sql`${t.resolution} IS NULL OR ${t.resolution} IN ('manual', 'resolved')`,
    ),
  }),
);

/**
 * Saved views over the savings findings list: a name plus the filter, status
 * tab and sort to reopen. Shared through `object_access_grants` as the
 * `savings_view` type (creator is the implicit owner, the canvas rule).
 * Names are unique per org among live rows, the saved cost filter rule, so
 * the CLI's `--view <name>` and org config as code can address them.
 */
export const savingsViews = pgTable(
  "savings_views",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    /** A `SavingsFindingStatusFilter`: `open`, one status, or `all`. */
    status: text("status").notNull().default("open"),
    /** A normalized `SavingsFindingFilter`. */
    filter: jsonb("filter").$type<SavingsFindingFilter>().notNull().default({}),
    sort: jsonb("sort")
      .$type<SavingsFindingSort>()
      .notNull()
      .default({ field: "savings", direction: "desc" }),
    createdByUserId: text("created_by_user_id"),
    /** Soft delete, the saved filter rule. */
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("savings_views_org_idx").on(t.organizationId),
    orgNameUnique: uniqueIndex("savings_views_org_name_unique")
      .on(t.organizationId, t.name)
      .where(sql`deleted_at IS NULL`),
  }),
);

/**
 * One row per org: when the savings scan last ran (the claim column, same
 * conditional-upsert idiom as the daily alert radars) and whether its first,
 * baseline-only scan has happened.
 */
export const savingsFindingScans = pgTable("savings_finding_scans", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  lastScanAt: timestamp("last_scan_at"),
  baselinedAt: timestamp("baselined_at"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
