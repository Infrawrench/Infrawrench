import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ClusterPolicyResourceType: ResourceTypeDefinition = {
  id: "databricks-cluster-policy",
  displayName: "Cluster Policy",
  pluralDisplayName: "Cluster Policies",
  description: "A Databricks compute policy that constrains cluster creation and cost controls",
  fields: [
    { key: "policyId", label: "Policy ID", kind: "string", required: true },
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "description", label: "Description", kind: "string", required: false },
    { key: "creatorUserName", label: "Creator", kind: "string", required: false },
    { key: "policyFamilyId", label: "Policy Family", kind: "string", required: false },
    { key: "isDefault", label: "Default", kind: "boolean", required: false },
    { key: "maxClustersPerUser", label: "Max Clusters/User", kind: "number", required: false },
  ],
  outputs: [{ key: "policyId", label: "Policy ID", sensitive: false }],
  dashboardPinnable: true,
  iconKey: "settings",
};

export const NodeTypeResourceType: ResourceTypeDefinition = {
  id: "databricks-node-type",
  displayName: "Node Type",
  pluralDisplayName: "Node Types",
  description: "A Databricks-supported compute node type for launching clusters",
  fields: [
    { key: "nodeTypeId", label: "Node Type ID", kind: "string", required: true },
    { key: "category", label: "Category", kind: "string", required: false },
    { key: "description", label: "Description", kind: "string", required: false },
    { key: "instanceTypeId", label: "Instance Type", kind: "string", required: false },
    { key: "memoryMb", label: "Memory MB", kind: "number", required: false },
    { key: "numCores", label: "Cores", kind: "number", required: false },
    { key: "numGpus", label: "GPUs", kind: "number", required: false },
    { key: "isDeprecated", label: "Deprecated", kind: "boolean", required: false },
    { key: "isHidden", label: "Hidden", kind: "boolean", required: false },
    { key: "photonWorkerCapable", label: "Photon Worker", kind: "boolean", required: false },
  ],
  outputs: [{ key: "nodeTypeId", label: "Node Type ID", sensitive: false }],
  dashboardPinnable: false,
  iconKey: "compute",
};

export const WorkspaceObjectResourceType: ResourceTypeDefinition = {
  id: "databricks-workspace-object",
  displayName: "Workspace Object",
  pluralDisplayName: "Workspace Objects",
  description: "A Databricks workspace notebook, file, directory, repo, or dashboard object",
  fields: [
    { key: "objectId", label: "Object ID", kind: "number", required: false },
    { key: "path", label: "Path", kind: "string", required: true },
    { key: "objectType", label: "Type", kind: "string", required: true },
    { key: "language", label: "Language", kind: "string", required: false },
    { key: "resourceId", label: "Resource ID", kind: "string", required: false },
    { key: "size", label: "Size", kind: "number", required: false },
  ],
  outputs: [
    { key: "path", label: "Path", sensitive: false },
    { key: "resourceId", label: "Resource ID", sensitive: false },
  ],
  dashboardPinnable: false,
  iconKey: "file",
};

