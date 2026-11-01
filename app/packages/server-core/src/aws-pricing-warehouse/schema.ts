/**
 * The AWS pricing warehouse: the AWS bulk price lists (and EC2 spot prices)
 * as ClickHouse tables, for instances.infrawrench.com's chat to query.
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
 */

export const SCHEMA_VERSION = 2;

/** The database a sync loads a bundle into before swapping it in. */
export const STAGING_DATABASE = "staging";

/** Column types the loader knows how to encode (RowBinary). */
export type ColumnType =
  | "String"
  | "LowCardinality(String)"
  | "Nullable(String)"
  | "Float64"
  | "Nullable(Float64)"
  | "UInt32"
  | "Nullable(UInt32)"
  | "UInt64"
  | "DateTime"
  | "Nullable(DateTime)"
  | "Bool"
  | "Map(String, String)";

export interface Column {
  name: string;
  type: ColumnType;
  /** What it holds, for the model: units, allowed values, how to use it. */
  comment: string;
}

export interface Table {
  name: string;
  comment: string;
  columns: readonly Column[];
  orderBy: readonly string[];
  /** The partition key column; `source` unless said otherwise. */
  partitionBy?: string;
}

/** Sources whose `prices` rows are split into this many shards (about 400,000 rows each). */
export const SHARDS: Readonly<Record<string, number>> = { ec2: 16, spot: 16 };

/** FNV-1a, so a shard is a pure function of the instance type. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** The `prices` partition an instance type's rows go in. */
export function shardOf(source: string, instanceType: string): string {
  const n = SHARDS[source];
  return n ? `${source}-${String(fnv1a(instanceType) % n).padStart(2, "0")}` : source;
}

/** Every `prices` partition a source can have. */
export function shardsOf(source: string): string[] {
  const n = SHARDS[source];
  return n
    ? Array.from({ length: n }, (_, i) => `${source}-${String(i).padStart(2, "0")}`)
    : [source];
}

const col = (name: string, type: ColumnType, comment: string): Column => ({ name, type, comment });

const SOURCE = col(
  "source",
  "LowCardinality(String)",
  "Which price list bundle the row was loaded from: the platform name, or `spot` for EC2 spot prices. Rarely needed in queries.",
);
const PLATFORM = col(
  "platform",
  "LowCardinality(String)",
  "AWS service: `ec2`, `rds`, `elasticache`, `opensearch`, `redshift`, `docdb`, `neptune`, `memorydb`, `dax`, `sagemaker`, `emr` or `gamelift`. Spot prices are `ec2`.",
);
const INSTANCE_TYPE = col(
  "instance_type",
  "String",
  "The instance type as AWS names it on that platform, e.g. `m7g.large`, `db.r6g.xlarge`, `cache.t4g.micro`, `r6g.large.search`, `ml.g5.xlarge`.",
);
const FAMILY = col(
  "family",
  "LowCardinality(String)",
  "Instance family without any platform prefix, e.g. `m7g` for `m7g.large` and `db.m7g.large`; `` when the name does not parse.",
);
const SIZE = col(
  "size",
  "LowCardinality(String)",
  "Size part of the name: `nano`, `micro`, `small`, `medium`, `large`, `xlarge`, `2xlarge`, ..., `metal`, `metal-48xl`.",
);
const ARCHITECTURE = col(
  "architecture",
  "LowCardinality(String)",
  "CPU architecture: `arm64` (AWS Graviton, Apple silicon) or `x86_64` (Intel, AMD); `` when AWS gives nothing to tell. Use this for ARM vs x86 questions.",
);
const VCPU = col("vcpu", "Nullable(Float64)", "vCPUs.");
const MEMORY = col("memory_gib", "Nullable(Float64)", "Memory in GiB.");
const GPUS = col(
  "gpus",
  "Nullable(UInt32)",
  "Number of GPUs (or accelerators); NULL when it has none listed.",
);

/**
 * Variant fields AWS prices products by, as their own columns. Price list keys
 * map onto these (several platforms share `usagetype`, `licenseModel`); a key
 * not listed here lands in `prices.variant`.
 */
export const VARIANT_COLUMNS: Readonly<Record<string, string>> = {
  operatingSystem: "operating_system",
  tenancy: "tenancy",
  licenseModel: "license_model",
  preInstalledSw: "pre_installed_sw",
  capacitystatus: "capacity_status",
  databaseEngine: "database_engine",
  databaseEdition: "database_edition",
  deploymentOption: "deployment_option",
  deploymentModel: "deployment_model",
  engineMediaType: "engine_media_type",
  cacheEngine: "cache_engine",
  engine: "cache_engine",
  softwareType: "software_type",
  component: "component",
  usagetype: "usage_type",
};

