/**
 * The instance pricing warehouse: the AWS bulk price lists (and EC2 spot
 * prices), RunPod's GPU and CPU pod prices, Alibaba Cloud ECS, Azure virtual
 * machine and Google Cloud Compute Engine prices as ClickHouse tables, for instances.infrawrench.com's chat and
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

export const SCHEMA_VERSION = 3;

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
  /** Data skipping indexes, as `name expression TYPE type GRANULARITY n`. */
  indexes?: readonly string[];
}

/** Sources whose `prices` rows are split into this many shards (about 400,000 rows each). */
export const SHARDS: Readonly<Record<string, number>> = {
  ec2: 16,
  spot: 16,
  alibaba: 4,
  azure: 2,
};

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
  "Platform. AWS services: `ec2`, `rds`, `elasticache`, `opensearch`, `redshift`, `docdb`, `neptune`, `memorydb`, `dax`, `sagemaker`, `emr` or `gamelift` (EC2 spot prices are `ec2`). Other clouds: `runpod` (RunPod GPU types and CPU pods), `alibaba` (Alibaba Cloud ECS), `azure` (Azure virtual machines) and `gcp` (Google Cloud Compute Engine).",
);
const INSTANCE_TYPE = col(
  "instance_type",
  "String",
  "The instance type as the provider names it on that platform, e.g. `m7g.large`, `db.r6g.xlarge`, `cache.t4g.micro`, `r6g.large.search`, `ml.g5.xlarge`; Alibaba `ecs.g7.large`; Azure VM sizes by ARM name such as `Standard_D2s_v3`; Google Cloud machine types such as `n2-standard-2`; RunPod GPU type ids such as `NVIDIA H100 80GB HBM3` and CPU pod ids such as `cpu3c-2-4` (flavor, vCPUs, GB of memory).",
);
const FAMILY = col(
  "family",
  "LowCardinality(String)",
  "Instance family without any platform prefix, e.g. `m7g` for `m7g.large` and `db.m7g.large`, `g7` for Alibaba's `ecs.g7.large`, the flavor `cpu3c` for a RunPod CPU pod `cpu3c-2-4`, the Azure series as Azure writes it (`Dsv3` for `Standard_D2s_v3`, `NCads_H100_v5`), the Google Cloud machine series (`n2` for `n2-standard-2`, `c4a`); `''` when the name does not parse (RunPod GPU types, a few Azure oddities).",
);
const SIZE = col(
  "size",
  "LowCardinality(String)",
  "Size part of the name: `nano`, `micro`, `small`, `medium`, `large`, `xlarge`, `2xlarge`, ..., `metal`, `metal-48xl`; for a RunPod CPU pod, `<vcpus>-<memory GB>` (`2-4`); for Azure, the vCPUs in the name (`2`, or `64-16` for a constrained-vCPU size); for Google Cloud, the rest of the name after the series (`standard-2`, `highgpu-1g`, `standard-4-lssd`, `micro`); `''` for RunPod GPU types.",
);
const ARCHITECTURE = col(
  "architecture",
  "LowCardinality(String)",
  "CPU architecture: `arm64` (AWS Graviton, Apple silicon, Alibaba Yitian and Ampere, Azure Cobalt and Ampere, Google Axion and Ampere) or `x86_64` (Intel, AMD, Hygon); `''` when the provider gives nothing to tell (RunPod). Use this for ARM vs x86 questions.",
);
const VCPU = col(
  "vcpu",
  "Nullable(Float64)",
  "vCPUs; NULL for RunPod GPU types and for the Azure sizes Azure's pricing calculator gives no specs for (mostly the newest and retired series).",
);
const MEMORY = col(
  "memory_gib",
  "Nullable(Float64)",
  "Memory in GiB (RunPod reports GB); NULL for RunPod GPU types, whose memory is GPU memory (instance_types.gpu_memory_gib), and for Azure sizes without calculator specs.",
);
const GPUS = col(
  "gpus",
  "Nullable(UInt32)",
  "Number of GPUs (or accelerators); NULL when it has none listed. 1 for a RunPod GPU type, which is priced per GPU. Azure lists GPUs for only some sizes, so an Azure N-series size can have NULL here.",
);

