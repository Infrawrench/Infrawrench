import { f, rt } from "@infrawrench/plugin-base";

export const CloudBuildTriggerResourceType = rt({
  name: "Cloud Build Trigger",
  id: "cloud-build-trigger",
  description: "A Google Cloud Build trigger for CI/CD pipelines",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("disabled", "Disabled", { kind: "boolean", required: false }),
    f("triggerType", "Trigger Type", { required: false }),
    f("repoName", "Repository", { required: false }),
    f("branchName", "Branch", { required: false }),
    f("filename", "Config File", { required: false }),
  ],
  outputs: [],
  supportsCreate: true,
});
