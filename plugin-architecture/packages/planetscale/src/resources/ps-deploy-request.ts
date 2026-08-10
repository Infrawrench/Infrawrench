import { f, o, rt } from "@infrawrench/plugin-base";

export const PsDeployRequestResourceType = rt({
  name: "Deploy Request",
  id: "ps-deploy-request",
  description: "A PlanetScale deploy request for applying branch schema changes",
  fields: [
    f("number", "Number", { kind: "number" }),
    f("databaseName", "Database"),
    f("branch", "Branch", { required: false }),
    f("intoBranch", "Into Branch", { required: false }),
    f("approved", "Approved", { kind: "boolean", required: false }),
    f("state", "State", { required: false }),
    f("htmlUrl", "URL", { required: false }),
    f("createdAt", "Created At", { required: false }),
    f("updatedAt", "Updated At", { required: false }),
    f("deployedAt", "Deployed At", { required: false }),
    f("closedAt", "Closed At", { required: false }),
  ],
  outputs: [
    o("deployRequestNumber", "Deploy Request Number"),
    o("sourceBranch", "Source Branch"),
    o("targetBranch", "Target Branch"),
  ],
  // Both branch names are bare while a branch's external id is
  // `{database}/{branch}`. A deploy request never crosses databases, so
  // composing with `databaseName` names exactly one branch.
  dependsOn: [
    { fieldKey: "databaseName", targetTypeId: "ps-database", label: "in database" },
    {
      fieldKey: "branch",
      targetTypeId: "ps-branch",
      matchTemplate: "{databaseName}/{branch}",
      label: "deploys from",
    },
    {
      fieldKey: "intoBranch",
      targetTypeId: "ps-branch",
      matchTemplate: "{databaseName}/{intoBranch}",
      label: "deploys into",
    },
  ],
  parentTypeId: "ps-database",
  iconKey: "planetscale",
});