/**
 * Variant fields products are priced by, as their own columns. Price list keys
 * map onto these (several platforms share `usagetype`, `licenseModel`, and
 * Alibaba's and Azure's `operatingSystem` share EC2's); a key not listed here
 * lands in `prices.variant` (Alibaba's `networkType`, RunPod's `cloudType`,
 * Azure's `priority`, Google Cloud's `provisioningModel`).
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
    "Every price the provider has listed for an instance type, one row per period a price held. `current = true` (equivalently `valid_to IS NULL`) is the price on offer now; filter on it unless the question is about history. A product's price is identified by (platform, instance_type, region, pricing, lease, offering_class, purchase_option) plus its variant columns, so always fix the variant columns that matter for the platform (see the defaults in the notes) or you will mix e.g. Windows and Linux prices.",
  columns: [
    SOURCE,
    col(
      "shard",
      "LowCardinality(String)",
      "Internal storage partition (the source, split into buckets for the largest sources). Never needed in queries.",
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
      "Region code, e.g. `us-east-1`, `eu-central-1`, or a Local Zone / Wavelength code such as `us-east-1-atl-1`. For the few locations AWS gives no code it is the location name. Alibaba uses its region ids (`cn-hangzhou`, `ap-southeast-1`, and its own `us-east-1`, Virginia). Azure uses its ARM region names (`eastus`, `westeurope`; a few Spot prices that apply in every region are at `Global`), Google Cloud its region ids (`us-central1`, `europe-west4`; prices are per region, not per zone). RunPod prices are the same in every data center, so every RunPod row is `global`. Join `regions` (on source or platform too, since codes repeat across clouds) for the human name.",
    ),
    col(
      "pricing",
      "LowCardinality(String)",
      "`on_demand` (Alibaba and Azure: pay-as-you-go; Azure's Spot and Low Priority and Google Cloud's Spot prices are also `on_demand` rows, told apart by variant['priority'] and variant['provisioningModel']), `reserved` (any committed price: AWS reserved instances, Alibaba subscriptions and reserved instances, Azure reservations and savings plans, Google Cloud committed use discounts, RunPod savings plans; see lease, offering_class, purchase_option) or `spot` (EC2 spot only, Linux and Windows, from AWS's spot price feed).",
    ),
    col(
      "lease",
      "LowCardinality(String)",
      "Committed term length: `1yr` or `3yr` (AWS, Alibaba reserved instances, Azure savings plans, Google Cloud committed use), `1mo` or `1yr` to `5yr` (Alibaba subscriptions), `1yr`, `3yr`, `5yr` or `10yr` (Azure reservations), `3mo` or `6mo` (RunPod savings plans); `''` for on-demand and spot.",
    ),
    col(
      "offering_class",
      "LowCardinality(String)",
      "What kind of commitment: AWS reserved instances `standard` or `convertible`; Alibaba `Subscription` or `Reserved Instance`; Azure `Reserved Instance` or `Savings Plan`; Google Cloud `Committed Use`; RunPod `Savings Plan`; `''` otherwise.",
    ),
    col(
      "purchase_option",
      "LowCardinality(String)",
      "Payment option: `No Upfront`, `Partial Upfront` or `All Upfront` (Alibaba subscriptions, Azure reservations and RunPod savings plans are always `All Upfront`; Azure savings plans and Google Cloud committed use are `No Upfront`); `''` otherwise.",
    ),
    col(
      "operating_system",
      "LowCardinality(String)",
      "EC2, GameLift and spot: `Linux`, `Windows`, `RHEL`, `SUSE`, `Ubuntu Pro`, `Red Hat Enterprise Linux with HA`, ... ; Alibaba and Azure: `Linux` or `Windows`; `''` elsewhere (Google Cloud prices leave out OS licenses).",
    ),
    col(
      "tenancy",
      "LowCardinality(String)",
      "EC2: `Shared` (normal), `Dedicated` (dedicated instance) or `Host` (dedicated host).",
    ),
    col(
      "license_model",
      "LowCardinality(String)",
      "EC2: `No License required` (the normal price, Windows license included), `License Included - Infrastructure` and `Bring your own license` (Windows only; both are the compute part alone, without the Windows license). RDS: `No license required`, `License included`, `Bring your own license`, `Bring your own media`, `Marketplace`. Match on the exact value.",
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
      "RDS: edition for commercial engines (`Standard`, `Enterprise`, `Web`, `Express`, ...); `''` for open-source ones.",
    ),
    col(
      "deployment_option",
      "LowCardinality(String)",
      "RDS: `Single-AZ`, `Multi-AZ`, `Multi-AZ (readable standbys)`, ...",
    ),
    col("deployment_model", "LowCardinality(String)", "RDS: e.g. `Outposts`; usually `''`."),
    col("engine_media_type", "LowCardinality(String)", "RDS: e.g. `AWS-provided`; usually `''`."),
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
      "Any other variant fields, by their price list key: Neptune `mncu`, SageMaker `platoinstancetype`; Alibaba `networkType` (`VPC`, or `Classic` in older history); RunPod `cloudType` (`Secure Cloud` or `Community Cloud`); Azure `priority` (`Regular`, `Spot` or `Low Priority`); Google Cloud `provisioningModel` (`Standard` or `Spot`). Read with variant['networkType'].",
    ),
    col(
      "hourly_usd",
      "Float64",
      "Hourly price in USD. For reserved rows it is the recurring hourly fee only (0 for All Upfront terms, Alibaba subscriptions and Azure reservations); see effective_hourly_usd. A RunPod or Azure savings plan's and a Google Cloud commitment's hourly_usd is its hourly rate. RunPod GPU prices are per GPU.",
    ),
    col(
      "upfront_usd",
      "Float64",
      "One-off upfront payment in USD for a committed term (an Alibaba subscription's or Azure reservation's whole price); 0 otherwise.",
    ),
    col(
      "effective_hourly_usd",
      "Float64",
      "What an hour costs all in: hourly_usd plus upfront_usd spread over the term (8,760 hours a year, 730 a month). Compare on this. A month is 730 hours.",
    ),
    col("valid_from", "DateTime", "When the provider started listing this price (UTC)."),
    col(
      "valid_to",
      "Nullable(DateTime)",
      "When the price stopped applying (replaced, withdrawn or the instance retired); NULL while it is current.",
    ),
    col("current", "Bool", "True for prices on offer now (valid_to IS NULL)."),
  ],
  orderBy: ["platform", "instance_type", "region", "pricing", "valid_from"],
  partitionBy: "shard",
  // `shard` hashes the instance type, so every partition holds some of every
  // platform: without the index a lookup of one instance type reads a block of
  // each partition, with it only the partition that has the type.
  indexes: ["instance_type_bloom instance_type TYPE bloom_filter GRANULARITY 1"],
};

export const INSTANCE_TYPES: Table = {
  name: "instance_types",
  comment:
    "One row per instance type per platform with its current specs. EC2 spot prices use the `ec2` rows. Specs the provider does not list are NULL or `''`; `attributes` has every attribute it publishes, as strings (AWS's price list keys, Alibaba's DescribeInstanceTypes fields such as `CpuCoreCount` and `CpuOptions.ThreadsPerCore`, Azure's pricing calculator fields such as `cores`, `ram` and `series`, Google Cloud's Compute Engine machine type fields such as `guestCpus`, `memoryMb` and `zones`, RunPod's GraphQL fields such as `maxGpuCountSecureCloud` and `dataCenters`).",
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
    col(
      "gpu_memory_gib",
      "Nullable(Float64)",
      "Total GPU memory in GiB (RunPod: the one GPU's memory in GB; Google Cloud: from the accelerator type when it names its memory, as in `nvidia-h100-80gb`); NULL when not listed (Azure).",
    ),
    col(
      "gpu_model",
      "String",
      "GPU model when the provider names it, e.g. `NVIDIA A10G`, Alibaba `NVIDIA A10`, Azure `H100` or `V100`, Google Cloud's accelerator type `nvidia-h100-80gb`, RunPod's display name `H100 SXM`.",
    ),
    col(
      "processor",
      "String",
      "Physical processor, e.g. `AWS Graviton3 Processor`, `Intel Xeon Platinum 8488C`, `AMD EPYC 9R14`; `''` for RunPod, Azure and Google Cloud.",
    ),
    col("clock_speed_ghz", "Nullable(Float64)", "Sustained clock speed in GHz."),
    col(
      "network_performance",
      "String",
      "As AWS writes it, e.g. `Up to 12.5 Gigabit`, `25 Gigabit`, `Moderate`; Alibaba's receive bandwidth as `<n> Gbit/s`; `''` for RunPod, Azure and Google Cloud.",
    ),
    col(
      "network_gbps",
      "Nullable(Float64)",
      "network_performance as a number of Gbit/s (the burst figure for `Up to`); NULL for `Low`/`Moderate`/`High`.",
    ),
    col(
      "storage",
      "String",
      "Instance storage as AWS writes it, e.g. `EBS only`, `1 x 237 NVMe SSD`; Alibaba local disks as `<count> x <GiB> GiB <category>`; Azure's temporary disk as `<GiB> GiB temporary disk`; Google Cloud's bundled Local SSDs as `<count> x Local SSD`; `''` when there is none listed.",
    ),
    col(
      "category",
      "LowCardinality(String)",
      "The provider's family category: AWS `General purpose`, `Compute optimized`, `Memory optimized`, `Storage optimized`, `GPU instance`, `Accelerated Computing`, ...; Alibaba `General-purpose`, `Compute-optimized`, `Memory-optimized`, `GPU`, ...; Azure `General purpose`, `Compute optimized`, `Memory optimized`, `Storage optimized`, `GPU accelerated`, `FPGA accelerated`, `High performance compute`; Google Cloud `General-purpose`, `Compute-optimized`, `Memory-optimized`, `Storage-optimized`, `Network-optimized`, `Accelerator-optimized`; RunPod `GPU`, or a CPU pod's flavor (`Compute-Optimized`, `General Purpose`, `Memory-Optimized`).",
    ),
    col(
      "current_generation",
      "Bool",
      "False for previous-generation types AWS still sells but no longer recommends, and for Google Cloud machine types Google marks deprecated or obsolete; always true for RunPod, Alibaba and Azure.",
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
      "When the provider dropped it from the price list; NULL while it is listed. Filter `retired_at IS NULL` for types you can still buy.",
    ),
    col(
      "attributes",
      "Map(String, String)",
      "Every attribute the provider lists for it, current values.",
    ),
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
    col(
      "attribute",
      "String",
      "The provider's attribute key, e.g. AWS `memory`, `networkPerformance`; Alibaba `MemorySize`; Azure `ram`; Google Cloud `zones`, which differs by region.",
    ),
    col("value", "Nullable(String)", "The new value; NULL when the attribute was removed."),
    col("region", "String", "Region code it applies to, `''` for every region."),
  ],
  orderBy: ["platform", "instance_type", "at"],
};

export const REGIONS: Table = {
  name: "regions",
  comment:
    "Region codes and the names the provider gives them, per source. Use it to turn a city or country into a region code. Codes repeat across clouds (Alibaba also has `us-east-1`), so filter on source. Google Cloud's names are the city, state or country from its regions page (`Council Bluffs, Iowa` for us-central1).",
  columns: [
    SOURCE,
    col("region", "String", "Region code as in prices.region, e.g. `eu-central-1`."),
    col(
      "location",
      "String",
      "The location's name, e.g. AWS `EU (Frankfurt)`, Alibaba `China (Hangzhou)`, Azure `US East`, Google Cloud `Ashburn, Virginia`; RunPod `global`.",
    ),
    col(
      "location_type",
      "LowCardinality(String)",
      "`AWS Region`, `AWS Local Zone`, `AWS Wavelength Zone` or `AWS Outposts`; `Alibaba Cloud Region`; `Azure Region` (and `Global`, for Azure Spot prices that apply in every region); `Google Cloud Region`; RunPod `Global`.",
    ),
  ],
  orderBy: ["region"],
};

export const SYNC_STATE: Table = {
  name: "sync_state",
  comment:
    "When each bundle was loaded and which price lists it covers; `max(price_list_to)` is how fresh the data is.",
  columns: [
    SOURCE,
    col("version", "String", "The bundle version loaded."),
    col("schema_version", "UInt32", "Warehouse schema version it was loaded with."),
    col("price_lists", "UInt32", "How many price list versions the bundle was built from."),
    col("price_list_from", "Nullable(DateTime)", "Oldest price list in the bundle (UTC)."),
    col("price_list_to", "Nullable(DateTime)", "Newest price list in the bundle (UTC)."),
    col("synced_at", "DateTime", "When it was loaded (UTC)."),
    col("price_rows", "UInt64", "Rows it wrote to prices."),
  ],
  orderBy: ["source"],
};

/** Every table a price list bundle loads, in load order; `sync_state` last, since it says a load finished. */
export const TABLES: readonly Table[] = [
  PRICES,
  INSTANCE_TYPES,
  ATTRIBUTE_CHANGES,
  REGIONS,
  SYNC_STATE,
];

