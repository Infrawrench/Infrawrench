/**
 * Just-in-time access: policies an admin writes, and the requests (with the
 * provider grants they produce) that members raise under them.
 *
 * Satellite schema: imports only `core-schema.js`, re-exported from
 * `schema.ts`.
 *
 * One request table, not a request table and a grant table, for the reason
 * break-glass gives (`access-schema.ts`): a grant whose request said something
 * else is exactly what an auditor is looking for, so the row is the request,
 * the decision, the grant and its end, in that order.
 *
 * Unlike break-glass, **expiry is swept, not evaluated**. A break-glass
 * elevation lives in Infrawrench's own permission resolver, which can simply
 * stop honouring it; a just-in-time grant lives in somebody's cloud, and
 * nothing there stops honouring it until something calls the provider. So the
 * `jit-access-expiry` poller pass revokes, records every failure on the row,
 * and retries with backoff; and the access review flags any grant whose revoke
 * failed or that is still marked held past its window.
 *
 * Deliberately **no foreign keys** from a request to the requester, the
 * account or the policy. A cascade from any of them would delete the only
 * record that a grant exists upstream, at exactly the moment (somebody left,
 * an account was disconnected, a policy was retired) when that grant most
 * needs revoking. The row keeps name snapshots so it stays legible, and a
 * revoke against an account that no longer exists fails loudly instead of
 * vanishing quietly.
 */
import { boolean, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { organizations } from "./core-schema.js";

export interface JitPolicyTargetRow {
  scopeId: string;
  scopeName: string;
  roleId: string;
  roleName: string;
}

export const jitAccessPolicies = pgTable(
  "jit_access_policies",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    enabled: boolean("enabled").notNull().default(true),
    /** The connected account whose plugin grants. Not an FK: see the module doc. */
    accountId: text("account_id").notNull(),
    pluginId: text("plugin_id").notNull(),
    targets: jsonb("targets").$type<JitPolicyTargetRow[]>().notNull().default([]),
    maxDurationMinutes: integer("max_duration_minutes").notNull(),
    defaultDurationMinutes: integer("default_duration_minutes").notNull(),
    requestTimeoutMinutes: integer("request_timeout_minutes").notNull().default(60),
    requesterUserIds: jsonb("requester_user_ids").$type<string[]>().notNull().default([]),
    requesterRoleIds: jsonb("requester_role_ids").$type<string[]>().notNull().default([]),
    approverUserIds: jsonb("approver_user_ids").$type<string[]>().notNull().default([]),
    approverRoleIds: jsonb("approver_role_ids").$type<string[]>().notNull().default([]),
    approverOnCallScheduleIds: jsonb("approver_on_call_schedule_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    allowSelfApprovalDuringIncident: boolean("allow_self_approval_during_incident")
      .notNull()
      .default(false),
    requireReason: boolean("require_reason").notNull().default(true),
    requireTicket: boolean("require_ticket").notNull().default(false),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("jit_access_policies_org_idx").on(t.organizationId),
  }),
);

export const jitAccessRequests = pgTable(
  "jit_access_requests",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    policyId: text("policy_id"),
    policyName: text("policy_name"),
    accountId: text("account_id").notNull(),
    accountName: text("account_name"),
    pluginId: text("plugin_id").notNull(),
    scopeId: text("scope_id").notNull(),
    scopeName: text("scope_name").notNull(),
    roleId: text("role_id").notNull(),
    roleName: text("role_name").notNull(),
    userId: text("user_id").notNull(),
    userName: text("user_name"),
    userEmail: text("user_email"),
    principalId: text("principal_id").notNull(),
    principalName: text("principal_name").notNull(),
    principalKind: text("principal_kind").$type<"user" | "group">().notNull().default("user"),
    principalMatched: boolean("principal_matched").notNull().default(false),
    reason: text("reason").notNull(),
    ticket: text("ticket"),
    durationMinutes: integer("duration_minutes").notNull(),
    /** See `JitRequestStatus` in client-core. */
    status: text("status").notNull().default("pending"),
    requestExpiresAt: timestamp("request_expires_at").notNull(),
    decidedAt: timestamp("decided_at"),
    decidedByUserId: text("decided_by_user_id"),
    decidedByName: text("decided_by_name"),
    decisionNote: text("decision_note"),
    selfApproved: boolean("self_approved").notNull().default(false),
    incidentId: text("incident_id"),
    grantedAt: timestamp("granted_at"),
    grantExpiresAt: timestamp("grant_expires_at"),
    /** The plugin's opaque handle. Never required to revoke. */
    grantRef: text("grant_ref"),
    preexisting: boolean("preexisting").notNull().default(false),
    extendedMinutes: integer("extended_minutes").notNull().default(0),
    endedAt: timestamp("ended_at"),
    endedByUserId: text("ended_by_user_id"),
    endedByName: text("ended_by_name"),
    /** "expired" | "revoked" | "grant_failed" */
    endReason: text("end_reason"),
    lastError: text("last_error"),
    grantAttempts: integer("grant_attempts").notNull().default(0),
    revokeAttempts: integer("revoke_attempts").notNull().default(0),
    /**
     * When the expiry pass should next touch this row. Doubles as the lease on
     * an in-flight grant or revoke: a worker that dies mid-call leaves the row
     * due again once the lease runs out, and the revoke is idempotent.
     */
    nextActionAt: timestamp("next_action_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgStatusIdx: index("jit_access_requests_org_status_idx").on(t.organizationId, t.status),
    orgCreatedIdx: index("jit_access_requests_org_created_idx").on(t.organizationId, t.createdAt),
    // The sweep: every row with something due, across orgs.
    dueIdx: index("jit_access_requests_due_idx").on(t.status, t.nextActionAt),
  }),
);
