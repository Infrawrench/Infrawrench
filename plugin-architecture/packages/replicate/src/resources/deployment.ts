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
  // The release's `model` is an `owner/name` reference — the same string the
  // Model list uses as its external id — and `hardware` is a `/v1/hardware` SKU.
  dependsOn: [
    { fieldKey: "model", targetTypeId: "model", label: "serves" },
    { fieldKey: "hardware", targetTypeId: "hardware", label: "runs on" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "deployment",
});