export const PRICES: Table = {
  name: "prices",
  comment:
    "Every price AWS has listed for an instance type, one row per period a price held. `current = true` (equivalently `valid_to IS NULL`) is the price on offer now; filter on it unless the question is about history. A product's price is identified by (platform, instance_type, region, pricing, lease, offering_class, purchase_option) plus its variant columns, so always fix the variant columns that matter for the platform (see the defaults in the notes) or you will mix e.g. Windows and Linux prices.",
  columns: [
    SOURCE,
    col(
      "shard",
      "LowCardinality(String)",
      "Internal storage partition (the source, split into buckets for ec2 and spot). Never needed in queries.",
    ),
    PLATFORM,
    INSTANCE_TYPE,
    FAMILY,
    SIZE,
    ARCHITECTURE,
    VCPU,
    MEMORY,
    GPUS,
    col(
      "region",
      "LowCardinality(String)",
      "Region code, e.g. `us-east-1`, `eu-central-1`, or a Local Zone / Wavelength code such as `us-east-1-atl-1`. For the few locations AWS gives no code it is the location name. Join `regions` for the human name.",
    ),
    col(
      "pricing",
      "LowCardinality(String)",
      "`on_demand`, `reserved` (reserved instances; see lease, offering_class, purchase_option) or `spot` (EC2 spot, Linux and Windows only, from AWS's spot price feed).",
    ),
    col("lease", "LowCardinality(String)", "Reserved term length: `1yr` or `3yr`; `` otherwise."),
    col(
      "offering_class",
      "LowCardinality(String)",
      "Reserved offering class: `standard` or `convertible`; `` otherwise.",
    ),
    col(
      "purchase_option",
      "LowCardinality(String)",
      "Reserved payment option: `No Upfront`, `Partial Upfront` or `All Upfront`; `` otherwise.",
    ),
    col(
      "operating_system",
      "LowCardinality(String)",
      "EC2, GameLift and spot: `Linux`, `Windows`, `RHEL`, `SUSE`, `Ubuntu Pro`, `Red Hat Enterprise Linux with HA`, ... ; `` elsewhere.",
    ),
    col(
      "tenancy",
      "LowCardinality(String)",
      "EC2: `Shared` (normal), `Dedicated` (dedicated instance) or `Host` (dedicated host).",
    ),
    col(
      "license_model",
      "LowCardinality(String)",
      "EC2/RDS: `No License required`, `License included`, `Bring your own license`.",
    ),
    col(
      "pre_installed_sw",
      "LowCardinality(String)",
      "EC2: bundled software, `NA` for none, else e.g. `SQL Std`, `SQL Web`, `SQL Ent`.",
    ),
    col(
      "capacity_status",
      "LowCardinality(String)",
      "EC2: `Used` (a normal running instance), `UnusedCapacityReservation` or `AllocatedCapacityReservation`.",
    ),
    col(
      "database_engine",
      "LowCardinality(String)",
      "RDS: `PostgreSQL`, `MySQL`, `MariaDB`, `Oracle`, `SQL Server`, `Aurora PostgreSQL`, `Aurora MySQL`, `Db2`, ...",
    ),
    col(
      "database_edition",
      "LowCardinality(String)",
      "RDS: edition for commercial engines (`Standard`, `Enterprise`, `Web`, `Express`, ...); `` for open-source ones.",
    ),
    col(
      "deployment_option",
      "LowCardinality(String)",
      "RDS: `Single-AZ`, `Multi-AZ`, `Multi-AZ (readable standbys)`, ...",
    ),
    col("deployment_model", "LowCardinality(String)", "RDS: e.g. `Outposts`; usually ``."),
    col("engine_media_type", "LowCardinality(String)", "RDS: e.g. `AWS-provided`; usually ``."),
    col(
      "cache_engine",
      "LowCardinality(String)",
      "ElastiCache and MemoryDB: `Redis`, `Valkey`, `Memcached`.",
    ),
    col("software_type", "LowCardinality(String)", "EMR: the EMR software line, e.g. `EMR`."),
    col(
      "component",
      "LowCardinality(String)",
      "SageMaker: what the instance runs, e.g. `Hosting`, `Training`, `Notebook`, `Processing`, `studio-jupyterlab`.",
    ),
    col(
      "usage_type",
      "LowCardinality(String)",
      "AWS usage type with the region prefix removed, e.g. `BoxUsage`, `InstanceUsage`, `Multi-AZUsage`, `NodeUsage`. Distinguishes e.g. Outposts or durability variants.",
    ),
    col(
      "variant",
      "Map(String, String)",
      "Any other price list variant fields, by their AWS key (e.g. Neptune `mncu`, SageMaker `platoinstancetype`). Usually empty.",
    ),
    col(
      "hourly_usd",
      "Float64",
      "Hourly price in USD. For reserved rows it is the recurring hourly fee only; see effective_hourly_usd.",
    ),
    col(
      "upfront_usd",
      "Float64",
      "One-off upfront payment in USD for a reserved term; 0 otherwise.",
    ),
    col(
      "effective_hourly_usd",
      "Float64",
      "What an hour costs all in: hourly_usd plus upfront_usd spread over the term (8,760 hours a year). Compare on this. A month is 730 hours.",
    ),
    col("valid_from", "DateTime", "When AWS started listing this price (UTC)."),
    col(
      "valid_to",
      "Nullable(DateTime)",
      "When the price stopped applying (replaced, withdrawn or the instance retired); NULL while it is current.",
    ),
    col("current", "Bool", "True for prices on offer now (valid_to IS NULL)."),
  ],
  orderBy: ["platform", "instance_type", "region", "pricing", "valid_from"],
  partitionBy: "shard",
};

