import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Lakebase Postgres (Autoscaling) projects, through the Postgres API
 * (`/api/2.0/postgres/projects`, GA August 2026). New Lakebase databases are
 * created as Autoscaling projects since March 2026 and older Provisioned
 * instances are being migrated to them, so this is the surface to manage.
 * https://docs.databricks.com/api/postgres/v1/project
 */
export const LakebaseProjectResourceType = rt({
  name: "Lakebase Project",
  id: "databricks-lakebase-project",
  description: "A Lakebase Postgres project: autoscaling, scale-to-zero managed Postgres",
  fields: [
    f("projectId", "Project ID", { editable: false }),
    f("displayName", "Name"),
    f("pgVersion", "Postgres Version", { kind: "number", required: false, editable: false }),
    f("owner", "Owner", { required: false, editable: false }),
    f("minCu", "Min Compute (CU)", {
      kind: "number",
      required: false,
      description: "Default autoscaling floor for new endpoints, at least 0.5 CU.",
    }),
    f("maxCu", "Max Compute (CU)", {
      kind: "number",
      required: false,
      description: "Default autoscaling ceiling for new endpoints.",
    }),
    f("suspendTimeoutSeconds", "Scale-to-zero After (s)", {
      kind: "number",
      required: false,
      description: "Idle seconds before compute suspends, 60 to 604800.",
    }),
    f("historyRetentionHours", "Restore Window (h)", {
      kind: "number",
      required: false,
      description: "How far back point-in-time restore and branching reach, 48 to 840 hours.",
    }),
    f("defaultBranch", "Default Branch", { required: false, editable: false }),
    f("storageBytes", "Storage (bytes)", { kind: "number", required: false, editable: false }),
    f("lastActive", "Compute Last Active", { required: false, editable: false }),
    f("budgetPolicyId", "Budget Policy", { required: false, editable: false }),
  ],
  outputs: [o("projectId", "Project ID"), o("projectName", "Resource Name")],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "database",
});

export const LakebaseBranchResourceType = rt({
  name: "Lakebase Branch",
  plural: "Lakebase Branches",
  pinnable: false,
  id: "databricks-lakebase-branch",
  description: "A copy-on-write branch of a Lakebase Postgres project",
  fields: [
    f("branchId", "Branch ID"),
    f("projectId", "Project ID"),
    f("state", "State", {
      kind: "enum",
      enumValues: ["STATE_UNSPECIFIED", "INIT", "IMPORTING", "RESETTING", "READY", "ARCHIVED"],
      required: false,
    }),
    f("isDefault", "Default", { kind: "boolean", required: false }),
    f("isProtected", "Protected", { kind: "boolean", required: false }),
    f("sourceBranch", "Source Branch", { required: false }),
    f("logicalSizeBytes", "Size (bytes)", { kind: "number", required: false }),
    f("expireTime", "Expires", { required: false }),
    f("createdAt", "Created", { required: false }),
  ],
  outputs: [o("branchName", "Resource Name")],
  dependsOn: [
    { fieldKey: "projectId", targetTypeId: "databricks-lakebase-project", label: "branch of" },
  ],
  parentTypeId: "databricks-lakebase-project",
  iconKey: "git-branch",
});
