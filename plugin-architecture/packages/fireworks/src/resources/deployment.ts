import { f, o, rt } from "@infrawrench/plugin-base";

export const DeploymentResourceType = rt({
  name: "Deployment",
  id: "deployment",
  description:
    "Dedicated GPU capacity serving one base model, with its own replica window and accelerator type",
  fields: [
    f("displayName", "Display Name"),
    f("deploymentId", "Deployment ID"),
    f("baseModel", "Base Model", { required: false }),
    f("state", "State", { required: false }),
    f("statusMessage", "Status Message", { required: false }),
    f("acceleratorType", "Accelerator", { required: false }),
    f("acceleratorCount", "Accelerators / Replica", { kind: "number", required: false }),
    f("replicaCount", "Replicas Running", { kind: "number", required: false }),
    f("desiredReplicaCount", "Replicas Desired", { kind: "number", required: false }),
    f("minReplicaCount", "Min Replicas", { kind: "number", required: false }),
    f("maxReplicaCount", "Max Replicas", { kind: "number", required: false }),
    f("readyReplicaCount", "Replicas Ready", { kind: "number", required: false }),
    f("region", "Region", { required: false }),
    f("precision", "Precision", { required: false }),
    f("scaleToZeroWindow", "Scale-to-zero Window", { required: false }),
    f("createTime", "Created", { required: false }),
    f("expireTime", "Expires", { required: false }),
  ],
  outputs: [
    o("deploymentName", "Deployment Resource Name", {
      description: "`accounts/{account}/deployments/{id}`",
    }),
    o("deploymentId", "Deployment ID"),
    o("baseModel", "Base Model", {
      description: "The model string to pass as `model` on an inference call",
    }),
  ],
  // `baseModel` is a full resource name (`accounts/{acct}/models/{id}`), so it
  // matches the model's `modelName` output rather than its short external id.
  // Deployments of Fireworks' own catalogue models (`accounts/fireworks/…`)
  // simply find no target, which is correct — those aren't account resources.
  dependsOn: [
    { fieldKey: "baseModel", targetTypeId: "model", targetKey: "modelName", label: "serves" },
  ],
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "deployment",
});