/**
 * AWS's public service health history, from the AWS Health Dashboard. Not
 * part of a bundle load: the same sync merges the dashboard's feeds into it
 * (`web/src/aws-bulk-pricing/service-events.ts`), and it was seeded from
 * archived copies of those feeds back to 2008. One partition per provider,
 * rewritten whole when an event changes; it is a few thousand rows.
 */
export const SERVICE_EVENTS: Table = {
  name: "service_events",
  comment:
    "Every incident AWS posted on its public Health Dashboard (status page), 2008 to now: one row per event, with when it was posted, when AWS says the impact began and ended, and every update AWS wrote. Only events AWS chose to post publicly; account-specific issues never appear, so no event does not prove no impact. Use it for questions about outages, incidents and how reliable a service or region has been.",
  columns: [
    col("provider", "LowCardinality(String)", "Cloud provider: `aws`."),
    col(
      "event_key",
      "String",
      "Unique id of the event: AWS's dashboard service key and the epoch second it was posted, e.g. `ec2-eu-west-1|1680798000`.",
    ),
    col(
      "service",
      "LowCardinality(String)",
      "AWS Health's service code, e.g. `ec2`, `s3`, `lambda`, `rds`, `elasticache`; `multipleservices` for an event AWS posted against several services at once (see impacted_services).",
    ),
    col(
      "service_name",
      "String",
      "The service's name, e.g. `Amazon Elastic Compute Cloud`; `''` when AWS's feeds never named it.",
    ),
    col(
      "region",
      "LowCardinality(String)",
      "Region code, e.g. `eu-west-1` (Dublin, Ireland); `''` for a global service such as IAM, Route 53 or CloudFront.",
    ),
    col("arn", "String", "AWS Health's event ARN; `''` for events before 2023."),
    col(
      "severity",
      "LowCardinality(String)",
      "The worst status the event reached, as the dashboard labels it: `impacted` (AWS's informational level), `degraded` or `disrupted`.",
    ),
    col("summary", "String", "AWS's title for the event, e.g. `Increased API Error Rates`."),
    col(
      "posted_at",
      "DateTime",
      "When AWS posted the event (UTC); the impact usually began earlier.",
    ),
    col("last_update_at", "DateTime", "When AWS last updated it (UTC)."),
    col(
      "resolved_at",
      "Nullable(DateTime)",
      "When AWS posted that it was resolved (UTC); NULL while it is ongoing.",
    ),
    col(
      "impact_started_at",
      "Nullable(DateTime)",
      "When AWS says the impact began (UTC), read from its resolution message (`Between 6:14 AM and 9:33 AM PDT, ...`); NULL when the message gives no window.",
    ),
    col(
      "impact_ended_at",
      "Nullable(DateTime)",
      "When AWS says the impact ended (UTC), from the same message; NULL when it gives no window.",
    ),
    col("updates", "UInt32", "How many updates AWS posted."),
    col(
      "description",
      "String",
      "AWS's last update, as plain text: for a resolved event, its own summary of what happened and when.",
    ),
    col(
      "event_log",
      "String",
      "Every update, oldest first, each as `YYYY-MM-DD HH:MM UTC  message`, separated by blank lines.",
    ),
    col(
      "impacted_services",
      "Map(String, String)",
      "Other services AWS listed as affected (since 2023), by service key (`eks-us-east-1`) to name. `mapContains(impacted_services, 'ec2-eu-west-1')` finds events that hit EC2 in eu-west-1 without being posted against it.",
    ),
  ],
  orderBy: ["provider", "service", "region", "posted_at"],
  partitionBy: "provider",
};

