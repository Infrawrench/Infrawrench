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

// ─── Organizations (WorkOS org) ────────────────────────────────────────────────

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),               // WorkOS org ID
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Users ────────────────────────────────────────────────────────────────────

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),             // WorkOS user ID
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    displayName: text("display_name"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("users_org_idx").on(t.organizationId),
    emailIdx: uniqueIndex("users_email_unique").on(t.email),
  }),
);

// ─── Plugin Installations ─────────────────────────────────────────────────────

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

// ─── Accounts (credentials per plugin per org) ────────────────────────────────

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
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgPluginIdx: index("accounts_org_plugin_idx").on(t.organizationId, t.pluginId),
  }),
);

// ─── Resources ────────────────────────────────────────────────────────────────

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
    fieldsJson: jsonb("fields_json").notNull().default(sql`'{}'::jsonb`),
    /** Resolved outputs cache as JSON */
    outputsJson: jsonb("outputs_json").notNull().default(sql`'{}'::jsonb`),
    parentResourceId: text("parent_resource_id"),
    lastSyncedAt: timestamp("last_synced_at"),
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

// ─── Secret Field States ───────────────────────────────────────────────────────

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

// ─── Associations ─────────────────────────────────────────────────────────────

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

// ─── Dashboards ───────────────────────────────────────────────────────────────

export const dashboards = pgTable(
  "dashboards",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("dashboards_org_idx").on(t.organizationId),
  }),
);

// ─── Dashboard Pins ───────────────────────────────────────────────────────────

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
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    dashboardPinUnique: uniqueIndex("dashboard_pin_unique").on(t.dashboardId, t.resourceId),
    dashboardIdx: index("dashboard_pin_dashboard_idx").on(t.dashboardId),
  }),
);
