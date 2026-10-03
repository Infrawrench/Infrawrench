import { f, o, rt } from "@infrawrench/plugin-base";

export const PostgresClusterResourceType = rt({
  name: "Managed Postgres",
  id: "postgres-cluster",
  description: "A Fly.io Managed Postgres cluster with automatic failover, backups, and pooling",
  fields: [
    f("name", "Name"),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["creating", "initializing", "ready", "deleting", "deleted", "failed"],
    }),
    f("plan", "Plan", { required: false }),
    f("region", "Region", { required: false, description: "Region of the primary node" }),
    f("pgMajorVersion", "Postgres Version", { required: false }),
    f("cpuKind", "CPU Kind", { required: false }),
    f("cpus", "vCPUs", { kind: "number", required: false }),
    f("memoryMb", "Memory (MB)", { kind: "number", required: false }),
    f("diskSizeGb", "Disk (GB)", { kind: "number", required: false }),
    f("replicas", "Replicas", { kind: "number", required: false }),
    f("postgisEnabled", "PostGIS", { kind: "boolean", required: false }),
    f("storageUsedBytes", "Storage Used (bytes)", { kind: "number", required: false }),
    f("storageProvisionedBytes", "Storage Provisioned (bytes)", {
      kind: "number",
      required: false,
    }),
    f("directHost", "Direct Host", { required: false }),
    f("directPort", "Direct Port", { kind: "number", required: false }),
    f("poolerHost", "Pooler Host", { required: false }),
    f("poolerPort", "Pooler Port", { kind: "number", required: false }),
    f("attachedApps", "Attached Apps", { required: false }),
    f("organization", "Organization", { required: false }),
    f("createdAt", "Created At", { required: false }),
  ],
  outputs: [
    o("clusterId", "Cluster ID"),
    o("host", "Host", { description: "Direct (unpooled) hostname on the private network" }),
    o("port", "Port"),
    o("poolerHost", "Pooler Host", { description: "PgBouncer hostname on the private network" }),
    o("poolerPort", "Pooler Port"),
  ],
  iconKey: "database",
  supportsCreate: true,
  attachTargets: [
    {
      pluginId: "fly",
      resourceTypeId: "app",
      verb: "Attach app",
    },
  ],
});
