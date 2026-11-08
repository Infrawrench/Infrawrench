/**
 * The instance pricing warehouse: the AWS bulk price lists (and EC2 spot
 * prices), RunPod's GPU and CPU pod prices, Alibaba Cloud ECS, Azure virtual
 * machine, Google Cloud Compute Engine, Hetzner, OVHcloud, Oracle Cloud and IBM Cloud prices as ClickHouse tables, for instances.infrawrench.com's chat and
 * `/api/v1/instance-pricing` to query. (The module keeps its `aws-` name from
 * before the other clouds.)
 *
 * Written by the AWS bulk pricing sync (`web/src/aws-bulk-pricing/warehouse.ts`,
 * run by `.github/workflows/aws-bulk-pricing-sync.yml`) and read, with a
 * read-only token, by the chat (`instances/lib/chat/`). Both sides take the
 * tables from here: the loader creates them from {@link createTableSql} and
 * encodes rows in {@link TABLES} column order, and the chat's system prompt is
 * {@link describeSchema}, so the model sees exactly the columns the loader
 * writes and what each one means.
 *
 * Every table is partitioned by `source`, the bundle its rows came from (a
 * platform name, or `spot`), except `prices`, which is partitioned by `shard`:
 * the source, split into {@link SHARDS} buckets for the largest ones. A sync
 * loads one bundle into the same tables in the `staging` database and swaps
 * the source's partitions in with `REPLACE PARTITION`, so a reader never sees
 * a half-loaded table. (The shards exist because CloudHouse hangs replacing a
 * partition of a few million rows; half a million swaps in seconds.)
 *
 * Bump {@link SCHEMA_VERSION} on any change to a table: the next sync drops
 * every table and reloads every bundle.
 *
 * {@link SERVICE_EVENTS} (AWS's public status page history) sits beside the
 * bundle tables rather than among them: it has its own loader and is not
 * dropped by a schema version bump, since its older years exist only in
 * archived copies of AWS's feeds.
 */
import { PricingWarehouse } from "@infrawrench/client-core";

// The definitions are client-core's (`pricing-warehouse.ts`), so the API
// contract can document the tables without importing server code. These are
// the names the loaders, the chat and the tests import.
export const {
  SCHEMA_VERSION,
  STAGING_DATABASE,
  SHARDS,
  shardOf,
  shardsOf,
  VARIANT_COLUMNS,
  PRICES,
  INSTANCE_TYPES,
  ATTRIBUTE_CHANGES,
  REGIONS,
  SYNC_STATE,
  TABLES,
  SERVICE_EVENTS,
  QUERYABLE_TABLES,
  createTableSql,
  SCHEMA_NOTES,
  describeSchema,
} = PricingWarehouse;

export type ColumnType = PricingWarehouse.ColumnType;
export type Column = PricingWarehouse.Column;
export type Table = PricingWarehouse.Table;
