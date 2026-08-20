/**
 * Runbooks: the document, the runs performed against it, and the per-step
 * record of who did what.
 *
 * Three tables, and the split between the last two is the load-bearing
 * decision. A run's steps could have been one jsonb column on the run — the
 * runbook's own steps are exactly that — but two responders working the same
 * incident tick different steps at the same time, and a read-modify-write of a
 * shared jsonb loses whichever update lands second. Per-step rows make each
 * tick an independent `UPDATE`, so the failure mode simply cannot occur.
 *
 * The runbook's own steps stay jsonb because they are only ever read and
 * written whole, by one editor, exactly like a workflow's source.
 *
 * Lives in its own module (importing only `core-schema.js`) and is re-exported
 * from `schema.ts`, the satellite-schema convention.
 */
import {
  pgTable,
  text,
  boolean,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { organizations, users } from "./core-schema.js";

/**
 * The stored shape of a step. Structurally the client-core `RunbookStep`, and
 * spelled with explicit `| undefined` so it stays assignable from it under
 * `exactOptionalPropertyTypes` — the schema deliberately does not import from
 * client-core, since a db module's only dependency is `core-schema`.
 */
interface StoredRunbookStep {
  id: string;
  kind: "manual" | "workflow" | "link";
  title: string;
  body: string;
  workflowId?: string | undefined;
  url?: string | undefined;
}

/**
 * One runbook.
 *
 * `resourceTypeIds` is comma-joined text, the `backup_policies` convention:
 * short opaque identifiers with no commas, only ever read whole.
 *
 * `createdByUserId` is nulled rather than cascaded when the user leaves. The
 * org's runbook outlives whoever typed it in — and unlike most authored rows,
 * this one is read *by strangers under pressure*, so losing it because someone
 * offboarded would be the worst-timed data loss in the product.
 */
export const runbooks = pgTable(
  "runbooks",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    /** Ordered steps. Read and written whole; see the module note. */
    steps: jsonb("steps").notNull().$type<StoredRunbookStep[]>().default([]),
    /** Comma-joined resource type ids; empty means "not scoped to a type". */
    resourceTypeIds: text("resource_type_ids").notNull().default(""),
    tagKey: text("tag_key"),
    tagValue: text("tag_value"),
    /**
     * Off keeps the row and hides it from the "what applies here" lookup — the
     * schedules `paused` stance. Retiring a runbook must not cost you the
     * history of the runs performed against it.
     */
    enabled: boolean("enabled").notNull().default(true),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("runbooks_org_idx").on(t.organizationId),
    /** One name per org: two runbooks called "Failover" is how the wrong one gets run. */
    orgNameUnique: uniqueIndex("runbooks_org_name_unique").on(t.organizationId, t.name),
  }),
);

/**
 * One performance of a runbook.
 *
 * `incidentId` is a plain column rather than a foreign key with a cascade: a
 * run performed during an incident is evidence about the run, and deleting the
 * incident must not delete the record that somebody followed the failover
 * procedure at 03:14.
 */
export const runbookRuns = pgTable(
  "runbook_runs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /**
     * Cascade-deleted with the runbook, unlike the incident link. Deleting a
     * runbook is an explicit "this procedure is gone" — keeping orphan runs
     * whose steps reference a document nobody can read would be worse than
     * losing them, and `enabled: false` exists precisely so nobody has to.
     */
    runbookId: text("runbook_id")
      .notNull()
      .references(() => runbooks.id, { onDelete: "cascade" }),
    /**
     * The runbook's name when the run started. Copied for the same reason each
     * step's title is: a renamed runbook must not silently rewrite the history
     * of what was performed.
     */
    runbookName: text("runbook_name").notNull(),
    /** "running" | "completed" | "abandoned" */
    status: text("status")
      .$type<"running" | "completed" | "abandoned">()
      .notNull()
      .default("running"),
    incidentId: text("incident_id"),
    startedByUserId: text("started_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
    summary: text("summary"),
  },
  (t) => ({
    orgIdx: index("runbook_runs_org_idx").on(t.organizationId),
    runbookIdx: index("runbook_runs_runbook_idx").on(t.runbookId, t.startedAt),
    incidentIdx: index("runbook_runs_incident_idx").on(t.incidentId),
  }),
);

/**
 * One step of one run.
 *
 * `title` and `kind` are snapshots of the step as it was when the run started.
 * A postmortem that renders today's wording against last month's run is not
 * merely stale — it is quietly wrong about what somebody was asked to do.
 */
export const runbookRunSteps = pgTable(
  "runbook_run_steps",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runbookRuns.id, { onDelete: "cascade" }),
    /** The step's id in the runbook document at the time of the run. */
    stepId: text("step_id").notNull(),
    /** Ordering within the run; the document's order, frozen. */
    position: integer("position").notNull(),
    title: text("title").notNull(),
    kind: text("kind").$type<"manual" | "workflow" | "link">().notNull(),
    /** "pending" | "done" | "skipped" | "failed" */
    status: text("status")
      .$type<"pending" | "done" | "skipped" | "failed">()
      .notNull()
      .default("pending"),
    note: text("note"),
    /** The workflow run this step kicked off, when it kicked one off. */
    workflowRunId: text("workflow_run_id"),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at"),
  },
  (t) => ({
    runIdx: index("runbook_run_steps_run_idx").on(t.runId, t.position),
    /** One row per step per run — what makes a tick an idempotent update. */
    runStepUnique: uniqueIndex("runbook_run_steps_run_step_unique").on(t.runId, t.stepId),
  }),
);
