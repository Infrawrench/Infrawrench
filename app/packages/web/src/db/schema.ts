import {
  pgTable,
  text,
  boolean,
  integer,
  timestamp,
  index,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(), // WorkOS org ID
  displayName: text("display_name").notNull(),
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
    role: text("role").notNull().default("member"), // "owner" | "admin" | "member"
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    userOrgUnique: uniqueIndex("org_members_user_org_unique").on(t.userId, t.organizationId),
    orgIdx: index("org_members_org_idx").on(t.organizationId),
    userIdx: index("org_members_user_idx").on(t.userId),
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
    syncVersion: integer("sync_version").notNull().default(0),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgPluginIdx: index("accounts_org_plugin_idx").on(t.organizationId, t.pluginId),
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
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Resolved outputs cache as JSON */
    outputsJson: jsonb("outputs_json")
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
    role: text("role").notNull().default("member"), // "admin" | "member"
    invitedByUserId: text("invited_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    acceptedAt: timestamp("accepted_at"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    tokenUnique: uniqueIndex("invitations_token_unique").on(t.token),
    orgIdx: index("invitations_org_idx").on(t.organizationId),
    emailOrgIdx: index("invitations_email_org_idx").on(t.email, t.organizationId),
  }),
);
