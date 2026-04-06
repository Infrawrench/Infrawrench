import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const AlloyDbClusterResourceType: ResourceTypeDefinition = {
  id: "alloydb-cluster",
  displayName: "AlloyDB Cluster",
  pluralDisplayName: "AlloyDB Clusters",
  description: "A Google Cloud AlloyDB for PostgreSQL cluster",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
    { key: "databaseVersion", label: "Database Version", kind: "string", required: false },
    { key: "state", label: "State", kind: "string", required: false },
    { key: "clusterType", label: "Cluster Type", kind: "string", required: false },
  ],
  outputs: [
    { key: "primaryEndpoint", label: "Primary Endpoint", sensitive: false },
  ],
  dashboardPinnable: true,
};
