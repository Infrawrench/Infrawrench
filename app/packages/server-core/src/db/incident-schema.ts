import { pgTable, text, timestamp, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core";

import { organizations, users } from "./core-schema.js";

/**
 * **Incident mode** — a declared operational incident and the things declaring
 * it did on the operator's behalf.
 *
 * Do not confuse this with `provider_status_incidents` (schema.ts), which is a
 * *provider's* status-page entry that we scrape and correlate against the org's
 * resources. That one is something happening to us; this one is something we
 * said out loud. The two meet only on the timeline, where an overlapping
 * provider incident is evidence.
 *
 * The table holds the incident's own facts and nothing else. The timeline is
 * assembled **on read** by joining the feeds that already exist (resource
 * changes, deployments, cost anomalies, provider incidents, audit, freezes,
 * probes, metric alerts) — copying those rows in here would freeze a snapshot
 * that goes stale the moment anything is corrected upstream, and would make
 * this table grow with the org's entire event volume.
 */
export const incidents = pgTable(
  "incidents",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** `sev1`…`sev4` — see `INCIDENT_SEVERITIES` in client-core. */
    severity: text("severity").$type<"sev1" | "sev2" | "sev3" | "sev4">().notNull().default("sev2"),
    /**
     * `mitigated` is a real state, not a synonym for resolved: it is the moment
     * the paging stops and the write-up starts, and it is what makes
     * time-to-mitigate a measurement rather than a guess.
     */
    status: text("status").$type<"open" | "mitigated" | "resolved">().notNull().default("open"),
    summary: text("summary"),
    /** Backdatable — people declare after they start firefighting, not before. */
    startedAt: timestamp("started_at").notNull().defaultNow(),
    mitigatedAt: timestamp("mitigated_at"),
    resolvedAt: timestamp("resolved_at"),
    declaredByUserId: text("declared_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    resolvedByUserId: text("resolved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /**
     * Affected resource ids. Deliberately **not** foreign keys and deliberately
     * a JSON array rather than a join table: this is the operator's claim at
     * 03:14 about what is broken, and it has to survive the resource being
     * deleted (which, during an incident, is a thing that happens).
     */
    affectedResourceIds: jsonb("affected_resource_ids").$type<string[]>().notNull().default([]),
    affectedAccountIds: jsonb("affected_account_ids").$type<string[]>().notNull().default([]),
    /** Where the write-up was filed, once anyone filed it. */
    issueUrl: text("issue_url"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgStartedIdx: index("incidents_org_started_idx").on(t.organizationId, t.startedAt),
    orgStatusIdx: index("incidents_org_status_idx").on(t.organizationId, t.status),
  }),
);

/**
 * Operator notes: the running commentary that no join can reconstruct.
 *
 * `occurred_at` is separate from `created_at` on purpose. Notes are written
 * late — somebody catching up at 04:00 types "03:14: failed over to the
 * replica" — and a timeline that plots them at the moment they were *typed*
 * puts the write-up out of order with the events it explains.
 */
export const incidentNotes = pgTable(
  "incident_notes",
  {
    id: text("id").primaryKey(),
    incidentId: text("incident_id")
      .notNull()
      .references(() => incidents.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    authorUserId: text("author_user_id").references(() => users.id, { onDelete: "set null" }),
    occurredAt: timestamp("occurred_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    incidentIdx: index("incident_notes_incident_idx").on(t.incidentId, t.occurredAt),
  }),
);

/**
 * One row per side effect a declaration performed, **including the ones that
 * failed**.
 *
 * This table is the feature's partial-failure stance made structural. Declaring
 * writes the incident first and then attempts each opted-in artefact; an
 * artefact that throws lands here with `status = "failed"` and the error text,
 * so a Slack outage costs the announcement and never the incident. Resolving
 * consults this table to undo exactly what this incident created — the freeze
 * it opened, not whatever freeze happens to be in effect.
 *
 * `ref_id` / `ref_secondary` are plain text with no foreign key, on purpose:
 * the row is a record of *what we did*, and it has to stay legible after the
 * freeze is deleted or the Slack message is removed. `ref_secondary` carries
 * the second half of a compound reference (a Slack message `ts` beside its
 * channel id, the window minutes beside a pinned moment's timestamp).
 */
export const incidentArtifacts = pgTable(
  "incident_artifacts",
  {
    id: text("id").primaryKey(),
    incidentId: text("incident_id")
      .notNull()
      .references(() => incidents.id, { onDelete: "cascade" }),
    /** `freeze` | `moment` | `slack` | `status-page`. */
    kind: text("kind").$type<"freeze" | "moment" | "slack" | "status-page">().notNull(),
    /** `created` | `failed` | `closed`. */
    status: text("status").$type<"created" | "failed" | "closed">().notNull(),
    label: text("label"),
    refId: text("ref_id"),
    refSecondary: text("ref_secondary"),
    /** Verbatim enough to act on. Null unless `status` is `failed`. */
    error: text("error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    incidentIdx: index("incident_artifacts_incident_idx").on(t.incidentId),
    /**
     * One artefact of each kind per incident. Retrying a failed Slack post
     * overwrites the failure rather than accumulating a pile of attempts, and
     * "did this incident open a freeze?" stays a single-row question.
     */
    incidentKindUnique: uniqueIndex("incident_artifacts_incident_kind_unique").on(
      t.incidentId,
      t.kind,
    ),
  }),
);

/**
 * A written update on a public status page.
 *
 * Status pages were a purely *derived* view until now: every word on them came
 * from probe state and uptime rollups, so there was no way to say "we know,
 * we're on it" — which is the one thing visitors turn up for. A notice is that
 * sentence, and incident mode is what usually writes it.
 *
 * The security stance of `status_pages` carries over unchanged: nothing here is
 * assembled into the public payload by narrowing an internal shape. The public
 * assembler picks `title`, `body`, `state` and the timestamps by name, and the
 * incident id is deliberately **not** among them — a visitor learns that
 * something is wrong, never the org's internal id for it.
 *
 * `affected_component_ids` names components on this page; an empty array means
 * the notice is about the page as a whole.
 */
export const statusPageNotices = pgTable(
  "status_page_notices",
  {
    id: text("id").primaryKey(),
    /**
     * Not a Drizzle foreign key only because it would make this module import
     * `schema.ts`, which imports this one back. The migration adds the real
     * `ON DELETE CASCADE` constraint, so a deleted page still takes its notices
     * with it.
     */
    statusPageId: text("status_page_id").notNull(),
    /** The declared incident that wrote it, when one did. Text, no FK. */
    incidentId: text("incident_id"),
    title: text("title").notNull(),
    body: text("body"),
    /**
     * The vocabulary a status page visitor already knows, and the same four
     * words `provider_status_incidents.state` uses.
     */
    state: text("state")
      .$type<"investigating" | "identified" | "monitoring" | "resolved">()
      .notNull()
      .default("investigating"),
    affectedComponentIds: jsonb("affected_component_ids").$type<string[]>().notNull().default([]),
    /** Ascending display order is by `startedAt`; newest renders first. */
    startedAt: timestamp("started_at").notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    pageIdx: index("status_page_notices_page_idx").on(t.statusPageId, t.startedAt),
    incidentIdx: index("status_page_notices_incident_idx").on(t.incidentId),
  }),
);

/**
 * Unused today, but kept beside the table it belongs to: how many days of
 * resolved notices the public payload carries. Long enough that a visitor
 * arriving the morning after sees what happened, short enough that the page is
 * about now.
 */
export const STATUS_PAGE_NOTICE_RETENTION_DAYS: number = 14;

/** Cap on notices returned in one public payload, newest first. */
export const STATUS_PAGE_NOTICE_LIMIT: number = 10;

/** Re-exported for callers that want the row type without the table. */
export type IncidentRow = typeof incidents.$inferSelect;
export type IncidentNoteRow = typeof incidentNotes.$inferSelect;
export type IncidentArtifactRow = typeof incidentArtifacts.$inferSelect;
export type StatusPageNoticeRow = typeof statusPageNotices.$inferSelect;
