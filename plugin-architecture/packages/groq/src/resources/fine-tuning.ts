import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A registered LoRA adapter on GroqCloud.
 *
 * Groq does *not* train adapters — you bring your own and register it here,
 * which is why this lives at `https://api.groq.com/v1/fine_tunings` rather
 * than under the OpenAI-compatible `/openai/v1` prefix.
 */
export const GroqFineTuningResourceType = rt({
  name: "Fine-Tuning",
  id: "groq-fine-tuning",
  description:
    "A LoRA adapter registered on GroqCloud for inference against a supported base model",
  plural: "Fine-Tunings",
  fields: [
    f("fineTuningId", "Fine-Tuning ID"),
    f("name", "Name", { required: false }),
    f("type", "Type", { required: false }),
    f("baseModel", "Base Model", { required: false }),
    f("fineTunedModel", "Fine-Tuned Model", { required: false }),
    f("status", "Status", { required: false }),
    f("inputFileId", "Input File", { required: false }),
    f("createdAt", "Created", { required: false }),
  ],
  outputs: [
    o("fineTunedModel", "Fine-Tuned Model ID"),
    o("fineTuningId", "Fine-Tuning ID"),
    o("baseUrl", "OpenAI-Compatible Base URL"),
  ],
  // `base_model` is a `/openai/v1/models` id; `input_file_id` a `/openai/v1/files`
  // id. `fineTunedModel` names the adapter this registration produces, so it is
  // deliberately not an edge.
  dependsOn: [
    { fieldKey: "baseModel", targetTypeId: "groq-model", label: "adapts" },
    { fieldKey: "inputFileId", targetTypeId: "groq-file", label: "built from" },
  ],
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "sliders",
});
