/**
 * Per-type monthly cost estimation for AWS, built on the live Price List
 * rates in `./pricing.ts`.
 *
 * This module used to be a static us-east-1 table. That table quoted the same
 * number in Tokyo as in Virginia and had drifted to instance generations the
 * size picker no longer offers, so it was recorded as known-broken rather
 * than trusted. Everything here now resolves through `pricing:GetProducts`
 * for the region the form has selected, and anything without a resolvable
 * rate is left out of the estimate instead of being approximated — see
 * `buildCostEstimate`, which drops unpriced components and returns `null`
 * when nothing at all could be priced.
 *
 * Field keys are the create form's. Most listers store the same spellings
 * (`region`, `instanceType`, `sizeGb`, `volumeType`, `instanceClass`,
 * `allocatedStorage`, `engine`, `multiAZ`); EKS is the exception — the form
 * writes `instanceType` while the lister stores `instanceTypes` (comma-joined
 * when a cluster has mixed node groups). Both are accepted below.
 */
import {
  buildCostEstimate,
  type CostEstimate,
  type CostEstimateLineItem,
} from "@infrawrench/plugin-base";

import type { AwsCredentials } from "./auth.js";
import {
  fetchEbsGbMonthPrice,
  fetchEc2MonthlyPrice,
  fetchRdsMonthlyPrice,
  fetchRdsStorageGbMonthPrice,
} from "./pricing.js";

/** EC2 and EKS node groups both provision a gp3 root volume — see `createResource`. */
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
): Promise<CostEstimate | null> {
  const region = fields["region"] || credentials.region;
  if (!region) return null;

  if (typeId === "ec2-instance") {
    const instanceType = fields["instanceType"] ?? "";
    if (!instanceType) return null;
    const diskGb = positiveNumber(fields["diskSizeGb"], 20);
    const [instanceMonthly, diskRate] = await Promise.all([
      fetchEc2MonthlyPrice(credentials, region, instanceType),
      diskGb > 0 ? fetchEbsGbMonthPrice(credentials, region, ROOT_VOLUME_TYPE) : null,
    ]);
    return buildCostEstimate(
      [
        instanceMonthly == null
          ? null
          : {
              label: `Instance (${instanceType})`,
              monthlyAmount: instanceMonthly,
              detail: `${money(instanceMonthly / 730)}/hour × 730 h`,
            },
        storageLine(`Root volume (${ROOT_VOLUME_TYPE})`, diskGb, diskRate),
      ],
      {
        partial: instanceMonthly == null || (diskGb > 0 && diskRate == null),
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
          ? ["Capacity only — provisioned IOPS are billed separately."]
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
    // Aurora has no allocated storage — its volume grows with the data and is
    // billed per GB consumed, so there is no provisioned figure to multiply
    // and quoting `allocatedStorage` here would invent one.
    const isAurora = engine.startsWith("aurora-");
    const storageGb = isAurora
      ? 0
      : positiveNumber(fields["allocatedStorage"], RDS_DEFAULT_STORAGE_GB);
    const [instanceMonthly, storageRate] = await Promise.all([
      fetchRdsMonthlyPrice(credentials, region, instanceClass, engine, multiAz),
      storageGb > 0 ? fetchRdsStorageGbMonthPrice(credentials, region, multiAz) : null,
    ]);
    const deployment = multiAz ? "Multi-AZ" : "Single-AZ";
    return buildCostEstimate(
      [
        instanceMonthly == null
          ? null
          : {
              label: `Instance (${instanceClass})`,
              monthlyAmount: instanceMonthly,
              detail: `${deployment} ${engine}, ${money(instanceMonthly / 730)}/hour × 730 h`,
            },
        storageLine("Allocated storage", storageGb, storageRate, ` (${deployment})`),
      ],
      {
        partial: instanceMonthly == null || (storageGb > 0 && storageRate == null) || isAurora,
        notes: isAurora
          ? ["Instance hours only — Aurora storage and I/O are billed per GB and per request."]
          : ["Backups beyond the free allocation and I/O are not included."],
      },
    );
  }

  if (typeId === "eks-cluster") {
    // The control plane is a flat per-cluster hourly charge that the Price
    // List API publishes under AmazonEKS; the nodes are ordinary EC2. Node
    // count is the replica dimension here, so the estimate has to move when
    // the count does — that is the whole point of quoting it live.
    //
    // Form field is `instanceType`; the lister stores `instanceTypes` as a
    // comma-joined set when node groups differ. Price the first type — mixed
    // clusters still get a partial estimate rather than none.
    const instanceTypeRaw = fields["instanceType"] || fields["instanceTypes"] || "";
    const instanceType = instanceTypeRaw.split(",")[0]?.trim() ?? "";
    const nodeCount = Math.max(1, Math.floor(positiveNumber(fields["nodeCount"], 2)));
    const diskGb = positiveNumber(fields["diskSizeGb"], 20);
    const [nodeMonthly, diskRate] = await Promise.all([
      instanceType ? fetchEc2MonthlyPrice(credentials, region, instanceType) : null,
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
        // The control-plane charge is real and is deliberately not guessed at
        // — the estimate says so rather than quietly under-quoting.
        partial: true,
        notes: [
          "Worker nodes only — the EKS control-plane hourly charge is not included.",
          "Load balancers created by services are billed separately.",
        ],
      },
    );
  }

  return null;
}
