import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A fine-tuned model produced by the Cohere Fine-tuning API.
 *
 * Verified: https://docs.cohere.com/reference/listfinetunedmodels
 * `GET /v1/finetuning/finetuned-models` →
 * `{ finetuned_models: [...], next_page_token, total_size }`, paginated with
 * `page_size`/`page_token`.
 *
 * ⚠️ Cohere files the whole fine-tuning group under "Deprecated" and retired
 * fine-tuning for command, command-light, command-r, classify and rerank on
 * 2025-09-15. The endpoints still answer, so existing fine-tunes remain
 * listable and deletable — hence no `supportsCreate` here.
 */
export const FinetunedModelResourceType = rt({
  name: "Fine-tuned Model",
  id: "finetuned-model",
  plural: "Fine-tuned Models",
  description: "A custom model trained from one of Cohere's base models",
  fields: [
    f("name", "Name"),
    f("status", "Status", { required: false }),
    f("baseType", "Base Type", { required: false }),
    f("baseModel", "Base Model", { required: false }),
    f("baseVersion", "Base Version", { required: false }),
    f("strategy", "Strategy", { required: false }),
    f("datasetId", "Dataset ID", { required: false }),
    f("createdAt", "Created", { required: false }),
    f("updatedAt", "Updated", { required: false }),
    f("completedAt", "Completed", { required: false }),
    f("hyperparameters", "Hyperparameters", { required: false }),
  ],
  outputs: [
    o("finetunedModelId", "Fine-tuned Model ID", {
      description: "The id used to build the `model` string for inference calls",
    }),
    o("modelName", "Model Name"),
    o("status", "Status"),
  ],
  // `settings.base_model.name` is a `/v1/models` name; `settings.dataset_id` a
  // `/v1/datasets` id.
  dependsOn: [
    { fieldKey: "baseModel", targetTypeId: "model", label: "trained from" },
    { fieldKey: "datasetId", targetTypeId: "dataset", label: "trains on" },
  ],
  iconKey: "model",
});
