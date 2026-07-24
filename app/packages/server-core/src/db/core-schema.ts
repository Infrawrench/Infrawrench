/**
 * Core tables referenced by the satellite schema modules (`agent-schema.ts`,
 * `workflow-schema.ts`) as well as by `schema.ts` itself.
 *
 * These live in their own module (with no internal imports) so the satellites
 * can reference them without importing `schema.ts` — which re-exports the
 * satellites and would otherwise form an import cycle. Everything here is
 * re-exported from `schema.ts`, so consumers keep importing from
 * `@infrawrench/server-core/db/schema` as before.
 */
import {
  pgTable,
  text,
  boolean,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(), // WorkOS org ID
  displayName: text("display_name").notNull(),
  /**
   * Optional monthly token-spend cap for the chat agent, in micro-dollars
   * (1 USD = 1_000_000). When the org's current-month chat_usage cost sum
   * exceeds this, the agent loop refuses new turns. Null means no cap.
   */
  chatMonthlyCapMicros: integer("chat_monthly_cap_micros"),
  /**
   * Platform-granted free ride: the org is never billed, gets every paid-plan
   * perk, and chat usage is uncapped by default (an org-set
   * chatMonthlyCapMicros still applies) and never reported to Stripe.
   * Set by platform admins via /api/admin — see web/src/auth/platform-admin.ts.
   */
  complimentary: boolean("complimentary").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(), // WorkOS user ID
    email: text("email").notNull(),
    displayName: text("display_name"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    emailIdx: uniqueIndex("users_email_unique").on(t.email),
  }),
);

export const bastionVms = pgTable(
  "bastion_vms",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** SHA-256 of the full enrollment token; the agent presents the plaintext token on each connect. */
    hashedToken: text("hashed_token").notNull(),
    /** First 8 chars of the token for display ("iwb_abc1…"). */
    tokenPrefix: text("token_prefix").notNull(),
    agentVersion: text("agent_version"),
    lastSeenAt: timestamp("last_seen_at"),
    /** "pending" | "active" | "revoked" — purely descriptive; "active" doesn't mean "currently connected". */
    status: text("status").notNull().default("pending"),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    hashedTokenUnique: uniqueIndex("bastion_vms_hashed_token_unique").on(t.hashedToken),
    orgIdx: index("bastion_vms_org_idx").on(t.organizationId),
  }),
);

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    pluginId: text("plugin_id").notNull(),
    displayName: text("display_name").notNull(),
    /** AES-256-GCM encrypted JSON blob of credentials */
    encryptedCredentials: text("encrypted_credentials").notNull(),
    credentialsIv: text("credentials_iv").notNull(),
    /**
     * Optional: route this account's plugin HTTPS calls through a bastion agent.
     * SET NULL on bastion delete so the account keeps working over direct egress.
     */
    bastionId: text("bastion_id").references(() => bastionVms.id, { onDelete: "set null" }),
    syncVersion: integer("sync_version").notNull().default(0),
    lastPolledAt: timestamp("last_polled_at"),
    nextPollAt: timestamp("next_poll_at"),
    pollFailureCount: integer("poll_failure_count").notNull().default(0),
    /**
     * Cost-collection schedule — parallel to the resource-poll columns but on
     * a ~daily cadence (provider billing APIs are rate-limited and sometimes
     * billed per request). Only meaningful for accounts whose plugin declares
     * a `costs` capability; NULL costNextPollAt means "due now".
     */
    costLastPolledAt: timestamp("cost_last_polled_at"),
    costNextPollAt: timestamp("cost_next_poll_at"),
    costPollFailureCount: integer("cost_poll_failure_count").notNull().default(0),
    /** Set once the initial cost-history backfill completes. */
    costBackfilledAt: timestamp("cost_backfilled_at"),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgPluginIdx: index("accounts_org_plugin_idx").on(t.organizationId, t.pluginId),
    pollDueIdx: index("accounts_poll_due_idx").on(t.nextPollAt),
    costPollDueIdx: index("accounts_cost_poll_due_idx").on(t.costNextPollAt),
    bastionIdx: index("accounts_bastion_idx").on(t.bastionId),
  }),
);

export const dashboards = pgTable(
  "dashboards",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    syncVersion: integer("sync_version").notNull().default(0),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("dashboards_org_idx").on(t.organizationId),
  }),
);

/**
 * One-time WebSocket handshake tokens (SHA-256 hash at rest, ~30s TTL).
 * DB-backed so any web replica can validate a token minted by another.
 */
export const wsTokens = pgTable(
  "ws_tokens",
  {
    hashedToken: text("hashed_token").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    expiresIdx: index("ws_tokens_expires_idx").on(t.expiresAt),
  }),
);
