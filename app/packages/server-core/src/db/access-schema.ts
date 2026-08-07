/**
 * Break-glass access: time-boxed permission elevation.
 *
 * The shape is the one `workflow_approvals` already established — a pending
 * row, a fan-out to whatever transports the org has configured, and a
 * conditional UPDATE that makes two racing deciders produce exactly one
 * decision. What is new is that the request stands on its own (no run is
 * suspended on it) and that an approval *does* something: it opens a window
 * during which the requester holds permissions their role does not grant.
 *
 * One table, not two. A grant is not a separate object from the request that
 * produced it — splitting them would let a grant exist whose request said
 * something else, which is precisely the thing an auditor is checking. The
 * row is the request, the decision, and the window, in that order.
 */
import { index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { organizations, users } from "./core-schema.js";

/**
 * One break-glass request and, if approved, the elevation it opened.
 *
 * A grant is live when `status = 'approved'`, `revoked_at IS NULL`, and now is
 * inside `[granted_at, grant_expires_at)`. Nothing sweeps expiry: the window is
 * evaluated on every permission resolution, so a grant stops applying the
 * instant it lapses rather than whenever a job next runs. That is the only
 * correct behaviour for something that hands out authority — a sweeper that
 * fell behind would be a sweeper that extended everyone's access.
 */
export const accessRequests = pgTable(
  "access_requests",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Who is asking. Cascades: a departed member's history goes with them. */
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Name snapshot, so the queue and the audit trail read as people. */
    userName: text("user_name"),
    /**
     * The permission strings being asked for. Stored verbatim, wildcards and
     * all; the decision path checks they are a subset of what the *approver*
     * holds, so a request can never mint authority nobody in the room had.
     */
    permissions: jsonb("permissions").$type<string[]>().notNull().default([]),
    /** Why. Required by the route — an unexplained elevation is not auditable. */
    reason: text("reason").notNull(),
    /** How long the elevation should last once granted. */
    durationMinutes: integer("duration_minutes").notNull(),
    /** "pending" | "approved" | "denied" | "expired" */
    status: text("status").notNull().default("pending"),
    /** When an undecided request stops being decidable (counts as a denial). */
    expiresAt: timestamp("expires_at").notNull(),
    decidedAt: timestamp("decided_at"),
    decidedByUserId: text("decided_by_user_id"),
    decidedByName: text("decided_by_name"),
    /** Why it was denied, or a condition attached to an approval. */
    decisionNote: text("decision_note"),
    /** Start of the elevation window; set at approval. */
    grantedAt: timestamp("granted_at"),
    /** End of the elevation window; `granted_at + duration_minutes`. */
    grantExpiresAt: timestamp("grant_expires_at"),
    /** Set when a live grant was ended early. */
    revokedAt: timestamp("revoked_at"),
    revokedByUserId: text("revoked_by_user_id"),
    revokedByName: text("revoked_by_name"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    orgStatusIdx: index("access_requests_org_status_idx").on(t.organizationId, t.status),
    // The hot path: "does this user hold a live grant right now", asked on
    // every permission resolution for a member who has ever requested one.
    orgUserStatusIdx: index("access_requests_org_user_status_idx").on(
      t.organizationId,
      t.userId,
      t.status,
    ),
    orgCreatedIdx: index("access_requests_org_created_idx").on(t.organizationId, t.createdAt),
  }),
);
