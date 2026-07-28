import { f, o, rt } from "@infrawrench/plugin-base";

export const ModelResourceType = rt({
  name: "Model",
  id: "model",
  description:
    "A model served by Together AI — chat, language, code, image, embedding, moderation, rerank or speech",
  fields: [
    f("name", "Name"),
    f("modelId", "Model ID"),
    f("type", "Type", { required: false }),
    f("organization", "Organization", { required: false }),
    f("contextLength", "Context Length", { kind: "number", required: false }),
    f("license", "License", { required: false }),
    f("link", "Model Card", { required: false }),
    f("inputPrice", "Input $/1M tokens", { kind: "number", required: false }),
    f("outputPrice", "Output $/1M tokens", { kind: "number", required: false }),
    f("hourlyPrice", "Dedicated $/hour", { kind: "number", required: false }),
    f("finetunePrice", "Fine-tune price", { kind: "number", required: false }),
    f("createdAt", "Added", { required: false }),
  ],
  outputs: [
    o("modelId", "Model ID", {
      description: "The string you pass as `model` on an inference call",
    }),
    o("modelName", "Model Name"),
    o("modelType", "Model Type"),
  ],
  iconKey: "model",
});
