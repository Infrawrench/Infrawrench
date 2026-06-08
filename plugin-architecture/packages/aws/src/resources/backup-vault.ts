import { f, o, rt } from "@infrawrench/plugin-base";

export const BackupVaultResourceType = rt({
  name: "Backup Vault",
  id: "backup-vault",
  description: "An AWS Backup vault that stores backup recovery points",
  fields: [
    f("backupVaultName", "Vault Name"),
    f("numberOfRecoveryPoints", "Recovery Points", { kind: "number", required: false }),
    f("encryptionKeyArn", "KMS Key ARN", { required: false }),
    f("creationDate", "Created", { required: false }),
  ],
  outputs: [o("backupVaultArn", "Backup Vault ARN")],
  iconKey: "storage",
  supportsMetrics: true,
});
