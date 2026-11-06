---
title: Bulk instances API
description: AWS instance specs and prices for twelve services, plus EC2 spot prices, Azure Virtual Machines, Google Cloud Compute Engine, Alibaba Cloud ECS, Oracle Cloud Compute, IBM Cloud Virtual Servers for VPC, Hetzner cloud servers and Server Auction listings, OVHcloud Public Cloud and eco servers, and RunPod GPU and CPU pods, with their full history, from the @infrawrench/bulk-instances SDKs or the HTTP API.
sidebar_order: 8
---

Use this API to get instance specs and prices, with their full history, into your own code. It covers every AWS instance type in twelve services: EC2, RDS, ElastiCache, OpenSearch, Redshift, DocumentDB, Neptune, MemoryDB, DAX, SageMaker, EMR and GameLift. It's built from every published version of the AWS Price List bulk API and refreshed as AWS publishes. EC2 spot prices are included too (see [Spot prices](#spot-prices)), and so are four other clouds in the same format: Azure Virtual Machines, Google Cloud Compute Engine, Alibaba Cloud ECS and RunPod's GPU and CPU pods (see [Other clouds](#other-clouds)).

You can read the data four ways:

- **[instances.infrawrench.com](https://instances.infrawrench.com/aws/ec2/m5.large)**, a page per instance type with charts, and a [chat](../features/instance-price-chat.md) that answers questions about the data with tables and charts. No key needed. Append `.md` to any page (or send `Accept: text/markdown`) for the same data as Markdown.
- **The `@infrawrench/bulk-instances` SDKs**, which download a whole service's data and decode it for you. This page documents the TypeScript one.
- **The HTTP API**, for one instance at a time, or the raw bundles.
- **[SQL](./instance-pricing-api.md)**, for questions across instances, regions and time, answered without downloading anything.

The SDKs and the HTTP API need an Infrawrench bearer credential: an [API key](./api-keys.md) (`iwk_…`), an agent credential or a WorkOS access token. Any of them can read everything. No scope is needed, since the data is the providers' public price lists.

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

The SDKs are MIT-licensed and behave the same in every language. They share one on-disk cache format, so a bundle downloaded by one serves the others. The examples below are TypeScript (Node 20 or later).

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

## Load data

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

Each load downloads the newest bundle (xz-compressed, about 20 MB for EC2) only if you don't already have it cached, then deletes that service's older bundles. If the server can't be reached, the newest cached bundle is used instead. A rejected token always throws. Each service is cached separately, so loading one never removes another. With `cachePricingData: false` the SDK always downloads and never writes to disk.

Returned objects are shared between calls, so treat them as read-only.

### `fetchAwsInstance(platform, instanceType, options?)`

Fetches one instance from the HTTP API instead of downloading the whole service. It returns the same `AWSInstance` that `get` does, or `undefined` if the service has no instance with that name. Nothing is cached.

```ts
import { fetchAwsInstance } from "@infrawrench/bulk-instances";

const m5 = await fetchAwsInstance("ec2", "m5.large");
m5?.pricing.onDemand.length;
```

It takes `token` and `baseUrl` (default `https://app.infrawrench.com`). It picks up each new bundle within about half an hour, so it can briefly lag behind `downloadAwsPricingData`.

### Errors

Failures throw `AWSPricingDataError`, with `status` set to the HTTP status when there was a response.

- `401`: the credential wasn't accepted (unknown, revoked or expired).
- `503`: the service couldn't check the credential. It doesn't mean the credential is bad. The SDK retries a couple of times, honouring `Retry-After`, before it throws.

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

One instance type.

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

`spot` holds EC2's spot prices, by instance type, for Linux and Windows. They come from AWS's [Spot pricing page](https://aws.amazon.com/ec2/spot/pricing/), with history before November 2026 filled in from EC2's spot price history:

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

### Other clouds

Ten more platforms come in the same format, with their own download functions and types (`AzurePricingData`, `GCPPricingData`, `RunpodPricingData`, `AlibabaPricingData`, `HetznerPricingData` and so on and their instances, which have the same members as `AWSPricingData` and `AWSInstance`):

| Platform         | Download function                   | What                                                                                           | History from  |
| ---------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------- | ------------- |
| `azure`          | `downloadAzurePricingData`          | Azure VM sizes by ARM name (`Standard_D2s_v3`), priced per VM per hour                         | November 2026 |
| `gcp`            | `downloadGcpPricingData`            | Google Cloud Compute Engine machine types (`n2-standard-2`), priced per VM per hour            | November 2026 |
| `runpod`         | `downloadRunpodPricingData`         | RunPod GPU types (by id, priced per GPU per hour) and CPU pods (`cpu3c-2-4`, per pod per hour) | November 2026 |
| `alibaba`        | `downloadAlibabaPricingData`        | Alibaba Cloud ECS instance types (`ecs.g7.large`), from its international site, in USD         | May 2018      |
| `hetzner`        | `downloadHetznerPricingData`        | Hetzner cloud servers (`cx23`), priced per server per hour                                     | November 2026 |
| `hetznerauction` | `downloadHetznerAuctionPricingData` | Hetzner Server Auction listings by id (`3107671`), each one physical server                    | November 2026 |
| `ovh`            | `downloadOvhPricingData`            | OVHcloud Public Cloud flavors (`b3-8`), from its World and US catalogs, in USD                 | November 2026 |
| `ovheco`         | `downloadOvhEcoPricingData`         | OVHcloud's Kimsufi, So you Start, Rise and Advance servers (`24sys01`), rented by the month    | November 2026 |
| `oracle`         | `downloadOraclePricingData`         | Oracle Cloud VM and bare metal shapes (`BM.GPU.H100.8`), priced per hour                       | November 2026 |
| `ibm`            | `downloadIbmPricingData`            | IBM Cloud Virtual Server for VPC profiles (`bx3d-2x10`), priced per hour                       | November 2026 |

- **Azure**: locations are ARM region names (`eastus`), and `regions` gives each Azure's display `name` (`US East`); a few Spot prices that apply everywhere are in the location `Global`. The variant keys are `operatingSystem` (`Linux`, `Windows`) and `priority` (`Regular`, `Spot` or `Low Priority`). `pricing.onDemand` has pay-as-you-go prices, dated by when Azure says they took effect. Reservations are reserved prices with the term `1yr`, `3yr`, `5yr` or `10yr`, `Reserved Instance`, `All Upfront` (`hourly` is 0 and `upfront` the whole term), listed under `Linux` only since a Windows license is billed on top; savings plans have `1yr` or `3yr`, `Savings Plan`, `No Upfront`, and `hourly` is the plan's rate. Attributes are `skuName`, `productName` and, from Azure's pricing calculator, `cores`, `ram` (GiB), `diskSize` (temporary disk, GiB), `gpu` and `series`; about a third of sizes, mostly the newest and retired series, have no calculator specs. Dedicated hosts are not included.
- **Google Cloud**: locations are region ids (`us-central1`). The only variant key is `provisioningModel` (`Standard` or `Spot`). Google bills most machine types per vCPU and per GiB of memory at their series' rates, plus their GPUs, so each price is worked out from those rates and the machine type's shape; prices leave out bundled Local SSD, OS licenses and sustained use discounts, and TPU, X4, X5 and A4X machine types are not included. Committed use discounts are reserved prices with the term `1yr` or `3yr`, `Committed Use`, `No Upfront`, and `hourly` is the commitment's rate. Attributes are the machine type's fields from the Compute Engine API (`guestCpus`, `memoryMb`, `description`, `isSharedCpu`, ...), `acceleratorType` and `acceleratorCount` for its GPUs, and `zones`, the zones in each region that have it, which differ by region.
- **RunPod**: prices are the same in every data center, so every price is in the location `global`. The only variant key is `cloudType` (`Secure Cloud` or `Community Cloud`). Savings plans are reserved prices with the term `3mo` or `6mo`, `Savings Plan`, `All Upfront`, whose `hourly` is the plan's effective hourly rate. A GPU's `dataCenters` attribute lists the data centers that stock it; stock levels and spot prices are not included.
- **Alibaba Cloud**: locations are region ids (`cn-hangzhou`), and `regions` gives each an English `name`. The variant keys are `operatingSystem` (`Linux`, `Windows`) and `networkType` (`VPC`, or `Classic` in older history). `pricing.onDemand` is pay-as-you-go. Subscriptions are reserved prices with the term `1mo` or `1yr` to `5yr`, `Subscription`, `All Upfront`, paid in full when bought, so `hourly` is 0 and `upfront` is the price; reserved instances have `1yr` or `3yr`, `Reserved Instance` and a purchase option. Attributes are Alibaba's instance type definitions (`CpuCoreCount`, `MemorySize`, ...), from May 2023 on.
- **Hetzner**: locations are Cloud API location names (`fsn1`, `ash`). The only variant key is `ipv4` (`IPv6 only` or `Primary IPv4`), since a primary IPv4 is optional and billed apart. `reserved` has the monthly cap, as `1mo`, `Monthly Cap`, `Postpaid`, with `upfront` the cap. A Server Auction listing has the same shape, and its history ends when the server sells.
- **OVHcloud**: Public Cloud locations are pricing zones, not regions (`world`, `3az`, `lz-eu`, `us`, ...), and the only variant key is `operatingSystem`. **Eco servers have no on-demand prices**, because they are only rented by the month: the rent is in `reserved`, as `1mo`, `Rental`, `All Upfront`, with `upfront` the rent, beside prepaying for 1 or 2 years. Their locations are data centers (`gra`), their variant keys `memory`, `storage` and `systemStorage`, and the `range` attribute says which range a server is in.
- **Oracle Cloud**: prices are the same in every commercial region, so every price is in the location `global`. The only variant key is `operatingSystem`. Flexible shapes are priced at a set of sizes named `<shape>-<ocpus>-<GB>` (`VM.Standard.E5.Flex-2-16`), which aren't names Oracle uses; the `ocpuPrice` and `memoryGbPrice` attributes give any other size.
- **IBM Cloud**: locations are regions (`us-south`). The only variant key is `capacityType` (`On-Demand`, `Spot`, `Burstable 50%`, ...). `reserved` has 1- and 3-year reservations. About 90 older profiles (`bx2`, `cx2`, `mx2`, `gx2`, ...) have no public on-demand price of their own, so theirs is IBM's rate for an hourly reservation, which is an approximation.

```ts
import { downloadRunpodPricingData } from "@infrawrench/bulk-instances";

const runpod = await downloadRunpodPricingData();
runpod
  .get("NVIDIA H100 80GB HBM3")
  ?.pricing.onDemand.find((p) => p.variant.cloudType === "Secure Cloud")?.hourly;
```

The single-instance HTTP endpoint below serves them too (`/api/v1/aws-bulk-pricing/azure/<size>`, `/api/v1/aws-bulk-pricing/gcp/<machine type>`, `/api/v1/aws-bulk-pricing/runpod/<id>`, `/api/v1/aws-bulk-pricing/alibaba/<instance type>`; URL-encode RunPod's ids, which have spaces). The SDKs have `fetchRunpodInstance` and `fetchAlibabaInstance` for it; for Azure and Google Cloud, download the bundle.

## HTTP API

The SDKs use two endpoints, which you can also call directly with `Authorization: Bearer <credential>`.

### One instance: `app.infrawrench.com/api/v1/aws-bulk-pricing`

| Request                                              | Response                                                                                                                                                 |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/aws-bulk-pricing`                       | `{ platforms: [...] }`: each service (AWS, `azure`, `gcp`, `alibaba` and `runpod`) synced so far, with its bundle version, sync time and instance count. |
| `GET /api/v1/aws-bulk-pricing/<platform>`            | That service's `variant_keys`, price list `snapshots` (Unix seconds) and every instance name.                                                            |
| `GET /api/v1/aws-bulk-pricing/<platform>/<instance>` | Everything about one instance, in the bundle encoding below, cut down to that instance. Sends an `ETag` and answers `If-None-Match` with `304`.          |

```bash
curl -H "Authorization: Bearer $INFRAWRENCH_API_KEY" \
  https://app.infrawrench.com/api/v1/aws-bulk-pricing/ec2/m5.large
```

`404` means no such service or instance. `503` means the data couldn't be reached, so retry. The instance responses are in the compact bundle encoding, not plain JSON objects: `fetchAwsInstance` is the easy way to read them. This endpoint is not part of the [OpenAPI spec](./openapi.md); the bulk-instances SDKs are its clients.

### Whole bundles: `instances-bundles.infrawrench.com`

| Request                                                                               | Response                                |
| ------------------------------------------------------------------------------------- | --------------------------------------- |
| `GET /latest` (EC2), `GET /<platform>-latest`                                         | The newest bundle's timestamp, as text. |
| `GET /bundle-<timestamp>.json.xz` (EC2), `GET /<platform>-bundle-<timestamp>.json.xz` | The bundle, xz-compressed.              |

Bundles support `ETag` revalidation and range requests. A new EC2 bundle can appear every few minutes as AWS publishes; the other services are checked every 15 minutes, RunPod every 30 minutes, Azure and Google Cloud every hour, and spot prices and Alibaba Cloud every 6 hours.

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
