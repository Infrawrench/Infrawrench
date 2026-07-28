import { f, o, rt } from "@infrawrench/plugin-base";

export const ModelResourceType = rt({
  name: "Model",
  id: "model",
  description: "A base model or LoRA add-on visible to this Fireworks account",
  fields: [
    f("displayName", "Display Name"),
    f("modelId", "Model ID"),
    f("kind", "Kind", { required: false }),
    f("state", "State", { required: false }),
    f("description", "Description", { required: false }),
    f("contextLength", "Context Length", { kind: "number", required: false }),
    f("parameterCount", "Parameters", { required: false }),
    f("public", "Public", { kind: "boolean", required: false }),
    f("supportsServerless", "Serverless", { kind: "boolean", required: false }),
    f("supportsLora", "LoRA Add-ons", { kind: "boolean", required: false }),
    f("supportsImageInput", "Image Input", { kind: "boolean", required: false }),
    f("supportsTools", "Tool Calling", { kind: "boolean", required: false }),
    f("huggingFaceUrl", "Hugging Face", { required: false }),
    f("githubUrl", "GitHub", { required: false }),
    f("deprecationDate", "Deprecation Date", { required: false }),
    f("createTime", "Created", { required: false }),
  ],
  outputs: [
    o("modelName", "Model Resource Name", {
      description: "`accounts/{account}/models/{id}` — this is the inference `model` string",
    }),
    o("modelId", "Model ID"),
  ],
  supportsMetrics: true,
  iconKey: "model",
});
