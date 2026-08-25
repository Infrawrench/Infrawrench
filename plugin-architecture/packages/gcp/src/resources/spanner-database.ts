import { f, rt } from "@infrawrench/plugin-base";

export const SpannerDatabaseResourceType = rt({
  name: "Spanner Database",
  plural: "Databases",
  id: "spanner-database",
  description: "A database inside a Google Cloud Spanner instance",
  fields: [
    f("name", "Database ID"),
    f("instance", "Instance", { required: false }),
    f("state", "State", { required: false }),
    f("dialect", "Dialect", { required: false }),
    f("versionRetentionPeriod", "Version retention", { required: false }),
    f("earliestVersionTime", "Earliest version time", { required: false }),
    f("createTime", "Created", { required: false }),
    f("enableDropProtection", "Drop protection", { kind: "boolean", required: false }),
    f("encryptionConfig", "Encryption", { required: false }),
    f("defaultLeader", "Default leader", { required: false }),
  ],
  outputs: [],
  dependsOn: [
    { fieldKey: "instance", targetTypeId: "spanner-instance", label: "in instance" },
    // encryptionConfig stores the raw kmsKeyName — a full KMS resource path.
    { fieldKey: "encryptionConfig", targetTypeId: "kms-key", label: "encrypted by" },
  ],
  // `versionRetentionPeriod` is deliberately not declared as a retention field:
  // it is a PITR *version* window ("3600s"), not a backup retention in days,
  // and reading it as one would report every database as failing a policy.
  backupPolicy: { protectedBy: ["spanner-backup"] },
  parentTypeId: "spanner-instance",
  supportsCreate: true,
  supportsRestQuery: true,
});
