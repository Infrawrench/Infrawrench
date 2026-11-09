/**
 * Per-organization feature flags (`ORG_FEATURES` in client-core), set by a
 * platform admin from `/admin`. A row means the feature is on; there is no
 * "off" row. Lives in its own module and is re-exported from `schema.ts`,
 * the satellite-schema convention.
 */
import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import type { OrgFeature } from "@infrawrench/client-core";

import { organizations } from "./core-schema.js";

export const organizationFeatures = pgTable(
  "organization_features",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    feature: text("feature").$type<OrgFeature>().notNull(),
    /** The platform admin who turned it on, by email. */
    enabledBy: text("enabled_by").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.organizationId, t.feature] }),
  }),
);
