import { f, o, rt } from "@infrawrench/plugin-base";

export const ClusterPolicyResourceType = rt({
  name: "Cluster Policy",
  plural: "Cluster Policies",
  id: "databricks-cluster-policy",
  description: "A Databricks compute policy that constrains cluster creation and cost controls",
  fields: [
    f("policyId", "Policy ID"),
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("creatorUserName", "Creator", { required: false }),
    f("policyFamilyId", "Policy Family", { required: false }),
    f("isDefault", "Default", { kind: "boolean", required: false }),
    f("maxClustersPerUser", "Max Clusters/User", { kind: "number", required: false }),
  ],
  outputs: [o("policyId", "Policy ID")],
  iconKey: "settings",
});

export const NodeTypeResourceType = rt({
  name: "Node Type",
  pinnable: false,
  id: "databricks-node-type",
  description: "A Databricks-supported compute node type for launching clusters",
  fields: [
    f("nodeTypeId", "Node Type ID"),
    f("category", "Category", { required: false }),
    f("description", "Description", { required: false }),
    f("instanceTypeId", "Instance Type", { required: false }),
    f("memoryMb", "Memory MB", { kind: "number", required: false }),
    f("numCores", "Cores", { kind: "number", required: false }),
    f("numGpus", "GPUs", { kind: "number", required: false }),
    f("isDeprecated", "Deprecated", { kind: "boolean", required: false }),
    f("isHidden", "Hidden", { kind: "boolean", required: false }),
    f("photonWorkerCapable", "Photon Worker", { kind: "boolean", required: false }),
  ],
  outputs: [o("nodeTypeId", "Node Type ID")],
  iconKey: "compute",
});

export const WorkspaceObjectResourceType = rt({
  name: "Workspace Object",
  pinnable: false,
  id: "databricks-workspace-object",
  description: "A Databricks workspace notebook, file, directory, repo, or dashboard object",
  fields: [
    f("objectId", "Object ID", { kind: "number", required: false }),
    f("path", "Path"),
    f("objectType", "Type"),
    f("language", "Language", { required: false }),
    f("resourceId", "Resource ID", { required: false }),
    f("size", "Size", { kind: "number", required: false }),
  ],
  outputs: [o("path", "Path"), o("resourceId", "Resource ID")],
  iconKey: "file",
});

export const RepoResourceType = rt({
  name: "Git Folder",
  id: "databricks-repo",
  description: "A Databricks Git folder/repo synced into the workspace",
  fields: [
    f("repoId", "Repo ID", { kind: "number" }),
    f("path", "Path"),
    f("url", "Remote URL", { required: false }),
    f("provider", "Provider", { required: false }),
    f("branch", "Branch", { required: false }),
    f("headCommitId", "HEAD", { required: false }),
  ],
  outputs: [o("repoId", "Repo ID"), o("path", "Path"), o("url", "Remote URL")],
  iconKey: "git-branch",
});

export const DashboardResourceType = rt({
  name: "AI/BI Dashboard",
  id: "databricks-dashboard",
  description: "A Databricks Lakeview / AI-BI dashboard",
  fields: [
    f("dashboardId", "Dashboard ID"),
    f("displayName", "Name"),
    f("lifecycleState", "State", { required: false }),
    f("warehouseId", "Warehouse ID", { required: false }),
    f("path", "Path", { required: false }),
  ],
  outputs: [o("dashboardId", "Dashboard ID"), o("dashboardUrl", "Dashboard URL")],
  dependsOn: [
    { fieldKey: "warehouseId", targetTypeId: "databricks-sql-warehouse", label: "queries via" },
  ],
  iconKey: "dashboard",
});

export const SqlQueryResourceType = rt({
  name: "SQL Query",
  plural: "SQL Queries",
  id: "databricks-sql-query",
  description: "A saved Databricks SQL query",
  fields: [
    f("queryId", "Query ID"),
    f("name", "Name"),
    f("catalog", "Catalog", { required: false }),
    f("schema", "Schema", { required: false }),
    f("warehouseId", "Warehouse ID", { required: false }),
    f("owner", "Owner", { required: false }),
    f("isFavorite", "Favorite", { kind: "boolean", required: false }),
  ],
  outputs: [o("queryId", "Query ID"), o("queryUrl", "Query URL")],
  // `schema` is bare while a schema's external id is `catalog.schema`; the
  // query's own `catalog` supplies the missing half.
  dependsOn: [
    { fieldKey: "catalog", targetTypeId: "databricks-catalog", label: "in catalog" },
    {
      fieldKey: "schema",
      targetTypeId: "databricks-schema",
      matchTemplate: "{catalog}.{schema}",
      label: "in schema",
    },
    { fieldKey: "warehouseId", targetTypeId: "databricks-sql-warehouse", label: "runs on" },
  ],
  iconKey: "database",
});

export const VolumeResourceType = rt({
  name: "Volume",
  pinnable: false,
  id: "databricks-volume",
  description: "A Unity Catalog volume for governed file access",
  fields: [
    f("name", "Name"),
    f("catalogName", "Catalog"),
    f("schemaName", "Schema"),
    f("volumeType", "Type", { required: false }),
    f("owner", "Owner", { required: false }),
    f("storageLocation", "Storage Location", { required: false }),
    f("comment", "Comment", { required: false }),
  ],
  outputs: [
    o("fullName", "Full Name"),
    o("volumePath", "Volume Path"),
    o("storageLocation", "Storage Location"),
  ],
  // A schema's external id is `catalog.schema`, so the bare `schemaName` only
  // matches once composed with its catalog.
  dependsOn: [
    { fieldKey: "catalogName", targetTypeId: "databricks-catalog", label: "in catalog" },
    {
      fieldKey: "schemaName",
      targetTypeId: "databricks-schema",
      matchTemplate: "{catalogName}.{schemaName}",
      label: "in schema",
    },
  ],
  parentTypeId: "databricks-schema",
  iconKey: "folder",
});

