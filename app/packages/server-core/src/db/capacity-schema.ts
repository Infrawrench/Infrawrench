/**
 * Capacity runway readings: a resource's declared usage and its limit, one row
 * per resource, usage and hour.
 *
 * The values are already in `resources.fields_json`, overwritten on every
 * sync; this is the history that turns "62 GiB of 100" into "full in 19
 * days". The sync writes it (`capacity/record.ts`), so a reading costs no
 * provider call and no pass of its own.
 *
 * One row per *hour* rather than per sync: an account polled every few
 * minutes would otherwise write a dozen identical points an hour for a trend
 * fitted over a fortnight. The bucket is the identity and a later sync in the
 * same hour overwrites the row, so the hour keeps its latest reading.
 *
 * The limit is stored on every row for the quota radar's reason: a resized
 * disk or an upgraded plan must not rewrite last week's utilisation.
 *
 * `resource_id` carries no FK: resources are soft-deleted, and the history of
 * one that is gone is pruned by retention like any other row. Deleting the
 * account takes it with the cascade.
 */
import { doublePrecision, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { accounts, organizations } from "./core-schema.js";

export const resourceCapacitySnapshots = pgTable(
  "resource_capacity_snapshots",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    resourceId: text("resource_id").notNull(),
    /** The declaration's key: a field or output key (`metric:` usages are never stored here). */
    capacityKey: text("capacity_key").notNull(),
    used: doublePrecision("used").notNull(),
    capacityLimit: doublePrecision("capacity_limit").notNull(),
    /** When the provider value was read: the resource's sync time. */
    observedAt: timestamp("observed_at").notNull(),
    /** `observed_at` truncated to the hour: the row's identity. */
    bucket: timestamp("bucket").notNull(),
  },
  (t) => ({
    bucketUnique: uniqueIndex("resource_capacity_snapshots_bucket_unique").on(
      t.resourceId,
      t.capacityKey,
      t.bucket,
    ),
    /** The feed's read: the org's readings since the window opened. */
    orgObservedIdx: index("resource_capacity_snapshots_org_observed_idx").on(
      t.organizationId,
      t.observedAt,
    ),
  }),
);
