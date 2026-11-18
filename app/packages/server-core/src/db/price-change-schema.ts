/**
 * Provider price-change watch: list-price changes for instance types an org
 * actually runs, and the org's thresholds. See `price-changes/` for the
 * detector and client-core `price-changes.ts` for the shared contract.
 *
 * Price history itself is not stored here. The instance pricing warehouse
 * keeps every price a provider has listed as one row per period it held
 * (`prices.valid_from` / `valid_to`), so a change is a pair of adjacent
 * periods there. What this table keeps is the org's side of a change: which
 * of its resources it hits, what that costs a month, and what was done about
 * it (alerted, registered as expected, modelled as a scenario).
 *
 * One row per (org, change), keyed by `change_key` (platform, instance type,
 * region, variant and the instant the new price took effect), so a rescan
 * refreshes the resources and the figure but never alerts twice.
 */
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { organizations } from "./core-schema.js";

/** One affected resource as stored on a change (names are resolved on read). */
export interface StoredPriceChangeResource {
  resourceId: string;
  accountId: string;
  units: number;
  approximate: boolean;
}

export const priceChangeEvents = pgTable(
  "price_change_events",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Stable identity of the change; see client-core `priceChangeKey`. */
    changeKey: text("change_key").notNull(),
    pluginId: text("plugin_id").notNull(),
    /** The warehouse's `platform` (`ec2`, `rds`, `azure`...). */
    platform: text("platform").notNull(),
    instanceType: text("instance_type").notNull(),
    region: text("region").notNull(),
    /** The variant matched, keyed like `InstancePricingUsage.selection`. */
    selection: jsonb("selection").$type<Record<string, string>>().notNull().default({}),
    oldHourlyUsd: doublePrecision("old_hourly_usd").notNull(),
    newHourlyUsd: doublePrecision("new_hourly_usd").notNull(),
    /** When the new price took effect (the warehouse's `valid_from`). */
    effectiveAt: timestamp("effective_at").notNull(),
    /** Instances, nodes or GPUs the org runs of it, summed over `resources`. */
    units: integer("units").notNull(),
    /** True when a cluster's node count was unknown, so `units` is a lower bound. */
    approximate: boolean("approximate").notNull().default(false),
    /** (new - old) x 730 hours x units, in USD; negative for a cut. */
    monthlyImpactUsd: doublePrecision("monthly_impact_usd").notNull(),
    resources: jsonb("resources").$type<StoredPriceChangeResource[]>().notNull().default([]),
    /** When the one alert for this change was routed; null until then (or below threshold). */
    alertedAt: timestamp("alerted_at"),
    /** Anomaly suppressions registered for it (`cost_anomaly_suppressions.id`). */
    suppressionIds: jsonb("suppression_ids").$type<string[]>().notNull().default([]),
    /**
     * The scenario model made from it with one click. FK-less like
     * `saved_filter_id`: the model is the user's to delete, and the read
     * checks it still exists.
     */
    scenarioModelId: text("scenario_model_id"),
    detectedAt: timestamp("detected_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgKeyIdx: uniqueIndex("price_change_events_org_key_idx").on(t.organizationId, t.changeKey),
    orgEffectiveIdx: index("price_change_events_org_effective_idx").on(
      t.organizationId,
      t.effectiveAt,
    ),
  }),
);

/**
 * Per-org price-change watch settings. No row means the shipped defaults.
 * `last_notified_at` is the daily scan's claim (the shared
 * `alerts/daily-window.ts` protocol): "last scan", not "last message".
 */
export const orgPriceChangeSettings = pgTable("org_price_change_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /** Whether the daily scan runs (and so alerts) for this org at all. */
  enabled: boolean("enabled").notNull().default(true),
  /** Changes moving the org's monthly cost by less than this (cents of USD) are not alerted. */
  minMonthlyImpactCents: integer("min_monthly_impact_cents").notNull().default(1000),
  /** Changes smaller than this percentage of the old price are not alerted. */
  minPercent: doublePrecision("min_percent").notNull().default(1),
  /** Register an alerted increase as expected, so anomaly detection does not fire on the step. */
  registerExpected: boolean("register_expected").notNull().default(true),
  lastNotifiedAt: timestamp("last_notified_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
