import {
  pgTable,
  text,
  boolean,
  integer,
  timestamp,
  index,
  jsonb,
  date,
} from "drizzle-orm/pg-core";

import { accounts, organizations, users } from "./core-schema.js";

/**
 * Whether the org wants flow collection to run at all, and how far back to
 * start.
 *
 * **This is off by default, and that is not timidity.** Answering "which two
 * things are talking" means running a query against the provider's own log
 * store, and on AWS that query is billed to the *customer's* account per GB
 * scanned: a busy VPC's flow-log group is not small. A monitoring product that
 * silently puts a recurring line on someone's bill has done something it was
 * not asked to do, so the switch is explicit, the surface says what it costs,
 * and nothing runs until somebody turns it on.
 *
 * That is also why the write is `org:settings:write` rather than `costs:write`:
 * it is not an edit to a cost object, it is a decision to spend the
 * organization's money in its cloud account. Same class of act as a billing
 * rule, which is governed the same way.
 */
export const orgNetworkFlowSettings = pgTable("org_network_flow_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /** Master switch. No row at all reads as disabled: see `network-flow/settings.ts`. */
  enabled: boolean("enabled").notNull().default(false),
  /**
   * How many days of history the first pass for an account walks back through.
   *
   * Small by default: flow logs are commonly retained for 7 or 30 days at the
   * source, so a large value mostly buys empty queries the customer still pays
   * to run. The plugin's `maxHistoryDays` caps it further.
   */
  initialLookbackDays: integer("initial_lookback_days").notNull().default(7),
  updatedByUserId: text("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * Per-account collection schedule, watermark and last failure; the
 * `account_credit_polls` pattern, for the same reason: flow-capable plugins are
 * a small minority, so a row that exists only for accounts the pass touches
 * keeps the due-work query a scan of a tiny table.
 *
 * The one structural difference from every other collection pass in this
 * codebase is `collectedThrough`, and it is worth stating plainly:
 * **flow collection is forward-only and never restates.** Cost collection
 * re-fetches a trailing window because providers restate billing data for days
 * afterwards; flow logs do not restate (a closed UTC day is final within
 * minutes) and re-running one costs the customer another scan of the same
 * data for an identical answer. So a day is collected once, the watermark
 * advances past it, and it is never revisited. The consequence to accept: a day
 * collected during an outage stays as collected as it was, and there is no
 * mechanism that will quietly repair it later.
 */
export const accountNetworkFlowPolls = pgTable(
  "account_network_flow_polls",
  {
    accountId: text("account_id")
      .primaryKey()
      .references(() => accounts.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    lastPolledAt: timestamp("last_polled_at"),
    /** Due time AND claim lease, the `accounts.next_poll_at` protocol. */
    nextPollAt: timestamp("next_poll_at"),
    /**
     * Who holds the lease `next_poll_at` is counting down: a fresh identifier
     * written by every claim, and null when nobody holds it.
     *
     * The one thing in this table that is not the account's state: it is the
     * poller's, and it exists because the lease needs an **identity separate
     * from the deadline it is renewing**. A renewal that matched on the
     * deadline was comparing against a value it was itself in the business of
     * changing, so a write that committed without answering left the holder
     * unable to say whether the lease had moved under it or been taken from it.
     * Matching on this instead, every write the holder makes is unambiguous:
     * the token changes only when somebody else claims the account. See
     * `network-flow/lease.ts`.
     */
    leaseOwner: text("lease_owner"),
    /**
     * The last UTC day fully collected for this account. Null on an account the
     * pass has never run for, which is what makes the first run take the
     * org's `initialLookbackDays` window instead of a single day.
     */
    collectedThrough: date("collected_through"),
    failureCount: integer("failure_count").notNull().default(0),
    /**
     * Last failure, kept so the panel can explain an empty screen rather than
     * leaving the user to guess whether their network is quiet. Cleared on the
     * next success.
     */
    lastError: text("last_error"),
    /** Set when the plugin threw `NetworkFlowSetupError`: a setup gap, not a fault. */
    lastErrorHelpUrl: text("last_error_help_url"),
    /**
     * The flow-log sources the last pass discovered, usable or not, as returned
     * by the plugin. Stored so the surface can say "you have three flow logs
     * and two of them use the default record format", which is a different
     * screen from "you have no flow logs", and the fix is different too.
     */
    lastSources: jsonb("last_sources").$type<
      Array<{
        id: string;
        target: string;
        region?: string;
        destinationType: string;
        usable: boolean;
        unusableReason?: string;
        helpUrl?: string;
      }>
    >(),
    /**
     * Bytes the provider billed the customer for the last pass's queries, when
     * it reports them. Shown on the surface: a diagnostic that costs money
     * should say how much, every time it is looked at.
     */
    lastQueryBytesScanned: integer("last_query_bytes_scanned"),
  },
  (t) => ({
    dueIdx: index("account_network_flow_polls_due_idx").on(t.nextPollAt),
    orgIdx: index("account_network_flow_polls_org_idx").on(t.organizationId),
  }),
);

/**
 * Per-cluster settings for Kubernetes network cost allocation.
 *
 * One row per Kubernetes account, created the first time someone saves it.
 * It holds the one thing the cluster cannot know about itself: **which billed
 * cost rows are this cluster's data transfer**. A cluster's pod traffic is
 * billed to the cloud account that owns its nodes, on a line whose shape
 * differs per provider (`AWS Data Transfer` and part of `EC2 - Other` on AWS,
 * `Bandwidth` on Azure, a SKU inside `Compute Engine` on GCP), so the user
 * picks it with the cost query language rather than us guessing at service
 * names that would be wrong for half the orgs reading them.
 *
 * With a billed source, the report apportions that real money across the
 * cluster's workloads by their list-priced traffic, day by day, and never
 * hands out more than was billed. Without one, the report shows the list
 * estimate and says so.
 *
 * The query is stored as **text**, not compiled filters, so it reads back the
 * way it was typed and an edit starts from the user's own words; it is
 * compiled on every read by the same parser the cost graphs use.
 */
export const kubernetesNetworkSettings = pgTable(
  "kubernetes_network_settings",
  {
    accountId: text("account_id")
      .primaryKey()
      .references(() => accounts.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Cost query language text selecting the billed data-transfer rows. Null: none. */
    billedQuery: text("billed_query"),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("kubernetes_network_settings_org_idx").on(t.organizationId),
  }),
);