/** Every table the chat and the SQL API can query. */
export const QUERYABLE_TABLES: readonly Table[] = [...TABLES, SERVICE_EVENTS];

const quote = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** `CREATE TABLE IF NOT EXISTS`, with every comment, in `database` (the current one by default). */
export function createTableSql(table: Table, database?: string): string {
  const name = database ? `${database}.${table.name}` : table.name;
  const columns = [
    ...table.columns.map((c) => `  ${c.name} ${c.type} COMMENT ${quote(c.comment)}`),
    ...(table.indexes ?? []).map((index) => `  INDEX ${index}`),
  ].join(",\n");
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
/**
 * How to query the tables correctly, beyond what each column says. Shown to
 * the chat's model and returned by `GET /api/v1/instance-pricing/schema`.
 */
export const SCHEMA_NOTES: readonly string[] = [
  "All prices are USD (Alibaba's from its international site). Timestamps are UTC DateTime.",
  "Usual defaults when a question does not say otherwise: for ec2, operating_system = 'Linux', tenancy = 'Shared', pre_installed_sw = 'NA', capacity_status = 'Used', license_model = 'No License required' and pricing = 'on_demand'; for rds, deployment_option = 'Single-AZ', one database_engine (PostgreSQL if unsaid) and usage_type NOT LIKE '%Unused%' (those rows price unused capacity reservations); for elasticache and memorydb, cache_engine = 'Redis' (or 'Valkey') and usage_type = 'NodeUsage'; region us-east-1.",
  "EC2 Windows: the price AWS quotes for Windows (license included) is license_model = 'No License required'. The `License Included - Infrastructure` and `Bring your own license` rows price only the compute, at the Linux rate, so never quote them as the Windows price unless the question is about bringing a license. Windows with SQL Server is pre_installed_sw = 'SQL Web', 'SQL Std' or 'SQL Ent'.",
  '"Cheapest" means the lowest effective_hourly_usd among current rows. Hourly to monthly: x 730.',
  "Spot rows (pricing = 'spot') only exist for ec2 with operating_system 'Linux' or 'Windows', and leave tenancy, license_model, pre_installed_sw and capacity_status as '': drop those ec2 defaults for spot (pricing = 'spot' OR (tenancy = 'Shared' AND ...)). A spot price is the lowest across the region's availability zones, as AWS's Spot pricing page shows it. Spot history starts 2026-08-03 with a price every hour (for the 17 main regions; the others and Local Zones start 2026-11-01), and has one every 6 hours since 2026-11-01, so aggregate it (by day, say) rather than listing rows.",
  "Reserved rows: an All Upfront term has hourly_usd = 0 and the whole cost in upfront_usd; compare reserved and on-demand on effective_hourly_usd.",
  "RunPod (platform = 'runpod'): GPU types are priced per GPU per hour (size and family are '', gpus = 1, gpu_memory_gib is the GPU's memory) and CPU pods per pod per hour; tell them apart with attributes['productFamily'] ('GPU' or 'CPU') on instance_types. Every price is region = 'global'; pick a cloud with variant['cloudType'] = 'Secure Cloud' (the default) or 'Community Cloud' (cheaper, community hosts). Savings plans are pricing = 'reserved', offering_class = 'Savings Plan', lease '3mo' or '6mo', with hourly_usd the effective rate. Which data centers stock a GPU is attributes['dataCenters'] (comma separated); stock levels and spot prices are not included. History starts in November 2026.",
  "Alibaba Cloud ECS (platform = 'alibaba'): default to operating_system = 'Linux' and variant['networkType'] = 'VPC' (Classic is retired). on_demand is pay-as-you-go. Subscriptions are offering_class = 'Subscription' (lease '1mo' or '1yr' to '5yr', paid in full: hourly_usd = 0, upfront_usd the price); reserved instances are offering_class = 'Reserved Instance' (lease '1yr' or '3yr', with a purchase_option). Prices go back to May 2018; specs (attributes) start in May 2023, so older retired types can have NULL vcpu and memory_gib.",
  "Azure virtual machines (platform = 'azure'): default to operating_system = 'Linux', variant['priority'] = 'Regular' and region 'eastus'. Spot and Low Priority prices are on_demand rows with variant['priority'] = 'Spot' or 'Low Priority', so always fix priority. Reservations are offering_class = 'Reserved Instance', All Upfront (hourly_usd = 0, upfront_usd the whole term), lease '1yr', '3yr' and for some sizes '5yr' or '10yr'; Azure lists them under operating_system = 'Linux' only, since a Windows license is billed on top. Savings plans are offering_class = 'Savings Plan', No Upfront, '1yr' or '3yr', hourly_usd the plan's rate. Specs come from Azure's pricing calculator (attributes 'cores', 'ram', 'diskSize', 'gpu', 'series'); about a third of sizes, mostly the newest and retired series, have none, so vcpu and memory_gib are NULL there: match on instance_type or family (the series) for those. Dedicated hosts are not included. valid_from is when Azure says a price took effect (back to 2017), but changes are tracked from November 2026.",
  "Google Cloud Compute Engine (platform = 'gcp'): default to variant['provisioningModel'] = 'Standard' and region 'us-central1'; Spot prices are on_demand rows with provisioningModel = 'Spot'. Google bills most machine types per vCPU and per GiB of memory at their series' rates, plus their GPUs, so each price is worked out from those rates and the machine type's shape. Prices leave out bundled Local SSD, OS licenses and sustained use discounts, and TPU, X4, X5 and A4X machine types are not included. Committed use discounts are offering_class = 'Committed Use', No Upfront, '1yr' or '3yr', hourly_usd the commitment's rate. Which zones of a region offer a machine type is attributes['zones'] (comma separated), which differs by region: read it from attribute_changes for the region (attribute = 'zones'), as instance_types holds one region's value. History starts in November 2026.",
  "Comparing clouds: region codes are each provider's own, so join regions on source as well as region and compare by location (Alibaba's us-east-1 is US (Virginia), the same area as AWS's us-east-1, Azure's eastus and Google Cloud's us-east4). Compare on effective_hourly_usd for similar vcpu and memory_gib, like for like (on demand against pay-as-you-go and Standard; spot against Azure Spot and Google Spot), and say which cloud each row is from.",
  "Use instance_types for specs and to list types; join prices on (platform, instance_type) when you need specs it does not carry.",
  "prices is large (millions of rows for ec2): always filter on platform and current (or a time range), and aggregate or LIMIT.",
  "service_events is AWS's public status page history, not a measured uptime: AWS publishes no availability percentage. To estimate downtime, sum dateDiff('minute', impact_started_at, impact_ended_at) (fall back to posted_at and resolved_at when those are NULL) over events with severity 'degraded' or 'disrupted', and say that it covers only events AWS posted publicly. An event filed under `multipleservices` or another service can still have hit the one asked about: also match mapContains(impacted_services, '<service>-<region>').",
];

export function describeSchema(): string {
  const tables = QUERYABLE_TABLES.map((t) => {
    const columns = t.columns.map((c) => `  ${c.name} ${c.type}  -- ${c.comment}`).join("\n");
    return `TABLE ${t.name}  -- ${t.comment}\n${columns}`;
  }).join("\n\n");
  return `${tables}\n\nNotes:\n${SCHEMA_NOTES.map((n) => `- ${n}`).join("\n")}`;
}
