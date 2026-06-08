import { f, o, rt } from "@infrawrench/plugin-base";

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
  parentTypeId: "spanner-instance",
  supportsCreate: true,
});
