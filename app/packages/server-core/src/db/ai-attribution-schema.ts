import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { accounts, organizations, users } from "./core-schema.js";

/**
 * A configured AI request-log source: where per-request logs live and how to
 * read them. Either a provider plugin's source kind on one of the org's
 * accounts (Bedrock invocation logs through an AWS account, AI Gateway logs
 * through a Cloudflare account, JSONL in S3) or the host-owned LiteLLM
 * adapter, which has no account and carries its own encrypted key.
 *
 * The row doubles as the collection claim (`next_run_at` is the due time and
 * the lease, the cost-exports protocol) and carries the forward-only
 * watermark. Request logs do not restate, so a collected day is not revisited
 * unless someone asks (re-collect after a mapping change).
 *
 * Writes are `org:settings:write`, not `costs:write`: a source authorizes a
 * daily read of the org's request logs and, for the CloudWatch kind, a query
 * billed to the org's own AWS account.
 */
export const aiRequestSources = pgTable(
  "ai_request_sources",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** `plugin` | `litellm`. */
    kind: text("kind").notNull(),
    pluginId: text("plugin_id"),
    accountId: text("account_id").references(() => accounts.id, { onDelete: "cascade" }),
    sourceKindId: text("source_kind_id").notNull(),
    location: jsonb("location").$type<Record<string, string>>().notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    lookbackDays: integer("lookback_days").notNull().default(7),
    /** LiteLLM only. */
    baseUrl: text("base_url"),
    encryptedApiKey: text("encrypted_api_key"),
    apiKeyIv: text("api_key_iv"),
    collectedThrough: date("collected_through"),
    lastRunAt: timestamp("last_run_at"),
    /** Due time and claim lease. Null when disabled. */
    nextRunAt: timestamp("next_run_at"),
    failureCount: integer("failure_count").notNull().default(0),
    lastError: text("last_error"),
    lastErrorHelpUrl: text("last_error_help_url"),
    observedMetadataKeys: jsonb("observed_metadata_keys")
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    lastQueryBytesScanned: integer("last_query_bytes_scanned"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("ai_request_sources_org_idx").on(t.organizationId),
    dueIdx: index("ai_request_sources_due_idx").on(t.nextRunAt),
  }),
);

/**
 * A caller dimension (`team`, `feature`…) and the request-metadata keys that
 * feed it, first present wins. The dimension appears in every cost report as
 * the tag key `caller:<key>`.
 */
export const aiAttributionDimensions = pgTable(
  "ai_attribution_dimensions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    metadataKeys: jsonb("metadata_keys").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgKeyIdx: uniqueIndex("ai_attribution_dimensions_org_key_idx").on(t.organizationId, t.key),
  }),
);

/** Per-source figures one attribution run produced for one day. */
export interface AiAttributionDaySourceStats {
  requests: number;
  matchedRequests: number;
  ambiguousRequests: number;
  unmatchedRequests: number;
  skippedRecords: number;
  degraded: boolean;
  truncated: boolean;
  /** Keyed by currency. */
  attributed: Record<string, number>;
  billed: Record<string, number>;
}

/** How a source's latest collection of a day went. */
export interface AiAttributionDayCollection {
  requests: number;
  skipped: number;
  degraded: boolean;
  truncated: boolean;
}

/** Per-provider billed vs attributed money one run produced for one day. */
export interface AiAttributionDayProviderStats {
  provider: string;
  currency: string;
  billed: number;
  attributed: number;
}

/**
 * The outcome of the latest attribution run for one org-day: match-rate
 * statistics per source and coverage per provider. Small (one row per day)
 * and overwritten on every run, so the stats endpoint sums a range in app code
 * without touching ClickHouse.
 */
export const aiAttributionDays = pgTable(
  "ai_attribution_days",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    /** Null until the first run; a collection can record its outcome before one. */
    runAt: timestamp("run_at"),
    sources: jsonb("sources")
      .$type<Record<string, AiAttributionDaySourceStats>>()
      .notNull()
      .default({}),
    providers: jsonb("providers").$type<AiAttributionDayProviderStats[]>().notNull().default([]),
    /** What each source's latest collection of the day reported about itself. */
    collections: jsonb("collections")
      .$type<Record<string, AiAttributionDayCollection>>()
      .notNull()
      .default({}),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.organizationId, t.day] }),
  }),
);
