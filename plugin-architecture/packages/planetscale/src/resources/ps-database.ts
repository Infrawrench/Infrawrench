import { f, o, rt } from "@infrawrench/plugin-base";

export const PsDatabaseResourceType = rt({
  name: "Database",
  id: "ps-database",
  description: "A PlanetScale database: MySQL-compatible (Vitess) or Postgres",
  fields: [
    f("name", "Name", { editable: false }),
    f("kind", "Engine", {
      kind: "enum",
      enumValues: ["mysql", "postgresql", "neki"],
      required: false,
      editable: false,
    }),
    f("region", "Region", { required: false, editable: false }),
    f("state", "State", { required: false, editable: false }),
    f("plan", "Plan", { required: false, editable: false }),
    f("branchesCount", "Branches", { kind: "number", required: false, editable: false }),
    f("htmlUrl", "Dashboard URL", { required: false, editable: false }),
    f("createdAt", "Created At", { required: false, editable: false }),
    f("updatedAt", "Updated At", { required: false, editable: false }),
    // Database settings (`PATCH /organizations/{org}/databases/{db}`), which
    // the Edit form writes. The migration and foreign-key settings only apply
    // to Vitess databases; PlanetScale ignores them on Postgres.
    f("defaultBranch", "Default Branch", { required: false }),
    f("deletionProtected", "Deletion Protection", { kind: "boolean", required: false }),
    f("requireApprovalForDeploy", "Require Deploy Request Approval", {
      kind: "boolean",
      required: false,
    }),
    f("restrictBranchRegion", "Restrict Branches to Database Region", {
      kind: "boolean",
      required: false,
    }),
    f("productionBranchWebConsole", "Web Console on Production Branches", {
      kind: "boolean",
      required: false,
    }),
    f("insightsRawQueries", "Collect Full Queries in Insights", {
      kind: "boolean",
      required: false,
    }),
    f("allowDataBranching", "Allow Data Branching", {
      kind: "boolean",
      required: false,
      description: "Vitess only: seed new branches with data from the latest backup.",
    }),
    f("foreignKeysEnabled", "Foreign Key Constraints", {
      kind: "boolean",
      required: false,
      description: "Vitess only.",
    }),
    f("automaticMigrations", "Automatically Copy Migration Data", {
      kind: "boolean",
      required: false,
      description: "Vitess only: copy the migration table's rows on deploy.",
    }),
    f("migrationFramework", "Migration Framework", {
      required: false,
      description: "Vitess only, e.g. rails, prisma, laravel, other.",
    }),
    f("migrationTableName", "Migration Table", { required: false, description: "Vitess only." }),
    f("developmentBranchesLimit", "Development Branch Limit", {
      kind: "number",
      required: false,
      description: "Maximum development branches (1-5000).",
    }),
  ],
  outputs: [o("databaseName", "Database Name"), o("region", "Region")],
  dependsOn: [
    // A branch's external id is `{database}/{branch}`, so compose it.
    {
      fieldKey: "defaultBranch",
      targetTypeId: "ps-branch",
      matchTemplate: "{name}/{defaultBranch}",
      label: "default branch",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "planetscale",
});
