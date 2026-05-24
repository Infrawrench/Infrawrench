import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { DatabricksClient } from "./client.js";
import { ClusterResourceType } from "./resources/cluster.js";
import { SqlWarehouseResourceType } from "./resources/sql-warehouse.js";
import { JobResourceType } from "./resources/job.js";
import { PipelineResourceType } from "./resources/pipeline.js";
import { CatalogResourceType } from "./resources/catalog.js";
import { SchemaResourceType } from "./resources/schema.js";
import { TableResourceType } from "./resources/table.js";
import { ServingEndpointResourceType } from "./resources/serving-endpoint.js";

const manifest: PluginManifest = {
  id: "databricks",
  version: "0.1.0",
  displayName: "Databricks",
  description:
    "Manage Databricks workspaces — clusters, SQL warehouses, jobs, pipelines, and Unity Catalog.",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#FF3621"/>
    <g transform="translate(14,10) scale(3)" fill="#fff">
      <path d="M.95 14.184L12 20.403l9.919-5.55v2.21L12 22.662l-10.484-5.96-.565.308v.77L12 24l11.05-6.218v-4.317l-.515-.309L12 19.118l-9.867-5.653v-2.21L12 16.805l11.05-6.218V6.32l-.515-.308L12 11.974 2.647 6.681 12 1.388l7.76 4.368.668-.411v-.566L12 0 .95 6.27v.72L12 13.207l9.919-5.55v2.26L12 15.52 1.516 9.56l-.565.308Z"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "host",
      label: "Workspace URL",
      description:
        "Your Databricks workspace URL (e.g. https://adb-1234567890.7.azuredatabricks.net or https://dbc-abc123.cloud.databricks.com).",
      sensitive: false,
      placeholder: "https://adb-1234567890.7.azuredatabricks.net",
    },
    {
      key: "token",
      label: "Personal Access Token",
      description: "A Databricks personal access token (PAT) or service principal OAuth token.",
      sensitive: true,
      placeholder: "dapi...",
    },
  ],
};

const resourceTypes: ResourceTypeDefinition[] = [
  ClusterResourceType,
  SqlWarehouseResourceType,
  JobResourceType,
  PipelineResourceType,
  CatalogResourceType,
  SchemaResourceType,
  TableResourceType,
  ServingEndpointResourceType,
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials) => new DatabricksClient(credentials, resourceTypes),
};