export const INSTANCE_TYPES: Table = {
  name: "instance_types",
  comment:
    "One row per instance type per platform with its current specs. EC2 spot prices use the `ec2` rows. Specs AWS does not list are NULL or ``; `attributes` has every attribute AWS publishes, as strings.",
  columns: [
    SOURCE,
    PLATFORM,
    INSTANCE_TYPE,
    FAMILY,
    SIZE,
    ARCHITECTURE,
    VCPU,
    MEMORY,
    GPUS,
    col("gpu_memory_gib", "Nullable(Float64)", "Total GPU memory in GiB."),
    col("gpu_model", "String", "GPU model when AWS names it, e.g. `NVIDIA A10G`."),
    col(
      "processor",
      "String",
      "Physical processor, e.g. `AWS Graviton3 Processor`, `Intel Xeon Platinum 8488C`, `AMD EPYC 9R14`.",
    ),
    col("clock_speed_ghz", "Nullable(Float64)", "Sustained clock speed in GHz."),
    col(
      "network_performance",
      "String",
      "As AWS writes it, e.g. `Up to 12.5 Gigabit`, `25 Gigabit`, `Moderate`.",
    ),
    col(
      "network_gbps",
      "Nullable(Float64)",
      "network_performance as a number of Gbit/s (the burst figure for `Up to`); NULL for `Low`/`Moderate`/`High`.",
    ),
    col(
      "storage",
      "String",
      "Instance storage as AWS writes it, e.g. `EBS only`, `1 x 237 NVMe SSD`.",
    ),
    col(
      "category",
      "LowCardinality(String)",
      "AWS's family category: `General purpose`, `Compute optimized`, `Memory optimized`, `Storage optimized`, `GPU instance`, `Accelerated Computing`, `Machine Learning ASIC Instances`, ...",
    ),
    col(
      "current_generation",
      "Bool",
      "False for previous-generation types AWS still sells but no longer recommends.",
    ),
    col(
      "regions_offered",
      "UInt32",
      "How many regions offer it on demand now; 0 when it is no longer sold anywhere.",
    ),
    col("first_listed", "DateTime", "When it first appeared in the price list (UTC)."),
    col(
      "retired_at",
      "Nullable(DateTime)",
      "When AWS dropped it from the price list; NULL while it is listed. Filter `retired_at IS NULL` for types you can still buy.",
    ),
    col("attributes", "Map(String, String)", "Every attribute AWS lists for it, current values."),
  ],
  orderBy: ["platform", "instance_type"],
};

export const ATTRIBUTE_CHANGES: Table = {
  name: "attribute_changes",
  comment:
    "History of instance attributes: the values each type was first listed with, then every change. Use it for questions like when a spec changed.",
  columns: [
    SOURCE,
    PLATFORM,
    INSTANCE_TYPE,
    col("at", "DateTime", "When the value took effect (UTC)."),
    col("attribute", "String", "AWS attribute key, e.g. `memory`, `networkPerformance`."),
    col("value", "Nullable(String)", "The new value; NULL when the attribute was removed."),
    col("region", "String", "Region code it applies to, `` for every region."),
  ],
  orderBy: ["platform", "instance_type", "at"],
};

