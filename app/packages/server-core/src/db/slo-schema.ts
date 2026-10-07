/**
 * Service-level objectives: a target over a rolling window, measured from the
 * metric store (synthetic probe series, or any series a synced resource
 * reports).
 *
 * One table. Like query monitors, the time series is deliberately **not**
 * stored here: the events an SLO counts are already in ClickHouse's 1m rollup,
 * and the evaluator and the detail view both read them from there. What is
 * kept is the last snapshot (SLI, budget, burn rates), which is what the list
 * renders, what the wallboard reads, and the claim column the alert
 * transitions are deduplicated on.
 *
 * The source columns are **not** foreign keys, the `synthetic_probes.resource_id`
 * stance: deleting a probe or a resource must not silently delete the
 * objective somebody wrote about it. The SLO goes `unknown` with a
 * `last_error` naming what disappeared, and can be pointed at a replacement.
 *
 * Lives in its own module (importing only `core-schema.js`) and is re-exported
 * from `schema.ts`, the satellite-schema convention.
 */
import {
  pgTable,
  text,
  boolean,
  integer,
  doublePrecision,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  SloBurnAlert,
  SloBurnRates,
  SloComparator,
  SloSliKind,
} from "@infrawrench/client-core";

import { organizations, users } from "./core-schema.js";

export const slos = pgTable(
  "slos",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),

    /** "probe_availability" | "probe_latency" | "metric_threshold" */
    sliKind: text("sli_kind").$type<SloSliKind>().notNull(),
    /** `probe_*`: the synthetic probe row. Not a FK, see above. */
    probeId: text("probe_id"),
    /** `probe_latency`: good at or under this many milliseconds. */
    latencyThresholdMs: integer("latency_threshold_ms"),
    /** `metric_threshold`: the synced resource (`resources.id`). Not a FK. */
    resourceId: text("resource_id"),
    metricKey: text("metric_key"),
    comparator: text("comparator").$type<SloComparator>(),
    threshold: doublePrecision("threshold"),

    /** Percentage, e.g. 99.9. */
    targetPercent: doublePrecision("target_percent").notNull(),
    /** 7 | 28 | 30. */
    windowDays: integer("window_days").notNull().default(30),
    alertsEnabled: boolean("alerts_enabled").notNull().default(true),
    suggestFreeze: boolean("suggest_freeze").notNull().default(true),
    enabled: boolean("enabled").notNull().default(true),

    /**
     * Due time **and** claim lease, the metric-alert protocol: the claim pushes
     * it forward in the same statement, and completion overwrites the lease
     * with the true next cadence. Null means due now.
     */
    nextEvalAt: timestamp("next_eval_at"),
    lastEvalAt: timestamp("last_eval_at"),

    /** Last snapshot; null fields mean "no data in the window". */
    sli: doublePrecision("sli"),
    goodEvents: doublePrecision("good_events").notNull().default(0),
    totalEvents: doublePrecision("total_events").notNull().default(0),
    budgetRemaining: doublePrecision("budget_remaining"),
    burnRates: jsonb("burn_rates").$type<SloBurnRates>().notNull().default({}),
    lastError: text("last_error"),

    /**
     * The alert level last settled on: "none" | "slow" | "fast". A transition
     * is a conditional `UPDATE … WHERE burn_alert = <old>`, so with N replicas
     * evaluating the same SLO exactly one sends the notification.
     */
    burnAlert: text("burn_alert").$type<SloBurnAlert>().notNull().default("none"),
    burnAlertChangedAt: timestamp("burn_alert_changed_at"),
    /**
     * When the budget last ran out; cleared once some is back. Set by the same
     * conditional-update claim, so the "budget exhausted" message goes out once
     * per episode.
     */
    exhaustedAt: timestamp("exhausted_at"),

    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("slos_org_idx").on(t.organizationId),
    dueIdx: index("slos_due_idx").on(t.nextEvalAt),
    orgNameUnique: uniqueIndex("slos_org_name_unique").on(t.organizationId, t.name),
    targetRange: check(
      "slos_target_range",
      sql`${t.targetPercent} >= 50 AND ${t.targetPercent} < 100`,
    ),
    windowAllowed: check("slos_window_allowed", sql`${t.windowDays} IN (7, 28, 30)`),
  }),
);
