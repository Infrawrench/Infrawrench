---
title: AWS pricing SQL API
description: Query every AWS instance type's specs and every on-demand, reserved and spot price, with history, in read-only SQL over the HTTP API.
sidebar_order: 9
---

The data behind [instances.infrawrench.com](https://instances.infrawrench.com) and its [chat](../features/instance-price-chat.md) is a ClickHouse database you can query directly in SQL. It holds every AWS instance type's specs, and every price AWS has listed for it (on demand, reserved and EC2 spot), in every region, with history, for twelve AWS services: EC2, RDS, ElastiCache, OpenSearch, Redshift, DocumentDB, Neptune, MemoryDB, DAX, SageMaker, EMR and GameLift. It is built from every published version of the AWS Price List and reloaded as AWS publishes.

Two endpoints, both in the [OpenAPI spec](./openapi.md) (tag **AWS pricing**) and so in every [client SDK](./client-sdks.md):

- `POST /api/v1/aws-pricing/query` runs one read-only statement.
- `GET /api/v1/aws-pricing/schema` returns the tables below as JSON, with how fresh each platform's data is.

Any Infrawrench bearer credential works: an [API key](./api-keys.md) (`iwk_…`), an agent credential or a WorkOS access token. No scope is needed, because the data is AWS's public price list. If you would rather download whole services and work offline, the [bulk instances API](./bulk-instances-api.md) serves the same price lists as files.

## Run a query

```bash
curl https://app.infrawrench.com/api/v1/aws-pricing/query \
  -H "Authorization: Bearer $INFRAWRENCH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT instance_type, vcpu, memory_gib, effective_hourly_usd FROM prices WHERE platform = '\''ec2'\'' AND current AND pricing = '\''on_demand'\'' AND region = '\''us-east-1'\'' AND operating_system = '\''Linux'\'' AND tenancy = '\''Shared'\'' AND pre_installed_sw = '\''NA'\'' AND capacity_status = '\''Used'\'' AND architecture = '\''arm64'\'' ORDER BY effective_hourly_usd LIMIT 3"}'
```

```json
{
  "columns": [
    { "name": "instance_type", "type": "String" },
    { "name": "vcpu", "type": "Nullable(Float64)" },
    { "name": "memory_gib", "type": "Nullable(Float64)" },
    { "name": "effective_hourly_usd", "type": "Float64" }
  ],
  "rows": [
    ["t4g.nano", 2, 0.5, 0.0042],
    ["t4g.micro", 2, 1, 0.0084],
    ["t4g.small", 2, 2, 0.0168]
  ],
  "truncated": false,
  "elapsedMs": 412
}
```

The request body is `{ "sql": "...", "maxRows": 1000 }`:

- **`sql`**: one statement, `SELECT` or `WITH` (also `DESCRIBE`, `SHOW` and `EXPLAIN`). No `FORMAT` or `SETTINGS` clause and no second statement; a trailing semicolon is fine. It is ClickHouse SQL, so its functions (`argMin`, `quantile`, `toStartOfMonth`, `arrayJoin`...) and joins work.
- **`maxRows`**: the most rows to return, 1 to 10,000; 1,000 if left out. When more rows match, `truncated` is `true`: aggregate or add a `LIMIT` rather than raising it.

Values come back in `columns` order. Numbers, including ClickHouse's 64-bit integers and decimals, are JSON numbers (values above 2^53 lose precision); `DateTime` values are `YYYY-MM-DD hh:mm:ss` in UTC; arrays and maps come back as JSON text.

| Status | Means                                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `200`  | The result.                                                                                                                          |
| `400`  | The query was refused: not read-only, more than one statement, or ClickHouse's own error (unknown column, syntax), with its message. |
| `401`  | The credential is missing, unknown or revoked.                                                                                       |
| `502`  | The database could not answer. Try again shortly; it happens briefly while new data is loading.                                      |
| `504`  | The query ran longer than 30 seconds.                                                                                                |

## Writing fast, correct queries

- **Filter `prices` on `platform` and `current`** (or a time range on `valid_from` / `valid_to`). It has millions of rows for EC2 alone, sorted by platform, instance type, region and pricing, so filters on those come back fastest.
- **Fix the variant columns.** One instance type in one region has many prices: per operating system, tenancy, license and bundled software on EC2, per engine and deployment option on RDS, and so on. Leave them open and you will average Windows into Linux. The notes below give the usual defaults.
- **Compare on `effective_hourly_usd`.** It folds a reserved term's upfront payment into the hourly rate, so on-demand, reserved and spot prices compare directly. A month is 730 hours.
- **Use `instance_types` for specs.** `prices` repeats the common specs (architecture, vCPUs, memory, GPUs) on every row, so most questions need no join; join `instance_types` on `(platform, instance_type)` for anything else.

A few more examples:

```sql
-- The cheapest current-generation ARM type per family, Linux on demand in eu-west-1
SELECT family, argMin(instance_type, effective_hourly_usd) AS cheapest, min(effective_hourly_usd) AS per_hour
FROM prices
WHERE platform = 'ec2' AND current AND pricing = 'on_demand' AND region = 'eu-west-1'
  AND operating_system = 'Linux' AND tenancy = 'Shared' AND pre_installed_sw = 'NA'
  AND capacity_status = 'Used' AND architecture = 'arm64'
GROUP BY family ORDER BY per_hour

-- How db.r6g.large's PostgreSQL Single-AZ price changed, per region
SELECT region, valid_from, valid_to, hourly_usd
FROM prices
WHERE platform = 'rds' AND instance_type = 'db.r6g.large' AND pricing = 'on_demand'
  AND database_engine = 'PostgreSQL' AND deployment_option = 'Single-AZ'
  AND usage_type NOT LIKE '%Unused%'
ORDER BY region, valid_from

-- Spot discount against on demand for m7g.large in us-east-1
SELECT pricing, effective_hourly_usd
FROM prices
WHERE platform = 'ec2' AND instance_type = 'm7g.large' AND region = 'us-east-1' AND current
  AND operating_system = 'Linux' AND pricing IN ('spot', 'on_demand')
  AND (pricing = 'spot' OR (tenancy = 'Shared' AND pre_installed_sw = 'NA' AND capacity_status = 'Used'))

-- Instance types AWS added in the last 90 days
SELECT platform, instance_type, first_listed FROM instance_types
WHERE first_listed > now() - INTERVAL 90 DAY ORDER BY first_listed DESC
```

## Schema

Five tables, all in the default database. `GET /api/v1/aws-pricing/schema` returns the same descriptions as JSON, and each column also carries its description as a ClickHouse `COMMENT`, so `DESCRIBE TABLE prices` shows it too.

### `prices`

Every price AWS has listed for an instance type, one row per period a price held. `current = true` (equivalently `valid_to IS NULL`) is the price on offer now; filter on it unless the question is about history. A product's price is identified by (platform, instance_type, region, pricing, lease, offering_class, purchase_option) plus its variant columns, so always fix the variant columns that matter for the platform (see the defaults in the notes) or you will mix e.g. Windows and Linux prices.

Sorted by `platform, instance_type, region, pricing, valid_from`.

| Column                 | Type                     | What it holds                                                                                                                                                                                                   |
| ---------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`               | `LowCardinality(String)` | Which price list bundle the row was loaded from: the platform name, or `spot` for EC2 spot prices. Rarely needed in queries.                                                                                    |
| `shard`                | `LowCardinality(String)` | Internal storage partition (the source, split into buckets for ec2 and spot). Never needed in queries.                                                                                                          |
| `platform`             | `LowCardinality(String)` | AWS service: `ec2`, `rds`, `elasticache`, `opensearch`, `redshift`, `docdb`, `neptune`, `memorydb`, `dax`, `sagemaker`, `emr` or `gamelift`. Spot prices are `ec2`.                                             |
| `instance_type`        | `String`                 | The instance type as AWS names it on that platform, e.g. `m7g.large`, `db.r6g.xlarge`, `cache.t4g.micro`, `r6g.large.search`, `ml.g5.xlarge`.                                                                   |
| `family`               | `LowCardinality(String)` | Instance family without any platform prefix, e.g. `m7g` for `m7g.large` and `db.m7g.large`; `''` when the name does not parse.                                                                                  |
| `size`                 | `LowCardinality(String)` | Size part of the name: `nano`, `micro`, `small`, `medium`, `large`, `xlarge`, `2xlarge`, ..., `metal`, `metal-48xl`.                                                                                            |
| `architecture`         | `LowCardinality(String)` | CPU architecture: `arm64` (AWS Graviton, Apple silicon) or `x86_64` (Intel, AMD); `''` when AWS gives nothing to tell. Use this for ARM vs x86 questions.                                                       |
| `vcpu`                 | `Nullable(Float64)`      | vCPUs.                                                                                                                                                                                                          |
| `memory_gib`           | `Nullable(Float64)`      | Memory in GiB.                                                                                                                                                                                                  |
| `gpus`                 | `Nullable(UInt32)`       | Number of GPUs (or accelerators); NULL when it has none listed.                                                                                                                                                 |
| `region`               | `LowCardinality(String)` | Region code, e.g. `us-east-1`, `eu-central-1`, or a Local Zone / Wavelength code such as `us-east-1-atl-1`. For the few locations AWS gives no code it is the location name. Join `regions` for the human name. |
| `pricing`              | `LowCardinality(String)` | `on_demand`, `reserved` (reserved instances; see lease, offering_class, purchase_option) or `spot` (EC2 spot, Linux and Windows only, from AWS's spot price feed).                                              |
| `lease`                | `LowCardinality(String)` | Reserved term length: `1yr` or `3yr`; `''` otherwise.                                                                                                                                                           |
| `offering_class`       | `LowCardinality(String)` | Reserved offering class: `standard` or `convertible`; `''` otherwise.                                                                                                                                           |
| `purchase_option`      | `LowCardinality(String)` | Reserved payment option: `No Upfront`, `Partial Upfront` or `All Upfront`; `''` otherwise.                                                                                                                      |
| `operating_system`     | `LowCardinality(String)` | EC2, GameLift and spot: `Linux`, `Windows`, `RHEL`, `SUSE`, `Ubuntu Pro`, `Red Hat Enterprise Linux with HA`, ... ; `''` elsewhere.                                                                             |
| `tenancy`              | `LowCardinality(String)` | EC2: `Shared` (normal), `Dedicated` (dedicated instance) or `Host` (dedicated host).                                                                                                                            |
| `license_model`        | `LowCardinality(String)` | EC2/RDS: `No License required`, `License included`, `Bring your own license`.                                                                                                                                   |
| `pre_installed_sw`     | `LowCardinality(String)` | EC2: bundled software, `NA` for none, else e.g. `SQL Std`, `SQL Web`, `SQL Ent`.                                                                                                                                |
| `capacity_status`      | `LowCardinality(String)` | EC2: `Used` (a normal running instance), `UnusedCapacityReservation` or `AllocatedCapacityReservation`.                                                                                                         |
| `database_engine`      | `LowCardinality(String)` | RDS: `PostgreSQL`, `MySQL`, `MariaDB`, `Oracle`, `SQL Server`, `Aurora PostgreSQL`, `Aurora MySQL`, `Db2`, ...                                                                                                  |
| `database_edition`     | `LowCardinality(String)` | RDS: edition for commercial engines (`Standard`, `Enterprise`, `Web`, `Express`, ...); `''` for open-source ones.                                                                                               |
| `deployment_option`    | `LowCardinality(String)` | RDS: `Single-AZ`, `Multi-AZ`, `Multi-AZ (readable standbys)`, ...                                                                                                                                               |
| `deployment_model`     | `LowCardinality(String)` | RDS: e.g. `Outposts`; usually `''`.                                                                                                                                                                             |
| `engine_media_type`    | `LowCardinality(String)` | RDS: e.g. `AWS-provided`; usually `''`.                                                                                                                                                                         |
| `cache_engine`         | `LowCardinality(String)` | ElastiCache and MemoryDB: `Redis`, `Valkey`, `Memcached`.                                                                                                                                                       |
| `software_type`        | `LowCardinality(String)` | EMR: the EMR software line, e.g. `EMR`.                                                                                                                                                                         |
| `component`            | `LowCardinality(String)` | SageMaker: what the instance runs, e.g. `Hosting`, `Training`, `Notebook`, `Processing`, `studio-jupyterlab`.                                                                                                   |
| `usage_type`           | `LowCardinality(String)` | AWS usage type with the region prefix removed, e.g. `BoxUsage`, `InstanceUsage`, `Multi-AZUsage`, `NodeUsage`. Distinguishes e.g. Outposts or durability variants.                                              |
| `variant`              | `Map(String, String)`    | Any other price list variant fields, by their AWS key (e.g. Neptune `mncu`, SageMaker `platoinstancetype`). Usually empty.                                                                                      |
| `hourly_usd`           | `Float64`                | Hourly price in USD. For reserved rows it is the recurring hourly fee only; see effective_hourly_usd.                                                                                                           |
| `upfront_usd`          | `Float64`                | One-off upfront payment in USD for a reserved term; 0 otherwise.                                                                                                                                                |
| `effective_hourly_usd` | `Float64`                | What an hour costs all in: hourly_usd plus upfront_usd spread over the term (8,760 hours a year). Compare on this. A month is 730 hours.                                                                        |
| `valid_from`           | `DateTime`               | When AWS started listing this price (UTC).                                                                                                                                                                      |
| `valid_to`             | `Nullable(DateTime)`     | When the price stopped applying (replaced, withdrawn or the instance retired); NULL while it is current.                                                                                                        |
| `current`              | `Bool`                   | True for prices on offer now (valid_to IS NULL).                                                                                                                                                                |

### `instance_types`

One row per instance type per platform with its current specs. EC2 spot prices use the `ec2` rows. Specs AWS does not list are NULL or `''`; `attributes` has every attribute AWS publishes, as strings.

Sorted by `platform, instance_type`.

| Column                | Type                     | What it holds                                                                                                                                                                           |
| --------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`              | `LowCardinality(String)` | Which price list bundle the row was loaded from: the platform name, or `spot` for EC2 spot prices. Rarely needed in queries.                                                            |
| `platform`            | `LowCardinality(String)` | AWS service: `ec2`, `rds`, `elasticache`, `opensearch`, `redshift`, `docdb`, `neptune`, `memorydb`, `dax`, `sagemaker`, `emr` or `gamelift`. Spot prices are `ec2`.                     |
| `instance_type`       | `String`                 | The instance type as AWS names it on that platform, e.g. `m7g.large`, `db.r6g.xlarge`, `cache.t4g.micro`, `r6g.large.search`, `ml.g5.xlarge`.                                           |
| `family`              | `LowCardinality(String)` | Instance family without any platform prefix, e.g. `m7g` for `m7g.large` and `db.m7g.large`; `''` when the name does not parse.                                                          |
| `size`                | `LowCardinality(String)` | Size part of the name: `nano`, `micro`, `small`, `medium`, `large`, `xlarge`, `2xlarge`, ..., `metal`, `metal-48xl`.                                                                    |
| `architecture`        | `LowCardinality(String)` | CPU architecture: `arm64` (AWS Graviton, Apple silicon) or `x86_64` (Intel, AMD); `''` when AWS gives nothing to tell. Use this for ARM vs x86 questions.                               |
| `vcpu`                | `Nullable(Float64)`      | vCPUs.                                                                                                                                                                                  |
| `memory_gib`          | `Nullable(Float64)`      | Memory in GiB.                                                                                                                                                                          |
| `gpus`                | `Nullable(UInt32)`       | Number of GPUs (or accelerators); NULL when it has none listed.                                                                                                                         |
| `gpu_memory_gib`      | `Nullable(Float64)`      | Total GPU memory in GiB.                                                                                                                                                                |
| `gpu_model`           | `String`                 | GPU model when AWS names it, e.g. `NVIDIA A10G`.                                                                                                                                        |
| `processor`           | `String`                 | Physical processor, e.g. `AWS Graviton3 Processor`, `Intel Xeon Platinum 8488C`, `AMD EPYC 9R14`.                                                                                       |
| `clock_speed_ghz`     | `Nullable(Float64)`      | Sustained clock speed in GHz.                                                                                                                                                           |
| `network_performance` | `String`                 | As AWS writes it, e.g. `Up to 12.5 Gigabit`, `25 Gigabit`, `Moderate`.                                                                                                                  |
| `network_gbps`        | `Nullable(Float64)`      | network_performance as a number of Gbit/s (the burst figure for `Up to`); NULL for `Low`/`Moderate`/`High`.                                                                             |
| `storage`             | `String`                 | Instance storage as AWS writes it, e.g. `EBS only`, `1 x 237 NVMe SSD`.                                                                                                                 |
| `category`            | `LowCardinality(String)` | AWS's family category: `General purpose`, `Compute optimized`, `Memory optimized`, `Storage optimized`, `GPU instance`, `Accelerated Computing`, `Machine Learning ASIC Instances`, ... |
| `current_generation`  | `Bool`                   | False for previous-generation types AWS still sells but no longer recommends.                                                                                                           |
| `regions_offered`     | `UInt32`                 | How many regions offer it on demand now; 0 when it is no longer sold anywhere.                                                                                                          |
| `first_listed`        | `DateTime`               | When it first appeared in the price list (UTC).                                                                                                                                         |
| `retired_at`          | `Nullable(DateTime)`     | When AWS dropped it from the price list; NULL while it is listed. Filter `retired_at IS NULL` for types you can still buy.                                                              |
| `attributes`          | `Map(String, String)`    | Every attribute AWS lists for it, current values.                                                                                                                                       |

### `attribute_changes`

History of instance attributes: the values each type was first listed with, then every change. Use it for questions like when a spec changed.

Sorted by `platform, instance_type, at`.

| Column          | Type                     | What it holds                                                                                                                                                       |
| --------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`        | `LowCardinality(String)` | Which price list bundle the row was loaded from: the platform name, or `spot` for EC2 spot prices. Rarely needed in queries.                                        |
| `platform`      | `LowCardinality(String)` | AWS service: `ec2`, `rds`, `elasticache`, `opensearch`, `redshift`, `docdb`, `neptune`, `memorydb`, `dax`, `sagemaker`, `emr` or `gamelift`. Spot prices are `ec2`. |
| `instance_type` | `String`                 | The instance type as AWS names it on that platform, e.g. `m7g.large`, `db.r6g.xlarge`, `cache.t4g.micro`, `r6g.large.search`, `ml.g5.xlarge`.                       |
| `at`            | `DateTime`               | When the value took effect (UTC).                                                                                                                                   |
| `attribute`     | `String`                 | AWS attribute key, e.g. `memory`, `networkPerformance`.                                                                                                             |
| `value`         | `Nullable(String)`       | The new value; NULL when the attribute was removed.                                                                                                                 |
| `region`        | `String`                 | Region code it applies to, `''` for every region.                                                                                                                   |

### `regions`

Region codes and the names AWS gives them, per platform's price list. Use it to turn a city or country into a region code.

Sorted by `region`.

| Column          | Type                     | What it holds                                                                                                                |
| --------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `source`        | `LowCardinality(String)` | Which price list bundle the row was loaded from: the platform name, or `spot` for EC2 spot prices. Rarely needed in queries. |
| `region`        | `String`                 | Region code as in prices.region, e.g. `eu-central-1`.                                                                        |
| `location`      | `String`                 | AWS's location name, e.g. `EU (Frankfurt)`.                                                                                  |
| `location_type` | `LowCardinality(String)` | `AWS Region`, `AWS Local Zone`, `AWS Wavelength Zone` or `AWS Outposts`.                                                     |

### `sync_state`

When each bundle was loaded and which AWS price lists it covers; `max(price_list_to)` is how fresh the data is.

Sorted by `source`.

| Column            | Type                     | What it holds                                                                                                                |
| ----------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `source`          | `LowCardinality(String)` | Which price list bundle the row was loaded from: the platform name, or `spot` for EC2 spot prices. Rarely needed in queries. |
| `version`         | `String`                 | The bundle version loaded.                                                                                                   |
| `schema_version`  | `UInt32`                 | Warehouse schema version it was loaded with.                                                                                 |
| `price_lists`     | `UInt32`                 | How many AWS price list versions the bundle was built from.                                                                  |
| `price_list_from` | `Nullable(DateTime)`     | Oldest price list in the bundle (UTC).                                                                                       |
| `price_list_to`   | `Nullable(DateTime)`     | Newest price list in the bundle (UTC).                                                                                       |
| `synced_at`       | `DateTime`               | When it was loaded (UTC).                                                                                                    |
| `price_rows`      | `UInt64`                 | Rows it wrote to prices.                                                                                                     |

### Notes for writing queries

- All prices are USD. Timestamps are UTC DateTime.
- Usual defaults when a question does not say otherwise: for ec2, operating_system = 'Linux', tenancy = 'Shared', pre_installed_sw = 'NA', capacity_status = 'Used', license_model = 'No License required' and pricing = 'on_demand'; for rds, deployment_option = 'Single-AZ', one database_engine (PostgreSQL if unsaid) and usage_type NOT LIKE '%Unused%' (those rows price unused capacity reservations); for elasticache and memorydb, cache_engine = 'Redis' (or 'Valkey') and usage_type = 'NodeUsage'; region us-east-1.
- "Cheapest" means the lowest effective_hourly_usd among current rows. Hourly to monthly: x 730.
- Spot rows (pricing = 'spot') only exist for ec2 with operating_system 'Linux' or 'Windows'; spot prices move often, so their history is dense.
- Reserved rows: an All Upfront term has hourly_usd = 0 and the whole cost in upfront_usd; compare reserved and on-demand on effective_hourly_usd.
- Use instance_types for specs and to list types; join prices on (platform, instance_type) when you need specs it does not carry.
- prices is large (millions of rows for ec2): always filter on platform and current (or a time range), and aggregate or LIMIT.

## Freshness

The database is reloaded each time AWS publishes a new price list for a service, checked twice an hour. `sync_state` (and the `sources` list in `GET /api/v1/aws-pricing/schema`) says which price lists each service's data comes from and when it was loaded; `max(price_list_to)` is the newest. While a service is being reloaded, a query can briefly fail with a `502`; retry it.
