import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A model available to the workspace: base models and the workspace's own
 * fine-tuned checkpoints share this listing.
 *
 * `GET https://api.mistral.ai/v1/models`: note there are **no pagination
 * parameters** on this endpoint; the full catalogue comes back in one call.
 * https://docs.mistral.ai/api/endpoint/models
 *
 * Fine-tuned checkpoints carry header actions rather than type-level
 * edit/delete, because base models can be neither: archive and unarchive
 * (`POST`/`DELETE /v1/fine_tuning/models/{model_id}/archive`) and delete
 * (`DELETE /v1/models/{model_id}`).
 *
 * Metrics and Logs come from Studio Observability spans whose
 * `request_model`/`response_model` is this model (see `observability.ts`).
 */
export const MistralModelResourceType = rt({
  name: "Model",
  id: "mistral-model",
  description: "A Mistral model (base or fine-tuned) with its capabilities and context window",
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
  // Calls, latency and token series plus a Logs tab of recent calls, from
  // Studio Observability spans (Enterprise, Private Preview).
  supportsMetrics: true,
  supportsDelete: false,
  iconKey: "cpu",
});
