import { pgTable, text, integer, timestamp, index, jsonb } from "drizzle-orm/pg-core";

import { accounts, organizations, users } from "./core-schema.js";

/**
 * **IaC reconciliation** (the ClickOps detector) — an org uploads the
 * Terraform state it already has, and every synced resource is classified as
 * managed / drifted / unmanaged.
 *
 * Not to be confused with the three other "Terraform" things in this repo:
 * eject-to-Terraform (`Plugin.terraformExport`) writes HCL for the user's
 * cloud resources, org config as code moves a whole org as one JSON document,
 * and `terraform-provider-infrawrench` manages Infrawrench's own configuration.
 *
 * **A state document can contain secrets.** Attributes Terraform marks
 * sensitive are dropped by the parser before they reach this table (the key
 * name survives in `redactedAttributeKeys` so the UI can say a comparison was
 * skipped), and only attribute values are stored at all — never the document.
 */
export const iacStates = pgTable(
  "iac_states",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Null when the state covers the whole org rather than one account. */
    accountId: text("account_id").references(() => accounts.id, { onDelete: "cascade" }),
    /** User-supplied name, e.g. "prod / us-east-1". */
    label: text("label").notNull(),
    /** "tfstate" (a raw state file) or "show-json" (`terraform show -json`). */
    format: text("format").$type<"tfstate" | "show-json">().notNull(),
    /** The document's own version: "4" for a tfstate, "1.0"-style otherwise. */
    formatVersion: text("format_version").notNull(),
    terraformVersion: text("terraform_version"),
    /** `serial`/`lineage` exist only in a raw tfstate; null for show output. */
    serial: integer("serial"),
    lineage: text("lineage"),
    resourceCount: integer("resource_count").notNull().default(0),
    dataSourceCount: integer("data_source_count").notNull().default(0),
    redactedAttributeCount: integer("redacted_attribute_count").notNull().default(0),
    /** Non-fatal notes from the parser (truncation, redaction counts, empty modules). */
    parseWarnings: jsonb("parse_warnings").$type<string[]>().notNull().default([]),
    uploadedByUserId: text("uploaded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    orgCreatedIdx: index("iac_states_org_created_idx").on(t.organizationId, t.createdAt),
    orgAccountIdx: index("iac_states_org_account_idx").on(t.organizationId, t.accountId),
  }),
);

/**
 * One resource instance lifted out of an uploaded state document.
 *
 * Deliberately *not* a copy of the document: `attributes` holds only what the
 * parser kept after redaction and truncation, which is what the field-level
 * drift comparison reads.
 */
export const iacManagedResources = pgTable(
  "iac_managed_resources",
  {
    id: text("id").primaryKey(),
    stateId: text("state_id")
      .notNull()
      .references(() => iacStates.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Full Terraform address, e.g. `module.vpc.aws_subnet.private[0]`. */
    address: text("address").notNull(),
    /** Module address, null in the root module. */
    module: text("module"),
    /** "managed" or "data" — data sources are recorded but never matched. */
    mode: text("mode").$type<"managed" | "data">().notNull(),
    terraformType: text("terraform_type").notNull(),
    terraformName: text("terraform_name").notNull(),
    /** `count` index or `for_each` key, rendered as text. */
    indexKey: text("index_key"),
    providerName: text("provider_name"),
    /** Lower-cased `id`/`arn`/`self_link` values, the matching keys. */
    identifiers: jsonb("identifiers").$type<string[]>().notNull().default([]),
    /** Redacted, truncated attribute bag — see the table comment above. */
    attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default({}),
    /** Keys whose values were dropped as sensitive, so drift can say "not compared". */
    redactedAttributeKeys: jsonb("redacted_attribute_keys").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    stateIdx: index("iac_managed_resources_state_idx").on(t.stateId),
    orgTypeIdx: index("iac_managed_resources_org_type_idx").on(t.organizationId, t.terraformType),
  }),
);
