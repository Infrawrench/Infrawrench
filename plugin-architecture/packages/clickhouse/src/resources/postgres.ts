import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * ClickHouse Managed Postgres (beta in the Cloud API). A Postgres service
 * hosted by ClickHouse Cloud next to the organization's ClickHouse services.
 * The superuser password and connection string are only returned when the
 * service is created or its password is reset, so they are captured at
 * create time and never re-read.
 */
export const PostgresResourceType = rt({
  name: "Managed Postgres",
  plural: "Managed Postgres",
  id: "ch-postgres",
  description: "A ClickHouse Managed Postgres service",
  fields: [
    f("postgresId", "Postgres ID", { editable: false }),
    f("name", "Name", { description: "Up to 50 characters." }),
    f("state", "State", {
      kind: "enum",
      editable: false,
      enumValues: [
        "creating",
        "restarting",
        "running",
        "replaying_wal",
        "restoring_backup",
        "finalizing_restore",
        "unavailable",
        "stopped",
        "deleting",
      ],
    }),
    f("provider", "Cloud Provider", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("postgresVersion", "Postgres Version", { required: false, editable: false }),
    f("size", "Instance Size", {
      required: false,
      description: "VM size, e.g. r8gd.large on AWS or c4a-highmem-4 on GCP.",
    }),
    f("storageSize", "Storage (GiB)", { kind: "number", required: false, editable: false }),
    f("haType", "High Availability", {
      kind: "enum",
      enumValues: ["none", "async", "sync"],
      required: false,
      description:
        "none: no standby. async: one standby with asynchronous replication. sync: two standbys with synchronous replication.",
    }),
    f("isPrimary", "Primary", { kind: "boolean", required: false, editable: false }),
    f("hostname", "Hostname", { required: false, editable: false }),
    f("username", "Username", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("postgresId", "Postgres ID"),
    o("hostname", "Hostname"),
    o("username", "Username"),
    o("connectionString", "Connection String", {
      sensitive: true,
      description: "Only available for services created from Infrawrench.",
    }),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "database",
});
