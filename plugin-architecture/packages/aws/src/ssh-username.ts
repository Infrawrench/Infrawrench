/**
 * Derive the default SSH username for an EC2 instance.
 *
 * Strategy: at create time the handler stores the resolved image FAMILY on
 * the instance (see `FAMILY_SSH_USERNAME` in ami-lookup.ts). For instances
 * synced from outside Infrawrench (where only an AMI ID is known), we fall
 * back to substring-matching the AMI name/description against the known
 * vendor conventions — far more durable than a hardcoded map of stale AMI
 * IDs that rotate every couple of months.
 *
 * Returns an empty string when nothing matches; callers should fall through
 * to the host's other defaults (usually `ec2-user`).
 */

/**
 * Vendor patterns sorted from most-specific to least-specific. Names in
 * AWS-published AMI metadata follow stable conventions:
 *   - Amazon Linux:  "amzn2-ami-…", "al2023-ami-…"
 *   - Ubuntu:        "ubuntu/images/…", "ubuntu-…-server-…"
 *   - Debian:        "debian-12-…", "debian-11-…"
 *   - RHEL:          "RHEL-9.…", "RHEL-8.…"
 *   - SUSE:          "suse-sles-…"
 *   - Rocky:         "Rocky-9-…", "Rocky-8-…"
 *   - AlmaLinux:     "AlmaLinux OS 9.…"
 *   - Fedora:        "Fedora-Cloud-…"
 *   - CentOS Stream: "CentOS Stream …"
 *   - Bottlerocket:  "bottlerocket-…"   (no SSH by design — intentionally unset)
 *   - Windows:       "Windows_Server-…" (no SSH by default — intentionally unset)
 */
const NAME_USERNAME_PATTERNS: Array<{ match: RegExp; username: string }> = [
  // Amazon Linux 2 / Amazon Linux 2023 / EKS-optimized AMIs all use ec2-user.
  { match: /^(amzn2|al2023|amazon-eks-node)/i, username: "ec2-user" },
  // Ubuntu — both Canonical's "ubuntu/…" and the AWS Marketplace "ubuntu-…-server-…"
  { match: /\bubuntu\b/i, username: "ubuntu" },
  // Debian — also recognise "debian/…" name namespaces.
  { match: /^debian[-_/]/i, username: "admin" },
  // RHEL — Red Hat publishes as "RHEL-9.5.0_HVM-…"
  { match: /^RHEL[-_]/i, username: "ec2-user" },
  // SUSE Linux Enterprise Server — "suse-sles-15-sp6-…"
  { match: /^suse-sles/i, username: "ec2-user" },
  // Rocky Linux — "Rocky-9-EC2-…"
  { match: /^Rocky[-_]/i, username: "rocky" },
  // AlmaLinux OS — "AlmaLinux OS 9.x …"
  { match: /^AlmaLinux\b/i, username: "ec2-user" },
  // Fedora Cloud — "Fedora-Cloud-Base-…"
  { match: /^Fedora-Cloud/i, username: "fedora" },
  // CentOS Stream
  { match: /^CentOS\s+Stream/i, username: "centos" },
];

/**
 * Resolve SSH username from an AMI name (or description, or any other label
 * string the caller can extract from DescribeImages). Returns empty string
 * when no pattern matches.
 */
export function ec2SshUsernameFromImageName(name: string): string {
  if (!name) return "";
  for (const { match, username } of NAME_USERNAME_PATTERNS) {
    if (match.test(name)) return username;
  }
  return "";
}

/**
 * Best-effort fallback for callers that only have an AMI ID. We don't keep a
 * hardcoded map — AMI IDs rotate too often to maintain by hand. Returns "".
 * Callers with access to DescribeImages metadata should prefer
 * `ec2SshUsernameFromImageName`.
 */
export function ec2SshUsername(_imageId: string): string {
  return "";
}
