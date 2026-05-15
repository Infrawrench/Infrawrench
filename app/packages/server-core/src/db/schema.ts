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
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgPluginIdx: index("accounts_org_plugin_idx").on(t.organizationId, t.pluginId),
    pollDueIdx: index("accounts_poll_due_idx").on(t.nextPollAt),
    bastionIdx: index("accounts_bastion_idx").on(t.bastionId),
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
    /**
     * Legacy plaintext token column. No longer written; retained for backfill
     * and to keep older migrations valid. Reads use `hashedToken` exclusively.
     */
    token: text("token").notNull(),
    /** SHA-256 hash of the invitation token. Lookups are performed on this. */
    hashedToken: text("hashed_token").notNull(),
    acceptedAt: timestamp("accepted_at"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    tokenUnique: uniqueIndex("invitations_token_unique").on(t.token),
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
