// Approximate monthly on-demand pricing (us-east-1, Linux)
const EC2_PRICING: Record<string, number> = {
  "t3.nano": 3.8,
  "t3.micro": 7.59,
  "t3.small": 15.18,
  "t3.medium": 30.37,
  "t3.large": 60.74,
  "t3.xlarge": 121.47,
  "t3.2xlarge": 242.94,
  "m6i.large": 69.35,
  "m6i.xlarge": 138.7,
  "m6i.2xlarge": 277.4,
  "m6i.4xlarge": 554.8,
  "m6i.8xlarge": 1109.6,
  "c6i.large": 61.32,
  "c6i.xlarge": 122.64,
  "c6i.2xlarge": 245.28,
  "c6i.4xlarge": 490.56,
  "r6i.large": 91.98,
  "r6i.xlarge": 183.96,
  "r6i.2xlarge": 367.92,
  "r6i.4xlarge": 735.84,
};

// EBS per-GB-month pricing (us-east-1). Covers every volumeType offered
// in the ebs-volume create form.
const EBS_PER_GB_MONTH: Record<string, number> = {
  gp3: 0.08,
  gp2: 0.1,
  io2: 0.125,
  st1: 0.045,
  sc1: 0.015,
  standard: 0.05,
};

const ebsRate = (volumeType: string): number =>
  EBS_PER_GB_MONTH[volumeType] ?? EBS_PER_GB_MONTH["gp3"]!;

export function getCreateCostEstimate(
  typeId: string,
  fields: Record<string, string>,
): number | null {
  if (typeId === "ec2-instance") {
    const instanceType = fields["instanceType"] ?? "";
    const basePrice = EC2_PRICING[instanceType];
    if (basePrice == null) return null;
    // EC2 create provisions a gp3 root volume (see createResource).
    const diskGb = Number(fields["diskSizeGb"] ?? "20");
    const diskCost = (Number.isFinite(diskGb) ? diskGb : 0) * ebsRate("gp3");
    return Number((basePrice + diskCost).toFixed(2));
  }
  if (typeId === "ebs-volume") {
    const sizeGb = Number(fields["sizeGb"] ?? "20");
    if (!Number.isFinite(sizeGb) || sizeGb <= 0) return null;
    const volumeType = fields["volumeType"] ?? "gp3";
    return Number((sizeGb * ebsRate(volumeType)).toFixed(2));
  }
  if (typeId === "rds-instance") {
    // Approximate on-demand pricing (us-east-1, PostgreSQL, single-AZ, 730h/month)
    const rdsPricing: Record<string, number> = {
      "db.t3.micro": 12.41,
      "db.t3.small": 24.82,
      "db.t3.medium": 49.64,
      "db.t3.large": 99.28,
      "db.r6g.large": 175.2,
      "db.r6g.xlarge": 350.4,
    };
    const instanceClass = fields["instanceClass"] ?? "";
    const basePrice = rdsPricing[instanceClass];
    if (basePrice == null) return null;
    // RDS defaults allocated storage to gp2 ($0.115/GB-month in us-east-1).
    const storageGb = Number(fields["allocatedStorage"] ?? "20");
    const storageCost = (Number.isFinite(storageGb) ? storageGb : 0) * 0.115;
    return Number((basePrice + storageCost).toFixed(2));
  }
  return null;
}
