import { ensureArray } from "./auth.js";
import type { AwsCreateContext } from "./create-handlers/shared.js";

export type Arch = "x86_64" | "arm64";

/**
 * Derive CPU architecture from an EC2 instance type.
 *
 * Graviton (arm64) types end with `g` (optionally followed by capability
 * letters like `d`/`n`/`e`) before the size suffix — e.g. `t4g.small`,
 * `m6gd.large`, `c7gn.xlarge`. The legacy `a1.*` family is also arm64.
 * Everything else (t3, m6i, m7a, c6i, r5, …) is x86_64.
 */
export function instanceTypeArch(instanceType: string): Arch {
  const family = instanceType.split(".")[0] ?? "";
  if (family === "a1") return "arm64";
  // Match families like t4g, m6g, m6gd, c7gn, r7g — i.e. ending in 'g'
  // followed by zero or more capability letters.
  if (/^[a-z]+\d+g[a-z]*$/.test(family)) return "arm64";
  return "x86_64";
}

/**
 * Known image-family slugs. Used as image-picker option ids and as the
 * lookup key when resolving to a real AMI per region/arch at create time.
 */
export type ImageFamily =
  | "al2023"
  | "amzn2"
  | "ubuntu-2204"
  | "ubuntu-2404"
  | "debian-12"
  | "rhel-9"
  | "sles-15";

/**
 * Default SSH username for each family. EC2 AMIs from different vendors
 * ship with different default accounts (Amazon Linux: ec2-user, Ubuntu:
 * ubuntu, Debian: admin, …).
 */
export const FAMILY_SSH_USERNAME: Record<ImageFamily, string> = {
  al2023: "ec2-user",
  amzn2: "ec2-user",
  "ubuntu-2204": "ubuntu",
  "ubuntu-2404": "ubuntu",
  "debian-12": "admin",
  "rhel-9": "ec2-user",
  "sles-15": "ec2-user",
};

export function isImageFamily(value: string): value is ImageFamily {
  return value in FAMILY_SSH_USERNAME;
}

/**
 * Build the SSM Public Parameter path that resolves to the latest AMI for
 * the given family + arch. Returns null when SSM coverage is unreliable
 * for the family (RHEL, SUSE) — the caller should fall back to
 * DescribeImages.
 */
function ssmPathFor(family: ImageFamily, arch: Arch): string | null {
  switch (family) {
    case "al2023":
      // /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64
      return `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-${arch}`;
    case "amzn2":
      return `/aws/service/ami-amazon-linux-latest/amzn2-ami-kernel-5.10-hvm-${arch}-gp2`;
    case "ubuntu-2204": {
      const ubuntuArch = arch === "x86_64" ? "amd64" : "arm64";
      return `/aws/service/canonical/ubuntu/server/22.04/stable/current/${ubuntuArch}/hvm/ebs-gp3/ami-id`;
    }
    case "ubuntu-2404": {
      const ubuntuArch = arch === "x86_64" ? "amd64" : "arm64";
      return `/aws/service/canonical/ubuntu/server/24.04/stable/current/${ubuntuArch}/hvm/ebs-gp3/ami-id`;
    }
    case "debian-12": {
      // Debian publishes SSM Public Parameters keyed by codename, not version
      // number. `bookworm` = 12, `bullseye` = 11. The numeric path returns
      // nothing; verified via the Debian wiki Cloud/AmazonEC2Image/Bookworm
      // and SSM parameter listings.
      const debianArch = arch === "x86_64" ? "amd64" : "arm64";
      return `/aws/service/debian/release/bookworm/latest/${debianArch}`;
    }
    case "rhel-9":
    case "sles-15":
      return null;
  }
}

/**
 * Vendor-owner ID + AMI name pattern used to look up RHEL / SUSE images
 * via `DescribeImages`. We pick the newest match.
 */
function describeImagesQuery(
  family: ImageFamily,
  arch: Arch,
): { owner: string; namePattern: string } | null {
  if (family === "rhel-9") {
    // Red Hat (309956199498) publishes images named e.g.
    //   RHEL-9.4.0_HVM-20240603-x86_64-87-Hourly2-GP3
    return {
      owner: "309956199498",
      namePattern: `RHEL-9.*_HVM-*-${arch}-*-Hourly2-GP*`,
    };
  }
  if (family === "sles-15") {
    // SUSE (013907871322) publishes images named e.g.
    //   suse-sles-15-sp6-v20240625-hvm-ssd-x86_64
    return {
      owner: "013907871322",
      namePattern: `suse-sles-15-sp*-v*-hvm-ssd-${arch}`,
    };
  }
  return null;
}

async function resolveViaSsm(rctx: AwsCreateContext, path: string): Promise<string> {
  const data = await rctx.json<{ Parameter?: { Value?: string } }>(
    "ssm",
    "AmazonSSM.GetParameter",
    { Name: path },
  );
  const value = data.Parameter?.Value;
  if (!value) {
    throw new Error(`SSM parameter ${path} returned no value`);
  }
  return value;
}

async function resolveViaDescribeImages(
  rctx: AwsCreateContext,
  owner: string,
  namePattern: string,
  arch: Arch,
): Promise<string> {
  const data = await rctx.ec2<Record<string, unknown>>("DescribeImages", {
    "Owner.1": owner,
    "Filter.1.Name": "name",
    "Filter.1.Value.1": namePattern,
    "Filter.2.Name": "architecture",
    "Filter.2.Value.1": arch,
    "Filter.3.Name": "virtualization-type",
    "Filter.3.Value.1": "hvm",
    "Filter.4.Name": "root-device-type",
    "Filter.4.Value.1": "ebs",
    "Filter.5.Name": "state",
    "Filter.5.Value.1": "available",
  });
  const imagesSet = data["imagesSet"] as Record<string, unknown> | undefined;
  const images = ensureArray(imagesSet?.["item"]) as Record<string, unknown>[];
  if (images.length === 0) {
    throw new Error(`No AMIs found for owner=${owner} name=${namePattern} arch=${arch}`);
  }
  images.sort((a, b) => {
    const ad = String(a["creationDate"] ?? "");
    const bd = String(b["creationDate"] ?? "");
    return bd.localeCompare(ad);
  });
  const imageId = String(images[0]?.["imageId"] ?? "");
  if (!imageId) throw new Error(`DescribeImages returned no imageId`);
  return imageId;
}

/**
 * Resolve a logical image family + architecture to a concrete AMI ID for
 * the region the context is bound to. Throws if the lookup fails.
 */
export async function resolveAmiId(
  rctx: AwsCreateContext,
  family: ImageFamily,
  arch: Arch,
): Promise<string> {
  const ssmPath = ssmPathFor(family, arch);
  if (ssmPath) {
    return resolveViaSsm(rctx, ssmPath);
  }
  const q = describeImagesQuery(family, arch);
  if (q) {
    return resolveViaDescribeImages(rctx, q.owner, q.namePattern, arch);
  }
  throw new Error(`No AMI lookup configured for family=${family}`);
}
