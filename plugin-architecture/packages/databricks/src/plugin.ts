import type { Plugin, PluginManifest, ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { DatabricksClient } from "./client.js";
import { ClusterResourceType } from "./resources/cluster.js";
import { SqlWarehouseResourceType } from "./resources/sql-warehouse.js";
import { JobResourceType } from "./resources/job.js";
import { PipelineResourceType } from "./resources/pipeline.js";
import { CatalogResourceType } from "./resources/catalog.js";
import { SchemaResourceType } from "./resources/schema.js";
import { TableResourceType } from "./resources/table.js";

const manifest: PluginManifest = {
  id: "databricks",
  version: "0.1.0",
  displayName: "Databricks",
  description: "Manage Databricks workspaces — clusters, SQL warehouses, jobs, pipelines, and Unity Catalog.",
  logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="12" fill="#FF3621"/>
    <g transform="translate(50,50)">
      <polygon points="0,-30 26,15 0,0 -26,15" fill="#fff" opacity="0.9"/>
      <polygon points="0,0 26,15 0,30 -26,15" fill="#fff" opacity="0.7"/>
    </g>
  </svg>`,
  author: "Infrawrench",
  license: "MIT",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "host",
      label: "Workspace URL",
      description: "Your Databricks workspace URL (e.g. https://adb-1234567890.7.azuredatabricks.net or https://dbc-abc123.cloud.databricks.com).",
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
];

export const plugin: Plugin = {
  manifest,
  resourceTypes,
  createClient: (credentials) => new DatabricksClient(credentials),
};
