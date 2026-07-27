import {
  pgTable,
  text,
  boolean,
  integer,
  timestamp,
  index,
  uniqueIndex,
  jsonb,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { accounts, dashboards, organizations, users } from "./core-schema.js";

export const roles = pgTable(
  "roles",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    isSystem: boolean("is_system").notNull().default(false),
    /** "owner" | "admin" | "member" for system rows; null for custom roles */
    systemKey: text("system_key"),
    /** Permission strings; ignored for system roles (resolved from code instead). */
    permissions: jsonb("permissions").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("roles_org_idx").on(t.organizationId),
    orgSystemUnique: uniqueIndex("roles_org_system_unique").on(t.organizationId, t.systemKey),
  }),
);

export const organizationMembers = pgTable(
  "organization_members",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Legacy text role; superseded by roleId. Kept for one release for fallback. */
    role: text("role").notNull().default("member"), // "owner" | "admin" | "member"
    roleId: text("role_id").references(() => roles.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    userOrgUnique: uniqueIndex("org_members_user_org_unique").on(t.userId, t.organizationId),
    orgIdx: index("org_members_org_idx").on(t.organizationId),
    userIdx: index("org_members_user_idx").on(t.userId),
    roleIdx: index("org_members_role_idx").on(t.roleId),
  }),
);

export const pluginInstallations = pgTable(
  "plugin_installations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    pluginId: text("plugin_id").notNull(),
    packageName: text("package_name").notNull(),
    version: text("version").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    installedAt: timestamp("installed_at").notNull().defaultNow(),
  },
  (t) => ({
    orgPluginUnique: uniqueIndex("plugin_install_org_plugin_unique").on(
      t.organizationId,
      t.pluginId,
    ),
    orgIdx: index("plugin_install_org_idx").on(t.organizationId),
  }),
);

