/**
 * Paging providers (PagerDuty, incident.io, any plugin with the paging
 * capability): per-account settings, the outbound event log, and the mirror of
 * the provider's own incidents.
 *
 * Lives in its own module (importing only `core-schema.js`) and is re-exported
 * from `schema.ts`, the satellite-schema convention. That is also why
 * `paging_provider_events.alert_delivery_id` carries no foreign key:
 * `alert_deliveries` lives in `schema.ts`, and the column is a pointer the
 * acknowledgement sync matches on, not an ownership edge. A delivery that is
 * pruned by retention simply stops matching.
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

import { accounts, organizations } from "./core-schema.js";

/**
 * One row per paging account the org has configured. No row means the
 * defaults: outbound destinations work, nothing is mirrored inbound.
 *
 * `webhook_token` is the unguessable path segment of the account's inbound
 * webhook URL. It only says *which* account a delivery is for; the signature
 * (verified with the encrypted secret) is what says the delivery is genuine.
 */
export const pagingProviderSettings = pgTable(
  "paging_provider_settings",
  {
    accountId: text("account_id")
      .primaryKey()
      .references(() => accounts.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Mirror this account's incidents into Infrawrench. */
    inboundEnabled: boolean("inbound_enabled").notNull().default(false),
    webhookToken: text("webhook_token").notNull(),
    /** The provider's subscription id, for a managed webhook. */
    webhookId: text("webhook_id"),
    /** AES-GCM ciphertext of the signing secret (AAD: paging-provider/<account>/webhook-secret). */
    encryptedWebhookSecret: text("encrypted_webhook_secret"),
    webhookSecretIv: text("webhook_secret_iv"),
    lastSyncedAt: timestamp("last_synced_at"),
    lastSyncError: text("last_sync_error"),
    /** When the poller should next reconcile incidents. Also its claim column. */
    nextSyncAt: timestamp("next_sync_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("paging_provider_settings_webhook_token_unique").on(t.webhookToken),
    index("paging_provider_settings_org_idx").on(t.organizationId),
    index("paging_provider_settings_next_sync_idx").on(t.nextSyncAt),
  ],
);

/**
 * One upstream alert Infrawrench opened on a provider target, addressed by a
 * stable dedup key, plus the outbox for the next thing to tell the provider.
 *
 * One row per (account, target, dedup key) rather than one per send: a
 * trigger, its acknowledgement and its resolution are one alert upstream, and
 * keeping them on one row is what lets a resolve that arrives before the
 * trigger was ever delivered simply replace it (nobody was paged, so there is
 * nothing to resolve). `pending_action` + `next_attempt_at` are the outbox: the
 * send path tries immediately when it can, and the poller pass claims whatever
 * is still due, with the claim lease written into `next_attempt_at`.
 */
export const pagingProviderEvents = pgTable(
  "paging_provider_events",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    targetId: text("target_id").notNull(),
    dedupKey: text("dedup_key").notNull(),
    /** The alert lifecycle key (`probe:<id>`…), for resolving by condition. */
    lifecycleKey: text("lifecycle_key"),
    /** The escalating `alert_deliveries` row this alert belongs to, if any. */
    alertDeliveryId: text("alert_delivery_id"),
    trigger: text("trigger").notNull(),
    title: text("title").notNull(),
    /** The latest state Infrawrench asked for: triggered, acknowledged, resolved. */
    state: text("state").notNull().default("triggered"),
    /** The action still to send, or null once the provider took it. */
    pendingAction: text("pending_action"),
    /** The rendered event (summary, body, severity, links) minus the action. */
    payload: jsonb("payload").notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at"),
    lastError: text("last_error"),
    externalUrl: text("external_url"),
    sentAt: timestamp("sent_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("paging_provider_events_target_dedup_unique").on(
      t.accountId,
      t.targetId,
      t.dedupKey,
    ),
    index("paging_provider_events_org_lifecycle_idx").on(t.organizationId, t.lifecycleKey),
    index("paging_provider_events_delivery_idx").on(t.alertDeliveryId),
    index("paging_provider_events_due_idx").on(t.nextAttemptAt),
    index("paging_provider_events_account_dedup_idx").on(t.accountId, t.dedupKey),
  ],
);

/**
 * The provider's incidents, mirrored. Rewritten from the provider on every
 * webhook nudge and every reconcile, so nothing here is authoritative; it is
 * what the incidents surfaces read without a provider round trip per view.
 */
export const pagingProviderIncidents = pgTable(
  "paging_provider_incidents",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    reference: text("reference"),
    title: text("title").notNull(),
    /** triggered | acknowledged | resolved */
    status: text("status").notNull(),
    statusLabel: text("status_label"),
    urgency: text("urgency"),
    url: text("url"),
    serviceName: text("service_name"),
    assignees: jsonb("assignees").notNull().default([]),
    dedupKey: text("dedup_key"),
    externalCreatedAt: timestamp("external_created_at").notNull(),
    externalUpdatedAt: timestamp("external_updated_at"),
    resolvedAt: timestamp("resolved_at"),
    syncedAt: timestamp("synced_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("paging_provider_incidents_account_external_unique").on(t.accountId, t.externalId),
    index("paging_provider_incidents_org_status_idx").on(t.organizationId, t.status),
  ],
);
