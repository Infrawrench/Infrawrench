import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const BackupVaultResourceType: ResourceTypeDefinition = {
  id: "backup-vault",
  displayName: "Backup Vault",
  pluralDisplayName: "Backup Vaults",
  description: "An AWS Backup vault that stores backup recovery points",
  fields: [
    { key: "backupVaultName", label: "Vault Name", kind: "string", required: true },
    { key: "numberOfRecoveryPoints", label: "Recovery Points", kind: "number", required: false },
    { key: "encryptionKeyArn", label: "KMS Key ARN", kind: "string", required: false },
    { key: "creationDate", label: "Created", kind: "string", required: false },
  ],
  outputs: [{ key: "backupVaultArn", label: "Backup Vault ARN", sensitive: false }],
  dashboardPinnable: true,
  iconKey: "storage",
  supportsMetrics: true,
};