export const resources = pgTable(
  "resources",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    pluginId: text("plugin_id").notNull(),
    resourceTypeId: text("resource_type_id").notNull(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    externalId: text("external_id"),
    /** Non-secret fields as JSON */
    fieldsJson: jsonb("fields_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Resolved outputs cache as JSON */
    outputsJson: jsonb("outputs_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    parentResourceId: text("parent_resource_id"),
    lastSyncedAt: timestamp("last_synced_at"),
    syncVersion: integer("sync_version").notNull().default(0),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgPluginTypeIdx: index("resources_org_plugin_type_idx").on(
      t.organizationId,
      t.pluginId,
      t.resourceTypeId,
    ),
    accountIdx: index("resources_account_idx").on(t.accountId),
    externalIdx: index("resources_external_idx").on(t.pluginId, t.externalId),
    parentIdx: index("resources_parent_idx").on(t.parentResourceId),
  }),
);

export const secretFieldStates = pgTable(
  "secret_field_states",
  {
    id: text("id").primaryKey(),
    resourceId: text("resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    fieldKey: text("field_key").notNull(),
    /** "literal" | "output-ref" */
    resolutionKind: text("resolution_kind").notNull(),
    // Literal columns
    encryptedValue: text("encrypted_value"),
    valueIv: text("value_iv"),
    // Output-ref columns
    sourcePluginId: text("source_plugin_id"),
    sourceResourceTypeId: text("source_resource_type_id"),
    sourceResourceId: text("source_resource_id"),
    sourceAccountId: text("source_account_id"),
    sourceOutputKey: text("source_output_key"),
    // Cache for output-ref
    cachedEncryptedValue: text("cached_encrypted_value"),
    cachedValueIv: text("cached_value_iv"),
    cachedAt: timestamp("cached_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    resourceFieldUnique: uniqueIndex("secret_field_resource_field_unique").on(
      t.resourceId,
      t.fieldKey,
    ),
    resourceIdx: index("secret_field_resource_idx").on(t.resourceId),
  }),
);

export const associations = pgTable(
  "associations",
  {
    id: text("id").primaryKey(),
    consumerResourceId: text("consumer_resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    consumerFieldKey: text("consumer_field_key").notNull(),
    providerResourceId: text("provider_resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "restrict" }),
    providerOutputKey: text("provider_output_key").notNull(),
    syncVersion: integer("sync_version").notNull().default(0),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    consumerUnique: uniqueIndex("assoc_consumer_unique").on(
      t.consumerResourceId,
      t.consumerFieldKey,
    ),
    consumerIdx: index("assoc_consumer_idx").on(t.consumerResourceId),
    providerIdx: index("assoc_provider_idx").on(t.providerResourceId),
  }),
);

export const dashboardPins = pgTable(
  "dashboard_pins",
  {
    id: text("id").primaryKey(),
    dashboardId: text("dashboard_id")
      .notNull()
      .references(() => dashboards.id, { onDelete: "cascade" }),
    resourceId: text("resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    gridX: integer("grid_x").notNull().default(0),
    gridY: integer("grid_y").notNull().default(0),
    gridW: integer("grid_w").notNull().default(1),
    gridH: integer("grid_h").notNull().default(1),
    syncVersion: integer("sync_version").notNull().default(0),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    dashboardPinUnique: uniqueIndex("dashboard_pin_unique").on(t.dashboardId, t.resourceId),
    dashboardIdx: index("dashboard_pin_dashboard_idx").on(t.dashboardId),
  }),
);

/**
 * Non-resource dashboard cards (cost graphs, budget views). A separate table
 * from dashboardPins — which FKs resources — following the
 * dashboardWorkflowPins precedent of one table per pin kind. `config` is a
 * kind-discriminated JSONB blob validated against the zod schemas in
 * `@infrawrench/ui/cost` at the API boundary.
 */
export const dashboardWidgets = pgTable(
  "dashboard_widgets",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    dashboardId: text("dashboard_id")
      .notNull()
      .references(() => dashboards.id, { onDelete: "cascade" }),
    /** "cost_graph" | "budget" */
    kind: text("kind").notNull(),
    title: text("title").notNull().default(""),
    config: jsonb("config").notNull(),
    gridX: integer("grid_x").notNull().default(0),
    gridY: integer("grid_y").notNull().default(0),
    /** Cost charts want width — default to a double-wide card. */
    gridW: integer("grid_w").notNull().default(2),
    gridH: integer("grid_h").notNull().default(1),
    syncVersion: integer("sync_version").notNull().default(0),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    dashboardIdx: index("dashboard_widgets_dashboard_idx").on(t.dashboardId),
    orgIdx: index("dashboard_widgets_org_idx").on(t.organizationId),
  }),
);

/**
 * Spend budgets. Independent of dashboard widgets — a budget keeps evaluating
 * and alerting even when no widget shows it. `filters` scopes which cost rows
 * count (CostFilter[] from `@infrawrench/ui/cost`); `thresholds` is
 * Array<{ type: "actual" | "forecast"; percent: number }>.
 */
export const budgets = pgTable(
  "budgets",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Monthly budget amount in cents of `currency`. */
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    filters: jsonb("filters").notNull().default([]),
    thresholds: jsonb("thresholds").notNull().default([]),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("budgets_org_idx").on(t.organizationId),
  }),
);

/**
 * Fired budget-threshold crossings. The unique index makes each threshold
 * fire at most once per calendar month — evaluation inserts with
 * onConflictDoNothing and only notifies on a fresh insert.
 */
