import { f, rt } from "@infrawrench/plugin-base";

export const AlloyDbClusterResourceType = rt({
  name: "AlloyDB Cluster",
  id: "alloydb-cluster",
  iconKey: "database",
  description: "A Google Cloud AlloyDB for PostgreSQL cluster",
  fields: [
    f("name", "Name"),
    f("location", "Location", { showcase: true }),
    f("databaseVersion", "Database Version", { required: false }),
    f("state", "State", { showcase: true, required: false }),
    f("clusterType", "Cluster Type", { required: false }),
  ],
  outputs: [],
  supportsCreate: true,
});