export const REGIONS: Table = {
  name: "regions",
  comment:
    "Region codes and the names AWS gives them, per platform's price list. Use it to turn a city or country into a region code.",
  columns: [
    SOURCE,
    col("region", "String", "Region code as in prices.region, e.g. `eu-central-1`."),
    col("location", "String", "AWS's location name, e.g. `EU (Frankfurt)`."),
    col(
      "location_type",
      "LowCardinality(String)",
      "`AWS Region`, `AWS Local Zone`, `AWS Wavelength Zone` or `AWS Outposts`.",
    ),
  ],
  orderBy: ["region"],
};

export const SYNC_STATE: Table = {
  name: "sync_state",
  comment:
    "When each bundle was loaded and which AWS price lists it covers; `max(price_list_to)` is how fresh the data is.",
  columns: [
    SOURCE,
    col("version", "String", "The bundle version loaded."),
    col("schema_version", "UInt32", "Warehouse schema version it was loaded with."),
    col("price_lists", "UInt32", "How many AWS price list versions the bundle was built from."),
    col("price_list_from", "Nullable(DateTime)", "Oldest price list in the bundle (UTC)."),
    col("price_list_to", "Nullable(DateTime)", "Newest price list in the bundle (UTC)."),
    col("synced_at", "DateTime", "When it was loaded (UTC)."),
    col("price_rows", "UInt64", "Rows it wrote to prices."),
  ],
  orderBy: ["source"],
};

/** Every table, in load order; `sync_state` last, since it says a load finished. */
export const TABLES: readonly Table[] = [
  PRICES,
  INSTANCE_TYPES,
  ATTRIBUTE_CHANGES,
  REGIONS,
  SYNC_STATE,
];

const quote = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** `CREATE TABLE IF NOT EXISTS`, with every comment, in `database` (the current one by default). */
export function createTableSql(table: Table, database?: string): string {
  const name = database ? `${database}.${table.name}` : table.name;
  const columns = table.columns
    .map((c) => `  ${c.name} ${c.type} COMMENT ${quote(c.comment)}`)
    .join(",\n");
  return [
    `CREATE TABLE IF NOT EXISTS ${name} (\n${columns}\n)`,
    "ENGINE = MergeTree",
    `PARTITION BY ${table.partitionBy ?? "source"}`,
    `ORDER BY (${table.orderBy.join(", ")})`,
    `COMMENT ${quote(table.comment)}`,
  ].join("\n");
}

/**
 * The schema as the chat's system prompt shows it: each table as SQL-ish
 * column lists with their comments, then the conventions a correct query
 * depends on. Deterministic, so it caches with the rest of the prompt.
 */
export function describeSchema(): string {
  const tables = TABLES.map((t) => {
    const columns = t.columns.map((c) => `  ${c.name} ${c.type}  -- ${c.comment}`).join("\n");
    return `TABLE ${t.name}  -- ${t.comment}\n${columns}`;
  }).join("\n\n");
  return `${tables}

Notes:
- All prices are USD. Timestamps are UTC DateTime.
- Usual defaults when the question does not say otherwise:
  - ec2: operating_system = 'Linux', tenancy = 'Shared', pre_installed_sw = 'NA', capacity_status = 'Used', license_model = 'No License required', pricing = 'on_demand'.
  - rds: deployment_option = 'Single-AZ', and pick a database_engine (PostgreSQL if unsaid).
  - elasticache / memorydb: cache_engine = 'Redis' (or 'Valkey'), usage_type = 'NodeUsage'.
  - region: us-east-1.
- "Cheapest" means the lowest effective_hourly_usd among current rows. Hourly to monthly: x 730.
- Spot rows (pricing = 'spot') only exist for ec2 with operating_system 'Linux' or 'Windows'; spot prices move often, so their history is dense.
- Reserved rows: an All Upfront term has hourly_usd = 0 and the whole cost in upfront_usd; compare reserved and on-demand on effective_hourly_usd.
- Use instance_types for specs and to list types; join prices on (platform, instance_type) when you need specs it does not carry.
- prices is large (millions of rows for ec2): always filter on platform and current (or a time range), and aggregate or LIMIT.`;
}