export const budgetAlertEvents = pgTable(
  "budget_alert_events",
  {
    id: text("id").primaryKey(),
    budgetId: text("budget_id")
      .notNull()
      .references(() => budgets.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** "YYYY-MM" (UTC) the crossing was observed in. */
    month: text("month").notNull(),
    thresholdType: text("threshold_type").$type<"actual" | "forecast">().notNull(),
    thresholdPercent: integer("threshold_percent").notNull(),
    actualAmountCents: integer("actual_amount_cents").notNull(),
    forecastAmountCents: integer("forecast_amount_cents"),
    triggeredAt: timestamp("triggered_at").notNull().defaultNow(),
    notifiedAt: timestamp("notified_at"),
  },
  (t) => ({
    onceUnique: uniqueIndex("budget_alert_once_unique").on(
      t.budgetId,
      t.month,
      t.thresholdType,
      t.thresholdPercent,
    ),
    orgIdx: index("budget_alert_events_org_idx").on(t.organizationId),
  }),
);

export const sshKeys = pgTable(
  "ssh_keys",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Owner of this key — only the owner can manage it */
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** AES-256-GCM encrypted public key */
    encryptedPublicKey: text("encrypted_public_key").notNull(),
    publicKeyIv: text("public_key_iv").notNull(),
    /** AES-256-GCM encrypted private key (server-generated keys only) */
    encryptedPrivateKey: text("encrypted_private_key"),
    privateKeyIv: text("private_key_iv"),
    /** e.g. "ssh-ed25519" */
    keyType: text("key_type"),
    /** Whether the key was imported (true) or server-generated (false) */
    isImported: boolean("is_imported").notNull().default(false),
    /** SHA-256 fingerprint of the public key (for display/verification) */
    fingerprint: text("fingerprint"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("ssh_keys_org_idx").on(t.organizationId),
    userIdx: index("ssh_keys_user_idx").on(t.userId),
    userNameUnique: uniqueIndex("ssh_keys_user_name_unique").on(t.userId, t.name),
  }),
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id"),
    apiKeyId: text("api_key_id"),
    action: text("action").notNull(), // e.g. "account.create", "resource.delete"
    entityType: text("entity_type").notNull(), // "account" | "resource" | "dashboard" | ...
    entityId: text("entity_id").notNull(),
    metadata: jsonb("metadata"), // action-specific payload
    ipAddress: text("ip_address"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    orgCreatedIdx: index("audit_logs_org_created_idx").on(t.organizationId, t.createdAt),
    orgEntityTypeIdx: index("audit_logs_org_entity_type_idx").on(t.organizationId, t.entityType),
  }),
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    hashedKey: text("hashed_key").notNull(), // SHA-256 of full key
    prefix: text("prefix").notNull(), // first 8 chars for display (e.g. "iwk_abc1")
    scopes: jsonb("scopes").notNull(), // string[] of granted scopes
    lastUsedAt: timestamp("last_used_at"),
    expiresAt: timestamp("expires_at"),
    revokedAt: timestamp("revoked_at"),
    /**
     * For keys still on the legacy SHA-256 hash scheme, the cutover date past
     * which authentication is refused. Set on first legacy-hash auth hit;
     * cleared once the row has been rehashed with HMAC.
     */
    legacyHashSunsetAt: timestamp("legacy_hash_sunset_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    hashedKeyUnique: uniqueIndex("api_keys_hashed_key_unique").on(t.hashedKey),
    orgIdx: index("api_keys_org_idx").on(t.organizationId),
  }),
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    stripeSubscriptionId: text("stripe_subscription_id"),
    stripePriceId: text("stripe_price_id"),
    /** "active" | "past_due" | "canceled" | "unpaid" | "trialing" */
    status: text("status").notNull().default("trialing"),
    currentPeriodStart: timestamp("current_period_start"),
    currentPeriodEnd: timestamp("current_period_end"),
    seatCount: integer("seat_count").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgUnique: uniqueIndex("subscriptions_org_unique").on(t.organizationId),
    stripeCustomerIdx: index("subscriptions_stripe_customer_idx").on(t.stripeCustomerId),
    stripeSubIdx: index("subscriptions_stripe_sub_idx").on(t.stripeSubscriptionId),
  }),
);

export const invitations = pgTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    /** Legacy text role; superseded by roleId. Kept for one release for fallback. */
    role: text("role").notNull().default("member"), // "admin" | "member"
    roleId: text("role_id").references(() => roles.id, { onDelete: "set null" }),
    invitedByUserId: text("invited_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 hash of the invitation token. Lookups are performed on this. */
    hashedToken: text("hashed_token").notNull(),
    acceptedAt: timestamp("accepted_at"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    hashedTokenUnique: uniqueIndex("invitations_hashed_token_unique").on(t.hashedToken),
    orgIdx: index("invitations_org_idx").on(t.organizationId),
    emailOrgIdx: index("invitations_email_org_idx").on(t.email, t.organizationId),
  }),
);

