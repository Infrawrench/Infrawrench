/**
 * Per-type monthly cost estimation for AWS.
 *
 * Instance rates come from the instance pricing warehouse when the host has
 * one: it needs no AWS permission and covers every engine and service. Failing
 * that, and for everything the warehouse does not hold (volumes, storage), they
 * come from `pricing:GetProducts` for the region the form has selected
 * (`./pricing.ts`). Anything without a resolvable rate is left out of the
 * estimate instead of being approximated: see `buildCostEstimate`, which drops
 * unpriced components and returns `null` when nothing at all could be priced.
 *
 * Field keys are the create form's. Most listers store the same spellings
 * (`region`, `instanceType`, `sizeGb`, `volumeType`, `instanceClass`,
 * `allocatedStorage`, `engine`, `multiAZ`); EKS is the exception: the form
 * writes `instanceType` while the lister stores `instanceTypes` (comma-joined
 * when a cluster has mixed node groups). Both are accepted below.
 */
import {
  buildCostEstimate,
  fetchInstanceOnDemandRates,
  type CostEstimate,
  type CostEstimateLineItem,
  type InstancePricingHostServices,
} from "@infrawrench/plugin-base";

import type { AwsCredentials } from "./auth.js";
import { CACHE_ENGINES, EC2_LINUX, RDS_ENGINES, rdsSelection } from "./instance-pricing.js";
import {
  HOURS_PER_MONTH,
  fetchEbsGbMonthPrice,
  fetchEc2MonthlyPrice,
  fetchElastiCacheNodeHourlyUsd,
  fetchRdsMonthlyPrice,
  fetchRdsStorageGbMonthPrice,
} from "./pricing.js";

/** EC2 and EKS node groups both provision a gp3 root volume: see `createResource`. */
const ROOT_VOLUME_TYPE = "gp3";
/** `CreateDBInstance` defaults allocated storage to General Purpose (gp2). */
const RDS_DEFAULT_STORAGE_GB = 20;

function positiveNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? fallback);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function isTrue(raw: string | undefined): boolean {
  return raw === "true";
}

function money(usd: number): string {
  // Storage rates run to four decimals ($0.0800/GB-month); instance-hour
  // rates to five. Trailing zeros are trimmed so the common case reads as
  // "$0.08" rather than "$0.08000".
  return `$${Number(usd.toFixed(5))}`;
}

/** A `sizeGb × rate` line, or null when the rate or the size is unusable. */
function storageLine(
  label: string,
  sizeGb: number,
  gbMonthUsd: number | null,
  detailSuffix = "",
): CostEstimateLineItem | null {
  if (gbMonthUsd == null || sizeGb <= 0) return null;
  return {
    label,
    monthlyAmount: sizeGb * gbMonthUsd,
    detail: `${sizeGb} GB × ${money(gbMonthUsd)}/GB-month${detailSuffix}`,
    quantity: sizeGb,
    unit: "GB",
  };
}

/** One instance's monthly on-demand price: the warehouse's, or else `live()`'s. */
async function instanceMonthly(
  pricing: InstancePricingHostServices | undefined,
  platform: string,
  region: string,
  instanceType: string,
  selection: Readonly<Record<string, string>>,
  live: () => Promise<number | null>,
): Promise<number | null> {
  const rates = await fetchInstanceOnDemandRates(pricing, {
    platform,
    region,
    instanceTypes: [instanceType],
    selection,
  });
  const hourly = rates?.[instanceType];
  return hourly === undefined ? live() : Number((hourly * HOURS_PER_MONTH).toFixed(2));
}

/** `count × type` nodes billed by the hour, or null when there is no rate. */
function nodesLine(
  label: string,
  instanceType: string,
  count: number,
  monthly: number | null,
): CostEstimateLineItem | null {
  if (monthly == null) return null;
  return {
    label: `${label} (${count} × ${instanceType})`,
    monthlyAmount: monthly * count,
    detail: `${count} × ${money(monthly)}/month`,
    quantity: count,
    unit: "nodes",
  };
}

/**
 * Estimate the monthly cost of an AWS configuration.
 *
 * `region` comes from the form's region picker (and from the lister's stored
 * `region` field for an existing resource); it falls back to the account's
 * own region, which is what the region picker itself defaults to.
 */
