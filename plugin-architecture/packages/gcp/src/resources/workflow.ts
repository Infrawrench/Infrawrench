import { f, rt } from "@infrawrench/plugin-base";

export const WorkflowResourceType = rt({
  name: "Workflow",
  id: "workflow",
  description: "A Google Cloud Workflows serverless workflow orchestration",
  fields: [
    f("name", "Name"),
    f("region", "Region", { required: false }),
    f("state", "State", { required: false }),
    f("revisionId", "Revision ID", { required: false }),
    f("serviceAccount", "Service Account", { required: false }),
  ],
  outputs: [],
  // The lister trims `projects/<p>/serviceAccounts/<email>` down to the email,
  // which is the service account's externalId.
  dependsOn: [
    { fieldKey: "serviceAccount", targetTypeId: "gcp-service-account", label: "runs as" },
  ],
  supportsCreate: true,
});
