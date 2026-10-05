import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { GithubIacSource, GithubIssueRoute, GithubRepoRef } from "@infrawrench/client-core";

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
 * The savings scan's memory: which orphaned/oversized findings it has already
 * seen, so it raises `savingsFindings` for new ones only and can tell when one
 * has gone away. Findings are recomputed on read, so without this there is no
 * "new".
 */
export const savingsFindingStates = pgTable(
  "savings_finding_states",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.organizationId, t.sourceKind, t.sourceId] }),
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