export const sshHostKeys = pgTable(
  "ssh_host_keys",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    host: text("host").notNull(),
    port: integer("port").notNull(),
    /** SHA-256 fingerprint of the host key, "SHA256:..." format */
    fingerprint: text("fingerprint").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgHostPortUnique: uniqueIndex("ssh_host_keys_org_host_port_unique").on(
      t.organizationId,
      t.host,
      t.port,
    ),
  }),
);

export const twilioSettings = pgTable(
  "twilio_settings",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    /** AES-256-GCM encrypted Twilio Account SID. AAD: `twilio:<orgId>:accountSid`. */
    encryptedAccountSid: text("encrypted_account_sid"),
    accountSidIv: text("account_sid_iv"),
    /** AES-256-GCM encrypted Twilio auth token. AAD: `twilio:<orgId>:authToken`. */
    encryptedAuthToken: text("encrypted_auth_token"),
    authTokenIv: text("auth_token_iv"),
    /** E.164 number messages/calls originate from (Twilio number). */
    fromNumber: text("from_number"),
    /** Page after this many distinct sync failures in `windowMinutes`. */
    failureThreshold: integer("failure_threshold").notNull().default(3),
    windowMinutes: integer("window_minutes").notNull().default(10),
    /** Minimum minutes between re-pages for the same open incident. */
    cooldownMinutes: integer("cooldown_minutes").notNull().default(60),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    failureThresholdPositive: check(
      "twilio_settings_failure_threshold_positive",
      sql`${t.failureThreshold} > 0`,
    ),
    windowMinutesPositive: check(
      "twilio_settings_window_minutes_positive",
      sql`${t.windowMinutes} > 0`,
    ),
    cooldownMinutesPositive: check(
      "twilio_settings_cooldown_minutes_positive",
      sql`${t.cooldownMinutes} > 0`,
    ),
  }),
);

export const twilioRecipients = pgTable(
  "twilio_recipients",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    /** E.164 phone number (e.g. `+15551234567`). */
    phoneNumber: text("phone_number").notNull(),
    sms: boolean("sms").notNull().default(true),
    voice: boolean("voice").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("twilio_recipients_org_idx").on(t.organizationId),
  }),
);

/**
 * A Slack workspace an org has installed the Infrawrench app into, via the
 * "Add to Slack" OAuth flow. Holds the bot token we post as; the token is
 * long-lived (Slack only rotates it when the workspace enables token rotation,
 * which this install does not request).
 *
 * An org may install into more than one workspace, so this is keyed by
 * (org, teamId) rather than by org alone. Uninstalling sets `deletedAt` so the
 * channel rows and their trigger opt-ins survive a re-install.
 */
export const slackInstallations = pgTable(
  "slack_installations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Slack workspace id (`T…`). */
    teamId: text("team_id").notNull(),
    /** Workspace name at install time, for display. */
    teamName: text("team_name"),
    /** The bot user we post as (`U…`), returned by oauth.v2.access. */
    botUserId: text("bot_user_id"),
    /** Space-separated scopes the install was granted, for diagnosing failures. */
    scopes: text("scopes"),
    /** AES-256-GCM encrypted bot token (`xoxb-…`). AAD: `slack:<orgId>:botToken`. */
    encryptedBotToken: text("encrypted_bot_token").notNull(),
    botTokenIv: text("bot_token_iv").notNull(),
    installedByUserId: text("installed_by_user_id"),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("slack_installations_org_idx").on(t.organizationId),
    orgTeamUnique: uniqueIndex("slack_installations_org_team_unique").on(
      t.organizationId,
      t.teamId,
    ),
  }),
);

/**
 * A Slack channel an org routes alerts to, with one opt-in per trigger. The
 * three flags mirror `pushPreferences` so a channel can take budget alerts
 * without also taking every sync incident.
 */
