import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A tuned model created through AI Studio's supervised tuning flow.
 *
 * Verified against the live discovery document
 * (`https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta`),
 * which lists `tunedModels.list/get/create/patch/delete`.
 *
 * ⚠️ The HTML reference at `ai.google.dev/api/tuning` 404s and only documents
 * create/generateContent, so the discovery doc is the authority here. The
 * endpoints are real; treat the missing HTML as a signal that tuning is
 * de-emphasised rather than as evidence it is gone.
 *
 * `GET /v1beta/tunedModels?pageSize=&pageToken=&filter=` →
 * `{ tunedModels: [...], nextPageToken }`. ⚠️ `pageSize` defaults to **10**
 * here (max 1000), not 50 like `models`. By default the list excludes tuned
 * models shared with everyone; the `filter` param takes `owner:me`,
 * `writers:me`, `readers:me`, `readers:everyone`.
 */
export const TunedModelResourceType = rt({
  name: "Tuned Model",
  id: "tuned-model",
  description: "A model tuned from a Gemini base model on your own examples",
  fields: [
    f("name", "Resource Name"),
    f("displayName", "Display Name", { required: false }),
    f("state", "State", { required: false }),
    f("baseModel", "Base Model", { required: false }),
    f("sourceTunedModel", "Source Tuned Model", { required: false }),
    f("descriptionText", "Description", { required: false }),
    f("createTime", "Created", { required: false }),
    f("updateTime", "Updated", { required: false }),
    f("temperature", "Temperature", { kind: "number", required: false }),
    f("topP", "Top P", { kind: "number", required: false }),
    f("topK", "Top K", { kind: "number", required: false }),
    f("epochCount", "Epoch Count", { kind: "number", required: false }),
    f("batchSize", "Batch Size", { kind: "number", required: false }),
    f("learningRate", "Learning Rate", { kind: "number", required: false }),
    f("tuningStartTime", "Tuning Started", { required: false }),
    f("tuningCompleteTime", "Tuning Completed", { required: false }),
  ],
  outputs: [
    o("tunedModelId", "Tuned Model ID"),
    o("tunedModelName", "Resource Name", {
      description: 'Fully-qualified name, e.g. "tunedModels/my-model-abc123"',
    }),
    o("state", "State"),
  ],
  iconKey: "model",
});
