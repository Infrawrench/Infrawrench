import { f, o, rt } from "@infrawrench/plugin-base";

export const TursoDatabaseResourceType = rt({
  name: "Database",
  id: "turso-database",
  description: "A Turso SQLite database — edge-replicated via libsql",
  fields: [
    f("name", "Name", { editable: false }),
    f("group", "Group", { required: false, editable: false }),
    f("primaryRegion", "Primary Region", { required: false, editable: false }),
    f("regions", "Regions", { required: false, editable: false }),
    f("version", "Version", { required: false, editable: false }),
    f("isSchema", "Schema Database", { kind: "boolean", required: false, editable: false }),
    f("schema", "Parent Schema", { required: false, editable: false }),
    f("parent", "Branched From", { required: false, editable: false }),
    f("branchedAt", "Branched At", { required: false, editable: false }),
    f("sleeping", "Sleeping", { kind: "boolean", required: false, editable: false }),
    f("archived", "Archived", { kind: "boolean", required: false, editable: false }),
    // Everything below is the database's configuration
    // (`PATCH .../databases/{db}/configuration`), which is what the Edit form writes.
    f("deleteProtection", "Delete Protection", {
      kind: "boolean",
      required: false,
      description: "Refuse deletion until protection is turned off again.",
    }),
    f("blockReads", "Block Reads", { kind: "boolean", required: false }),
    f("blockWrites", "Block Writes", { kind: "boolean", required: false }),
    f("sizeLimit", "Size Limit", {
      required: false,
      description: "Maximum database size, in bytes or with a unit (256mb, 1gb). Blank means none.",
    }),
    f("allowedIps", "Allowed IPs", {
      required: false,
      description:
        "Comma-separated IP addresses or CIDR blocks allowed to connect. Blank accepts any source.",
    }),
    f("allowedAwsVpcIds", "Allowed AWS VPC Endpoints", {
      required: false,
      description:
        "Comma-separated AWS VPC endpoint IDs (vpce-...) allowed to connect. Blank accepts any endpoint.",
    }),
  ],
  outputs: [
    o("hostname", "Hostname"),
    o("connectionString", "Connection String (libsql)", { sensitive: true }),
    o("dbName", "Database Name"),
  ],
  dependsOn: [
    { fieldKey: "group", targetTypeId: "turso-group", label: "in group" },
    // Schema databases are named, so a child points at its parent by name.
    { fieldKey: "schema", targetTypeId: "turso-database", label: "extends schema" },
    // A branch (or point-in-time copy) names the database it was forked from.
    { fieldKey: "parent", targetTypeId: "turso-database", label: "branched from" },
    { fieldKey: "primaryRegion", targetTypeId: "turso-location", label: "primary in" },
    // Comma-joined location codes: one edge per replica location.
    { fieldKey: "regions", targetTypeId: "turso-location", label: "replicated in" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "turso",
  secretExportTemplates: [
    {
      id: "connection-url",
      displayName: "Connection URL",
      description: "TURSO_DATABASE_URL for libsql client connections",
      entries: [
        { envKey: "TURSO_DATABASE_URL", outputKey: "connectionString" },
        { envKey: "TURSO_HOSTNAME", outputKey: "hostname" },
      ],
    },
  ],
  resourceSqlDriver: {
    driver: "libsql",
    connectionStringOutputKey: "connectionString",
  },
});