export const slackChannels = pgTable(
  "slack_channels",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    installationId: text("installation_id")
      .notNull()
      .references(() => slackInstallations.id, { onDelete: "cascade" }),
    /** Slack channel id (`C…`/`G…`). Stable across renames, unlike the name. */
    channelId: text("channel_id").notNull(),
    /** Channel name at the time it was added, refreshed when we list channels. */
    channelName: text("channel_name").notNull(),
    isPrivate: boolean("is_private").notNull().default(false),
    syncIncidents: boolean("sync_incidents").notNull().default(true),
    budgetAlerts: boolean("budget_alerts").notNull().default(true),
    /** Alerts raised by a workflow calling `infra.page(...)`. */
    workflowPages: boolean("workflow_pages").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("slack_channels_org_idx").on(t.organizationId),
    installChannelUnique: uniqueIndex("slack_channels_install_channel_unique").on(
      t.installationId,
      t.channelId,
    ),
  }),
);

/**
 * A Microsoft Teams channel an org routes alerts to, identified by the webhook
 * URL of a Teams "Workflows" automation (or a legacy Office 365 connector).
 * The three flags mirror `slackChannels` and `pushPreferences`.
 *
 * There is no installation table above this one, as there is for Slack: Teams
 * has no app-only OAuth flow we can use, so each channel stands alone with its
 * own URL. See `server-core/src/msteams.ts` for why.
 *
 * The URL is a bearer credential — it carries its own signature — so it is
 * stored encrypted and never leaves the server. `urlHost` and `urlHint` are the
 * non-secret parts kept in the clear for display and diagnostics.
 */
export const msteamsWebhooks = pgTable(
  "msteams_webhooks",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** User-supplied display name, e.g. `#alerts (Platform)`. */
    label: text("label").notNull(),
    /** AES-256-GCM encrypted webhook URL. AAD: `msteams:<orgId>:webhookUrl`. */
    encryptedUrl: text("encrypted_url").notNull(),
    urlIv: text("url_iv").notNull(),
    /**
     * Keyed HMAC of the URL. Lets re-pasting the same webhook update the
     * existing row instead of doubling up delivery, without storing the URL in
     * a comparable form.
     */
    urlDigest: text("url_digest").notNull(),
    /** Hostname, for display and for spotting legacy connector URLs. */
    urlHost: text("url_host").notNull(),
    /** Non-secret display hint, e.g. `contoso.webhook.office.com · …a7f2`. */
    urlHint: text("url_hint").notNull(),
    syncIncidents: boolean("sync_incidents").notNull().default(true),
    budgetAlerts: boolean("budget_alerts").notNull().default(true),
    /** Alerts raised by a workflow calling `infra.page(...)`. */
    workflowPages: boolean("workflow_pages").notNull().default(true),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("msteams_webhooks_org_idx").on(t.organizationId),
    orgDigestUnique: uniqueIndex("msteams_webhooks_org_digest_unique").on(
      t.organizationId,
      t.urlDigest,
    ),
  }),
);

/**
 * Rolling-window record of poller sync failures, used by the Twilio pager to
 * decide whether a (account, resourceType) has crossed its threshold. Rows
 * older than the org's `windowMinutes` are deleted on each tick.
 */
export const accountSyncFailures = pgTable(
  "account_sync_failures",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    resourceTypeId: text("resource_type_id").notNull(),
    failedAt: timestamp("failed_at").notNull().defaultNow(),
    error: text("error"),
  },
  (t) => ({
    orgAccountTypeIdx: index("account_sync_failures_org_account_type_idx").on(
      t.organizationId,
      t.accountId,
      t.resourceTypeId,
    ),
    failedAtIdx: index("account_sync_failures_failed_at_idx").on(t.failedAt),
  }),
);

/**
 * One row per open or resolved incident. While `closedAt` is null the
 * incident is open; the pager re-pages every `cooldownMinutes` until the next
 * successful sync of the same (account, resourceType) closes it.
 */
