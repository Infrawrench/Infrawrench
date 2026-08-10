import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A model available to the workspace — base models and the workspace's own
 * fine-tuned checkpoints share this listing.
 *
 * `GET https://api.mistral.ai/v1/models` — note there are **no pagination
 * parameters** on this endpoint; the full catalogue comes back in one call.
 * https://docs.mistral.ai/api/endpoint/models
 */
export const MistralModelResourceType = rt({
  name: "Model",
  id: "mistral-model",
  description:
    "A Mistral model — base or fine-tuned — with its capability flags and context window",
  fields: [
    f("modelId", "Model ID"),
    f("name", "Name", { required: false }),
    f("type", "Type", { required: false }),
    f("ownedBy", "Owned By", { required: false }),
    f("maxContextLength", "Max Context Length", { kind: "number", required: false }),
    f("capabilities", "Capabilities", { required: false }),
    f("aliases", "Aliases", { required: false }),
    f("archived", "Archived", { kind: "boolean", required: false }),
    f("job", "Fine-Tuning Job", { required: false }),
    f("created", "Created", { required: false }),
  ],
  outputs: [o("modelId", "Model ID"), o("baseUrl", "API Base URL")],
  // Fine-tuned models carry the id of the job that produced them.
  dependsOn: [{ fieldKey: "job", targetTypeId: "mistral-fine-tuning-job", label: "produced by" }],
  supportsDelete: false,
  iconKey: "cpu",
});
