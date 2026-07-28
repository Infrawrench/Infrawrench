import { f, o, rt } from "@infrawrench/plugin-base";

export const DeploymentResourceType = rt({
  name: "Deployment",
  id: "deployment",
  description:
    "A private, always-addressable endpoint for one model version with its own hardware and instance window",
  fields: [
    f("owner", "Owner"),
    f("name", "Name"),
    f("model", "Model", { required: false }),
    f("version", "Version", { required: false }),
    f("hardware", "Hardware", { required: false }),
    f("minInstances", "Min Instances", { kind: "number", required: false }),
    f("maxInstances", "Max Instances", { kind: "number", required: false }),
    f("releaseNumber", "Release", { kind: "number", required: false }),
    f("createdAt", "Created", { required: false }),
    f("createdBy", "Created By", { required: false }),
  ],
  outputs: [
    o("deploymentRef", "Deployment Reference", { description: "`owner/name`" }),
    o("predictionsUrl", "Predictions URL"),
    o("version", "Deployed Version ID"),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "deployment",
});