export const FunctionResourceType = rt({
  name: "Function",
  pinnable: false,
  id: "databricks-function",
  description: "A Unity Catalog SQL or external function",
  fields: [
    f("name", "Name"),
    f("catalogName", "Catalog"),
    f("schemaName", "Schema"),
    f("dataType", "Return Type", { required: false }),
    f("routineBody", "Body Type", { required: false }),
    f("owner", "Owner", { required: false }),
    f("comment", "Comment", { required: false }),
  ],
  outputs: [o("fullName", "Full Name")],
  // A schema's external id is `catalog.schema`, so the bare `schemaName` only
  // matches once composed with its catalog.
  dependsOn: [
    { fieldKey: "catalogName", targetTypeId: "databricks-catalog", label: "in catalog" },
    {
      fieldKey: "schemaName",
      targetTypeId: "databricks-schema",
      matchTemplate: "{catalogName}.{schemaName}",
      label: "in schema",
    },
  ],
  parentTypeId: "databricks-schema",
  iconKey: "function",
});

export const RegisteredModelResourceType = rt({
  name: "Registered Model",
  id: "databricks-registered-model",
  description: "A Unity Catalog MLflow registered model",
  fields: [
    f("name", "Name"),
    f("catalogName", "Catalog", { required: false }),
    f("schemaName", "Schema", { required: false }),
    f("owner", "Owner", { required: false }),
    f("aliasCount", "Aliases", { kind: "number", required: false }),
    f("storageLocation", "Storage Location", { required: false }),
    f("comment", "Comment", { required: false }),
  ],
  outputs: [o("fullName", "Full Name"), o("storageLocation", "Storage Location")],
  // A schema's external id is `catalog.schema`. Both halves are optional here —
  // a model outside Unity Catalog has neither, and the template correctly
  // yields nothing rather than a half-built key.
  dependsOn: [
    { fieldKey: "catalogName", targetTypeId: "databricks-catalog", label: "in catalog" },
    {
      fieldKey: "schemaName",
      targetTypeId: "databricks-schema",
      matchTemplate: "{catalogName}.{schemaName}",
      label: "in schema",
    },
  ],
  parentTypeId: "databricks-schema",
  iconKey: "model",
});

export const ModelVersionResourceType = rt({
  name: "Model Version",
  id: "databricks-model-version",
  description: "A Unity Catalog MLflow model version",
  fields: [
    f("id", "ID", { required: false }),
    f("modelName", "Model"),
    f("fullName", "Full Name"),
    f("version", "Version", { kind: "number" }),
    f("status", "Status", { required: false }),
    f("createdBy", "Created By", { required: false }),
    f("runId", "Run ID", { required: false }),
    f("source", "Source", { required: false }),
  ],
  outputs: [o("fullName", "Full Name"), o("version", "Version")],
  // `fullName` on a version is the *model's* full name, which is the registered
  // model's external id.
  dependsOn: [
    { fieldKey: "fullName", targetTypeId: "databricks-registered-model", label: "version of" },
  ],
  parentTypeId: "databricks-registered-model",
  iconKey: "model",
});

export const VectorSearchEndpointResourceType = rt({
  name: "Vector Search Endpoint",
  id: "databricks-vector-search-endpoint",
  description: "A Databricks Vector Search endpoint",
  fields: [
    f("name", "Name"),
    f("endpointType", "Type", { required: false }),
    f("state", "State", { required: false }),
    f("creator", "Creator", { required: false }),
  ],
  outputs: [o("endpointName", "Endpoint Name")],
  iconKey: "search",
});

export const VectorSearchIndexResourceType = rt({
  name: "Vector Search Index",
  plural: "Vector Search Indexes",
  id: "databricks-vector-search-index",
  description: "A Databricks Vector Search index",
  fields: [
    f("name", "Name"),
    f("endpointName", "Endpoint"),
    f("indexType", "Type", { required: false }),
    f("indexSubtype", "Subtype", { required: false }),
    f("primaryKey", "Primary Key", { required: false }),
    f("creator", "Creator", { required: false }),
  ],
  outputs: [o("fullName", "Index Name")],
  dependsOn: [
    {
      fieldKey: "endpointName",
      targetTypeId: "databricks-vector-search-endpoint",
      label: "served by",
    },
  ],
  parentTypeId: "databricks-vector-search-endpoint",
  iconKey: "search",
});

export const AppResourceType = rt({
  name: "App",
  id: "databricks-app",
  description: "A Databricks App deployment",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("computeSize", "Compute Size", { required: false }),
    f("appStatus", "App Status", { required: false }),
    f("computeStatus", "Compute Status", { required: false }),
    f("url", "URL", { required: false }),
    f("budgetPolicyId", "Budget Policy", { required: false }),
  ],
  outputs: [o("appName", "App Name"), o("appUrl", "App URL")],
  iconKey: "app",
});

export const SecretScopeResourceType = rt({
  name: "Secret Scope",
  pinnable: false,
  id: "databricks-secret-scope",
  description: "A Databricks secret scope. Secret values are never exposed by the API.",
  fields: [
    f("name", "Name"),
    f("backendType", "Backend", { required: false }),
    f("keyVaultDnsName", "Key Vault DNS", { required: false }),
    f("keyVaultResourceId", "Key Vault Resource ID", { required: false }),
  ],
  outputs: [o("scopeName", "Scope Name")],
  iconKey: "key",
});
