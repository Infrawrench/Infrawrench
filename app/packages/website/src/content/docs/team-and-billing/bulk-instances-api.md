---
title: Bulk instances API
description: AWS instance specs and prices for twelve services, plus EC2 spot prices, with their full history, from the @infrawrench/bulk-instances SDKs or the HTTP API.
sidebar_order: 8
---

Infrawrench keeps every AWS instance type's attributes and prices, with the full history of both, for twelve AWS services: EC2, RDS, ElastiCache, OpenSearch, Redshift, DocumentDB, Neptune, MemoryDB, DAX, SageMaker, EMR and GameLift. It is built from every published version of the AWS Price List bulk API and refreshed as AWS publishes. EC2 spot prices, which are not in the price lists, are kept alongside (see [Spot prices](#spot-prices)).

You can read it four ways:

- **[instances.infrawrench.com](https://instances.infrawrench.com/aws/ec2/m5.large)**, a page per instance type with charts, and a [chat](../features/instance-price-chat.md) that answers questions about the data with tables and charts. No key needed. Append `.md` to any page (or send `Accept: text/markdown`) for the same data as Markdown.
- **The `@infrawrench/bulk-instances` SDKs**, which download a whole service's data and decode it for you. This page documents the TypeScript one.
- **The HTTP API**, for one instance at a time, or the raw bundles.
- **[SQL](./aws-pricing-api.md)**, for questions across instances, regions and time, answered without downloading anything.

Both the SDKs and the HTTP API need an Infrawrench bearer credential: an [API key](./api-keys.md) (`iwk_…`), an agent credential or a WorkOS access token. Any of them can read everything; no scope is required, because the data is AWS's public price list.

## Install

| Language   | Install                                                |
| ---------- | ------------------------------------------------------ |
| TypeScript | `npm install @infrawrench/bulk-instances`              |
| Python     | `pip install infrawrench-bulk-instances`               |
| Ruby       | `gem install infrawrench-bulk_instances`               |
| Java       | `com.infrawrench:bulk-instances`                       |
| C#         | `dotnet add package Infrawrench.BulkInstances`         |
| Rust       | `cargo add infrawrench-bulk-instances`                 |
| PHP        | `composer require infrawrench/bulk-instances`          |
| Go         | `go get github.com/infrawrench/bulk-instances-sdks/go` |

The SDKs are MIT-licensed and kept identical by a shared conformance suite: they decode the same data the same way, and share one on-disk cache format, so a bundle downloaded by one serves the others. The examples below are TypeScript (Node 20 or later).

## Quick start

```ts
import { downloadAwsEc2PricingData } from "@infrawrench/bulk-instances";

const data = await downloadAwsEc2PricingData({ token: process.env.INFRAWRENCH_API_KEY });

data.keys(); // ["m5.large", "t2.micro", ...]

const m5 = data.get("m5.large")!;
m5.attributes.vcpu; // "2"
m5.attributesIn("US East (N. Virginia)"); // with that region's overrides

m5.pricing.onDemand.find(
  (p) =>
    p.regionCode === "us-east-1" &&
    p.operatingSystem === "Linux" &&
    p.tenancy === "Shared" &&
    p.preInstalledSw === "NA" &&
    p.capacitystatus === "Used",
)?.hourly; // 0.096

m5.attributesHistory; // every attribute change, oldest first
m5.pricingHistory.reserved; // every reserved price change, oldest first
```

`token` defaults to the `INFRAWRENCH_API_KEY` environment variable.

## Loading data

### `downloadAwsPricingData(platform, options?)`

Loads one service's data and returns an `AWSPricingData`. `platform` is one of:

| Platform      | AWS service          |
| ------------- | -------------------- |
| `ec2`         | EC2                  |
| `rds`         | RDS                  |
| `elasticache` | ElastiCache          |
| `opensearch`  | OpenSearch Service   |
| `redshift`    | Redshift             |
| `docdb`       | DocumentDB           |
| `neptune`     | Neptune              |
| `memorydb`    | MemoryDB             |
| `dax`         | DynamoDB Accelerator |
| `sagemaker`   | SageMaker            |
| `emr`         | EMR                  |
| `gamelift`    | GameLift             |
| `spot`        | EC2 spot prices      |

`AWS_PLATFORMS` exports that list. Any other lowercase name is requested as is, so a service added later works without a new SDK.

`downloadAwsEc2PricingData(options?)` is the same as `downloadAwsPricingData("ec2", options)`.

| Option             | Default                                     | What it does                                       |
| ------------------ | ------------------------------------------- | -------------------------------------------------- |
| `token`            | `INFRAWRENCH_API_KEY`                       | The bearer credential.                             |
| `cachePricingData` | `true`                                      | Keep the decompressed bundle on disk and reuse it. |
| `cachePath`        | `~/.infrawrench/aws_pricing_data`           | Where the cache lives.                             |
| `baseUrl`          | `https://instances-bundles.infrawrench.com` | Where the bundles are served from.                 |

Each load asks the server which bundle is newest and downloads it (xz-compressed, about 20 MB for EC2) only if it is not already cached, then deletes that service's older bundles. If the server cannot be reached, the newest cached bundle is used instead; a rejected token is never papered over that way. Each service is cached under its own name, so loading one never evicts another. With `cachePricingData: false` the SDK always downloads and never touches the disk.

Loading parses the whole bundle, but instances are decoded lazily: `get` only wraps the raw rows, and each of `attributes`, `attributesHistory`, `pricing` and `pricingHistory` decodes on first access and keeps the result. Returned objects are shared between calls, so treat them as read-only.

### `fetchAwsInstance(platform, instanceType, options?)`

Fetches one instance from the HTTP API instead of downloading the whole service. It returns the same `AWSInstance` that `get` does, or `undefined` if the service has no instance with that name. Nothing is cached.

```ts
import { fetchAwsInstance } from "@infrawrench/bulk-instances";

const m5 = await fetchAwsInstance("ec2", "m5.large");
m5?.pricing.onDemand.length;
```

It takes `token` and `baseUrl` (default `https://app.infrawrench.com`). The API picks up each new bundle within about half an hour of it being published, so it can briefly trail `downloadAwsPricingData`.

### Errors

Failures throw `AWSPricingDataError`, with `status` set to the HTTP status when there was a response. A `401` means the credential was not accepted (unknown, revoked or expired). A `503` is retried a couple of times, honouring `Retry-After`, before it is thrown; it means the service could not check the credential, not that the credential is bad.

## `AWSPricingData`

One service's data, keyed by instance type.

| Member        | What it is                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------- |
| `keys()`      | Every instance type in the data, including ones AWS no longer lists.                            |
| `has(type)`   | Whether the data has ever listed `type`.                                                        |
| `get(type)`   | The `AWSInstance`, or `undefined`.                                                              |
| `offer`       | The AWS offer code, such as `AmazonEC2` or `AmazonRDS`.                                         |
| `variantKeys` | The names of the fields that pick a price (see below).                                          |
| `snapshots`   | The publication date of every AWS price list the data was built from, oldest first, as `Date`s. |
| `regions`     | Each location's attributes (`regionCode`, `locationType`), keyed by location name.              |

## `AWSInstance`

One instance type. Each getter decodes on first access.

| Member                 | What it is                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| `name`                 | The instance type, such as `m5.large`.                                                                      |
| `createdAt`            | When AWS first listed it.                                                                                   |
| `deletedAt`            | When AWS stopped listing it, or `null`.                                                                     |
| `attributes`           | The latest attributes shared by every region, as AWS names them (`vcpu`, `memory`, `physicalProcessor`, …). |
| `attributesIn(region)` | The latest attributes in one location, with that location's own values on top.                              |
| `attributesHistory`    | Every attribute change, oldest first, starting with the values it was first listed with.                    |
| `pricing`              | The current price of everything still offered: `{ onDemand, reserved }`.                                    |
| `pricingHistory`       | Every on-demand and reserved price change, oldest first: `{ onDemand, reserved }`.                          |

### Prices

Every price carries its location and its variant:

- `region` is the AWS location name (`US East (N. Virginia)`) and `regionCode` its code (`us-east-1`), where the price list gives one.
- `variant` holds the fields that pick the price, keyed by `variantKeys`. They differ by service: EC2 uses `operatingSystem`, `tenancy`, `licenseModel`, `preInstalledSw` and `capacitystatus`; RDS uses `databaseEngine`, `databaseEdition`, `licenseModel`, `deploymentOption` and more. EC2's five fields are also top-level properties on every price, and are `""` on services that do not have them.
- Reserved prices also carry `leaseContractLength` (`1yr`, `3yr`), `offeringClass` (`standard`, `convertible`) and `purchaseOption` (`No Upfront`, `Partial Upfront`, `All Upfront`).

| Type                  | Fields                                                                  |
| --------------------- | ----------------------------------------------------------------------- |
| `OnDemandPrice`       | `hourly` (USD), `since` (when it took effect)                           |
| `ReservedPrice`       | `hourly`, `upfront` (USD), `since`                                      |
| `OnDemandPriceChange` | `at`, `hourly` (`null`: no longer offered from `at`)                    |
| `ReservedPriceChange` | `at`, `hourly`, `upfront` (both `null` when withdrawn)                  |
| `AttributeChange`     | `at`, `key`, `value` (`null`: removed), `region` (`null`: every region) |

```ts
import { downloadAwsPricingData } from "@infrawrench/bulk-instances";

const rds = await downloadAwsPricingData("rds");
rds.variantKeys; // ["databaseEngine", "databaseEdition", "licenseModel", "deploymentOption", ...]
rds
  .get("db.m5.large")!
  .pricing.onDemand.find(
    (p) =>
      p.regionCode === "us-east-1" &&
      p.variant.databaseEngine === "MySQL" &&
      p.variant.deploymentOption === "Multi-AZ",
  )?.hourly;
```

### History rules

- An attribute change with a `region` applies only there, and keeps applying even after a newer change to the same attribute for every region. `attributesIn` follows that rule.
- Price timestamps are AWS's effective dates; attribute changes are dated by the price list that first showed them.
- When AWS stops listing an instance, removal rows are written for all its prices, so its `pricing` is empty and `deletedAt` is set. If AWS lists it again, `deletedAt` goes back to `null`.

### Spot prices

`spot` holds EC2's spot prices, by instance type, for Linux and Windows. AWS publishes no price list for them, so they come from the feed behind AWS's [Spot pricing page](https://aws.amazon.com/ec2/spot/pricing/), with the history before November 2026 filled in from EC2's spot price history:

- Each price is the lowest across the region's availability zones, as AWS's page shows it. Spot prices are in `pricing.onDemand` and `pricingHistory.onDemand`; there are no reserved prices.
- `variantKeys` is `["operatingSystem"]`, so `operatingSystem` is `Linux` or `Windows` and the other EC2 fields are `""`. A spot price compares with the EC2 on-demand price that has the same operating system, `Shared` tenancy, `No License required`, no pre-installed software and capacity status `Used`.
- Locations are region codes, including Local Zones such as `us-east-1-atl-1`, so `region` and `regionCode` are both the code. `regions` gives each its `locationType`.
- Instances have no attributes; take an instance type's specs from `ec2`.
- The history starts on 3 August 2026, with a price every hour for the main regions (the rest, and Local Zones, start on 1 November 2026), and has one every 6 hours since 1 November 2026. Spot prices change far more often than on-demand prices, so the history is dense.

```ts
import { downloadAwsPricingData } from "@infrawrench/bulk-instances";

const spot = await downloadAwsPricingData("spot");
spot
  .get("m5.large")!
  .pricing.onDemand.find((p) => p.regionCode === "us-east-1" && p.operatingSystem === "Linux")
  ?.hourly; // 0.0405
```

## HTTP API

The SDKs use two endpoints, which you can also call directly with `Authorization: Bearer <credential>`.

### One instance: `app.infrawrench.com/api/v1/aws-bulk-pricing`

| Request                                              | Response                                                                                                                                        |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/aws-bulk-pricing`                       | `{ platforms: [...] }`: each service synced so far, with its bundle version, sync time and instance count.                                      |
| `GET /api/v1/aws-bulk-pricing/<platform>`            | That service's `variant_keys`, price list `snapshots` (Unix seconds) and every instance name.                                                   |
| `GET /api/v1/aws-bulk-pricing/<platform>/<instance>` | Everything about one instance, in the bundle encoding below, cut down to that instance. Sends an `ETag` and answers `If-None-Match` with `304`. |

```bash
curl -H "Authorization: Bearer $INFRAWRENCH_API_KEY" \
  https://app.infrawrench.com/api/v1/aws-bulk-pricing/ec2/m5.large
```

`404` means no such service or instance; `503` means the data store could not be reached, so retry. The instance responses are in the compact bundle encoding, not plain JSON objects: `fetchAwsInstance` is the easy way to read them. This endpoint is not part of the [OpenAPI spec](./openapi.md); the bulk-instances SDKs are its clients.

### Whole bundles: `instances-bundles.infrawrench.com`

| Request                                                                               | Response                                |
| ------------------------------------------------------------------------------------- | --------------------------------------- |
| `GET /latest` (EC2), `GET /<platform>-latest`                                         | The newest bundle's timestamp, as text. |
| `GET /bundle-<timestamp>.json.xz` (EC2), `GET /<platform>-bundle-<timestamp>.json.xz` | The bundle, xz-compressed.              |

Bundles are served from Cloudflare's edge cache, with `ETag` revalidation and range requests. A new EC2 bundle can appear every few minutes as AWS publishes; the other services are checked every 15 minutes, and spot prices every 6 hours.

### The bundle encoding

Every string lives once in `compression_table` (most used first), and everything else refers to strings by index. Timestamps are Unix seconds.

```jsonc
{
  "offer": "AmazonRDS", // left out of EC2 bundles
  "compression_table": ["US West (Oregon)", "US East (N. Virginia)", ...],
  "snapshots": [1600976855, ...], // every price list appended, oldest first
  "regions": [[<location>, [[<key>, <value>], ...]]], // regionCode, locationType
  "variant_keys": ["databaseEngine", ...], // left out of EC2 bundles
  "variants": [[<value>, ...]], // one value per variant key
  "reserved_terms": [[<lease>, <offeringClass>, <purchaseOption>]],
  "instances": {
    "m5.large": [
      [[<key>, <value>]], // 0: attributes when first listed
      [[<ts>, <key>, <value or null>, <region, omitted if global>]], // 1: attribute changes
      0.096, // 2: the most common on-demand price
      [[<ts>, <region>, <variant>, <price: omitted = field 2, null = withdrawn>]], // 3: on-demand
      [[<ts>, <region>, <variant>, <reserved term>, <hourly or null>, <upfront, omitted if 0>]], // 4: reserved
      1600976855, // 5: first listed
      null, // 6: no longer listed since
    ],
  },
}
```

The per-instance API response is the same shape with `name` and `instance` (that instance's row) in place of `instances`, and tables holding only what that instance uses.