export async function estimateAwsCost(
  credentials: AwsCredentials,
  typeId: string,
  fields: Record<string, string>,
  pricing?: InstancePricingHostServices,
): Promise<CostEstimate | null> {
  const region = fields["region"] || credentials.region;
  if (!region) return null;

  if (typeId === "ec2-instance") {
    const instanceType = fields["instanceType"] ?? "";
    if (!instanceType) return null;
    const diskGb = positiveNumber(fields["diskSizeGb"], 20);
    const [monthly, diskRate] = await Promise.all([
      instanceMonthly(pricing, "ec2", region, instanceType, EC2_LINUX, () =>
        fetchEc2MonthlyPrice(credentials, region, instanceType),
      ),
      diskGb > 0 ? fetchEbsGbMonthPrice(credentials, region, ROOT_VOLUME_TYPE) : null,
    ]);
    return buildCostEstimate(
      [
        monthly == null
          ? null
          : {
              label: `Instance (${instanceType})`,
              monthlyAmount: monthly,
              detail: `${money(monthly / 730)}/hour × 730 h`,
            },
        storageLine(`Root volume (${ROOT_VOLUME_TYPE})`, diskGb, diskRate),
      ],
      {
        partial: monthly == null || (diskGb > 0 && diskRate == null),
        notes: ["On-demand Linux rate. Data transfer and snapshots are not included."],
      },
    );
  }

  if (typeId === "ebs-volume") {
    const sizeGb = positiveNumber(fields["sizeGb"], 20);
    if (sizeGb <= 0) return null;
    const volumeType = fields["volumeType"] || ROOT_VOLUME_TYPE;
    const rate = await fetchEbsGbMonthPrice(credentials, region, volumeType);
    return buildCostEstimate([storageLine(`Volume (${volumeType})`, sizeGb, rate)], {
      partial: rate == null,
      notes:
        volumeType === "io2" || volumeType === "io1"
          ? ["Capacity only; provisioned IOPS are billed separately."]
          : [],
    });
  }

  if (typeId === "rds-instance") {
    const instanceClass = fields["instanceClass"] ?? "";
    if (!instanceClass) return null;
    const engine = fields["engine"] || "postgres";
    // The lister stores `multiAZ`; the create form has no such control yet, so
    // an absent value means the single-AZ deployment `CreateDBInstance` makes.
    const multiAz = isTrue(fields["multiAZ"]);
    // Aurora has no allocated storage: its volume grows with the data and is
    // billed per GB consumed, so there is no provisioned figure to multiply
    // and quoting `allocatedStorage` here would invent one.
    const isAurora = engine.startsWith("aurora-");
    const storageGb = isAurora
      ? 0
      : positiveNumber(fields["allocatedStorage"], RDS_DEFAULT_STORAGE_GB);
    const [monthly, storageRate] = await Promise.all([
      // An engine the price lists do not name is not guessed at: the live
      // lookup below refuses it too, so the line drops and the estimate is partial.
      RDS_ENGINES[engine]
        ? instanceMonthly(
            pricing,
            "rds",
            region,
            instanceClass,
            rdsSelection(engine, multiAz),
            () => fetchRdsMonthlyPrice(credentials, region, instanceClass, engine, multiAz),
          )
        : null,
      storageGb > 0 ? fetchRdsStorageGbMonthPrice(credentials, region, multiAz) : null,
    ]);
    const deployment = multiAz ? "Multi-AZ" : "Single-AZ";
    // The form does not ask about the license, so the estimate says which it used.
    const license = RDS_ENGINES[engine]?.license;
    return buildCostEstimate(
      [
        monthly == null
          ? null
          : {
              label: `Instance (${instanceClass})`,
              monthlyAmount: monthly,
              detail: `${deployment} ${engine}, ${money(monthly / 730)}/hour × 730 h`,
            },
        storageLine("Allocated storage", storageGb, storageRate, ` (${deployment})`),
      ],
      {
        partial: monthly == null || (storageGb > 0 && storageRate == null) || isAurora,
        notes: [
          isAurora
            ? "Instance hours only; Aurora storage and I/O are billed separately."
            : "Backups beyond the free allocation and I/O are not included.",
          ...(license ? [`Priced as ${license.toLowerCase()}.`] : []),
        ],
      },
    );
  }

  if (typeId === "eks-cluster") {
    // The control plane is a flat per-cluster hourly charge that the Price
    // List API publishes under AmazonEKS; the nodes are ordinary EC2. Node
    // count is the replica dimension here, so the estimate has to move when
    // the count does: that is the whole point of quoting it live.
    //
    // Form field is `instanceType`; the lister stores `instanceTypes` as a
    // comma-joined set when node groups differ. Price the first type: mixed
    // clusters still get a partial estimate rather than none.
    const instanceTypeRaw = fields["instanceType"] || fields["instanceTypes"] || "";
    const instanceType = instanceTypeRaw.split(",")[0]?.trim() ?? "";
    const nodeCount = Math.max(1, Math.floor(positiveNumber(fields["nodeCount"], 2)));
    const diskGb = positiveNumber(fields["diskSizeGb"], 20);
    const [nodeMonthly, diskRate] = await Promise.all([
      instanceType
        ? instanceMonthly(pricing, "ec2", region, instanceType, EC2_LINUX, () =>
            fetchEc2MonthlyPrice(credentials, region, instanceType),
          )
        : null,
      diskGb > 0 ? fetchEbsGbMonthPrice(credentials, region, ROOT_VOLUME_TYPE) : null,
    ]);
    const perNodeDisk = diskRate == null ? 0 : diskGb * diskRate;
    return buildCostEstimate(
      [
        nodeMonthly == null
          ? null
          : {
              label: `Nodes (${nodeCount} × ${instanceType})`,
              monthlyAmount: nodeMonthly * nodeCount,
              detail: `${nodeCount} × ${money(nodeMonthly)}/month`,
              quantity: nodeCount,
              unit: "nodes",
            },
        perNodeDisk === 0
          ? null
          : {
              label: `Node volumes (${ROOT_VOLUME_TYPE})`,
              monthlyAmount: perNodeDisk * nodeCount,
              detail: `${nodeCount} × ${diskGb} GB × ${money(diskRate!)}/GB-month`,
              quantity: nodeCount * diskGb,
              unit: "GB",
            },
      ],
      {
        // The control-plane charge is real and is deliberately not guessed at:
        // the estimate says so rather than quietly under-quoting.
        partial: true,
        notes: [
          "Worker nodes only; the EKS control-plane charge is not included.",
          "Load balancers created by services are billed separately.",
        ],
      },
    );
  }

  if (typeId === "elasticache-cluster") {
    // The form's field is `cacheNodeType` / `numCacheNodes`; the lister stores
    // `nodeType` / `numNodes`.
    const nodeType = fields["cacheNodeType"] || fields["nodeType"] || "";
    if (!nodeType) return null;
    const engine = (fields["engine"] || "redis").toLowerCase();
    const count = Math.max(
      1,
      Math.floor(positiveNumber(fields["numCacheNodes"] ?? fields["numNodes"], 1)),
    );
    const monthly = await instanceMonthly(
      pricing,
      "elasticache",
      region,
      nodeType,
      CACHE_ENGINES[engine] ? { cache_engine: CACHE_ENGINES[engine] } : {},
      async () => {
        const hourly = await fetchElastiCacheNodeHourlyUsd(credentials, region, nodeType, engine);
        return hourly == null ? null : Number((hourly * HOURS_PER_MONTH).toFixed(2));
      },
    );
    return buildCostEstimate([nodesLine("Nodes", nodeType, count, monthly)], {
      notes: ["Backup storage and data transfer are not included."],
    });
  }

  if (typeId === "opensearch-domain") {
    const instanceType = fields["instanceType"] ?? "";
    if (!instanceType) return null;
    const count = Math.max(1, Math.floor(positiveNumber(fields["instanceCount"], 1)));
    const monthly = await instanceMonthly(
      pricing,
      "opensearch",
      region,
      instanceType,
      {},
      async () => null,
    );
    return buildCostEstimate([nodesLine("Instances", instanceType, count, monthly)], {
      partial: true,
      notes: ["Instance hours only; EBS storage and dedicated master nodes are billed separately."],
    });
  }

  if (typeId === "redshift-cluster") {
    const nodeType = fields["nodeType"] ?? "";
    if (!nodeType) return null;
    const count = Math.max(1, Math.floor(positiveNumber(fields["numberOfNodes"], 1)));
    const monthly = await instanceMonthly(
      pricing,
      "redshift",
      region,
      nodeType,
      {},
      async () => null,
    );
    return buildCostEstimate([nodesLine("Nodes", nodeType, count, monthly)], {
      partial: true,
      notes: ["Compute only; managed storage and backups are billed separately."],
    });
  }

  return null;
}
