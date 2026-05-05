/**
 * Derive the default SSH username for an EC2 instance based on its AMI ID.
 *
 * Known AMI IDs from the create-config image picker are mapped directly.
 * For unknown AMIs (e.g. synced instances with custom images), returns an
 * empty string so the host falls through to other defaults.
 */

const KNOWN_AMI_USERNAMES: Record<string, string> = {
  // Amazon Linux
  "ami-0c02fb55956c7d316": "ec2-user",
  "ami-0261755bbcb8c4a84": "ec2-user",
  // Ubuntu
  "ami-0c7217cdde317cfec": "ubuntu",
  "ami-0e001c9271cf7f3b9": "ubuntu",
  // Debian
  "ami-0b0dcb5067f052a63": "admin",
  // RHEL
  "ami-0dfcb1ef8fc5fd105": "ec2-user",
  // SUSE
  "ami-0b5eea76982371e91": "ec2-user",
};

export function ec2SshUsername(imageId: string): string {
  return KNOWN_AMI_USERNAMES[imageId] ?? "";
}
