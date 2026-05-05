import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const SpannerDatabaseResourceType: ResourceTypeDefinition = {
  id: "spanner-database",
  displayName: "Spanner Database",
  pluralDisplayName: "Databases",
  description: "A database inside a Google Cloud Spanner instance",
  fields: [
    { key: "name", label: "Database ID", kind: "string", required: true },
    { key: "instance", label: "Instance", kind: "string", required: false },
    { key: "state", label: "State", kind: "string", required: false },
    { key: "dialect", label: "Dialect", kind: "string", required: false },
    { key: "versionRetentionPeriod", label: "Version retention", kind: "string", required: false },
    { key: "earliestVersionTime", label: "Earliest version time", kind: "string", required: false },
    { key: "createTime", label: "Created", kind: "string", required: false },
    { key: "enableDropProtection", label: "Drop protection", kind: "boolean", required: false },
    { key: "encryptionConfig", label: "Encryption", kind: "string", required: false },
    { key: "defaultLeader", label: "Default leader", kind: "string", required: false },
  ],
  outputs: [],
  parentTypeId: "spanner-instance",
  dashboardPinnable: true,
  supportsCreate: true,
};
