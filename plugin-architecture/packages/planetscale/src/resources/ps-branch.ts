import { f, o, rt } from "@infrawrench/plugin-base";

export const PsBranchResourceType = rt({
  name: "Branch",
  plural: "Branches",
  id: "ps-branch",
  description:
    "A PlanetScale database branch: an isolated schema environment with its own connection endpoint",
  fields: [
    f("name", "Name", { editable: false }),
    f("databaseName", "Database", { editable: false }),
    f("kind", "Engine", {
      kind: "enum",
      enumValues: ["mysql", "postgresql", "neki"],
      required: false,
      editable: false,
    }),
    f("parentBranch", "Parent Branch", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("clusterName", "Cluster Size", { required: false, editable: false }),
    f("production", "Production", { kind: "boolean", required: false, editable: false }),
    f("ready", "Ready", { kind: "boolean", required: false, editable: false }),
    f("safeMigrations", "Safe Migrations", { kind: "boolean", required: false, editable: false }),
    f("deletionProtected", "Deletion Protection", {
      kind: "boolean",
      required: false,
      description: "Refuse deletion of this branch until protection is turned off again.",
    }),
    f("createdAt", "Created At", { required: false, editable: false }),
  ],
  outputs: [
    o("branchName", "Branch Name"),
    o("databaseName", "Database Name"),
    o("connectionString", "Connection String", { sensitive: true }),
  ],
  // `parentBranch` holds a bare branch name while a branch's external id is
  // `{database}/{branch}`. A branch can only fork inside its own database, so
  // composing the qualified id is exact: matching the bare name would collide
  // with every other database's `main`.
  dependsOn: [
    { fieldKey: "databaseName", targetTypeId: "ps-database", label: "in database" },
    {
      fieldKey: "parentBranch",
      targetTypeId: "ps-branch",
      matchTemplate: "{databaseName}/{parentBranch}",
      label: "branched from",
    },
  ],
  // PlanetScale exposes no retention window on the branch payload, so
  // `production` (which is what makes a branch auto-backed-up) is deliberately
  // not read as an automated-backup flag: it says the branch *should* have
  // backups, not that it does. Only a listed `ps-backup` counts.
  backupPolicy: { protectedBy: ["ps-backup"] },
  parentTypeId: "ps-database",
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "planetscale",
  attachTargets: [
    {
      pluginId: "planetscale",
      resourceTypeId: "ps-branch",
      matchField: "databaseName",
      verb: "Create deploy request",
    },
  ],
  // The connection string is MySQL for Vitess branches (a branch password)
  // and Postgres for Postgres branches (a branch role), so each SQL tab only
  // shows on the engine it can talk to.
  peerIntegrations: [
    {
      pluginId: "mysql",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "MySQL",
      showWhen: { fieldKey: "kind", equals: "mysql" },
    },
    {
      pluginId: "postgres",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "PostgreSQL",
      showWhen: { fieldKey: "kind", equals: "postgresql" },
    },
  ],
  secretExportTemplates: [
    {
      id: "connection-url",
      displayName: "Connection URL",
      description: "DATABASE_URL for connections to this branch",
      entries: [{ envKey: "DATABASE_URL", outputKey: "connectionString" }],
    },
  ],
});