export const RepoResourceType: ResourceTypeDefinition = {
  id: "databricks-repo",
  displayName: "Git Folder",
  pluralDisplayName: "Git Folders",
  description: "A Databricks Git folder/repo synced into the workspace",
  fields: [
    { key: "repoId", label: "Repo ID", kind: "number", required: true },
    { key: "path", label: "Path", kind: "string", required: true },
    { key: "url", label: "Remote URL", kind: "string", required: false },
    { key: "provider", label: "Provider", kind: "string", required: false },
    { key: "branch", label: "Branch", kind: "string", required: false },
    { key: "headCommitId", label: "HEAD", kind: "string", required: false },
  ],
  outputs: [
    { key: "repoId", label: "Repo ID", sensitive: false },
    { key: "path", label: "Path", sensitive: false },
    { key: "url", label: "Remote URL", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "git-branch",
};

export const DashboardResourceType: ResourceTypeDefinition = {
  id: "databricks-dashboard",
  displayName: "AI/BI Dashboard",
  pluralDisplayName: "AI/BI Dashboards",
  description: "A Databricks Lakeview / AI-BI dashboard",
  fields: [
    { key: "dashboardId", label: "Dashboard ID", kind: "string", required: true },
    { key: "displayName", label: "Name", kind: "string", required: true },
    { key: "lifecycleState", label: "State", kind: "string", required: false },
    { key: "warehouseId", label: "Warehouse ID", kind: "string", required: false },
    { key: "path", label: "Path", kind: "string", required: false },
  ],
  outputs: [
    { key: "dashboardId", label: "Dashboard ID", sensitive: false },
    { key: "dashboardUrl", label: "Dashboard URL", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "dashboard",
};

export const SqlQueryResourceType: ResourceTypeDefinition = {
  id: "databricks-sql-query",
  displayName: "SQL Query",
  pluralDisplayName: "SQL Queries",
  description: "A saved Databricks SQL query",
  fields: [
    { key: "queryId", label: "Query ID", kind: "string", required: true },
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "catalog", label: "Catalog", kind: "string", required: false },
    { key: "schema", label: "Schema", kind: "string", required: false },
    { key: "warehouseId", label: "Warehouse ID", kind: "string", required: false },
    { key: "owner", label: "Owner", kind: "string", required: false },
    { key: "isFavorite", label: "Favorite", kind: "boolean", required: false },
  ],
  outputs: [
    { key: "queryId", label: "Query ID", sensitive: false },
    { key: "queryUrl", label: "Query URL", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "database",
};

export const VolumeResourceType: ResourceTypeDefinition = {
  id: "databricks-volume",
  displayName: "Volume",
  pluralDisplayName: "Volumes",
  description: "A Unity Catalog volume for governed file access",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "catalogName", label: "Catalog", kind: "string", required: true },
    { key: "schemaName", label: "Schema", kind: "string", required: true },
    { key: "volumeType", label: "Type", kind: "string", required: false },
    { key: "owner", label: "Owner", kind: "string", required: false },
    { key: "storageLocation", label: "Storage Location", kind: "string", required: false },
    { key: "comment", label: "Comment", kind: "string", required: false },
  ],
  outputs: [
    { key: "fullName", label: "Full Name", sensitive: false },
    { key: "volumePath", label: "Volume Path", sensitive: false },
    { key: "storageLocation", label: "Storage Location", sensitive: false },
  ],
  parentTypeId: "databricks-schema",
  dashboardPinnable: false,
  iconKey: "folder",
};

export const FunctionResourceType: ResourceTypeDefinition = {
  id: "databricks-function",
  displayName: "Function",
  pluralDisplayName: "Functions",
  description: "A Unity Catalog SQL or external function",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "catalogName", label: "Catalog", kind: "string", required: true },
    { key: "schemaName", label: "Schema", kind: "string", required: true },
    { key: "dataType", label: "Return Type", kind: "string", required: false },
    { key: "routineBody", label: "Body Type", kind: "string", required: false },
    { key: "owner", label: "Owner", kind: "string", required: false },
    { key: "comment", label: "Comment", kind: "string", required: false },
  ],
  outputs: [{ key: "fullName", label: "Full Name", sensitive: false }],
  parentTypeId: "databricks-schema",
  dashboardPinnable: false,
  iconKey: "function",
};

export const RegisteredModelResourceType: ResourceTypeDefinition = {
  id: "databricks-registered-model",
  displayName: "Registered Model",
  pluralDisplayName: "Registered Models",
  description: "A Unity Catalog MLflow registered model",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "catalogName", label: "Catalog", kind: "string", required: false },
    { key: "schemaName", label: "Schema", kind: "string", required: false },
    { key: "owner", label: "Owner", kind: "string", required: false },
    { key: "aliasCount", label: "Aliases", kind: "number", required: false },
    { key: "storageLocation", label: "Storage Location", kind: "string", required: false },
    { key: "comment", label: "Comment", kind: "string", required: false },
  ],
  outputs: [
    { key: "fullName", label: "Full Name", sensitive: false },
    { key: "storageLocation", label: "Storage Location", sensitive: false },
  ],
  parentTypeId: "databricks-schema",
  dashboardPinnable: true,
  iconKey: "model",
};

export const VectorSearchEndpointResourceType: ResourceTypeDefinition = {
  id: "databricks-vector-search-endpoint",
  displayName: "Vector Search Endpoint",
  pluralDisplayName: "Vector Search Endpoints",
  description: "A Databricks Vector Search endpoint",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "endpointType", label: "Type", kind: "string", required: false },
    { key: "state", label: "State", kind: "string", required: false },
    { key: "creator", label: "Creator", kind: "string", required: false },
  ],
  outputs: [{ key: "endpointName", label: "Endpoint Name", sensitive: false }],
  dashboardPinnable: true,
  iconKey: "search",
};

export const VectorSearchIndexResourceType: ResourceTypeDefinition = {
  id: "databricks-vector-search-index",
  displayName: "Vector Search Index",
  pluralDisplayName: "Vector Search Indexes",
  description: "A Databricks Vector Search index",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "endpointName", label: "Endpoint", kind: "string", required: true },
    { key: "indexType", label: "Type", kind: "string", required: false },
    { key: "indexSubtype", label: "Subtype", kind: "string", required: false },
    { key: "primaryKey", label: "Primary Key", kind: "string", required: false },
    { key: "creator", label: "Creator", kind: "string", required: false },
  ],
  outputs: [{ key: "fullName", label: "Index Name", sensitive: false }],
  parentTypeId: "databricks-vector-search-endpoint",
  dashboardPinnable: true,
  iconKey: "search",
};

export const AppResourceType: ResourceTypeDefinition = {
  id: "databricks-app",
  displayName: "App",
  pluralDisplayName: "Apps",
  description: "A Databricks App deployment",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "description", label: "Description", kind: "string", required: false },
    { key: "computeSize", label: "Compute Size", kind: "string", required: false },
    { key: "appStatus", label: "App Status", kind: "string", required: false },
    { key: "computeStatus", label: "Compute Status", kind: "string", required: false },
    { key: "url", label: "URL", kind: "string", required: false },
    { key: "budgetPolicyId", label: "Budget Policy", kind: "string", required: false },
  ],
  outputs: [
    { key: "appName", label: "App Name", sensitive: false },
    { key: "appUrl", label: "App URL", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "app",
};

export const SecretScopeResourceType: ResourceTypeDefinition = {
  id: "databricks-secret-scope",
  displayName: "Secret Scope",
  pluralDisplayName: "Secret Scopes",
  description: "A Databricks secret scope. Secret values are never exposed by the API.",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "backendType", label: "Backend", kind: "string", required: false },
    { key: "keyVaultDnsName", label: "Key Vault DNS", kind: "string", required: false },
    { key: "keyVaultResourceId", label: "Key Vault Resource ID", kind: "string", required: false },
  ],
  outputs: [{ key: "scopeName", label: "Scope Name", sensitive: false }],
  dashboardPinnable: false,
  iconKey: "key",
};