export const pagingIncidents = pgTable(
  "paging_incidents",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    resourceTypeId: text("resource_type_id").notNull(),
    openedAt: timestamp("opened_at").notNull().defaultNow(),
    /** Set when the next successful sync of this (account, type) clears the incident. */
    closedAt: timestamp("closed_at"),
    /** Last time we actually sent SMS/voice for this incident. */
    pagedAt: timestamp("paged_at"),
    /** Truncated error message captured when the incident was opened. */
    error: text("error"),
  },
  (t) => ({
    openIncidentIdx: uniqueIndex("paging_incidents_open_unique")
      .on(t.accountId, t.resourceTypeId)
      .where(sql`closed_at IS NULL`),
    orgIdx: index("paging_incidents_org_idx").on(t.organizationId),
  }),
);

/**
 * Expo push tokens for the mobile app. User-scoped, not org-scoped — a phone
 * belongs to a person and registers once regardless of org memberships. The
 * unique index on the token lets re-registration upsert and reassign the row
 * to the current user (phone handoffs, account switches).
 */
export const pushDevices = pgTable(
  "push_devices",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** `ExponentPushToken[...]` string from expo-notifications. */
    expoPushToken: text("expo_push_token").notNull(),
    platform: text("platform").notNull().$type<"ios" | "android">(),
    deviceName: text("device_name"),
    /** Refreshed on every register call — the app re-registers on launch. */
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
    /** Consecutive send failures; reset to 0 on success or re-register. */
    failureCount: integer("failure_count").notNull().default(0),
    /** Set after repeated send failures; cleared on re-register. */
    disabledAt: timestamp("disabled_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    tokenUnique: uniqueIndex("push_devices_token_unique").on(t.expoPushToken),
    userIdx: index("push_devices_user_idx").on(t.userId),
  }),
);

/**
 * Per-(user, org) push trigger opt-outs. No row means everything is enabled —
 * registering a device is the opt-in act.
 */
export const pushPreferences = pgTable(
  "push_preferences",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    syncIncidents: boolean("sync_incidents").notNull().default(true),
    budgetAlerts: boolean("budget_alerts").notNull().default(true),
    /** Alerts raised by a workflow calling `infra.page(...)`. */
    workflowPages: boolean("workflow_pages").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    userOrgUnique: uniqueIndex("push_preferences_user_org_unique").on(t.userId, t.organizationId),
    orgIdx: index("push_preferences_org_idx").on(t.organizationId),
  }),
);

export const sshTunnelConfigs = pgTable(
  "ssh_tunnel_configs",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sshHost: text("ssh_host").notNull(),
    sshPort: integer("ssh_port").notNull().default(22),
    sshUser: text("ssh_user").notNull().default("root"),
    remoteHost: text("remote_host").notNull().default("127.0.0.1"),
    remotePort: integer("remote_port").notNull(),
    /** AES-256-GCM encrypted SSH private key */
    encryptedPrivateKey: text("encrypted_private_key").notNull(),
    privateKeyIv: text("private_key_iv").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    accountUnique: uniqueIndex("ssh_tunnel_configs_account_unique").on(t.accountId),
    orgIdx: index("ssh_tunnel_configs_org_idx").on(t.organizationId),
  }),
);

/* -------------------------------------------------------------------------- */
/* AI chat — conversations + per-turn messages + pending-action approvals     */
/* + per-turn token usage rolled up for Stripe metered billing.               */
/* -------------------------------------------------------------------------- */

