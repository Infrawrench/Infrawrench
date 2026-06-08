import { f, o, rt } from "@infrawrench/plugin-base";

export const AlloyDbClusterResourceType = rt({
  name: "AlloyDB Cluster",
  id: "alloydb-cluster",
  description: "A Google Cloud AlloyDB for PostgreSQL cluster",
  fields: [
    f("name", "Name"),
    f("location", "Location"),
    f("databaseVersion", "Database Version", { required: false }),
    f("state", "State", { required: false }),
    f("clusterType", "Cluster Type", { required: false }),
  ],
  outputs: [],
  supportsCreate: true,
});
