import { f, o, rt } from "@infrawrench/plugin-base";

export const DeployedModelResourceType = rt({
  name: "Deployed Model",
  id: "deployed-model",
  description:
    "A model attached to a deployment — typically a LoRA add-on loaded onto a base-model deployment",
  fields: [
    f("displayName", "Display Name"),
    f("deployedModelId", "Deployed Model ID"),
    f("model", "Model", { required: false }),
    f("deployment", "Deployment", { required: false }),
    f("state", "State", { required: false }),
    f("isDefault", "Default", { kind: "boolean", required: false }),
    f("public", "Public", { kind: "boolean", required: false }),
    f("serverless", "Fireworks-managed", { kind: "boolean", required: false }),
    f("createTime", "Created", { required: false }),
  ],
  outputs: [
    o("deployedModelName", "Deployed Model Resource Name"),
    o("model", "Model String", {
      description: "Pass this as `model` to route inference at the add-on",
    }),
  ],
  iconKey: "model",
});
