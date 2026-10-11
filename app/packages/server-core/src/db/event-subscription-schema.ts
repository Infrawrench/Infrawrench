/**
 * Event subscriptions: org-level outbound delivery of Infrawrench's own events
 * (signed HTTPS webhooks, or a publish to an `eventSink` resource such as an
 * EventBridge rule's bus or a Pub/Sub topic) and the durable outbox that
 * delivers them.
 *
 * Satellite-schema convention: imports only `core-schema.js`, re-exported
 * from `schema.ts`.
 *
 * `alert_deliveries` was the obvious thing to reuse and is deliberately not:
 * its rows are routing decisions (held for quiet hours, armed for escalation,
 * replayed through `routeAlert` with pinned legs), and its state machine has
 * no notion of a per-attempt HTTP response, a retry ladder or a redelivery.
 * An event delivery is a different object: one envelope, one destination,
 * retried until it lands or is given up on, and kept as a log the admin reads.
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
import { sql } from "drizzle-orm";

import { accounts, organizations, users } from "./core-schema.js";

export const eventSubscriptions = pgTable(
  "event_subscriptions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** "webhook" | "publish" */
    destinationKind: text("destination_kind").notNull(),
    /** Webhook URL. Not a secret on its own: every request is signed. */
    url: text("url"),
    /** Publish destination: a connected account and an `eventSink` resource in it. */
    publishAccountId: text("publish_account_id").references(() => accounts.id, {
      onDelete: "cascade",
    }),
    publishResourceTypeId: text("publish_resource_type_id"),
    publishResourceId: text("publish_resource_id"),
    /** Resolved at save time so the list reads without a plugin load. */
    destinationLabel: text("destination_label").notNull().default(""),
    /** AES-GCM ciphertext of the signing secret (AAD: event-subscription/<id>/secret). */
    encryptedSecret: text("encrypted_secret"),
    secretIv: text("secret_iv"),
    secretHint: text("secret_hint"),
    /** The secret before the last reroll, still signing until `previous_secret_expires_at`. */
    previousEncryptedSecret: text("previous_encrypted_secret"),
    previousSecretIv: text("previous_secret_iv"),
    previousSecretExpiresAt: timestamp("previous_secret_expires_at"),
    /** Filters; empty arrays do not filter. */
    eventTypes: text("event_types")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    minSeverity: text("min_severity"),
    accountIds: text("account_ids")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    environments: text("environments")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Health, for auto-disable. Reset by any success. */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    failingSince: timestamp("failing_since"),
    lastSuccessAt: timestamp("last_success_at"),
    lastFailureAt: timestamp("last_failure_at"),
    disabledReason: text("disabled_reason"),
    disabledAt: timestamp("disabled_at"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("event_subscriptions_org_idx").on(t.organizationId)],
);

/**
 * The outbox and the delivery log in one row: inserted by `publishEvent` in
 * the raise site's request, claimed and sent by the poller's
 * `event-deliveries` pass.
 *
 * `next_attempt_at` is both the due time and the claim column (the
 * `alerts/pass.ts` idiom): the claim writes a lease into it, so a replica that
 * dies mid-send lets the row come due again. `idempotency_key` makes a raise
 * site that re-runs (a retried incident announcement, a re-scanned posture
 * window) a no-op per subscription.
 */
export const eventDeliveries = pgTable(
  "event_deliveries",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    subscriptionId: text("subscription_id")
      .notNull()
      .references(() => eventSubscriptions.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    idempotencyKey: text("idempotency_key"),
    /** The envelope, exactly as sent (the signature covers its serialization). */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    /** pending | retrying | succeeded | dead | skipped */
    state: text("state").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at"),
    lastAttemptAt: timestamp("last_attempt_at"),
    deliveredAt: timestamp("delivered_at"),
    responseStatus: integer("response_status"),
    responseExcerpt: text("response_excerpt"),
    error: text("error"),
    /** Last attempts, newest last, capped. */
    attempts: jsonb("attempts")
      .$type<
        Array<{ at: string; status: number | null; durationMs: number; error: string | null }>
      >()
      .notNull()
      .default(sql`'[]'::jsonb`),
    isTest: boolean("is_test").notNull().default(false),
    redeliveryOf: text("redelivery_of"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("event_deliveries_idempotency_unique").on(t.subscriptionId, t.idempotencyKey),
    index("event_deliveries_due_idx").on(t.nextAttemptAt),
    index("event_deliveries_subscription_idx").on(t.subscriptionId, t.createdAt),
    index("event_deliveries_org_idx").on(t.organizationId, t.createdAt),
  ],
);