export const chatConversations = pgTable(
  "chat_conversations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /**
     * Nullable, and `set null` rather than `cascade`, so deleting an account
     * retires its conversations instead of destroying them.
     *
     * `chat_usage` rows hang off the messages here and are billing records —
     * `stripe_usage_record_id` stays null until the reporting sweep claims
     * them. Cascading from the user would take unreported usage with it, so an
     * account deleted inside the sweep window silently cost the org its charge.
     *
     * Every read scopes conversations with `userId === auth.userId`, so a
     * null-owned row matches nobody and the history stops being reachable —
     * which is the intent. The usage rows underneath it survive to be billed.
     */
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    title: text("title").notNull().default("New chat"),
    /**
     * Must stay in step with `DEFAULT_CHAT_MODEL` in client-core (server-core
     * can't import it — no dependency that way). The API writes the model
     * explicitly, so this is only reached by a caller that forgets; it points
     * at the cheapest model so forgetting is cheap rather than expensive.
     */
    model: text("model").notNull().default("gemini-3.6-flash"),
    /** System prompt override; null means use the default from chat/agent.ts */
    systemPrompt: text("system_prompt"),
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgUserIdx: index("chat_conversations_org_user_idx").on(t.organizationId, t.userId),
    orgUpdatedIdx: index("chat_conversations_org_updated_idx").on(t.organizationId, t.updatedAt),
  }),
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => chatConversations.id, { onDelete: "cascade" }),
    /** "user" | "assistant" | "tool" */
    role: text("role").notNull(),
    /**
     * Anthropic-shaped content blocks. For role=user this is the user's text
     * input plus any tool_result blocks returned from the previous turn. For
     * role=assistant it's the text + tool_use blocks the model emitted. Tool
     * results from approved-and-executed tool calls are stored as a follow-on
     * role=user message with tool_result blocks, mirroring the SDK shape.
     */
    content: jsonb("content").notNull(),
    /** Tokens reported by Anthropic for this individual turn (assistant rows only). */
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    /** Stop reason from the API: "end_turn" | "tool_use" | "max_tokens" | etc. */
    stopReason: text("stop_reason"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    conversationCreatedIdx: index("chat_messages_conversation_created_idx").on(
      t.conversationId,
      t.createdAt,
    ),
  }),
);

export const chatPendingActions = pgTable(
  "chat_pending_actions",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => chatConversations.id, { onDelete: "cascade" }),
    /** The assistant message that emitted this tool_use block. */
    messageId: text("message_id")
      .notNull()
      .references(() => chatMessages.id, { onDelete: "cascade" }),
    /** Tool call id from the Anthropic SDK (toolu_*). Used to build tool_result. */
    toolUseId: text("tool_use_id").notNull(),
    toolName: text("tool_name").notNull(),
    toolInput: jsonb("tool_input").notNull(),
    /** "pending" | "approved" | "rejected" | "executed" | "errored" */
    status: text("status").notNull().default("pending"),
    /** Tool result text once executed; or rejection reason. */
    result: text("result"),
    isError: boolean("is_error").notNull().default(false),
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    conversationIdx: index("chat_pending_actions_conversation_idx").on(t.conversationId),
    statusIdx: index("chat_pending_actions_status_idx").on(t.status),
  }),
);

export const chatUsage = pgTable(
  "chat_usage",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => chatConversations.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => chatMessages.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull(),
    cacheWriteTokens: integer("cache_write_tokens").notNull(),
    /** Total billable cost in micro-dollars after markup. */
    costMicros: integer("cost_micros").notNull(),
    /** Stripe usage record id once reported; null until reported. */
    stripeUsageRecordId: text("stripe_usage_record_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    orgCreatedIdx: index("chat_usage_org_created_idx").on(t.organizationId, t.createdAt),
    unreportedIdx: index("chat_usage_unreported_idx").on(t.stripeUsageRecordId),
  }),
);

/**
 * Cooldown rows for pages a server outside Infrawrench raised over
 * `POST /api/org/{orgId}/pages`. The workflow equivalent is `workflow_pages`;
 * these are keyed by a caller-chosen `source` instead of a workflow id, since
 * there is no row in this database to hang them off.
 */
export const externalPages = pgTable(
  "external_pages",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Caller-chosen name for the system raising pages, e.g. "checkout-api". */
    source: text("source").notNull(),
    /** The caller-chosen throttle key; "default" when unspecified. */
    key: text("key").notNull(),
    /** When this key last delivered a page — the start of its cooldown. */
    lastPagedAt: timestamp("last_paged_at").notNull().defaultNow(),
    /** The message that was sent, for the settings UI. */
    lastMessage: text("last_message"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    orgSourceKeyUnique: uniqueIndex("external_pages_org_source_key_unique").on(
      t.organizationId,
      t.source,
      t.key,
    ),
    orgIdx: index("external_pages_org_idx").on(t.organizationId),
  }),
);

export * from "./core-schema.js";
export * from "./workflow-schema.js";
export * from "./agent-schema.js";
